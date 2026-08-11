// GENERATED FILE — DO NOT EDIT.
// Built from src/content/ by scripts/build-content-scripts.js.
// Edit the source there and run: npm run build

(() => {
  // src/firebase-config.js
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
  function encodeFirestoreValue(value) {
    if (value === null || value === void 0) return { nullValue: null };
    if (typeof value === "string") return { stringValue: value };
    if (typeof value === "number") return { doubleValue: value };
    if (typeof value === "boolean") return { booleanValue: value };
    if (value instanceof Date) return { timestampValue: value.toISOString() };
    if (Array.isArray(value)) {
      return { arrayValue: { values: value.map(encodeFirestoreValue) } };
    }
    if (typeof value === "object") {
      return { mapValue: { fields: encodeFirestoreFields(value) } };
    }
    throw new Error(`Unsupported field value type: ${typeof value}`);
  }
  function encodeFirestoreFields(obj) {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      if (value === void 0) continue;
      result[key] = encodeFirestoreValue(value);
    }
    return result;
  }
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

  // src/lib/problem-url.js
  function parseProblemSlug(url) {
    const match = String(url ?? "").match(
      /^https:\/\/leetcode\.com\/problems\/([^/?#]+)/
    );
    return match ? match[1] : null;
  }
  function slugToTitle(slug) {
    return String(slug ?? "").split("-").filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
  }
  function titleToSlug(title) {
    return String(title ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }
  function strippedDocumentTitle(documentTitle) {
    return String(documentTitle ?? "").replace(/\s*[-–]\s*LeetCode\s*$/i, "").trim();
  }
  function titleMatchesSlug(documentTitle, slug) {
    const stripped = strippedDocumentTitle(documentTitle);
    return stripped !== "" && titleToSlug(stripped) === slug;
  }
  function getProblemTitle(documentTitle, slug) {
    return titleMatchesSlug(documentTitle, slug) ? strippedDocumentTitle(documentTitle) : slugToTitle(slug);
  }

  // src/lib/extension-lifecycle.js
  function extensionContextAlive() {
    try {
      return Boolean(globalThis.chrome?.runtime?.id);
    } catch (_error) {
      return false;
    }
  }
  function isContextInvalidatedError(error) {
    return /extension context invalidated|message port closed/i.test(
      String(error?.message ?? error)
    );
  }
  function createLifecycleGuard(onInvalidated) {
    let invalidated = false;
    function trip() {
      if (invalidated) return true;
      invalidated = true;
      onInvalidated?.();
      return true;
    }
    return {
      invalidated: () => invalidated,
      alive() {
        if (invalidated) return false;
        if (!extensionContextAlive()) {
          trip();
          return false;
        }
        return true;
      },
      failed(error) {
        if (!isContextInvalidatedError(error)) return false;
        return trip();
      }
    };
  }

  // src/content/leetcode-tracker.js
  var VERDICTS = {
    Accepted: "submit_pass",
    "Wrong Answer": "submit_fail",
    "Time Limit Exceeded": "submit_fail",
    "Memory Limit Exceeded": "submit_fail",
    "Output Limit Exceeded": "submit_fail",
    "Runtime Error": "submit_fail",
    "Compile Error": "submit_fail"
  };
  var lifecycle = createLifecycleGuard(() => {
    console.warn(
      "[CS 393 Buddy] the extension was reloaded or updated \u2014 this tab is no longer being tracked. Reload the page to resume."
    );
  });
  async function postActivityEvent(fields) {
    if (!lifecycle.alive()) return null;
    const url = `${FIRESTORE_BASE}/activity?key=${firebaseConfig.apiKey}`;
    const response = await fetch(url, {
      method: "POST",
      headers: await authedHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        fields: encodeFirestoreFields({
          studentNetID: netID,
          source: "leetcode",
          timestamp: /* @__PURE__ */ new Date(),
          ...fields
        })
      })
    });
    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Firestore POST ${response.status}: ${errorBody}`);
    }
    return response.json();
  }
  var netID = null;
  var lastLoggedSlug = null;
  var lastVerdict = null;
  var lastVerdictSlug = null;
  async function logOpenProblem(slug) {
    if (!netID || slug === lastLoggedSlug) return;
    lastLoggedSlug = slug;
    try {
      await postActivityEvent({
        eventType: "open_problem",
        problemSlug: slug,
        problemTitle: getProblemTitle(document.title, slug)
      });
      console.log(`[CS 393 Buddy] open_problem: ${slug}`);
    } catch (error) {
      if (lifecycle.failed(error)) return;
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
        problemTitle: getProblemTitle(document.title, slug)
      });
      console.log(`[CS 393 Buddy] ${eventType}: ${slug} (${verdict})`);
    } catch (error) {
      if (lifecycle.failed(error)) return;
      console.error("[CS 393 Buddy] failed to log verdict:", error);
    }
    if (eventType === "submit_pass") {
      await markSolved(slug);
    }
  }
  async function markSolved(slug) {
    const solvedAt = Date.now();
    const capturedUrl = submissionUrlFromLocation(slug);
    try {
      const { solvedProblems } = await chrome.storage.local.get("solvedProblems");
      const solves = { ...solvedProblems?.solves ?? {} };
      const solutions = { ...solvedProblems?.solutions ?? {} };
      solves[slug] = solvedAt;
      if (capturedUrl) solutions[slug] = capturedUrl;
      await chrome.storage.local.set({
        solvedProblems: { solves, solutions, syncedAt: Date.now() }
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
        `[CS 393 Buddy] persisted solved: ${slug} @ ${new Date(solvedAt).toISOString()}` + (capturedUrl ? ` (url captured)` : ``)
      );
    } catch (error) {
      console.error("[CS 393 Buddy] failed to persist solved to Firestore:", error);
    }
    if (firestoreOk) {
      firePushMyRecentGrade(slug);
    }
  }
  var pushDebounce = /* @__PURE__ */ new Map();
  var PUSH_DEBOUNCE_MS = 30 * 1e3;
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
  async function fetchStudentSolvesAndUrls(netID2) {
    const url = `${FIRESTORE_BASE}/students/${netID2}?key=${firebaseConfig.apiKey}`;
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
  async function writeSolvedAndUrlsToFirestore(netID2, solves, solutionUrls) {
    const url = `${FIRESTORE_BASE}/students/${netID2}?updateMask.fieldPaths=solvedProblems&updateMask.fieldPaths=solutionUrls&key=${firebaseConfig.apiKey}`;
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
    return response.json();
  }
  function submissionUrlFromLocation(slug) {
    if (!slug) return null;
    const m = location.pathname.match(
      new RegExp(`^/problems/${slug}/submissions/(\\d+)`)
    );
    if (!m) return null;
    return `https://leetcode.com/problems/${slug}/submissions/${m[1]}/`;
  }
  var RESULT_PANEL_KEYWORDS = /(testcases passed|submitted at|Submission Detail|Runtime\s*\d|Memory\s*\d)/i;
  var ANCESTOR_SEARCH_DEPTH = 6;
  var lastSubmitClickAt = 0;
  var SUBMIT_VERDICT_WINDOW_MS = 6e4;
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
    true
  );
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
    if (slug !== lastVerdictSlug) {
      lastVerdictSlug = slug;
      lastVerdict = null;
    }
    const found = findVerdictInDOM();
    if (found && found !== lastVerdict) {
      lastVerdict = found;
      logVerdict(slug, found);
    } else if (!found) {
      lastVerdict = null;
    }
  }
  var scheduled = false;
  function scheduleVerdictCheck() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      checkForVerdict();
    }, 200);
  }
  var origPushState = history.pushState;
  history.pushState = function(...args) {
    origPushState.apply(this, args);
    window.dispatchEvent(new Event("locationchange"));
  };
  function onLocationChange() {
    const slug = parseProblemSlug(location.href);
    if (slug) logOpenProblem(slug);
  }
  (async () => {
    const { netID: stored } = await chrome.storage.sync.get("netID");
    if (!stored) {
      console.log("[CS 393 Buddy] no netID set \u2014 skipping LeetCode tracking. Run onboarding first.");
      return;
    }
    netID = stored;
    window.addEventListener("popstate", onLocationChange);
    window.addEventListener("locationchange", onLocationChange);
    onLocationChange();
    const observer = new MutationObserver(scheduleVerdictCheck);
    observer.observe(document.body, { childList: true, subtree: true });
  })();
})();
