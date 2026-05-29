import { fetchStudent } from "./firestore.js";

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

function renderRecommendedProgress(data) {
  const list = document.getElementById("recommended-list");
  const fill = document.getElementById("recommended-fill");
  const text = document.getElementById("recommended-text");
  const bar = document.getElementById("recommended-bar");
  const meta = document.getElementById("recommended-meta");

  if (!data?.problems?.length) {
    list.innerHTML = '<li class="problem-empty">Visit a leetcode.com page to sync progress.</li>';
    fill.style.width = "0%";
    fill.className = "progress-fill";
    text.textContent = "— / 7";
    meta.textContent = "";
    return;
  }

  const problems = data.problems;
  const solved = problems.filter((p) => p.status === "ac").length;
  const total = problems.length;
  const pct = Math.round((solved / total) * 100);

  text.textContent = `${solved} / ${total}`;
  fill.style.width = `${pct}%`;
  fill.className = solved === total ? "progress-fill complete" : "progress-fill";
  bar.setAttribute("aria-valuenow", String(solved));
  bar.setAttribute("aria-valuemax", String(total));

  list.innerHTML = "";
  for (const p of problems) {
    const li = document.createElement("li");
    li.className = `problem ${p.status === "ac" ? "complete" : "pending"}`;

    const mark = document.createElement("span");
    mark.className = "problem-mark";
    mark.textContent = p.status === "ac" ? "✓" : "○";

    const link = document.createElement("a");
    link.className = "problem-link";
    link.href = `https://leetcode.com/problems/${p.titleSlug}/`;
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

  meta.textContent = data.syncedAt ? `Synced ${formatRelativeTime(data.syncedAt)}` : "";
}

async function initRecommendedProgress() {
  const { recommendedProgress } = await chrome.storage.local.get("recommendedProgress");
  renderRecommendedProgress(recommendedProgress);
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.recommendedProgress) {
    renderRecommendedProgress(changes.recommendedProgress.newValue);
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
  initRecommendedProgress();
})();
