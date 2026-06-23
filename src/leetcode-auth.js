// Wrapped in an IIFE so our top-level `const`s (firebaseConfig,
// FIRESTORE_BASE, etc.) stay scope-local. Without this, when both
// leetcode-auth.js and leetcode-tracker.js inject on the same /problems/
// page, they'd collide at the second redeclaration — content scripts of
// the same extension share an isolated world per tab — and the
// second-loaded file would silently fail with a SyntaxError, taking
// open_problem and submit_pass logging down with it.
(() => {
"use strict";

// Content script that runs on every leetcode.com page. Two jobs:
//
//   1. Auth check — call userStatus GraphQL (cookies attach automatically
//      because we're same-origin) and write the result to
//      chrome.storage.local under `leetcodeAuth`. Onboarding and the
//      dashboard react via chrome.storage.onChanged.
//
//   2. Recent-AC backstop sync — if the student is signed in, pull their
//      most recent ~20 accepted submissions (titleSlug + Unix timestamp)
//      via recentAcSubmissionList and reconcile against the cached/
//      Firestore-stored solvedProblems map. Catches solves the DOM-based
//      verdict detector in leetcode-tracker.js may have missed (e.g.
//      LeetCode UI redesign, solves on a different device).
//
// Both calls are read-only; no CSRF token needed.

const LEETCODE_GRAPHQL_URL = "https://leetcode.com/graphql/";

const firebaseConfig = {
  apiKey: "AIzaSyC2RxnVrQii0rT-Tm3JZmURmHzico-VqDg",
  projectId: "cs393-496021",
};

const FIRESTORE_BASE =
  `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}` +
  `/databases/(default)/documents`;

// Don't hammer the backstop on every page load. The verdict-detector
// covers same-page submissions in real time; the backstop only needs to
// catch up for things that happened elsewhere.
const BACKSTOP_INTERVAL_MS = 60 * 1000;

const USER_STATUS_QUERY = {
  operationName: "globalData",
  query: "query globalData { userStatus { isSignedIn isPremium username realName avatar } }",
  variables: {},
};

const RECENT_AC_QUERY = `query getACSubmissions($username: String!, $limit: Int) {
  recentAcSubmissionList(username: $username, limit: $limit) {
    titleSlug
    timestamp
  }
}`;

async function graphql(body) {
  const response = await fetch(LEETCODE_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Referer: "https://leetcode.com",
    },
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`GraphQL ${response.status}: ${response.statusText}`);
  }
  return response.json();
}

async function fetchUserStatus() {
  const json = await graphql(USER_STATUS_QUERY);
  return json?.data?.userStatus ?? null;
}

// LeetCode returns timestamps as strings of Unix seconds. We work in ms.
async function fetchRecentAcceptedSubmissions(username, limit = 20) {
  const json = await graphql({
    operationName: "getACSubmissions",
    query: RECENT_AC_QUERY,
    variables: { username, limit },
  });
  const list = json?.data?.recentAcSubmissionList;
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => ({
      slug: item.titleSlug,
      timestampMs: Number(item.timestamp) * 1000,
    }))
    .filter((x) => x.slug && Number.isFinite(x.timestampMs));
}

// ---- Firestore helpers (inlined; content scripts can't import) --------

// Read the current Firebase Auth ID token from chrome.storage.local.
// Same constraint as leetcode-tracker.js: content scripts can't import
// auth.js, so we just use the cached value. The dashboard/popup keep
// it fresh via auth.js's refresh logic.
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

async function fetchSolvedProblemsFromFirestore(netID) {
  const url = `${FIRESTORE_BASE}/students/${netID}?key=${firebaseConfig.apiKey}`;
  const response = await fetch(url, { headers: await authedHeaders() });
  if (response.status === 404) return {};
  if (!response.ok) throw new Error(`Firestore GET ${response.status}: ${response.statusText}`);
  const data = await response.json();
  const field = data.fields?.solvedProblems;
  if (!field?.mapValue) return {};
  const out = {};
  for (const [slug, valueObj] of Object.entries(field.mapValue.fields ?? {})) {
    const ts = Number(valueObj.doubleValue ?? valueObj.integerValue ?? 0);
    if (slug && ts) out[slug] = ts;
  }
  return out;
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
    fields: { solvedProblems: { mapValue: { fields: mapFields } } },
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
}

// ---- Backstop reconciliation ------------------------------------------

async function getNetID() {
  const { netID } = await chrome.storage.sync.get("netID");
  return netID || null;
}

async function runBackstop(username) {
  const netID = await getNetID();
  if (!netID) {
    console.log("[CS 393 Buddy] backstop: no netID in sync storage — skip");
    return;
  }

  const recent = await fetchRecentAcceptedSubmissions(username, 20);
  console.log(`[CS 393 Buddy] backstop: fetched ${recent.length} recent ACs`);
  if (recent.length === 0) return;

  // Read current state from Firestore (source of truth) and cache.
  // Cache may have entries not yet in Firestore — the tracker writes
  // cache first, Firestore second, so a failed/in-flight tracker write
  // would leave a divergence we want to reconcile.
  const [firestoreSolves, cacheBundle] = await Promise.all([
    fetchSolvedProblemsFromFirestore(netID).catch(() => ({})),
    chrome.storage.local.get("solvedProblems"),
  ]);
  const cachedSolves = cacheBundle?.solvedProblems?.solves ?? {};

  // Start from Firestore + cache. Cache wins for any overlap since it
  // reflects the most recent tracker-recorded timestamp.
  const merged = { ...firestoreSolves, ...cachedSolves };
  let updated = 0;
  for (const { slug, timestampMs } of recent) {
    // Take the max: if the tracker already recorded a more recent
    // solve, don't downgrade. If LeetCode reports a newer one (a fresh
    // submission the tracker missed), bump up.
    const previous = merged[slug] ?? 0;
    if (timestampMs > previous) {
      merged[slug] = timestampMs;
      updated++;
    }
  }

  // Anything to push? Either updated timestamps, new slugs, or cached
  // entries the tracker didn't manage to persist.
  const hasUnpushedFromCache = Object.keys(cachedSolves).some(
    (slug) => !(slug in firestoreSolves) || cachedSolves[slug] > (firestoreSolves[slug] ?? 0)
  );
  console.log(
    `[CS 393 Buddy] backstop: Firestore had ${Object.keys(firestoreSolves).length}, ` +
      `cache had ${Object.keys(cachedSolves).length}, ${updated} updated from recent ACs, ` +
      `unpushed cache=${hasUnpushedFromCache}`
  );
  if (updated === 0 && !hasUnpushedFromCache) return;

  if (updated > 0) console.log(`[CS 393 Buddy] backstop updating ${updated} solve(s) from recent ACs`);
  if (hasUnpushedFromCache) console.log(`[CS 393 Buddy] backstop reconciling cached solves to Firestore`);

  // Cache write first (fast UI), then Firestore (truth).
  await chrome.storage.local.set({
    solvedProblems: { solves: merged, syncedAt: Date.now() },
  });
  try {
    await writeSolvedProblemsToFirestore(netID, merged);
  } catch (error) {
    console.error("[CS 393 Buddy] backstop failed to persist to Firestore:", error);
  }
}

// ---- Entrypoint -------------------------------------------------------

(async () => {
  let auth = { signedIn: false, username: null, realName: null, avatar: null, checkedAt: Date.now() };
  try {
    const status = await fetchUserStatus();
    auth = {
      signedIn: !!status?.isSignedIn,
      username: status?.username ?? null,
      realName: status?.realName ?? null,
      avatar: status?.avatar ?? null,
      checkedAt: Date.now(),
    };
    console.log(
      auth.signedIn
        ? `[CS 393 Buddy] LeetCode session: signed in as ${auth.username}`
        : `[CS 393 Buddy] LeetCode session: signed out`
    );
  } catch (error) {
    console.error("[CS 393 Buddy] failed to fetch LeetCode userStatus:", error);
  }
  await chrome.storage.local.set({ leetcodeAuth: auth });

  if (!auth.signedIn || !auth.username) return;

  // Throttle the backstop: even on heavy LeetCode browsing, only run
  // once per minute.
  const { backstopLastRunAt } = await chrome.storage.local.get("backstopLastRunAt");
  if (backstopLastRunAt && Date.now() - backstopLastRunAt < BACKSTOP_INTERVAL_MS) return;
  await chrome.storage.local.set({ backstopLastRunAt: Date.now() });

  try {
    await runBackstop(auth.username);
  } catch (error) {
    console.error("[CS 393 Buddy] backstop sync failed:", error);
  }
})();

})();
