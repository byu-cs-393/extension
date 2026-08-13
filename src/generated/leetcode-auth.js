// GENERATED FILE — DO NOT EDIT.
// Built from src/content/ by scripts/build-content-scripts.js.
// Edit the source there and run: npm run build

(() => {
  // src/platform/firebase-config.js
  var firebaseConfig = {
    apiKey: "AIzaSyC2RxnVrQii0rT-Tm3JZmURmHzico-VqDg",
    authDomain: "cs393-496021.firebaseapp.com",
    projectId: "cs393-496021",
    storageBucket: "cs393-496021.firebasestorage.app",
    messagingSenderId: "620970916253",
    appId: "1:620970916253:web:12819e3116d187806ad774",
    measurementId: "G-0XEPMH2MLG"
  };

  // src/lib/firestore-rest.js
  var FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents`;
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

  // src/content/leetcode-auth.js
  var LEETCODE_GRAPHQL_URL = "https://leetcode.com/graphql/";
  var BACKSTOP_INTERVAL_MS = 60 * 1e3;
  var USER_STATUS_QUERY = {
    operationName: "globalData",
    query: "query globalData { userStatus { isSignedIn isPremium username realName avatar } }",
    variables: {}
  };
  var RECENT_AC_QUERY = `query getACSubmissions($username: String!, $limit: Int) {
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
        Referer: "https://leetcode.com"
      },
      credentials: "include",
      body: JSON.stringify(body)
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
  async function fetchRecentAcceptedSubmissions(username, limit = 20) {
    const json = await graphql({
      operationName: "getACSubmissions",
      query: RECENT_AC_QUERY,
      variables: { username, limit }
    });
    const list = json?.data?.recentAcSubmissionList;
    if (!Array.isArray(list)) return [];
    return list.map((item) => ({
      slug: item.titleSlug,
      timestampMs: Number(item.timestamp) * 1e3,
      submissionId: item.id ? String(item.id) : null
    })).filter((x) => x.slug && Number.isFinite(x.timestampMs));
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
        const url2 = valueObj.stringValue;
        if (slug && typeof url2 === "string" && url2) solutionUrls[slug] = url2;
      }
    }
    return { solves, solutionUrls };
  }
  async function writeSolvedAndUrlsToFirestore(netID, solves, solutionUrls) {
    const url = `${FIRESTORE_BASE}/students/${netID}?updateMask.fieldPaths=solvedProblems&updateMask.fieldPaths=solutionUrls&key=${firebaseConfig.apiKey}`;
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
        solutionUrls: { mapValue: { fields: urlsFields } }
      }
    };
    const response = await fetch(url, {
      method: "PATCH",
      headers: await authedHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Firestore PATCH ${response.status}: ${errorBody}`);
    }
  }
  async function getNetID() {
    const { netID } = await chrome.storage.sync.get("netID");
    return netID || null;
  }
  async function runBackstop(username) {
    const netID = await getNetID();
    if (!netID) {
      console.log("[CS 393 Buddy] backstop: no netID in sync storage \u2014 skip");
      return;
    }
    const recent = await fetchRecentAcceptedSubmissions(username, 20);
    console.log(`[CS 393 Buddy] backstop: fetched ${recent.length} recent ACs`);
    if (recent.length === 0) return;
    const [firestoreDoc, cacheBundle] = await Promise.all([
      fetchStudentDocFromFirestore(netID).catch(() => ({ solves: {}, solutionUrls: {} })),
      chrome.storage.local.get("solvedProblems")
    ]);
    const firestoreSolves = firestoreDoc.solves;
    const firestoreUrls = firestoreDoc.solutionUrls;
    const cachedSolves = cacheBundle?.solvedProblems?.solves ?? {};
    const cachedUrls = cacheBundle?.solvedProblems?.solutions ?? {};
    const mergedSolves = { ...firestoreSolves, ...cachedSolves };
    const mergedUrls = { ...firestoreUrls, ...cachedUrls };
    let updated = 0;
    let urlsUpdated = 0;
    for (const { slug, timestampMs, submissionId } of recent) {
      const previous = mergedSolves[slug] ?? 0;
      if (timestampMs > previous) {
        mergedSolves[slug] = timestampMs;
        updated++;
      }
      const url = submissionUrlFor(slug, submissionId);
      if (url && !mergedUrls[slug]) {
        mergedUrls[slug] = url;
        urlsUpdated++;
      }
    }
    const hasUnpushedFromCache = Object.keys(cachedSolves).some(
      (slug) => !(slug in firestoreSolves) || cachedSolves[slug] > (firestoreSolves[slug] ?? 0)
    ) || Object.keys(cachedUrls).some(
      (slug) => !(slug in firestoreUrls)
    );
    console.log(
      `[CS 393 Buddy] backstop: Firestore had ${Object.keys(firestoreSolves).length}, cache had ${Object.keys(cachedSolves).length}, ${updated} updated from recent ACs, ${urlsUpdated} URLs learned, unpushed cache=${hasUnpushedFromCache}`
    );
    if (updated === 0 && urlsUpdated === 0 && !hasUnpushedFromCache) return;
    await chrome.storage.local.set({
      solvedProblems: {
        solves: mergedSolves,
        solutions: mergedUrls,
        syncedAt: Date.now()
      }
    });
    try {
      await writeSolvedAndUrlsToFirestore(netID, mergedSolves, mergedUrls);
    } catch (error) {
      console.error("[CS 393 Buddy] backstop failed to persist to Firestore:", error);
    }
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
        checkedAt: Date.now()
      };
      console.log(
        auth.signedIn ? `[CS 393 Buddy] LeetCode session: signed in as ${auth.username}` : `[CS 393 Buddy] LeetCode session: signed out`
      );
    } catch (error) {
      console.error("[CS 393 Buddy] failed to fetch LeetCode userStatus:", error);
    }
    await chrome.storage.local.set({ leetcodeAuth: auth });
    if (!auth.signedIn || !auth.username) return;
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
