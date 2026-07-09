// Full-course view: same weekly scroll as the dashboard, but shows
// every week in the semester — past, current, AND future. Future
// weeks render as read-only faded cards with a "Released MMM D"
// badge; students can see what's coming but can't start early.
//
// Reuses dashboard.css for styling. Interactive OA/topic-exam cards
// only render for current/past weeks; future weeks show a placeholder.
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
import { getActive, OA_SESSION_KEY } from "./oa-session.js";

// Module-scoped state — render() reads from these.
let currentWeeks = [];
let currentSolves = null;
let currentProgress = {};
let currentActiveOa = null;
let currentNetID = null;

const SHORT_DATE = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });

async function getNetID() {
  const { netID } = await chrome.storage.sync.get("netID");
  return netID || null;
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

// ---- Rendering ---------------------------------------------------------

function renderWeeks() {
  const container = document.getElementById("weeks-container");
  container.innerHTML = "";

  if (currentWeeks.length === 0) {
    const empty = document.createElement("p");
    empty.className = "weeks-empty";
    empty.textContent = "No weeks yet. Visit leetcode.com to seed the schedule.";
    container.appendChild(empty);
    return;
  }

  // Full course view: sort newest-first (matches dashboard) so students
  // see the current week near the top.
  const now = Date.now();
  const sorted = [...currentWeeks].sort((a, b) => b.weekNum - a.weekNum);
  for (const week of sorted) {
    container.appendChild(createWeekSection(week, classifyWeek(week, now)));
  }
}

function createWeekSection(week, status) {
  const section = document.createElement("section");
  section.className = "week";
  if (status === "future") section.classList.add("future");
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
  } else if (status === "future") {
    const badge = document.createElement("span");
    badge.className = "week-badge locked";
    badge.textContent = `🔒 Released ${SHORT_DATE.format(new Date(week.startDate))}`;
    title.appendChild(badge);
  }

  const dates = document.createElement("div");
  dates.className = "week-dates";
  dates.textContent = formatDateRange(week.startDate, week.endDate);

  header.append(title, dates);
  section.appendChild(header);

  if (status === "future") {
    // Future weeks: read-only preview. No problem list (no peeking),
    // no interactive third card. Just a placeholder card that hints
    // at what's coming.
    section.appendChild(createFuturePlaceholder(week));
    return section;
  }

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

function createFuturePlaceholder(week) {
  const article = document.createElement("article");
  article.className = "card future-placeholder";

  const title = document.createElement("div");
  title.className = "card-title";
  title.textContent = "Recommended problems";
  article.appendChild(title);

  const total = week.problems?.length ?? 0;
  const meta = document.createElement("div");
  meta.className = "card-meta";
  meta.textContent =
    total > 0
      ? `${total} problems will unlock ${SHORT_DATE.format(new Date(week.startDate))}.`
      : `Will unlock ${SHORT_DATE.format(new Date(week.startDate))}.`;
  article.appendChild(meta);

  if (week.thirdCard?.type) {
    const kind = document.createElement("div");
    kind.className = "card-detail";
    kind.textContent = thirdCardLabel(week.thirdCard);
    article.appendChild(kind);
  }
  return article;
}

function thirdCardLabel(thirdCard) {
  switch (thirdCard.type) {
    case "topicExam":
      return `+ Topic Exam · ${thirdCard.topic ?? ""}`.trim();
    case "onlineAssessment":
      return `+ Online Assessment · ${thirdCard.topic ?? ""}`.trim();
    case "mockInterview":
      return "+ Mock Interview";
    default:
      return "";
  }
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
  if (isComplete) fill.className = "progress-fill complete";
  else if (status === "past") fill.className = "progress-fill incomplete";
  else fill.className = "progress-fill";
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

// ---- Bootstrap + storage listener --------------------------------------

async function init(netID) {
  currentNetID = netID;
  currentWeeks = await getWeeks();
  const { solvedProblems } = await chrome.storage.local.get("solvedProblems");
  currentSolves = solvedProblems ?? null;
  currentProgress = await getCachedProgress();
  currentActiveOa = await getActive();
  renderWeeks();

  // Background refresh
  refreshWeeks();
  refreshProgress(netID);
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

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  let needsRender = false;
  if (changes.solvedProblems) {
    currentSolves = changes.solvedProblems.newValue ?? null;
    needsRender = true;
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
    needsRender = true;
  }
  if (needsRender) renderWeeks();
});

// ---- Header buttons ----------------------------------------------------

document.getElementById("back-to-dashboard-btn").addEventListener("click", () => {
  window.location.href = chrome.runtime.getURL("dashboard.html");
});

// ---- Bootstrap ---------------------------------------------------------

(async () => {
  const netID = await getNetID();
  if (!netID) {
    window.location.href = chrome.runtime.getURL("onboard.html");
    return;
  }
  init(netID);
})();
