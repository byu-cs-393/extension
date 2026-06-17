// Content script that runs on every leetcode.com page. Its only job is
// to confirm LeetCode's session: call userStatus GraphQL (cookies attach
// automatically because we're same-origin) and write the result to
// chrome.storage.local. The onboarding wizard and dashboard react via
// chrome.storage.onChanged.
//
// Per-problem solved status used to be fetched here too, but the
// dashboard's source of truth moved to Firestore (students/{netID}.
// solvedProblems), populated by leetcode-tracker.js on real submit_pass
// events. That way "solved" means "solved during the class," not
// "solved at any point in LeetCode history."

const LEETCODE_GRAPHQL_URL = "https://leetcode.com/graphql/";

const USER_STATUS_QUERY = {
  operationName: "globalData",
  query: "query globalData { userStatus { isSignedIn isPremium username realName avatar } }",
  variables: {},
};

async function fetchUserStatus() {
  const response = await fetch(LEETCODE_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Referer: "https://leetcode.com",
    },
    credentials: "include",
    body: JSON.stringify(USER_STATUS_QUERY),
  });
  if (!response.ok) {
    throw new Error(`GraphQL ${response.status}: ${response.statusText}`);
  }
  const json = await response.json();
  return json?.data?.userStatus ?? null;
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
})();
