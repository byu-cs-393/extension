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
import { getWeeks, refreshWeeks } from "./recommended.js";

const RELATIVE_TIME = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

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

// ---- Nav ---------------------------------------------------------------

function wireNav() {
  const buttons = document.querySelectorAll(".ta-nav-btn");
  const views = document.querySelectorAll(".ta-view");
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      buttons.forEach((b) => b.classList.toggle("active", b === btn));
      views.forEach((v) => (v.hidden = v.dataset.view !== btn.dataset.view));
    });
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
