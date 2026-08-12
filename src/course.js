// Full-course view: same weekly scroll as the dashboard, but shows
// every week in the semester — past, current, AND future. Future
// weeks render as read-only faded cards with a "Released MMM D"
// badge; students can see what's coming but can't start early.
//
// Reuses dashboard.css for styling. Interactive OA / performance-exam
// cards only render for current/past weeks; future weeks show a
// placeholder that hints at the coming assignments.
import { fetchStudent } from "./firestore.js";
import {
  getAllScheduleCards,
  classifyWeek,
  solvedSlugsInWeek,
  flattenPlacementsToProblems,
  getOaRuntimeShape,
  getAssignments,
  getTopics,
} from "./course-data.js";
import {
  createThirdCardSection,
  getCachedProgress,
  refreshProgress,
} from "./third-card.js";
import {
  getCachedAssignmentProgress,
  refreshAssignmentProgress,
  ASSIGNMENT_PROGRESS_CACHE_KEY,
} from "./assignment-progress.js";
import { getActive, OA_SESSION_KEY } from "./oa-session.js";
import { renderExtraCreditSection } from "./extra-credit-view.js";

// Module-scoped state — render() reads from these.
let currentCards = [];
let currentSolves = null;
let currentProgress = {};
let currentActiveOa = null;
let currentNetID = null;
let currentOaShapes = {};
let currentAssignmentProgress = {};
// The full assignments[] list from course.json — extra credit lives
// there and nowhere in schedule[], so it can't be reached via the week
// cards like every other card type.
let currentAssignments = [];

const SHORT_DATE = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });

async function getNetID() {
  const { netID } = await chrome.storage.sync.get("netID");
  return netID || null;
}

// ---- Rendering ---------------------------------------------------------

function renderWeeks() {
  const container = document.getElementById("weeks-container");
  container.innerHTML = "";

  if (currentCards.length === 0) {
    const empty = document.createElement("p");
    empty.className = "weeks-empty";
    empty.textContent = "No weeks in the course.";
    container.appendChild(empty);
  } else {
    // Newest-first so the current week sits near the top (matches dashboard).
    const now = Date.now();
    const sorted = [...currentCards].sort((a, b) => b.week - a.week);
    for (const cards of sorted) {
      container.appendChild(createWeekSection(cards, classifyWeek(cards, now)));
    }
  }

  // Extra credit last — it belongs to no week, and it's optional, so it
  // shouldn't sit above the work that isn't.
  renderExtraCreditSection(container, {
    assignments: currentAssignments,
    assignmentProgress: currentAssignmentProgress,
    netID: currentNetID,
  });
}

function createWeekSection(cards, status) {
  const section = document.createElement("section");
  section.className = "week";
  if (status === "future") section.classList.add("future");
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
  } else if (status === "future" && cards.startMs != null) {
    const badge = document.createElement("span");
    badge.className = "week-badge locked";
    badge.textContent = `🔒 Released ${SHORT_DATE.format(new Date(cards.startMs))}`;
    title.appendChild(badge);
  }

  const dates = document.createElement("div");
  dates.className = "week-dates";
  dates.textContent = cards.dates ?? "";

  header.append(title, dates);
  section.appendChild(header);

  if (status === "future") {
    // Future weeks: read-only preview. No problem list (no peeking),
    // no interactive third cards. Just a placeholder card + a summary
    // of the assessments coming.
    section.appendChild(createFuturePlaceholder(cards));
    return section;
  }

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
      },
    );
    if (cardEl) section.appendChild(cardEl);
  }
  return section;
}

function createFuturePlaceholder(cards) {
  const article = document.createElement("article");
  article.className = "card future-placeholder";

  const title = document.createElement("div");
  title.className = "card-title";
  title.textContent = "Recommended problems";
  article.appendChild(title);

  const total = flattenPlacementsToProblems(cards.placements).length;
  const startText = cards.startMs != null
    ? SHORT_DATE.format(new Date(cards.startMs))
    : "later";
  const meta = document.createElement("div");
  meta.className = "card-meta";
  meta.textContent =
    total > 0
      ? `${total} problems will unlock ${startText}.`
      : `Will unlock ${startText}.`;
  article.appendChild(meta);

  for (const item of cards.performanceItems ?? []) {
    const line = document.createElement("div");
    line.className = "card-detail";
    line.textContent = "+ " + performanceItemLabel(item);
    article.appendChild(line);
  }
  return article;
}

function performanceItemLabel(item) {
  if (item.title) return item.title;
  switch (item.type) {
    case "oa":
      return `Online Assessment · ${item.topic ?? ""}`.trim();
    case "performance":
      return `Performance Exam · ${item.topic ?? ""}`.trim();
    case "peer-mock":
      return "Peer Mock Interview";
    case "live-interview":
      return item.index ? `Live Interview ${item.index}` : "Live Interview";
    case "professional-mock":
      return "Professional Mock Interview";
    case "final":
      return item.phase ? `Final Exam (${item.phase})` : "Final Exam";
    default:
      return item.type ?? "";
  }
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
    for (const p of problems) {
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
  if (p.tag) {
    const tag = document.createElement("span");
    tag.className = "problem-tag";
    tag.textContent = p.tag;
    li.appendChild(tag);
  }
  return li;
}

// ---- Bootstrap + storage listener --------------------------------------

async function init(netID) {
  currentNetID = netID;
  const [cards, topics, { solvedProblems }, progress, assignmentProgress, activeOa, assignments] =
    await Promise.all([
      getAllScheduleCards(),
      getTopics(),
      chrome.storage.local.get("solvedProblems"),
      getCachedProgress(),
      getCachedAssignmentProgress(),
      getActive(),
      getAssignments(),
    ]);
  currentCards = cards;
  currentAssignments = assignments;
  currentSolves = solvedProblems ?? null;
  currentProgress = progress;
  currentAssignmentProgress = assignmentProgress;
  currentActiveOa = activeOa;
  const oaEntries = await Promise.all(
    topics.map(async (t) => [t.id, await getOaRuntimeShape(t.id)]),
  );
  currentOaShapes = Object.fromEntries(oaEntries);
  renderWeeks();

  refreshProgress(netID);
  refreshAssignmentProgress(netID);
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

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  let needsRender = false;
  if (changes.solvedProblems) {
    currentSolves = changes.solvedProblems.newValue ?? null;
    needsRender = true;
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
