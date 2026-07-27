import {
  getCurrentWeekCards,
  solvedSlugsInWeek,
  flattenPlacementsToProblems,
  firstUnsolvedProblem,
} from "./course-data.js";

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
let currentCards = null;
let currentSolves = null;

function render() {
  if (!currentCards) {
    weekLabel.textContent = "No active week";
    text.textContent = "— / —";
    fill.style.width = "0%";
    fill.className = "progress-fill";
    detail.textContent = "No week scheduled right now.";
    nextBtn.hidden = true;
    return;
  }

  weekLabel.textContent = `Week ${currentCards.week} · ${currentCards.dates ?? ""}`;

  const problems = flattenPlacementsToProblems(currentCards.placements);
  const total = problems.length;
  const solvedSet = solvedSlugsInWeek(currentCards, currentSolves);
  const solved = problems.filter((p) => solvedSet.has(p.slug)).length;
  const pct = total === 0 ? 0 : Math.round((solved / total) * 100);

  text.textContent = `${solved} / ${total}`;
  fill.style.width = `${pct}%`;
  fill.className = total > 0 && solved === total ? "progress-fill complete" : "progress-fill";
  bar.setAttribute("aria-valuenow", String(solved));
  bar.setAttribute("aria-valuemax", String(total));

  const next = firstUnsolvedProblem(currentCards, currentSolves);
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
  const [cards, { solvedProblems }] = await Promise.all([
    getCurrentWeekCards(),
    chrome.storage.local.get("solvedProblems"),
  ]);
  currentCards = cards;
  currentSolves = solvedProblems ?? null;
  render();
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes.solvedProblems) {
    currentSolves = changes.solvedProblems.newValue ?? null;
    render();
  }
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
