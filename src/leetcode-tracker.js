// Content script: detects when the student opens a LeetCode problem and
// logs an open_problem event to Firestore's top-level activity collection.
//
// We can't use ES module imports in a MV3 content script, so the public
// Firebase config is inlined here. Safe to commit — access is gated by
// Firestore security rules, not the API key.
const firebaseConfig = {
  apiKey: "AIzaSyC2RxnVrQii0rT-Tm3JZmURmHzico-VqDg",
  projectId: "cs393-496021",
};

const FIRESTORE_BASE =
  `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}` +
  `/databases/(default)/documents`;

// Filled in from chrome.storage.sync at bootstrap. If onboarding hasn't
// happened yet, we silently no-op rather than logging unattributed events.
let netID = null;

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

async function logOpenProblem(slug) {
  const url = `${FIRESTORE_BASE}/activity?key=${firebaseConfig.apiKey}`;
  const body = {
    fields: {
      studentNetID: { stringValue: netID },
      eventType: { stringValue: "open_problem" },
      source: { stringValue: "leetcode" },
      problemSlug: { stringValue: slug },
      problemTitle: { stringValue: slugToTitle(slug) },
      timestamp: { timestampValue: new Date().toISOString() },
    },
  };
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Firestore POST ${response.status}: ${errorBody}`);
  }
  return response.json();
}

// LeetCode is a SPA — URL changes without a full page load. Debounce by
// tracking the last slug we logged so we don't fire twice for the same
// problem on description/submissions tab switches.
let lastLoggedSlug = null;

async function maybeLogCurrent() {
  const slug = parseProblemSlug(location.href);
  if (!slug || slug === lastLoggedSlug) return;
  lastLoggedSlug = slug;
  try {
    await logOpenProblem(slug);
    console.log(`[CS 393 Buddy] logged open_problem: ${slug}`);
  } catch (error) {
    console.error("[CS 393 Buddy] failed to log open_problem:", error);
  }
}

// Fire on initial load and any client-side navigation. LeetCode uses
// history.pushState, which doesn't emit popstate — patch it so we get
// notified.
const origPushState = history.pushState;
history.pushState = function (...args) {
  origPushState.apply(this, args);
  window.dispatchEvent(new Event("locationchange"));
};
window.addEventListener("popstate", maybeLogCurrent);
window.addEventListener("locationchange", maybeLogCurrent);

(async () => {
  const { netID: stored } = await chrome.storage.sync.get("netID");
  if (!stored) {
    console.log("[CS 393 Buddy] no netID set — skipping. Run onboarding first.");
    return;
  }
  netID = stored;
  maybeLogCurrent();
})();
