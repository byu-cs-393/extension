import { fetchStudent } from "./firestore.js";
import {
  getWeeks,
  refreshWeeks,
  classifyWeek,
  solvedSlugsInWeek,
} from "./recommended.js";
import {
  createThirdCardSection,
  getCachedProgress,
  refreshProgress,
} from "./third-card.js";
import {
  getActive,
  getRemainingMs,
  formatRemaining,
  endActiveAttempt,
  solvedInWindow,
  attemptPassed,
  OA_SESSION_KEY,
} from "./oa-session.js";

// Module-scoped state — render() reads from these. Two paths update
// them: chrome.storage.onChanged (live), or the bootstrap (initial).
let currentWeeks = [];
let currentSolves = null;
let currentProgress = {}; // { [weekNum]: progressDoc }
let currentActiveOa = null; // active OA session, or null
let currentNetID = null;
let timerInterval = null;

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
const SHORT_DATE = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });

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

function formatDateRange(startMs, endMs) {
  const start = new Date(startMs);
  const end = new Date(endMs - 1); // inclusive Sunday
  const startStr = SHORT_DATE.format(start);
  if (start.getMonth() === end.getMonth()) {
    return `${startStr} – ${end.getDate()}`;
  }
  return `${startStr} – ${SHORT_DATE.format(end)}`;
}

function renderWeeks() {
  const container = document.getElementById("weeks-container");
  container.innerHTML = "";

  // Visible weeks: current + past. Future weeks hidden until they start.
  const now = Date.now();
  const visible = currentWeeks
    .filter((w) => w.startDate <= now)
    .sort((a, b) => b.weekNum - a.weekNum); // newest first

  if (visible.length === 0) {
    const empty = document.createElement("p");
    empty.className = "weeks-empty";
    empty.textContent = "No weeks yet. Visit leetcode.com to seed the schedule.";
    container.appendChild(empty);
    return;
  }

  for (const week of visible) {
    container.appendChild(createWeekSection(week, classifyWeek(week, now)));
  }
}

function createWeekSection(week, status) {
  const section = document.createElement("section");
  section.className = "week";
  section.dataset.weekNum = String(week.weekNum);

  // Header
  const header = document.createElement("div");
  header.className = "week-header";

  const title = document.createElement("h2");
  title.className = "week-title";
  title.append(`Week ${week.weekNum}`);
  if (status === "current") {
    const badge = document.createElement("span");
    badge.className = "week-badge";
    badge.textContent = "Current";
    title.appendChild(badge);
  }

  const dates = document.createElement("div");
  dates.className = "week-dates";
  dates.textContent = formatDateRange(week.startDate, week.endDate);

  header.append(title, dates);
  section.appendChild(header);

  section.appendChild(createRecommendedCard(week, status));
  const thirdCardEl = createThirdCardSection(
    week.thirdCard,
    currentProgress?.[week.weekNum] ?? null,
    status,
    {
      weekNum: week.weekNum,
      netID: currentNetID,
      activeSession: currentActiveOa,
      solves: currentSolves?.solves ?? {},
    }
  );
  if (thirdCardEl) section.appendChild(thirdCardEl);
  return section;
}

function createRecommendedCard(week, status) {
  const solvedSet = solvedSlugsInWeek(week, currentSolves);
  const total = week.problems.length;
  const solved = week.problems.filter((p) => solvedSet.has(p.slug)).length;
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
    for (const p of week.problems) {
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
    const ended = SHORT_DATE.format(new Date(week.endDate - 1));
    meta.textContent = `Week ended ${ended} — no more credit.`;
  }
  article.appendChild(meta);

  return article;
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

  if (p.difficulty) {
    const diff = document.createElement("span");
    diff.className = `problem-diff diff-${p.difficulty.toLowerCase()}`;
    diff.textContent = p.difficulty;
    li.appendChild(diff);
  }
  return li;
}

// ---- Bootstrap + storage listener -------------------------------------

async function initWeeks(netID) {
  currentNetID = netID;
  currentWeeks = await getWeeks();
  const { solvedProblems } = await chrome.storage.local.get("solvedProblems");
  currentSolves = solvedProblems ?? null;
  currentProgress = await getCachedProgress();
  currentActiveOa = await getActive();
  renderWeeks();
  startTimerLoop();

  // Background weeks refresh — pulls Firestore, auto-seeds if empty.
  refreshWeeks();

  // Background third-card progress refresh — storage.onChanged fires
  // re-render when the bundle lands.
  refreshProgress(netID);

  // Background student-doc refresh — pulls Firestore, writes to cache,
  // storage.onChanged fires re-render.
  try {
    const student = await fetchStudent(netID);
    const raw = student?.solvedProblems;
    const solves = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    await chrome.storage.local.set({
      solvedProblems: { solves, syncedAt: Date.now() },
    });
  } catch (error) {
    console.error("Failed to fetch solved problems from Firestore:", error);
  }
}

// One-second tick that surgically updates the active OA timer text and
// auto-ends the attempt when time hits zero. Only runs while there's a
// TIMED active session (attempt 1); untimed attempts (attempts 2 and 3,
// open-window model) don't need a tick — the card just shows "in
// progress" and waits for the student to click Submit.
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
      `[data-oa-timer="${session.weekNum}"]`
    );
    if (timerEl) {
      timerEl.textContent = "⏱ " + formatRemaining(remaining);
    }
    if (remaining !== null && remaining <= 0) {
      stopTimerLoop();
      const week = currentWeeks.find((w) => w.weekNum === session.weekNum);
      const oa = week?.thirdCard;
      await endActiveAttempt({
        netID: currentNetID,
        existingProgress: currentProgress?.[session.weekNum] ?? null,
        attemptSpec: oa?.attempts?.[session.attemptIndex] ?? null,
        totalAttempts: oa?.attempts?.length ?? 0,
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

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  let needsRender = false;
  if (changes.solvedProblems) {
    currentSolves = changes.solvedProblems.newValue ?? null;
    needsRender = true;
    maybeAutoPass();
  }
  if (changes.weeksCatalog) {
    const next = changes.weeksCatalog.newValue?.weeks;
    if (Array.isArray(next)) {
      currentWeeks = next;
      needsRender = true;
    }
  }
  if (changes.weekProgressBundle) {
    currentProgress = changes.weekProgressBundle.newValue?.progress ?? {};
    needsRender = true;
  }
  if (changes[OA_SESSION_KEY]) {
    currentActiveOa = changes[OA_SESSION_KEY].newValue ?? null;
    // endActiveAttempt updates the local progress cache before clearing
    // the session, so there's no need to re-fetch here — the
    // weekProgressBundle change will land alongside this one.
    startTimerLoop();
    needsRender = true;
  }
  if (needsRender) renderWeeks();
});

// Fires whenever solvedProblems changes. If there's an active OA and
// the fresh solve count meets the pass threshold, auto-end the attempt
// as passed so the student doesn't have to click Submit. endActiveAttempt
// re-evaluates against a fresh Firestore fetch on its own, so the local
// evaluation here is just the "should we even try" gate.
async function maybeAutoPass() {
  const session = currentActiveOa;
  if (!session) return;
  const week = currentWeeks.find((w) => w.weekNum === session.weekNum);
  const attempt = week?.thirdCard?.attempts?.[session.attemptIndex];
  if (!attempt) return;
  const solved = solvedInWindow(
    attempt,
    currentSolves?.solves ?? {},
    session.startedAt,
    Date.now()
  );
  if (!attemptPassed(attempt, solved.length)) return;
  try {
    await endActiveAttempt({
      netID: currentNetID,
      existingProgress: currentProgress?.[session.weekNum] ?? null,
      attemptSpec: attempt,
      totalAttempts: week.thirdCard.attempts.length,
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
  initWeeks(netID);
})();
