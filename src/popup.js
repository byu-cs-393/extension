import {
  RECOMMENDED_PROBLEMS,
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

function renderWeekLabel() {
  const start = new Date(getCurrentWeekStart());
  const end = new Date(getCurrentWeekEnd() - 1);
  weekLabel.textContent = `This week · ${SHORT_DATE.format(start)} – ${SHORT_DATE.format(end)}`;
}

function renderProgress(cached) {
  const total = RECOMMENDED_PROBLEMS.length;
  const solvedSet = solvedSlugsThisWeek(cached);
  const solved = RECOMMENDED_PROBLEMS.filter((p) => solvedSet.has(p.slug)).length;
  const pct = Math.round((solved / total) * 100);

  text.textContent = `${solved} / ${total}`;
  fill.style.width = `${pct}%`;
  fill.className = solved === total ? "progress-fill complete" : "progress-fill";
  bar.setAttribute("aria-valuenow", String(solved));
  bar.setAttribute("aria-valuemax", String(total));

  const next = firstUnsolved(cached);
  if (next) {
    detail.textContent = `Currently on: ${next.title}`;
    nextBtn.hidden = false;
    nextBtn.dataset.slug = next.slug;
  } else if (solved === total) {
    detail.textContent = "✓ All recommended problems solved this week.";
    nextBtn.hidden = true;
    delete nextBtn.dataset.slug;
  } else {
    // No solves yet, or empty cache.
    detail.textContent = "Visit leetcode.com to sync progress.";
    nextBtn.hidden = false;
    nextBtn.dataset.slug = RECOMMENDED_PROBLEMS[0].slug;
  }
}

async function init() {
  renderWeekLabel();
  const { solvedProblems } = await chrome.storage.local.get("solvedProblems");
  renderProgress(solvedProblems);
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.solvedProblems) {
    renderProgress(changes.solvedProblems.newValue);
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

init();
