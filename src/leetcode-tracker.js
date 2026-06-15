// Content script: detects LeetCode problem opens AND submission verdicts,
// logs each as an event in the top-level Firestore `activity` collection.
//
// MV3 content scripts can't use ES module imports, so the public Firebase
// config is inlined. Safe to commit — Firestore security rules (not the
// API key) gate access.
const firebaseConfig = {
  apiKey: "AIzaSyC2RxnVrQii0rT-Tm3JZmURmHzico-VqDg",
  projectId: "cs393-496021",
};

const FIRESTORE_BASE =
  `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}` +
  `/databases/(default)/documents`;

// All LeetCode verdicts we recognize. Pass means submit_pass, anything
// else (including compile/runtime errors) means submit_fail.
const VERDICTS = {
  Accepted: "submit_pass",
  "Wrong Answer": "submit_fail",
  "Time Limit Exceeded": "submit_fail",
  "Memory Limit Exceeded": "submit_fail",
  "Output Limit Exceeded": "submit_fail",
  "Runtime Error": "submit_fail",
  "Compile Error": "submit_fail",
};

// LeetCode problem URLs look like:
//   https://leetcode.com/problems/two-sum/
//   https://leetcode.com/problems/two-sum/description/
//   https://leetcode.com/problems/two-sum/submissions/
function parseProblemSlug(url) {
  const match = url.match(/^https:\/\/leetcode\.com\/problems\/([^/?#]+)/);
  return match ? match[1] : null;
}

function slugToTitle(slug) {
  return slug
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

// LeetCode sets document.title to e.g. "Two Sum - LeetCode" on a problem
// page. Strip the suffix and use that as the title; fall back to a
// title-cased slug if it's missing/empty.
function getProblemTitle(slug) {
  const stripped = document.title.replace(/\s*[-–]\s*LeetCode\s*$/i, "").trim();
  return stripped || slugToTitle(slug);
}

function encodeFirestoreFields(obj) {
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string") result[key] = { stringValue: value };
    else if (typeof value === "number") result[key] = { doubleValue: value };
    else if (typeof value === "boolean") result[key] = { booleanValue: value };
    else if (value instanceof Date) result[key] = { timestampValue: value.toISOString() };
    else throw new Error(`Unsupported field type for ${key}: ${typeof value}`);
  }
  return result;
}

async function postActivityEvent(fields) {
  const url = `${FIRESTORE_BASE}/activity?key=${firebaseConfig.apiKey}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fields: encodeFirestoreFields({
        studentNetID: netID,
        source: "leetcode",
        timestamp: new Date(),
        ...fields,
      }),
    }),
  });
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Firestore POST ${response.status}: ${errorBody}`);
  }
  return response.json();
}

// ---- runtime state ------------------------------------------------------

let netID = null;
let lastLoggedSlug = null;       // dedupe open_problem on SPA tab switches
let lastVerdict = null;          // current verdict text visible on the page
let lastVerdictSlug = null;      // which problem the lastVerdict belongs to

async function logOpenProblem(slug) {
  if (!netID || slug === lastLoggedSlug) return;
  lastLoggedSlug = slug;
  try {
    await postActivityEvent({
      eventType: "open_problem",
      problemSlug: slug,
      problemTitle: getProblemTitle(slug),
    });
    console.log(`[CS 393 Buddy] open_problem: ${slug}`);
  } catch (error) {
    console.error("[CS 393 Buddy] failed to log open_problem:", error);
  }
}

async function logVerdict(slug, verdict) {
  if (!netID) return;
  const eventType = VERDICTS[verdict];
  try {
    await postActivityEvent({
      eventType,
      verdict,
      problemSlug: slug,
      problemTitle: getProblemTitle(slug),
    });
    console.log(`[CS 393 Buddy] ${eventType}: ${slug} (${verdict})`);
  } catch (error) {
    console.error("[CS 393 Buddy] failed to log verdict:", error);
  }
  if (eventType === "submit_pass") {
    await markRecommendedSolved(slug);
  }
}

// Optimistic dashboard update: if the just-solved problem is in the
// cached recommended-progress list, flip its status to "ac" locally so
// the dashboard reflects the win immediately, without waiting for the
// next GraphQL resync.
async function markRecommendedSolved(slug) {
  try {
    const { recommendedProgress } = await chrome.storage.local.get("recommendedProgress");
    const problems = recommendedProgress?.problems;
    if (!problems?.some((p) => p.titleSlug === slug && p.status !== "ac")) return;
    const updated = problems.map((p) =>
      p.titleSlug === slug ? { ...p, status: "ac" } : p
    );
    await chrome.storage.local.set({
      recommendedProgress: { ...recommendedProgress, problems: updated, syncedAt: Date.now() },
    });
    console.log(`[CS 393 Buddy] marked ${slug} as solved in recommended list`);
  } catch (error) {
    console.error("[CS 393 Buddy] failed to update recommended progress:", error);
  }
}

// ---- verdict detection --------------------------------------------------

// A real submission result panel always renders companion stats like
// "Runtime: 53 ms" or "Memory: 14.2 MB" near the verdict. Status badges
// for previously-solved problems and filter-dropdown UI ("Filter:
// Accepted") don't. We use this to distinguish a fresh submission
// verdict from incidental "Accepted" text elsewhere on the page.
const RESULT_PANEL_KEYWORDS = /\b(Runtime|Memory|Submission Detail)\b/i;
const ANCESTOR_SEARCH_DEPTH = 6;

// Walk visible spans/divs looking for an element whose trimmed text is
// exactly one of our known verdicts AND whose ancestor chain contains
// submission-result keywords. Returns the verdict string or null.
function findVerdictInDOM() {
  const candidates = document.querySelectorAll("span, div");
  for (const el of candidates) {
    const text = el.textContent?.trim();
    if (!text || !VERDICTS[text]) continue;

    let parent = el.parentElement;
    let depth = 0;
    while (parent && depth < ANCESTOR_SEARCH_DEPTH) {
      if (RESULT_PANEL_KEYWORDS.test(parent.textContent || "")) {
        return text;
      }
      parent = parent.parentElement;
      depth++;
    }
  }
  return null;
}

function checkForVerdict() {
  const slug = parseProblemSlug(location.href);
  if (!slug) return;

  // When the user navigates to a different problem, reset state so the
  // next verdict on the new problem fires cleanly.
  if (slug !== lastVerdictSlug) {
    lastVerdictSlug = slug;
    lastVerdict = null;
  }

  const found = findVerdictInDOM();
  if (found && found !== lastVerdict) {
    lastVerdict = found;
    logVerdict(slug, found);
  } else if (!found) {
    // Verdict cleared (e.g., a new submission is in progress). Reset so
    // the next verdict — even if it's the same string — will fire.
    lastVerdict = null;
  }
}

// MutationObserver fires on every DOM change, which on LeetCode is
// constant. Throttle to once per ~200ms; the verdict only matters when
// it lands, not the exact frame it arrives.
let scheduled = false;
function scheduleVerdictCheck() {
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    checkForVerdict();
  }, 200);
}

// ---- SPA navigation -----------------------------------------------------

// LeetCode uses history.pushState for client-side nav, which doesn't
// emit popstate. Patch pushState to dispatch our own event so we can
// detect problem-to-problem navigation.
const origPushState = history.pushState;
history.pushState = function (...args) {
  origPushState.apply(this, args);
  window.dispatchEvent(new Event("locationchange"));
};

function onLocationChange() {
  const slug = parseProblemSlug(location.href);
  if (slug) logOpenProblem(slug);
}

// ---- bootstrap ----------------------------------------------------------

(async () => {
  const { netID: stored } = await chrome.storage.sync.get("netID");
  if (!stored) {
    console.log("[CS 393 Buddy] no netID set — skipping LeetCode tracking. Run onboarding first.");
    return;
  }
  netID = stored;

  window.addEventListener("popstate", onLocationChange);
  window.addEventListener("locationchange", onLocationChange);
  onLocationChange();

  const observer = new MutationObserver(scheduleVerdictCheck);
  observer.observe(document.body, { childList: true, subtree: true });
})();
