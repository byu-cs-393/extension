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
  try {
    const { solvedProblems } = await chrome.storage.local.get("solvedProblems");
    const solves = { ...(solvedProblems?.solves ?? {}) };
    // Always overwrite with the new timestamp — a fresh accepted
    // submission for a previously-solved problem still counts for
    // whatever week it lands in.
    solves[slug] = solvedAt;
    await chrome.storage.local.set({
      solvedProblems: { solves, syncedAt: Date.now() },
    });
  } catch (error) {
    console.error("[CS 393 Buddy] failed to update solved cache:", error);
  }

  try {
    const existing = await fetchSolvedProblemsFromFirestore(netID);
    const updated = { ...existing, [slug]: solvedAt };
    await writeSolvedProblemsToFirestore(netID, updated);
    console.log(`[CS 393 Buddy] persisted solved: ${slug} @ ${new Date(solvedAt).toISOString()}`);
  } catch (error) {
    console.error("[CS 393 Buddy] failed to persist solved to Firestore:", error);
  }
}

// Returns a map of { slug: timestampMs }. Tolerates 404 (no student doc
// yet) and legacy array shape from the previous schema.
async function fetchSolvedProblemsFromFirestore(netID) {
  const url = `${FIRESTORE_BASE}/students/${netID}?key=${firebaseConfig.apiKey}`;
  const response = await fetch(url, { headers: await authedHeaders() });
  if (response.status === 404) return {};
  if (!response.ok) throw new Error(`Firestore GET ${response.status}: ${response.statusText}`);
  const data = await response.json();
  const field = data.fields?.solvedProblems;
  if (!field) return {};
  if (field.mapValue) {
    const out = {};
    for (const [slug, valueObj] of Object.entries(field.mapValue.fields ?? {})) {
      const ts = Number(valueObj.doubleValue ?? valueObj.integerValue ?? 0);
      if (slug && ts) out[slug] = ts;
    }
    return out;
  }
  return {};
}

async function writeSolvedProblemsToFirestore(netID, solves) {
  const url =
    `${FIRESTORE_BASE}/students/${netID}` +
    `?updateMask.fieldPaths=solvedProblems&key=${firebaseConfig.apiKey}`;
  const mapFields = {};
  for (const [slug, ts] of Object.entries(solves)) {
    mapFields[slug] = { doubleValue: ts };
  }
  const body = {
    fields: {
      solvedProblems: { mapValue: { fields: mapFields } },
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

// ---- verdict detection --------------------------------------------------

// A real submission result panel always renders companion text like
// "testcases passed" and "submitted at" that doesn't appear in status
// badges, tab labels, or the "X/Y solved" stats UI. The Runtime/Memory
// labels run on without spaces in LeetCode's React output (e.g.
// "Runtime0msBeats100.00%Memory") so we match those by label-then-digit
// rather than relying on word boundaries.
const RESULT_PANEL_KEYWORDS =
  /(testcases passed|submitted at|Submission Detail|Runtime\s*\d|Memory\s*\d)/i;
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
