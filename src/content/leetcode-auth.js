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

import {
  FIRESTORE_BASE,
  firebaseConfig,
  authedHeaders,
} from "../lib/firestore-rest.js";

const BACKSTOP_INTERVAL_MS = 60 * 1000;

const USER_STATUS_QUERY = {
  operationName: "globalData",
  query: "query globalData { userStatus { isSignedIn isPremium username realName avatar } }",
  variables: {},
};

const RECENT_AC_QUERY = `query getACSubmissions($username: String!, $limit: Int) {
  recentAcSubmissionList(username: $username, limit: $limit) {
    id
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
// `id` is the LeetCode submission id, which lets us construct the
// per-submission URL (https://leetcode.com/problems/<slug>/submissions/<id>/)
// that the Canvas submission templates ask for.
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
      submissionId: item.id ? String(item.id) : null,
    }))
    .filter((x) => x.slug && Number.isFinite(x.timestampMs));
}

function submissionUrlFor(slug, submissionId) {
  if (!slug || !submissionId) return null;
  return `https://leetcode.com/problems/${slug}/submissions/${submissionId}/`;
}

async function fetchStudentDocFromFirestore(netID) {
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
// rewritten wholesale (Firestore PATCH with updateMask replaces the
// listed fields entirely) — callers must pass the fully-merged maps,
// not just deltas.
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
  const [firestoreDoc, cacheBundle] = await Promise.all([
    fetchStudentDocFromFirestore(netID).catch(() => ({ solves: {}, solutionUrls: {} })),
    chrome.storage.local.get("solvedProblems"),
  ]);
  const firestoreSolves = firestoreDoc.solves;
  const firestoreUrls = firestoreDoc.solutionUrls;
  const cachedSolves = cacheBundle?.solvedProblems?.solves ?? {};
  const cachedUrls = cacheBundle?.solvedProblems?.solutions ?? {};

  // Start from Firestore + cache. Cache wins for any overlap since it
  // reflects the most recent tracker-recorded timestamp.
  const mergedSolves = { ...firestoreSolves, ...cachedSolves };
  // solutionUrls: whichever we have, prefer newest source. Cache first
  // (recent tracker/backstop write), Firestore second.
  const mergedUrls = { ...firestoreUrls, ...cachedUrls };
  let updated = 0;
  let urlsUpdated = 0;
  for (const { slug, timestampMs, submissionId } of recent) {
    const previous = mergedSolves[slug] ?? 0;
    if (timestampMs > previous) {
      mergedSolves[slug] = timestampMs;
      updated++;
    }
    // Only populate URL if we don't already have one for this slug —
    // an existing URL is either from a prior backstop run (fine) or a
    // fresher tracker-side capture (which we shouldn't overwrite with a
    // possibly-older submission id from the recent list).
    const url = submissionUrlFor(slug, submissionId);
    if (url && !mergedUrls[slug]) {
      mergedUrls[slug] = url;
      urlsUpdated++;
    }
  }

  // Anything to push? Either updated timestamps, new slugs, updated
  // URLs, or cached entries the tracker didn't manage to persist.
  const hasUnpushedFromCache = Object.keys(cachedSolves).some(
    (slug) => !(slug in firestoreSolves) || cachedSolves[slug] > (firestoreSolves[slug] ?? 0)
  ) || Object.keys(cachedUrls).some(
    (slug) => !(slug in firestoreUrls),
  );
  console.log(
    `[CS 393 Buddy] backstop: Firestore had ${Object.keys(firestoreSolves).length}, ` +
      `cache had ${Object.keys(cachedSolves).length}, ${updated} updated from recent ACs, ` +
      `${urlsUpdated} URLs learned, unpushed cache=${hasUnpushedFromCache}`
  );
  if (updated === 0 && urlsUpdated === 0 && !hasUnpushedFromCache) return;

  // Cache write first (fast UI), then Firestore (truth).
  await chrome.storage.local.set({
    solvedProblems: {
      solves: mergedSolves,
      solutions: mergedUrls,
      syncedAt: Date.now(),
    },
  });
  try {
    await writeSolvedAndUrlsToFirestore(netID, mergedSolves, mergedUrls);
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
