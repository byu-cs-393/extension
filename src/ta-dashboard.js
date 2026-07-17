// TA Dashboard bootstrap.
//
// Load-time contract: if the user isn't a TA, redirect back to the
// student dashboard. Only after that guard passes do we render
// TA-specific views.
//
// MVP scope: signoff queue only. Struggling students and student
// detail are placeholder tabs for now.

import { getRole } from "./auth.js";
import { fetchCollection, fetchDoc, patchDoc } from "./firestore.js";
import { getWeeks, refreshWeeks, classifyWeek, solvedSlugsInWeek } from "./recommended.js";

const RELATIVE_TIME = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

// Currently-selected netID for the student-detail view. Set when the
// TA clicks a row in the signoff queue or struggling list.
let selectedNetID = null;

// ---- Guard -------------------------------------------------------------

async function requireTaOrRedirect() {
  const role = await getRole();
  if (role !== "ta") {
    window.location.href = chrome.runtime.getURL("dashboard.html");
    return false;
  }
  return true;
}

// ---- Signoff queue -----------------------------------------------------

function timeAgo(ts) {
  if (!Number.isFinite(ts)) return "some time ago";
  const secs = Math.round((ts - Date.now()) / 1000);
  const units = [
    [60, "second"],
    [3600, "minute"],
    [86400, "hour"],
    [604800, "day"],
  ];
  for (const [limit, unit] of units) {
    if (Math.abs(secs) < limit) {
      const value = unit === "second" ? secs : Math.round(secs / (limit / 60));
      return RELATIVE_TIME.format(value, unit);
    }
  }
  return RELATIVE_TIME.format(Math.round(secs / 604800), "week");
}

function renderSignoffRow(item, onDecision) {
  const article = document.createElement("article");
  article.className = "signoff-row";
  article.dataset.netid = item.netID;
  article.dataset.weeknum = String(item.weekNum);

  const info = document.createElement("div");
  info.className = "signoff-info";

  const title = document.createElement("div");
  title.className = "signoff-title";
  const topic = item.week?.thirdCard?.topic ?? "topic exam";
  title.textContent = `${item.studentName} · Week ${item.weekNum} · ${topic}`;
  info.appendChild(title);

  const meta = document.createElement("div");
  meta.className = "signoff-meta";
  meta.textContent = `Requested ${timeAgo(item.requestedAt)}`;
  info.appendChild(meta);

  article.appendChild(info);

  const actions = document.createElement("div");
  actions.className = "signoff-actions";
  const passBtn = document.createElement("button");
  passBtn.className = "btn-pass";
  passBtn.textContent = "Pass";
  passBtn.addEventListener("click", () => onDecision(item, "passed", passBtn, failBtn));
  const failBtn = document.createElement("button");
  failBtn.className = "btn-fail";
  failBtn.textContent = "Fail";
  failBtn.addEventListener("click", () => onDecision(item, "failed", passBtn, failBtn));
  actions.append(passBtn, failBtn);
  article.appendChild(actions);

  return article;
}

async function renderSignoffQueue() {
  const container = document.getElementById("signoff-list");
  container.innerHTML = "<p class=\"ta-empty\">Loading…</p>";

  // Kick off a weeks refresh in the background so titles are current
  // if the catalog changed since the cache last synced.
  refreshWeeks();

  const items = await fetchSignoffQueueWithNames();
  container.innerHTML = "";

  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "ta-empty";
    empty.textContent = "No pending signoff requests.";
    container.appendChild(empty);
    return;
  }

  for (const item of items) {
    container.appendChild(renderSignoffRow(item, applyDecision));
  }
}

// Attach netIDs to the parsed student docs by re-parsing the raw
// Firestore list response. Cheaper than N individual gets.
async function fetchSignoffQueueWithNames() {
  const [studentsList, weeks] = await Promise.all([
    fetchStudentsWithIds(),
    getWeeks(),
  ]);
  const weekByNum = Object.fromEntries(weeks.map((w) => [w.weekNum, w]));

  const perStudent = await Promise.all(
    studentsList.map(async ({ netID, data }) => {
      const progressDocs = await fetchCollection(
        `students/${netID}/weekProgress`
      );
      return progressDocs
        .filter((p) => p?.type === "topicExam" && p?.status === "requested")
        .map((p) => ({
          netID,
          studentName: data?.name || netID,
          weekNum: p.weekNum,
          progress: p,
          week: weekByNum[p.weekNum] ?? null,
          requestedAt: p.requestedAt ?? null,
        }));
    })
  );
  const flat = perStudent.flat();
  flat.sort((a, b) => (b.requestedAt ?? 0) - (a.requestedAt ?? 0));
  return flat;
}

// Firestore REST list endpoint. Returns [{ netID, data }, ...].
// We re-implement lightweight parsing here to preserve doc IDs (netIDs)
// which our generic fetchCollection strips.
async function fetchStudentsWithIds() {
  const { firebaseConfig } = await import(chrome.runtime.getURL("firebase-config.js"));
  const { getIdToken } = await import(chrome.runtime.getURL("auth.js"));
  const url =
    `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}` +
    `/databases/(default)/documents/students?key=${firebaseConfig.apiKey}`;
  const idToken = await getIdToken();
  const resp = await fetch(url, {
    headers: idToken ? { Authorization: `Bearer ${idToken}` } : {},
  });
  if (!resp.ok) throw new Error(`students list ${resp.status}`);
  const body = await resp.json();
  const docs = body.documents ?? [];
  return docs.map((d) => {
    // d.name is like "projects/.../students/jack684"
    const netID = d.name.split("/").pop();
    const data = parseFirestoreFields(d.fields ?? {});
    return { netID, data };
  });
}

// Local copy of the Firestore field parser — the shared one is
// module-private in firestore.js. Same logic.
function parseFirestoreFields(fields) {
  const result = {};
  for (const [key, valueObj] of Object.entries(fields)) {
    result[key] = unwrapFirestoreValue(valueObj);
  }
  return result;
}
function unwrapFirestoreValue(valueObj) {
  const type = Object.keys(valueObj)[0];
  const value = valueObj[type];
  if (type === "arrayValue") {
    return (value.values ?? []).map(unwrapFirestoreValue);
  }
  if (type === "mapValue") {
    return parseFirestoreFields(value.fields ?? {});
  }
  // Firestore REST returns int64 as JSON string — see the note in
  // firestore.js. Same conversion here.
  if (type === "integerValue") {
    return Number(value);
  }
  return value;
}

// Signoff decision handler. Optimistic: disables buttons immediately,
// writes the progress doc, re-renders the queue on success. On
// failure, re-enables and shows an alert.
async function applyDecision(item, outcome, passBtn, failBtn) {
  passBtn.disabled = true;
  failBtn.disabled = true;
  const now = Date.now();
  const netID = item.netID;
  const weekNum = item.weekNum;

  try {
    // Merge with existing fields to keep requestedAt/scheduledAt/etc.
    const existing = await fetchDoc(`students/${netID}/weekProgress/${weekNum}`);
    const newDoc = {
      ...(existing ?? {}),
      type: "topicExam",
      weekNum,
      status: outcome, // "passed" | "failed"
      signoffAt: now,
    };
    await patchDoc(`students/${netID}/weekProgress/${weekNum}`, newDoc);
    // Refresh the queue — the row we just handled falls off.
    await renderSignoffQueue();
  } catch (err) {
    console.error("Signoff decision failed:", err);
    alert(`Couldn't record the decision: ${err.message}`);
    passBtn.disabled = false;
    failBtn.disabled = false;
  }
}

// ---- Struggling students view ------------------------------------------

const INACTIVE_DAYS_THRESHOLD = 7;
const CURRENT_WEEK_LOW_THRESHOLD = 0.5;
const OVERALL_LOW_THRESHOLD = 0.5;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Computes per-student engagement metrics from raw student + week data.
// All metrics are relative to weeks that are past or current — future
// weeks are excluded so they don't drag down the "overall" number.
function computeMetrics({ student, netID, weekProgressByNum, weeks }) {
  const now = Date.now();
  const solves = student?.solvedProblems ?? {};
  const visibleWeeks = weeks.filter((w) => w.startDate <= now);

  // Last active = latest solve timestamp anywhere.
  let lastActive = 0;
  for (const ts of Object.values(solves)) {
    if (typeof ts === "number" && ts > lastActive) lastActive = ts;
  }
  const daysSinceActive =
    lastActive === 0 ? Infinity : (now - lastActive) / ONE_DAY_MS;

  // Overall: total solved-from-listed across past+current, over
  // total listed problems on those weeks.
  let listedTotal = 0;
  let listedSolved = 0;
  for (const week of visibleWeeks) {
    const problems = Array.isArray(week.problems) ? week.problems : [];
    listedTotal += problems.length;
    const solvedSet = solvedSlugsInWeek(week, { solves });
    listedSolved += problems.filter((p) => solvedSet.has(p.slug)).length;
  }
  const overallRatio = listedTotal === 0 ? 1 : listedSolved / listedTotal;

  // Current week: same calc, just for the current week.
  const currentWeek = visibleWeeks.find(
    (w) => classifyWeek(w, now) === "current"
  );
  let currentSolved = 0;
  let currentTotal = 0;
  if (currentWeek) {
    const problems = Array.isArray(currentWeek.problems) ? currentWeek.problems : [];
    currentTotal = problems.length;
    const solvedSet = solvedSlugsInWeek(currentWeek, { solves });
    currentSolved = problems.filter((p) => solvedSet.has(p.slug)).length;
  }
  const currentRatio = currentTotal === 0 ? 1 : currentSolved / currentTotal;

  // Risk flags — surfaced as pills next to the name.
  const flags = [];
  if (daysSinceActive === Infinity) flags.push("No activity yet");
  else if (daysSinceActive >= INACTIVE_DAYS_THRESHOLD) {
    flags.push(`Inactive ${Math.floor(daysSinceActive)}d`);
  }
  if (currentTotal > 0 && currentRatio < CURRENT_WEEK_LOW_THRESHOLD) {
    flags.push(`Behind this week (${currentSolved}/${currentTotal})`);
  }
  if (listedTotal > 0 && overallRatio < OVERALL_LOW_THRESHOLD) {
    flags.push(`Overall ${Math.round(overallRatio * 100)}%`);
  }
  // Check for a stale-pending signoff request.
  const pendingSignoff = Object.values(weekProgressByNum).find(
    (p) => p?.type === "topicExam" && p?.status === "requested"
  );
  if (pendingSignoff?.requestedAt) {
    const waitingDays = (now - pendingSignoff.requestedAt) / ONE_DAY_MS;
    if (waitingDays >= 3) flags.push(`Signoff pending ${Math.floor(waitingDays)}d`);
  }

  // Composite risk score for sorting. Higher = worse.
  const risk =
    (daysSinceActive === Infinity ? 30 : Math.min(daysSinceActive, 30)) +
    (1 - overallRatio) * 20 +
    (1 - currentRatio) * 20;

  return {
    netID,
    name: student?.name || netID,
    daysSinceActive,
    lastActive,
    currentSolved,
    currentTotal,
    currentRatio,
    listedSolved,
    listedTotal,
    overallRatio,
    flags,
    risk,
  };
}

async function fetchAllStudentsWithProgress() {
  const [studentsList, weeks, activityByStudent] = await Promise.all([
    fetchStudentsWithIds(),
    getWeeks(),
    fetchActivityCountsByStudent(),
  ]);

  const perStudent = await Promise.all(
    studentsList.map(async ({ netID, data }) => {
      const progressDocs = await fetchCollection(
        `students/${netID}/weekProgress`
      );
      const weekProgressByNum = {};
      for (const p of progressDocs) {
        if (Number.isFinite(p?.weekNum)) weekProgressByNum[p.weekNum] = p;
      }
      return {
        netID,
        student: data,
        weekProgressByNum,
        activityCounts: activityByStudent[netID] ?? { opens: 0, passes: 0, fails: 0 },
      };
    })
  );

  return { rows: perStudent, weeks };
}

// Fetches every event in `activity/` and groups counts by netID +
// event type. Fine for a small course; we can switch to a filtered
// query per student later if the collection grows past a few
// thousand events.
async function fetchActivityCountsByStudent() {
  const events = await fetchCollection("activity");
  const byStudent = {};
  for (const e of events) {
    const netID = e?.studentNetID;
    if (!netID) continue;
    const bucket = byStudent[netID] ?? { opens: 0, passes: 0, fails: 0 };
    if (e.eventType === "open_problem") bucket.opens++;
    else if (e.eventType === "submit_pass") bucket.passes++;
    else if (e.eventType === "submit_fail") bucket.fails++;
    byStudent[netID] = bucket;
  }
  return byStudent;
}

// For a single student, buckets their activity events into per-week
// counts (weekNum → { opens, passes, fails }). Uses the week catalog
// to decide which week each event lands in based on timestamp.
async function fetchActivityPerWeek(netID, weeks) {
  const events = await fetchCollection("activity");
  const byWeek = {};
  for (const e of events) {
    if (e?.studentNetID !== netID) continue;
    if (typeof e?.timestamp !== "number") continue;
    const week = weeks.find(
      (w) => e.timestamp >= w.startDate && e.timestamp < w.endDate
    );
    if (!week) continue;
    const wn = week.weekNum;
    const bucket = byWeek[wn] ?? { opens: 0, passes: 0, fails: 0 };
    if (e.eventType === "open_problem") bucket.opens++;
    else if (e.eventType === "submit_pass") bucket.passes++;
    else if (e.eventType === "submit_fail") bucket.fails++;
    byWeek[wn] = bucket;
  }
  return byWeek;
}

function renderStruggling({ rows, weeks }) {
  const container = document.getElementById("struggling-list");
  container.innerHTML = "";
  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "ta-empty";
    empty.textContent = "No students yet.";
    container.appendChild(empty);
    return;
  }

  const metrics = rows.map((r) => ({
    ...computeMetrics({
      student: r.student,
      netID: r.netID,
      weekProgressByNum: r.weekProgressByNum,
      weeks,
    }),
    activityCounts: r.activityCounts,
  }));
  metrics.sort((a, b) => b.risk - a.risk);

  for (const m of metrics) {
    container.appendChild(renderStrugglingRow(m));
  }
}

function renderStrugglingRow(m) {
  const article = document.createElement("article");
  article.className = "struggling-row";
  article.dataset.netid = m.netID;
  article.addEventListener("click", () => selectStudent(m.netID));

  const info = document.createElement("div");
  info.className = "struggling-info";

  const nameLine = document.createElement("div");
  nameLine.className = "struggling-name";
  nameLine.textContent = `${m.name} (${m.netID})`;
  info.appendChild(nameLine);

  if (m.flags.length > 0) {
    const flagRow = document.createElement("div");
    flagRow.className = "struggling-flags";
    for (const f of m.flags) {
      const pill = document.createElement("span");
      pill.className = "flag-pill";
      pill.textContent = f;
      flagRow.appendChild(pill);
    }
    info.appendChild(flagRow);
  } else {
    const okRow = document.createElement("div");
    okRow.className = "struggling-flags";
    const ok = document.createElement("span");
    ok.className = "flag-pill flag-ok";
    ok.textContent = "On track";
    okRow.appendChild(ok);
    info.appendChild(okRow);
  }

  const meta = document.createElement("div");
  meta.className = "struggling-meta";
  const lastActiveStr =
    m.daysSinceActive === Infinity
      ? "no activity yet"
      : `last active ${timeAgo(m.lastActive)}`;
  const currentStr =
    m.currentTotal === 0
      ? "no current week"
      : `this week ${m.currentSolved}/${m.currentTotal}`;
  const overallStr = `overall ${m.listedSolved}/${m.listedTotal}`;
  const opens = m.activityCounts?.opens ?? 0;
  const passes = m.activityCounts?.passes ?? 0;
  const fails = m.activityCounts?.fails ?? 0;
  const visitsStr = `${opens} visits · ${passes} passes · ${fails} fails`;
  meta.textContent = `${lastActiveStr} · ${currentStr} · ${overallStr} · ${visitsStr}`;
  info.appendChild(meta);

  article.appendChild(info);

  const chevron = document.createElement("span");
  chevron.className = "struggling-chevron";
  chevron.textContent = "→";
  article.appendChild(chevron);

  return article;
}

async function loadAndRenderStruggling() {
  const container = document.getElementById("struggling-list");
  container.innerHTML = "<p class=\"ta-empty\">Loading…</p>";
  refreshWeeks();
  try {
    const data = await fetchAllStudentsWithProgress();
    renderStruggling(data);
  } catch (err) {
    console.error("Failed to load struggling view:", err);
    container.innerHTML = `<p class="ta-empty">Failed to load: ${err.message}</p>`;
  }
}

// ---- Student detail view -----------------------------------------------

function selectStudent(netID) {
  selectedNetID = netID;
  // Switch view.
  const buttons = document.querySelectorAll(".ta-nav-btn");
  const views = document.querySelectorAll(".ta-view");
  buttons.forEach((b) => b.classList.toggle("active", b.dataset.view === "student"));
  views.forEach((v) => (v.hidden = v.dataset.view !== "student"));
  loadAndRenderStudentDetail();
}

async function loadAndRenderStudentDetail() {
  const header = document.getElementById("student-detail-header");
  const body = document.getElementById("student-detail-body");
  header.innerHTML = "";
  body.innerHTML = "<p class=\"ta-empty\">Loading…</p>";

  if (!selectedNetID) {
    body.innerHTML = "";
    header.innerHTML =
      '<p class="ta-empty">Pick a student from ' +
      '<a href="#" class="link-to-struggling">Struggling students</a> ' +
      'to see their details.</p>';
    return;
  }

  try {
    const [student, weeks, progressDocs, activityByStudent] = await Promise.all([
      fetchDoc(`students/${selectedNetID}`),
      getWeeks(),
      fetchCollection(`students/${selectedNetID}/weekProgress`),
      fetchActivityCountsByStudent(),
    ]);
    const weekProgressByNum = {};
    for (const p of progressDocs) {
      if (Number.isFinite(p?.weekNum)) weekProgressByNum[p.weekNum] = p;
    }
    const activityPerWeek = await fetchActivityPerWeek(selectedNetID, weeks);

    renderStudentDetail({
      student,
      netID: selectedNetID,
      weeks,
      weekProgressByNum,
      activityCounts: activityByStudent[selectedNetID] ?? { opens: 0, passes: 0, fails: 0 },
      activityPerWeek,
    });
  } catch (err) {
    console.error("Failed to load student detail:", err);
    body.innerHTML = `<p class="ta-empty">Failed to load: ${err.message}</p>`;
  }
}

function renderStudentDetail({ student, netID, weeks, weekProgressByNum, activityCounts, activityPerWeek }) {
  const header = document.getElementById("student-detail-header");
  const body = document.getElementById("student-detail-body");
  header.innerHTML = "";
  body.innerHTML = "";

  const metrics = computeMetrics({
    student,
    netID,
    weekProgressByNum,
    weeks,
  });

  // Header block
  const h1 = document.createElement("h1");
  h1.textContent = student?.name || netID;
  header.appendChild(h1);

  const sub = document.createElement("p");
  sub.className = "student-detail-sub";
  const parts = [`netID ${netID}`];
  if (student?.leetcodeUsername) parts.push(`LeetCode @${student.leetcodeUsername}`);
  if (student?.note) parts.push(student.note);
  sub.textContent = parts.join(" · ");
  header.appendChild(sub);

  // Activity summary line
  const opens = activityCounts?.opens ?? 0;
  const passes = activityCounts?.passes ?? 0;
  const fails = activityCounts?.fails ?? 0;
  const activityLine = document.createElement("p");
  activityLine.className = "student-detail-sub";
  activityLine.textContent = `${opens} problem visits · ${passes} accepted submissions · ${fails} failed submissions`;
  header.appendChild(activityLine);

  // Flag row
  if (metrics.flags.length > 0) {
    const flagRow = document.createElement("div");
    flagRow.className = "struggling-flags";
    for (const f of metrics.flags) {
      const pill = document.createElement("span");
      pill.className = "flag-pill";
      pill.textContent = f;
      flagRow.appendChild(pill);
    }
    header.appendChild(flagRow);
  }

  // Body: per-week breakdown
  const now = Date.now();
  const visible = [...weeks]
    .filter((w) => w.startDate <= now)
    .sort((a, b) => b.weekNum - a.weekNum);

  const h2 = document.createElement("h2");
  h2.textContent = "Weekly breakdown";
  h2.className = "student-detail-section";
  body.appendChild(h2);

  if (visible.length === 0) {
    const empty = document.createElement("p");
    empty.className = "ta-empty";
    empty.textContent = "No weeks yet.";
    body.appendChild(empty);
    return;
  }

  const table = document.createElement("div");
  table.className = "weekly-breakdown";
  for (const week of visible) {
    table.appendChild(
      renderWeekBreakdownRow(
        week,
        student,
        weekProgressByNum[week.weekNum],
        activityPerWeek?.[week.weekNum]
      )
    );
  }
  body.appendChild(table);
}

function renderWeekBreakdownRow(week, student, progress, weekActivity) {
  const row = document.createElement("div");
  row.className = "weekly-row";

  const label = document.createElement("div");
  label.className = "weekly-label";
  label.textContent = `Week ${week.weekNum}`;
  row.appendChild(label);

  const problems = Array.isArray(week.problems) ? week.problems : [];
  const solves = student?.solvedProblems ?? {};
  const solvedSet = solvedSlugsInWeek(week, { solves });
  const solved = problems.filter((p) => solvedSet.has(p.slug)).length;

  const recCell = document.createElement("div");
  recCell.className = "weekly-cell";
  recCell.textContent = `Recommended: ${solved}/${problems.length}`;
  if (problems.length > 0 && solved === problems.length) recCell.classList.add("cell-done");
  else if (problems.length > 0 && solved / problems.length < 0.5)
    recCell.classList.add("cell-low");
  row.appendChild(recCell);

  const tcCell = document.createElement("div");
  tcCell.className = "weekly-cell";
  if (!week.thirdCard?.type) {
    tcCell.textContent = "—";
    tcCell.classList.add("cell-none");
  } else {
    const t = week.thirdCard.type;
    const label = t === "topicExam" ? "Topic Exam"
      : t === "onlineAssessment" ? "OA"
      : t === "mockInterview" ? "Mock Interview"
      : t;
    let statusText = "not attempted";
    if (progress) {
      if (t === "topicExam") statusText = progress.status ?? "not attempted";
      else if (t === "onlineAssessment") statusText = progress.finalStatus ?? "in progress";
      else if (t === "mockInterview") statusText = progress.status ?? "not attempted";
    }
    tcCell.textContent = `${label}: ${statusText}`;
    if (statusText === "passed" || statusText === "completed") tcCell.classList.add("cell-done");
    else if (statusText === "failed") tcCell.classList.add("cell-low");
  }
  row.appendChild(tcCell);

  // Per-week activity — visits + passes/fails from the activity log,
  // scoped to this week's window.
  const visitCell = document.createElement("div");
  visitCell.className = "weekly-cell weekly-cell-activity";
  const opens = weekActivity?.opens ?? 0;
  const passes = weekActivity?.passes ?? 0;
  const fails = weekActivity?.fails ?? 0;
  if (opens === 0 && passes === 0 && fails === 0) {
    visitCell.textContent = "no visits";
    visitCell.classList.add("cell-none");
  } else {
    visitCell.textContent = `${opens} visits · ${passes}✓ · ${fails}✗`;
  }
  row.appendChild(visitCell);

  return row;
}

// ---- Nav ---------------------------------------------------------------

function wireNav() {
  const buttons = document.querySelectorAll(".ta-nav-btn");
  const views = document.querySelectorAll(".ta-view");
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      buttons.forEach((b) => b.classList.toggle("active", b === btn));
      views.forEach((v) => (v.hidden = v.dataset.view !== btn.dataset.view));
      // Lazy-load views on first switch.
      if (btn.dataset.view === "struggling") loadAndRenderStruggling();
      if (btn.dataset.view === "student") loadAndRenderStudentDetail();
    });
  });

  // The empty-state link inside the detail view — clicking it should
  // navigate to struggling.
  document.addEventListener("click", (e) => {
    const link = e.target.closest(".link-to-struggling");
    if (!link) return;
    e.preventDefault();
    const strugglingBtn = document.querySelector(
      '.ta-nav-btn[data-view="struggling"]'
    );
    strugglingBtn?.click();
  });
}

// ---- Bootstrap ---------------------------------------------------------

(async () => {
  const ok = await requireTaOrRedirect();
  if (!ok) return;

  document.getElementById("back-to-student-btn").addEventListener("click", () => {
    window.location.href = chrome.runtime.getURL("dashboard.html");
  });

  wireNav();
  renderSignoffQueue();
})();
