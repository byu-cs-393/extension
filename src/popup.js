import {
  getRecommendedProblems,
  refreshRecommendedProblems,
  solvedSlugsThisWeek,
  firstUnsolved,
  getCurrentWeekStart,
  getCurrentWeekEnd,
} from "./recommended.js";

const SHORT_DATE = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });

const weekLabel = document.getElementById("popup-week-label");
const bar = document.getElementById("popup-progress-bar");
const fill = document.getElementById("popup-progress-fill");
const text = document.getElementById("popup-progress-text");
const detail = document.getElementById("popup-detail");
const nextBtn = document.getElementById("popup-next-btn");
const openDashboardBtn = document.getElementById("open-dashboard");

// Module-scoped state — render() reads from these.
let currentCatalog = [];
let currentSolves = null;

function renderWeekLabel() {
  const start = new Date(getCurrentWeekStart());
  const end = new Date(getCurrentWeekEnd() - 1);
  weekLabel.textContent = `This week · ${SHORT_DATE.format(start)} – ${SHORT_DATE.format(end)}`;
}

function render() {
  const total = currentCatalog.length;
  const solvedSet = solvedSlugsThisWeek(currentSolves);
  const solved = currentCatalog.filter((p) => solvedSet.has(p.slug)).length;
  const pct = total === 0 ? 0 : Math.round((solved / total) * 100);

  text.textContent = `${solved} / ${total || 7}`;
  fill.style.width = `${pct}%`;
  fill.className = total > 0 && solved === total ? "progress-fill complete" : "progress-fill";
  bar.setAttribute("aria-valuenow", String(solved));
  bar.setAttribute("aria-valuemax", String(total || 7));

  if (total === 0) {
    detail.textContent = "Loading recommended problems…";
    nextBtn.hidden = true;
    return;
  }

  const next = firstUnsolved(currentSolves, currentCatalog);
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

async function init() {
  renderWeekLabel();
  currentCatalog = await getRecommendedProblems();
  const { solvedProblems } = await chrome.storage.local.get("solvedProblems");
  currentSolves = solvedProblems ?? null;
  render();
  refreshRecommendedProblems();
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

init();
