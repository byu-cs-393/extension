import { fetchStudent, fetchCollection } from "../platform/firestore.js";
import { getRole } from "../platform/auth.js";
import { trackedActiveMsInWindow } from "../data/keystroke-analysis.js";
import { pendingAutoSubmissions } from "../data/auto-submit.js";
import { sendCanvasSubmission } from "../ui/submission-form.js";
import {
  getVisibleWeeks,
  getCardsForWeek,
  classifyWeek,
  solvedSlugsInWeek,
  flattenPlacementsToProblems,
  getOaRuntimeShape,
  getTopics,
  studyProblemsForWeek,
  studyAssignmentIdForWeek,
  getSignoffStaff,
} from "../data/course-data.js";
import {
  createThirdCardSection,
  getCachedProgress,
  refreshProgress,
  appendCanvasSubmitAffordance,
} from "../ui/third-card.js";
import {
  getCachedAssignmentProgress,
  refreshAssignmentProgress,
  ASSIGNMENT_PROGRESS_CACHE_KEY,
} from "../data/assignment-progress.js";
import {
  getActive,
  getRemainingMs,
  formatRemaining,
  endActiveAttempt,
  solvedInWindow,
  attemptPassed,
  OA_SESSION_KEY,
} from "../data/oa-session.js";

// Module-scoped state — render() reads from these. Two paths update
// them: chrome.storage.onChanged (live), or the bootstrap (initial).
let currentCards = []; // cards blobs from course-data.js
let currentSolves = null;
let currentProgress = {}; // { [weekNum]: progressDoc } — Firestore weekProgress
let currentActiveOa = null; // active OA session, or null
let currentNetID = null;
let timerInterval = null;
// Preloaded runtime-shape OAs keyed by topic id. Populated once in
// initWeeks so the sync third-card dispatcher can render OA cards
// without an async fetch mid-render.
let currentOaShapes = {};
let currentAssignmentProgress = {}; // { [assignmentId]: doc }
// Keystroke session METADATA only — enough for per-week active time
// without pulling every session's events.
let currentKeystrokeSessions = [];
// Who a student can request a signoff from, from course.json.
let currentSignoffStaff = [];

async function getNetID() {
  const { netID } = await chrome.storage.sync.get("netID");
  return netID || null;
}

function renderStudent(student) {
  const nameEl = document.getElementById("student-name");
  nameEl.textContent = student?.name || "friend";
}

async function loadAndRender(netID) {
  try {
    const student = await fetchStudent(netID);
    console.log("Loaded student from Firestore:", student);
    renderStudent(student);
  } catch (error) {
    console.error("Failed to load student:", error);
    document.getElementById("student-name").textContent = "friend";
  }
}

// ---- Week rendering ----------------------------------------------------

const RELATIVE_TIME_FORMATTER = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

function formatRelativeTime(timestamp) {
  if (!timestamp) return "";
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  const units = [
    [60, "second"],
    [3600, "minute"],
    [86400, "hour"],
    [604800, "day"],
  ];
  for (const [limit, unit] of units) {
    if (Math.abs(seconds) < limit) {
      const value = unit === "second" ? seconds : Math.round(seconds / (limit / 60));
      return RELATIVE_TIME_FORMATTER.format(value, unit);
    }
  }
  return RELATIVE_TIME_FORMATTER.format(Math.round(seconds / 604800), "week");
}

function renderWeeks() {
  const container = document.getElementById("weeks-container");
  container.innerHTML = "";

  if (currentCards.length === 0) {
    const empty = document.createElement("p");
    empty.className = "weeks-empty";
    empty.textContent = "No weeks in view yet — the semester hasn't started.";
    container.appendChild(empty);
    return;
  }

  const now = Date.now();
  for (const cards of currentCards) {
    container.appendChild(createWeekSection(cards, classifyWeek(cards, now)));
  }
}

function createWeekSection(cards, status) {
  const section = document.createElement("section");
  section.className = "week";
  section.dataset.weekNum = String(cards.week);

  // Header
  const header = document.createElement("div");
  header.className = "week-header";

  const title = document.createElement("h2");
  title.className = "week-title";
  title.append(`Week ${cards.week}`);
  if (cards.title) {
    const subtitle = document.createElement("span");
    subtitle.className = "week-subtitle";
    subtitle.textContent = ` — ${cards.title}`;
    title.appendChild(subtitle);
  }
  if (status === "current") {
    const badge = document.createElement("span");
    badge.className = "week-badge";
    badge.textContent = "Current";
    title.appendChild(badge);
  }

  const dates = document.createElement("div");
  dates.className = "week-dates";
  dates.textContent = cards.dates ?? "";

  header.append(title, dates);
  section.appendChild(header);

  section.appendChild(createRecommendedCard(cards, status));

  for (const item of cards.performanceItems ?? []) {
    const cardEl = createThirdCardSection(
      item,
      currentProgress?.[cards.week] ?? null,
      status,
      {
        weekNum: cards.week,
        netID: currentNetID,
        activeSession: currentActiveOa,
        solves: currentSolves?.solves ?? {},
        solutionUrls: currentSolves?.solutions ?? {},
        oaShapes: currentOaShapes,
        assignmentProgress: currentAssignmentProgress,
        signoffStaff: currentSignoffStaff,
      },
    );
    if (cardEl) section.appendChild(cardEl);
  }
  return section;
}

function createRecommendedCard(cards, status) {
  const problems = flattenPlacementsToProblems(cards.placements);
  const solvedSet = solvedSlugsInWeek(cards, currentSolves);
  const total = problems.length;
  const solved = problems.filter((p) => solvedSet.has(p.slug)).length;
  const pct = total === 0 ? 0 : Math.round((solved / total) * 100);
  const isComplete = total > 0 && solved === total;

  const article = document.createElement("article");
  article.className = "card";

  const cardTitle = document.createElement("div");
  cardTitle.className = "card-title";
  cardTitle.textContent = "Recommended problems";
  article.appendChild(cardTitle);

  // Progress bar
  const progress = document.createElement("div");
  progress.className = "progress";

  const bar = document.createElement("div");
  bar.className = "progress-bar";
  bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", String(total));
  bar.setAttribute("aria-valuenow", String(solved));

  const fill = document.createElement("div");
  fill.style.width = `${pct}%`;
  if (isComplete) {
    fill.className = "progress-fill complete";
  } else if (status === "past") {
    fill.className = "progress-fill incomplete";
  } else {
    fill.className = "progress-fill";
  }
  bar.appendChild(fill);

  const text = document.createElement("div");
  text.className = "progress-text";
  text.textContent = `${solved} / ${total}`;
  if (isComplete) {
    const check = document.createElement("span");
    check.className = "status-check";
    check.setAttribute("aria-hidden", "true");
    check.textContent = " ✓";
    text.appendChild(check);
  }

  progress.append(bar, text);
  article.appendChild(progress);

  // Collapsible problem list — always rendered, collapsed by default.
  if (total > 0) {
    const details = document.createElement("details");
    details.className = "problem-details";

    const summary = document.createElement("summary");
    summary.className = "problem-details-summary";
    const summaryText = document.createElement("span");
    summaryText.textContent = "Show problems";
    const chevron = document.createElement("span");
    chevron.className = "chevron";
    chevron.setAttribute("aria-hidden", "true");
    chevron.textContent = "▾";
    summary.append(summaryText, chevron);
    details.appendChild(summary);

    const list = document.createElement("ul");
    list.className = "card-list problem-list";
    for (const p of problems) {
      list.appendChild(createProblemItem(p, solvedSet.has(p.slug)));
    }
    details.appendChild(list);
    article.appendChild(details);
  }

  // Meta line
  const meta = document.createElement("div");
  meta.className = "card-meta";
  if (status === "current") {
    meta.textContent = currentSolves?.syncedAt
      ? `Synced ${formatRelativeTime(currentSolves.syncedAt)}`
      : "Solve a problem on LeetCode to register progress.";
  } else if (status === "past" && !isComplete) {
    meta.textContent = `Week ended — no more credit.`;
  }
  article.appendChild(meta);

  // Weekly Study submission — the recommended-problems card is the
  // student-facing surface for the study-w{N} assignment. We pre-fill
  // the `problems[]` extra field with the week's required + in-class
  // items so the submitted template lists them; the student fills in
  // hours + growth via the modal.
  if (cards.hasStudy) {
    const studyItem = {
      type: "study",
      assignmentId: studyAssignmentIdForWeek(cards.week),
    };
    const studyProgress = currentAssignmentProgress?.[studyItem.assignmentId] ?? null;
    // Prefer per-submission URLs from the tracker/backstop; fall back
    // to the plain problem URL if we haven't seen a submission id yet.
    const solutionUrls = currentSolves?.solutions ?? {};
    // The rubric wants ACCEPTED-SUBMISSION urls, so solved state and the
    // captured submission link both travel with each problem. The
    // template decides how to present them — a problem URL is not a
    // stand-in for proof of a solve.
    const solvedSet = solvedSlugsInWeek(cards, currentSolves);
    const problems = studyProblemsForWeek(cards).map((p) => {
      const slug = extractLeetcodeSlug(p.url);
      return {
        title: p.title,
        tag: p.tag,
        problemUrl: p.url,
        acceptedUrl: slug ? solutionUrls[slug] ?? null : null,
        solved: slug ? solvedSet.has(slug) : false,
      };
    });
    const tracked = trackedActiveMsInWindow(
      currentKeystrokeSessions,
      cards.startMs,
      cards.endMs,
    );
    if (tracked.sessions > 0 && tracked.trackedSessions === 0) {
      // Distinguishes "no sessions this week" from "sessions exist but
      // predate the tracker recording activeMs" — otherwise the missing
      // line looks identical in both cases.
      console.warn(
        `[CS 393 Buddy] week ${cards.week}: ${tracked.sessions} keystroke ` +
          "session(s) found but none record activeMs — recorded before " +
          "per-session timing was added. Re-record to get tracked time.",
      );
    }
    appendCanvasSubmitAffordance(article, studyItem, studyProgress, {
      netID: currentNetID,
      weekNum: cards.week,
    }, {
      extraSubmitData: { problems, trackedMs: tracked.activeMs },
    });
  }

  return article;
}

function extractLeetcodeSlug(url) {
  if (typeof url !== "string") return null;
  const m = url.match(/^https:\/\/leetcode\.com\/problems\/([^/?#]+)/);
  return m ? m[1] : null;
}

function createProblemItem(p, isSolved) {
  const li = document.createElement("li");
  li.className = `problem ${isSolved ? "complete" : "pending"}`;

  const mark = document.createElement("span");
  mark.className = "problem-mark";
  mark.textContent = isSolved ? "✓" : "○";

  const link = document.createElement("a");
  link.className = "problem-link";
  link.href = `https://leetcode.com/problems/${p.slug}/`;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = p.title;

  li.append(mark, link);

  if (p.tag) {
    const tag = document.createElement("span");
    tag.className = `problem-tag`;
    tag.textContent = p.tag;
    li.appendChild(tag);
  }
  return li;
}

// Sends any Canvas submission a TA has already approved.
//
// Performance exams and live interviews used to leave a Submit button on
// the card after a TA passed the student, asking them to re-type things
// the TA already recorded. The TA now captures those at signoff and this
// sends them — the student presses nothing.
//
// It runs from the STUDENT's session because submitCanvasAssignment
// derives the student from the caller's token; a TA pressing Pass would
// submit as themselves. So this happens the next time the student opens
// the dashboard, not the instant Pass is clicked.
//
// Failures are deliberately quiet. The student didn't ask for this and
// can't act on a Canvas error they didn't cause; the card falls back to
// showing a Submit button, which is the old behaviour.
async function runAutoSubmissions() {
  if (!currentNetID || !currentCards) return;
  let submittedAny = false;

  for (const cards of currentCards) {
    const pending = pendingAutoSubmissions(
      cards.performanceItems,
      currentAssignmentProgress,
    );
    for (const submission of pending) {
      try {
        const outcome = await sendCanvasSubmission({
          type: submission.type,
          assignmentId: submission.assignmentId,
          weekNum: cards.week,
          netID: currentNetID,
          data: submission.data,
        });
        if (outcome.ok) {
          submittedAny = true;
          console.log(
            `[CS 393 Buddy] auto-submitted ${submission.assignmentId} to Canvas`,
          );
        } else {
          console.error(
            `[CS 393 Buddy] auto-submit failed for ${submission.assignmentId}:`,
            outcome.result,
          );
        }
      } catch (err) {
        console.error("[CS 393 Buddy] auto-submit threw:", err);
      }
    }
  }

  if (submittedAny) {
    currentAssignmentProgress = await getCachedAssignmentProgress();
    renderWeeks();
  }
}

// Re-reads keystroke session metadata and re-renders.
//
// Sessions are written by a content script in a different tab, so
// nothing in this page's storage changes when one is recorded — the
// bootstrap fetch would otherwise be the only read this page ever does.
async function refreshKeystrokeSessions() {
  if (!currentNetID) return;
  try {
    currentKeystrokeSessions = await fetchCollection(
      `students/${currentNetID}/keystrokeSessions`,
    );
    renderWeeks();
  } catch (err) {
    // Best-effort: a failure just means the tracked-time line falls back
    // to whatever was already loaded.
    console.error("[CS 393 Buddy] failed to refresh keystroke sessions:", err);
  }
}

// Coming back to this tab is the other moment the sessions are likely
// stale — the student went and solved something in another tab.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshKeystrokeSessions();
});

// ---- Bootstrap + storage listener -------------------------------------

async function initWeeks(netID) {
  currentNetID = netID;
  const [
    cards,
    topics,
    signoffStaff,
    { solvedProblems },
    progress,
    assignmentProgress,
    activeOa,
    keystrokeSessions,
  ] = await Promise.all([
    getVisibleWeeks(),
    getTopics(),
    getSignoffStaff(),
    chrome.storage.local.get("solvedProblems"),
    getCachedProgress(),
    getCachedAssignmentProgress(),
    getActive(),
    // Session metadata only — one collection read, no chunk events.
    // Best-effort: a student with no recorded sessions, or a read that
    // fails, just means the study submission omits the tracked-time line.
    fetchCollection(`students/${netID}/keystrokeSessions`).catch((err) => {
      console.error("[CS 393 Buddy] failed to load keystroke sessions:", err);
      return [];
    }),
  ]);
  currentCards = cards;
  currentSolves = solvedProblems ?? null;
  currentProgress = progress;
  currentAssignmentProgress = assignmentProgress;
  currentSignoffStaff = signoffStaff;
  currentActiveOa = activeOa;
  currentKeystrokeSessions = keystrokeSessions;
  // Preload runtime-shape OAs for every topic so the sync third-card
  // dispatcher can render OA cards without an async fetch mid-render.
  const oaEntries = await Promise.all(
    topics.map(async (t) => [t.id, await getOaRuntimeShape(t.id)]),
  );
  currentOaShapes = Object.fromEntries(oaEntries);
  renderWeeks();
  startTimerLoop();
  // After the first paint, so a slow Canvas round-trip never delays the
  // dashboard appearing.
  runAutoSubmissions();

  // Background progress refreshes — storage.onChanged fires re-render
  // when either bundle lands.
  refreshProgress(netID);
  refreshAssignmentProgress(netID);

  // Background student-doc refresh — pulls Firestore, writes to cache,
  // storage.onChanged fires re-render. Preserves solutionUrls (as
  // `solutions` in cache) alongside solves, otherwise this refresh
  // would strip any per-submission URLs the tracker/backstop had
  // populated.
  try {
    const student = await fetchStudent(netID);
    const raw = student?.solvedProblems;
    const solves = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const rawUrls = student?.solutionUrls;
    const solutions = rawUrls && typeof rawUrls === "object" && !Array.isArray(rawUrls) ? rawUrls : {};
    await chrome.storage.local.set({
      solvedProblems: { solves, solutions, syncedAt: Date.now() },
    });
  } catch (error) {
    console.error("Failed to fetch solved problems from Firestore:", error);
  }
}

// One-second tick that surgically updates the active OA timer text and
// auto-ends the attempt when time hits zero.
function startTimerLoop() {
  stopTimerLoop();
  if (!currentActiveOa || currentActiveOa.deadlineMs == null) return;
  timerInterval = setInterval(async () => {
    const session = currentActiveOa;
    if (!session) {
      stopTimerLoop();
      return;
    }
    const remaining = getRemainingMs(session);
    const timerEl = document.querySelector(
      `[data-oa-timer="${session.weekNum}"]`,
    );
    if (timerEl) {
      timerEl.textContent = "⏱ " + formatRemaining(remaining);
    }
    if (remaining !== null && remaining <= 0) {
      stopTimerLoop();
      const attemptSpec = await getAttemptSpecForActiveSession();
      await endActiveAttempt({
        netID: currentNetID,
        existingProgress: currentProgress?.[session.weekNum] ?? null,
        attemptSpec,
        totalAttempts: attemptSpec ? (await getOaAttemptCountForWeek(session.weekNum)) : 0,
        solves: currentSolves?.solves ?? {},
        reason: "timer",
      });
    }
  }, 1000);
}

function stopTimerLoop() {
  if (timerInterval != null) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

// Look up the runtime-shape OA attempt spec for the currently-active OA
// session. Returns null if no session or the week has no OA (shouldn't
// happen if an active session exists, but defensive anyway).
async function getAttemptSpecForActiveSession() {
  const session = currentActiveOa;
  if (!session) return null;
  const oa = await getOaForWeek(session.weekNum);
  return oa?.attempts?.[session.attemptIndex] ?? null;
}

async function getOaAttemptCountForWeek(weekNum) {
  const oa = await getOaForWeek(weekNum);
  return oa?.attempts?.length ?? 0;
}

async function getOaForWeek(weekNum) {
  const cards = await getCardsForWeek(weekNum);
  const oaItem = cards?.performanceItems?.find((i) => i.type === "oa");
  if (!oaItem?.topic) return null;
  return getOaRuntimeShape(oaItem.topic);
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  let needsRender = false;
  if (changes.solvedProblems) {
    currentSolves = changes.solvedProblems.newValue ?? null;
    needsRender = true;
    maybeAutoPass();
    // A solve landing means the student was just on LeetCode, so their
    // keystroke sessions have moved on too. Without this the tracked
    // time in a Weekly Study submission is whatever it was when the
    // dashboard tab was opened — usually before any of the week's work.
    refreshKeystrokeSessions();
  }
  if (changes.weekProgressBundle) {
    currentProgress = changes.weekProgressBundle.newValue?.progress ?? {};
    needsRender = true;
  }
  if (changes[ASSIGNMENT_PROGRESS_CACHE_KEY]) {
    currentAssignmentProgress =
      changes[ASSIGNMENT_PROGRESS_CACHE_KEY].newValue?.progress ?? {};
    needsRender = true;
  }
  if (changes[OA_SESSION_KEY]) {
    currentActiveOa = changes[OA_SESSION_KEY].newValue ?? null;
    startTimerLoop();
    needsRender = true;
  }
  if (needsRender) renderWeeks();
});

// Fires whenever solvedProblems changes. If there's an active OA and
// the fresh solve count meets the pass threshold, auto-end the attempt
// as passed so the student doesn't have to click Submit.
async function maybeAutoPass() {
  const session = currentActiveOa;
  if (!session) return;
  const attemptSpec = await getAttemptSpecForActiveSession();
  if (!attemptSpec) return;
  const solved = solvedInWindow(
    attemptSpec,
    currentSolves?.solves ?? {},
    session.startedAt,
    Date.now(),
  );
  if (!attemptPassed(attemptSpec, solved.length)) return;
  try {
    await endActiveAttempt({
      netID: currentNetID,
      existingProgress: currentProgress?.[session.weekNum] ?? null,
      attemptSpec,
      totalAttempts: await getOaAttemptCountForWeek(session.weekNum),
      solves: currentSolves?.solves ?? {},
      reason: "autopass",
    });
  } catch (error) {
    console.error("[CS 393 Buddy] auto-pass failed:", error);
  }
}

// ---- Profile menu ------------------------------------------------------

function wireProfileMenu() {
  const button = document.getElementById("profile-button");
  const dropdown = document.getElementById("profile-dropdown");
  const signOutBtn = document.getElementById("sign-out-btn");

  function close() {
    dropdown.hidden = true;
    button.setAttribute("aria-expanded", "false");
  }

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    const wasHidden = dropdown.hidden;
    dropdown.hidden = !wasHidden;
    button.setAttribute("aria-expanded", String(wasHidden));
  });

  document.addEventListener("click", (event) => {
    if (!dropdown.hidden && !dropdown.contains(event.target)) close();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !dropdown.hidden) close();
  });

  signOutBtn.addEventListener("click", async () => {
    await chrome.storage.sync.remove("netID");
    window.location.href = chrome.runtime.getURL("onboard.html");
  });
}

function wireFullCourseButton() {
  const btn = document.getElementById("full-course-btn");
  if (!btn) return;
  btn.addEventListener("click", () => {
    window.location.href = chrome.runtime.getURL("course.html");
  });
}

async function wireTaDashboardButton() {
  const btn = document.getElementById("ta-dashboard-btn");
  if (!btn) return;
  const role = await getRole();
  if (role !== "ta") return; // stays hidden
  btn.hidden = false;
  btn.addEventListener("click", () => {
    window.location.href = chrome.runtime.getURL("ta-dashboard.html");
  });
}

// ---- Bootstrap ---------------------------------------------------------

(async () => {
  const netID = await getNetID();
  if (!netID) {
    window.location.href = chrome.runtime.getURL("onboard.html");
    return;
  }
  loadAndRender(netID);
  wireProfileMenu();
  wireFullCourseButton();
  wireTaDashboardButton();
  initWeeks(netID);
})();
