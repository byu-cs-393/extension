import { fetchStudent } from "./firestore.js";

// Recommended-problem catalog. Titles + difficulties hardcoded since we
// no longer fetch them from LeetCode — "solved" is now driven by
// student.solvedProblems in Firestore (populated by the LeetCode
// tracker on real submit_pass events).
//
// Difficulties are best-guess; double-check on LeetCode if it matters.
// Eventually this list will come from per-class Firestore config.
const RECOMMENDED_PROBLEMS = [
  { slug: "min-cost-climbing-stairs", title: "Min Cost Climbing Stairs", difficulty: "Easy" },
  { slug: "climbing-stairs", title: "Climbing Stairs", difficulty: "Easy" },
  { slug: "coin-change", title: "Coin Change", difficulty: "Medium" },
  { slug: "coin-change-ii", title: "Coin Change II", difficulty: "Medium" },
  { slug: "range-sum-query-immutable", title: "Range Sum Query - Immutable", difficulty: "Easy" },
  { slug: "range-sum-query-2d-immutable", title: "Range Sum Query 2D - Immutable", difficulty: "Medium" },
  { slug: "sum-of-distances", title: "Sum of Distances", difficulty: "Hard" },
];

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

// Monday 00:00 (local time) of the current week, in epoch ms.
function getCurrentWeekStart() {
  const now = new Date();
  const dow = now.getDay(); // 0 = Sunday, 1 = Monday, ...
  const daysFromMonday = (dow + 6) % 7;
  const monday = new Date(now);
  monday.setDate(now.getDate() - daysFromMonday);
  monday.setHours(0, 0, 0, 0);
  return monday.getTime();
}

function getCurrentWeekEnd() {
  return getCurrentWeekStart() + 7 * 24 * 60 * 60 * 1000;
}

const SHORT_DATE = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });

function renderWeekHeader() {
  const dates = document.getElementById("week-dates");
  if (!dates) return;
  const start = new Date(getCurrentWeekStart());
  const end = new Date(getCurrentWeekEnd() - 1); // inclusive Sunday
  dates.textContent = `${SHORT_DATE.format(start)} – ${SHORT_DATE.format(end)}`;
}

function renderRecommendedProgress(cached) {
  const list = document.getElementById("recommended-list");
  const fill = document.getElementById("recommended-fill");
  const text = document.getElementById("recommended-text");
  const bar = document.getElementById("recommended-bar");
  const meta = document.getElementById("recommended-meta");
  const details = document.getElementById("recommended-details");

  // Only solves whose timestamp falls inside this week's window count
  // for this week's recommended set.
  const weekStart = getCurrentWeekStart();
  const weekEnd = getCurrentWeekEnd();
  const solves = cached?.solves ?? {};
  const solvedSet = new Set(
    Object.entries(solves)
      .filter(([, ts]) => ts >= weekStart && ts < weekEnd)
      .map(([slug]) => slug)
  );

  const total = RECOMMENDED_PROBLEMS.length;
  const solved = RECOMMENDED_PROBLEMS.filter((p) => solvedSet.has(p.slug)).length;
  const pct = Math.round((solved / total) * 100);

  details.hidden = false;
  text.textContent = `${solved} / ${total}`;
  fill.style.width = `${pct}%`;
  fill.className = solved === total ? "progress-fill complete" : "progress-fill";
  bar.setAttribute("aria-valuenow", String(solved));
  bar.setAttribute("aria-valuemax", String(total));

  list.innerHTML = "";
  for (const p of RECOMMENDED_PROBLEMS) {
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

  meta.textContent = cached?.syncedAt
    ? `Synced ${formatRelativeTime(cached.syncedAt)}`
    : "Solve a problem on LeetCode to register progress.";
}

// Two-phase load: render from local cache instantly, then fetch
// authoritative state from Firestore in the background and overwrite
// the cache. The onChanged listener picks up the new value and
// re-renders.
async function initRecommendedProgress(netID) {
  const { solvedProblems } = await chrome.storage.local.get("solvedProblems");
  renderRecommendedProgress(solvedProblems);

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
  if (areaName === "local" && changes.solvedProblems) {
    renderRecommendedProgress(changes.solvedProblems.newValue);
  }
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
