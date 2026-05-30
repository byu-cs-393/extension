// Content script that runs on every leetcode.com page. Two jobs:
//
//   1. Auth check — call LeetCode's userStatus GraphQL (cookies attach
//      automatically because we're same-origin) and write the result to
//      chrome.storage.local under `leetcodeAuth`. The onboarding wizard
//      and dashboard react via chrome.storage.onChanged.
//
//   2. Recommended-problem sync — if the student is signed in, fetch
//      the per-user status of each problem in RECOMMENDED_PROBLEMS and
//      write to chrome.storage.local under `recommendedProgress` so the
//      dashboard can render the "N / 7 solved" card.
//
// Both calls are read-only; no CSRF token needed.

const LEETCODE_GRAPHQL_URL = "https://leetcode.com/graphql/";

// Hardcoded for now. Will move to per-class Firestore config later.
const RECOMMENDED_PROBLEMS = [
  "min-cost-climbing-stairs",
  "climbing-stairs",
  "coin-change",
  "coin-change-ii",
  "range-sum-query-immutable",
  "range-sum-query-2d-immutable",
  "sum-of-distances",
];

// Re-sync the recommended-problem statuses at most this often. Short
// enough that "I just solved one, let me check the dashboard" feels
// fresh; long enough that hammering refresh on leetcode.com doesn't
// fire 7 GraphQL calls per click. The leetcode-tracker.js submit_pass
// handler also optimistically updates this same key without a refetch,
// so the throttle mostly bounds the *catch-up* sync, not the
// just-solved case.
const RECOMMENDED_SYNC_INTERVAL_MS = 30 * 1000;

const USER_STATUS_QUERY = {
  operationName: "globalData",
  query: "query globalData { userStatus { isSignedIn isPremium username realName avatar } }",
  variables: {},
};

const QUESTION_STATUS_QUERY = `query questionStatus($titleSlug: String!) {
  question(titleSlug: $titleSlug) {
    titleSlug
    title
    difficulty
    status
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

async function fetchProblemStatus(titleSlug) {
  const json = await graphql({
    operationName: "questionStatus",
    query: QUESTION_STATUS_QUERY,
    variables: { titleSlug },
  });
  return json?.data?.question ?? null;
}

// One-by-one with a small delay to stay polite — ~5 req/sec.
async function syncRecommendedProgress() {
  const problems = [];
  for (const slug of RECOMMENDED_PROBLEMS) {
    try {
      const data = await fetchProblemStatus(slug);
      problems.push({
        titleSlug: data?.titleSlug ?? slug,
        title: data?.title ?? slug,
        difficulty: data?.difficulty ?? null,
        status: data?.status ?? null, // "ac" | "notac" | null
      });
    } catch (error) {
      console.error(`[CS 393 Buddy] failed to fetch ${slug}:`, error);
      problems.push({ titleSlug: slug, title: slug, difficulty: null, status: null });
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  await chrome.storage.local.set({
    recommendedProgress: { problems, syncedAt: Date.now() },
  });
  const solved = problems.filter((p) => p.status === "ac").length;
  console.log(`[CS 393 Buddy] synced ${solved}/${problems.length} recommended problems`);
}

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

  if (!auth.signedIn) return;

  const { recommendedProgress } = await chrome.storage.local.get("recommendedProgress");
  const stale =
    !recommendedProgress?.syncedAt ||
    Date.now() - recommendedProgress.syncedAt > RECOMMENDED_SYNC_INTERVAL_MS;
  if (stale) {
    await syncRecommendedProgress();
  }
})();
