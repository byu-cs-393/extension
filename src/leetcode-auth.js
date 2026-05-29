// Content script that runs on every leetcode.com page. It asks LeetCode
// who the current session belongs to (via their own GraphQL endpoint —
// cookies are sent automatically because we're same-origin) and writes
// the result to chrome.storage.local. Other parts of the extension —
// notably the onboarding wizard — subscribe to that key via
// chrome.storage.onChanged so they can react when the student signs in.
//
// Read-only. No CSRF token is needed for the userStatus query.

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
  try {
    const status = await fetchUserStatus();
    const auth = {
      signedIn: !!status?.isSignedIn,
      username: status?.username ?? null,
      realName: status?.realName ?? null,
      avatar: status?.avatar ?? null,
      checkedAt: Date.now(),
    };
    await chrome.storage.local.set({ leetcodeAuth: auth });
    console.log(
      auth.signedIn
        ? `[CS 393 Buddy] LeetCode session: signed in as ${auth.username}`
        : `[CS 393 Buddy] LeetCode session: signed out`
    );
  } catch (error) {
    console.error("[CS 393 Buddy] failed to fetch LeetCode userStatus:", error);
  }
})();
