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

// Read the current Firebase Auth ID token from chrome.storage.local.
// Content scripts can't import auth.js (no ES module imports), so we
// just read the cached value. The dashboard/popup keep it fresh via
// auth.js's refresh logic; if it's expired here, Firestore returns
// 401 and the call fails (worst case: a single solve doesn't sync
// until the dashboard refreshes the token next time it loads).
async function getStoredFirebaseIdToken() {
  const { firebaseAuth } = await chrome.storage.local.get("firebaseAuth");
  return firebaseAuth?.idToken ?? null;
}

async function authedHeaders(extra = {}) {
  const idToken = await getStoredFirebaseIdToken();
  const headers = { ...extra };
  if (idToken) headers.Authorization = `Bearer ${idToken}`;
  return headers;
}

async function postActivityEvent(fields) {
  const url = `${FIRESTORE_BASE}/activity?key=${firebaseConfig.apiKey}`;
  const response = await fetch(url, {
    method: "POST",
    headers: await authedHeaders({ "Content-Type": "application/json" }),
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
    await markSolved(slug);
  }
}

// Mark a problem as solved-during-class. Two writes:
//   1. chrome.storage.local — instant cache update so the dashboard's
//      onChanged listener re-renders within a second, no network wait.
//   2. Firestore students/{netID}.solvedProblems — source of truth.
//      Append-if-missing semantics via read-modify-write of the map.
// Cache update first so the user sees the win immediately even if the
// Firestore call is slow or fails.
async function markSolved(slug) {
  const solvedAt = Date.now();
  // Try to capture the per-submission URL synchronously from the
  // current page. If the tab is on /problems/{slug}/submissions/{id}/,
  // we can grab the id right now instead of waiting for the backstop.
  const capturedUrl = submissionUrlFromLocation(slug);
  try {
    const { solvedProblems } = await chrome.storage.local.get("solvedProblems");
    const solves = { ...(solvedProblems?.solves ?? {}) };
    const solutions = { ...(solvedProblems?.solutions ?? {}) };
    // Always overwrite with the new timestamp — a fresh accepted
    // submission for a previously-solved problem still counts for
    // whatever week it lands in.
    solves[slug] = solvedAt;
    if (capturedUrl) solutions[slug] = capturedUrl;
    await chrome.storage.local.set({
      solvedProblems: { solves, solutions, syncedAt: Date.now() },
    });
  } catch (error) {
    console.error("[CS 393 Buddy] failed to update solved cache:", error);
  }

  let firestoreOk = false;
  try {
    const existing = await fetchStudentSolvesAndUrls(netID);
    const updatedSolves = { ...existing.solves, [slug]: solvedAt };
    const updatedUrls = { ...existing.solutionUrls };
    if (capturedUrl) updatedUrls[slug] = capturedUrl;
    await writeSolvedAndUrlsToFirestore(netID, updatedSolves, updatedUrls);
    firestoreOk = true;
    console.log(
      `[CS 393 Buddy] persisted solved: ${slug} @ ${new Date(solvedAt).toISOString()}` +
      (capturedUrl ? ` (url captured)` : ``)
    );
  } catch (error) {
    console.error("[CS 393 Buddy] failed to persist solved to Firestore:", error);
  }

  // Fire-and-forget real-time Canvas grade push. Only runs if the
  // Firestore write above succeeded — otherwise the Cloud Function
  // would read stale data. Any failure gets picked up by the nightly
  // pushCanvasGrades reconciliation, so we don't need to retry here.
  if (firestoreOk) {
    firePushMyRecentGrade(slug);
  }
}

// Per-tab debounce: skip if we already fired for this slug within
// PUSH_DEBOUNCE_MS. Cross-tab races are OK because Canvas grade
// writes are idempotent — worst case we make two calls that write the
// same grade.
const pushDebounce = new Map(); // slug -> lastFireAt (ms)
const PUSH_DEBOUNCE_MS = 30 * 1000;

// We DON'T fetch directly from here. MV3 content scripts run in the
// host page's origin (leetcode.com) and get blocked by CORS when
// hitting our Cloud Function through Firebase Hosting rewrites.
// Instead, forward the request via chrome.runtime.sendMessage to the
// background service worker, which is an extension page and has the
// host_permissions CORS bypass. See background.js's onMessage
// handler for the actual fetch.
function firePushMyRecentGrade(slug) {
  const now = Date.now();
  const lastFire = pushDebounce.get(slug) ?? 0;
  if (now - lastFire < PUSH_DEBOUNCE_MS) {
    console.log(`[CS 393 Buddy] real-time push debounced for ${slug}`);
    return;
  }
  pushDebounce.set(slug, now);

  chrome.runtime.sendMessage(
    { type: "pushMyRecentGrade", slug },
    (result) => {
      if (chrome.runtime.lastError) {
        console.error(
          "[CS 393 Buddy] real-time push failed:",
          chrome.runtime.lastError.message
        );
        return;
      }
      console.log("[CS 393 Buddy] real-time push:", result);
    }
  );
}

// Returns { solves: {slug: ms}, solutionUrls: {slug: url} }. Tolerates
// 404 (no student doc yet).
async function fetchStudentSolvesAndUrls(netID) {
  const url = `${FIRESTORE_BASE}/students/${netID}?key=${firebaseConfig.apiKey}`;
  const response = await fetch(url, { headers: await authedHeaders() });
  if (response.status === 404) return { solves: {}, solutionUrls: {} };
  if (!response.ok) throw new Error(`Firestore GET ${response.status}: ${response.statusText}`);
  const data = await response.json();
  const solves = {};
  const solvesField = data.fields?.solvedProblems;
  if (solvesField?.mapValue) {
    for (const [slug, valueObj] of Object.entries(solvesField.mapValue.fields ?? {})) {
      const ts = Number(valueObj.doubleValue ?? valueObj.integerValue ?? 0);
      if (slug && ts) solves[slug] = ts;
    }
  }
  const solutionUrls = {};
  const urlsField = data.fields?.solutionUrls;
  if (urlsField?.mapValue) {
    for (const [slug, valueObj] of Object.entries(urlsField.mapValue.fields ?? {})) {
      const url = valueObj.stringValue;
      if (slug && typeof url === "string" && url) solutionUrls[slug] = url;
    }
  }
  return { solves, solutionUrls };
}

// Patches solvedProblems and solutionUrls in one call. Both maps are
// rewritten wholesale; caller must pass the fully-merged maps.
async function writeSolvedAndUrlsToFirestore(netID, solves, solutionUrls) {
  const url =
    `${FIRESTORE_BASE}/students/${netID}` +
    `?updateMask.fieldPaths=solvedProblems&updateMask.fieldPaths=solutionUrls&key=${firebaseConfig.apiKey}`;
  const solvesFields = {};
  for (const [slug, ts] of Object.entries(solves)) {
    solvesFields[slug] = { doubleValue: ts };
  }
  const urlsFields = {};
  for (const [slug, u] of Object.entries(solutionUrls)) {
    if (typeof u === "string" && u) urlsFields[slug] = { stringValue: u };
  }
  const body = {
    fields: {
      solvedProblems: { mapValue: { fields: solvesFields } },
      solutionUrls: { mapValue: { fields: urlsFields } },
    },
  };
  const response = await fetch(url, {
    method: "PATCH",
    headers: await authedHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Firestore PATCH ${response.status}: ${errorBody}`);
  }
  return response.json();
}

// Extract a per-submission URL from `location.pathname` if the current
// URL is a submission view. LeetCode's URL after a code submission is
// often "/problems/<slug>/submissions/<id>/", in which case we can
// capture the ID immediately without waiting for the backstop's
// GraphQL round-trip.
function submissionUrlFromLocation(slug) {
  if (!slug) return null;
  const m = location.pathname.match(
    new RegExp(`^/problems/${slug}/submissions/(\\d+)`)
  );
  if (!m) return null;
  return `https://leetcode.com/problems/${slug}/submissions/${m[1]}/`;
}

// ---- verdict detection --------------------------------------------------

// A real Accepted result panel always renders companion text like
// "testcases passed" / "submitted at" / "Runtime 0 ms" / "Memory ..MB"
// that doesn't appear in the persistent "Solved" tab badge. We use
// that anchor only for Accepted, because that's the verdict with the
// noisy persistent indicator. For failure verdicts (Wrong Answer,
// TLE, etc.) we use a different filter: only count them when they
// follow a recent click on the Submit button — that's what
// distinguishes a real submission from a Run.
const RESULT_PANEL_KEYWORDS =
  /(testcases passed|submitted at|Submission Detail|Runtime\s*\d|Memory\s*\d)/i;
const ANCESTOR_SEARCH_DEPTH = 6;

// Listen for clicks on LeetCode's Submit button. Run and Submit
// render the same verdict text in the DOM, so click-tracking is the
// only reliable way to tell them apart without parsing network
// requests. Window is generous: even slow problems should return
// within a minute.
let lastSubmitClickAt = 0;
const SUBMIT_VERDICT_WINDOW_MS = 60_000;

document.addEventListener(
  "click",
  (event) => {
    const button = event.target instanceof Element ? event.target.closest("button") : null;
    if (!button) return;
    const text = (button.textContent ?? "").trim();
    if (text === "Submit") {
      lastSubmitClickAt = Date.now();
    }
  },
  true,
);

// Walk visible spans/divs looking for an element whose trimmed text is
// exactly one of our known verdicts.
//   - "Accepted": require an ancestor with submission-result keywords
//     (filters out the persistent "Solved" tab badge).
//   - Other verdicts: require a Submit-button click within the last
//     SUBMIT_VERDICT_WINDOW_MS (filters out Run results and stale
//     entries in the submissions panel).
function findVerdictInDOM() {
  const candidates = document.querySelectorAll("span, div");
  for (const el of candidates) {
    const text = el.textContent?.trim();
    if (!text || !VERDICTS[text]) continue;

    if (text !== "Accepted") {
      if (Date.now() - lastSubmitClickAt < SUBMIT_VERDICT_WINDOW_MS) {
        return text;
      }
      continue;
    }

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
