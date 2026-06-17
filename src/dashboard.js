import { fetchStudent } from "./firestore.js";
import {
  getRecommendedProblems,
  refreshRecommendedProblems,
  getCurrentWeekStart,
  getCurrentWeekEnd,
  solvedSlugsThisWeek,
} from "./recommended.js";

// Module-scoped state — render() reads from these. Two paths update
// them: chrome.storage.onChanged (live), or the bootstrap (initial).
let currentCatalog = [];
let currentSolves = null;

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

// ---- Recommended-problem card ------------------------------------------

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

const SHORT_DATE = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });

function renderWeekHeader() {
  const dates = document.getElementById("week-dates");
  if (!dates) return;
  const start = new Date(getCurrentWeekStart());
  const end = new Date(getCurrentWeekEnd() - 1); // inclusive Sunday
  dates.textContent = `${SHORT_DATE.format(start)} – ${SHORT_DATE.format(end)}`;
}

function renderRecommendedProgress() {
  const list = document.getElementById("recommended-list");
  const fill = document.getElementById("recommended-fill");
  const text = document.getElementById("recommended-text");
  const bar = document.getElementById("recommended-bar");
  const meta = document.getElementById("recommended-meta");
  const details = document.getElementById("recommended-details");

  // Only solves whose timestamp falls inside this week's window count
  // for this week's recommended set.
  const solvedSet = solvedSlugsThisWeek(currentSolves);

  const total = currentCatalog.length;
  const solved = currentCatalog.filter((p) => solvedSet.has(p.slug)).length;
  const pct = total === 0 ? 0 : Math.round((solved / total) * 100);

  details.hidden = total === 0;
  text.textContent = `${solved} / ${total}`;
  fill.style.width = `${pct}%`;
  fill.className = total > 0 && solved === total ? "progress-fill complete" : "progress-fill";
  bar.setAttribute("aria-valuenow", String(solved));
  bar.setAttribute("aria-valuemax", String(total));

  list.innerHTML = "";
  for (const p of currentCatalog) {
    const isSolved = solvedSet.has(p.slug);
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

    li.appendChild(mark);
    li.appendChild(link);

    if (p.difficulty) {
      const diff = document.createElement("span");
      diff.className = `problem-diff diff-${p.difficulty.toLowerCase()}`;
      diff.textContent = p.difficulty;
      li.appendChild(diff);
    }
    list.appendChild(li);
  }

  meta.textContent = currentSolves?.syncedAt
    ? `Synced ${formatRelativeTime(currentSolves.syncedAt)}`
    : "Solve a problem on LeetCode to register progress.";
}

// Initial load: warm module state from cache for instant render, then
// kick off background refreshes (catalog from Firestore, student doc
// from Firestore). The onChanged listener picks up whichever lands
// first and re-renders.
async function initRecommendedProgress(netID) {
  currentCatalog = await getRecommendedProblems();
  const { solvedProblems } = await chrome.storage.local.get("solvedProblems");
  currentSolves = solvedProblems ?? null;
  renderRecommendedProgress();

  // Background catalog refresh (writes to cache → onChanged → re-render).
  refreshRecommendedProblems();

  // Background student-doc refresh (writes to cache → onChanged → re-render).
  try {
    const student = await fetchStudent(netID);
    const raw = student?.solvedProblems;
    // New shape: map of slug → timestampMs. Legacy arrays from older
    // schema versions are ignored — the backstop will repopulate from
    // recent ACs.
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
  if (changes.recommendedCatalog) {
    const next = changes.recommendedCatalog.newValue?.problems;
    if (Array.isArray(next)) {
      currentCatalog = next;
      needsRender = true;
    }
  }
  if (needsRender) renderRecommendedProgress();
});

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

// ---- Bootstrap ---------------------------------------------------------

(async () => {
  const netID = await getNetID();
  if (!netID) {
    window.location.href = chrome.runtime.getURL("onboard.html");
    return;
  }
  loadAndRender(netID);
  wireProfileMenu();
  renderWeekHeader();
  initRecommendedProgress(netID);
})();
