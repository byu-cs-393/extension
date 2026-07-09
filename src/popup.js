import {
  getWeeks,
  refreshWeeks,
  getCurrentWeek,
  solvedSlugsInWeek,
  firstUnsolved,
} from "./recommended.js";

const SHORT_DATE = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });

// Both panels + the sync pill and footer — the popup toggles between
// the pre-onboarding welcome and the normal current-week view based on
// whether a netID is on file.
const welcomePanel = document.getElementById("popup-welcome");
const onboardedPanel = document.getElementById("popup-onboarded");
const syncStatus = document.getElementById("popup-sync-status");
const footer = document.getElementById("popup-footer");
const continueSetupBtn = document.getElementById("continue-setup-btn");

const weekLabel = document.getElementById("popup-week-label");
const bar = document.getElementById("popup-progress-bar");
const fill = document.getElementById("popup-progress-fill");
const text = document.getElementById("popup-progress-text");
const detail = document.getElementById("popup-detail");
const nextBtn = document.getElementById("popup-next-btn");
const openDashboardBtn = document.getElementById("open-dashboard");

// Module-scoped state — render() reads from these.
let currentWeeks = [];
let currentSolves = null;

function formatDateRange(startMs, endMs) {
  const start = new Date(startMs);
  const end = new Date(endMs - 1);
  const startStr = SHORT_DATE.format(start);
  if (start.getMonth() === end.getMonth()) {
    return `${startStr} – ${end.getDate()}`;
  }
  return `${startStr} – ${SHORT_DATE.format(end)}`;
}

function render() {
  const week = getCurrentWeek(currentWeeks);

  if (!week) {
    weekLabel.textContent = "No active week";
    text.textContent = "— / —";
    fill.style.width = "0%";
    fill.className = "progress-fill";
    detail.textContent = currentWeeks.length === 0
      ? "Loading recommended problems…"
      : "No week scheduled right now.";
    nextBtn.hidden = true;
    return;
  }

  weekLabel.textContent = `Week ${week.weekNum} · ${formatDateRange(week.startDate, week.endDate)}`;

  const total = week.problems.length;
  const solvedSet = solvedSlugsInWeek(week, currentSolves);
  const solved = week.problems.filter((p) => solvedSet.has(p.slug)).length;
  const pct = total === 0 ? 0 : Math.round((solved / total) * 100);

  text.textContent = `${solved} / ${total}`;
  fill.style.width = `${pct}%`;
  fill.className = total > 0 && solved === total ? "progress-fill complete" : "progress-fill";
  bar.setAttribute("aria-valuenow", String(solved));
  bar.setAttribute("aria-valuemax", String(total));

  const next = firstUnsolved(week, currentSolves);
  if (next) {
    detail.textContent = `Currently on: ${next.title}`;
    nextBtn.hidden = false;
    nextBtn.dataset.slug = next.slug;
  } else {
    detail.textContent = "✓ All recommended problems solved this week.";
    nextBtn.hidden = true;
    delete nextBtn.dataset.slug;
  }
}

// Show either the welcome panel (no netID on file) or the current-week
// view (onboarded). The sync pill + footer only make sense once
// onboarding is done, so they piggyback on this decision.
function showWelcome() {
  welcomePanel.hidden = false;
  onboardedPanel.hidden = true;
  syncStatus.hidden = true;
  footer.hidden = true;
}

function showOnboarded() {
  welcomePanel.hidden = true;
  onboardedPanel.hidden = false;
  syncStatus.hidden = false;
  footer.hidden = false;
}

async function init() {
  const { netID } = await chrome.storage.sync.get("netID");
  if (!netID) {
    showWelcome();
    return;
  }
  showOnboarded();
  currentWeeks = await getWeeks();
  const { solvedProblems } = await chrome.storage.local.get("solvedProblems");
  currentSolves = solvedProblems ?? null;
  render();
  refreshWeeks();
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
  if (needsRender) render();
});

nextBtn.addEventListener("click", () => {
  const slug = nextBtn.dataset.slug;
  if (!slug) return;
  chrome.tabs.create({ url: `https://leetcode.com/problems/${slug}/` });
  window.close();
});

openDashboardBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
  window.close();
});

continueSetupBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("onboard.html") });
  window.close();
});

init();
