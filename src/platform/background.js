// Service worker. Runs in its own short-lived context — no DOM, no
// window. Four responsibilities:
//
//   1. On install, open the onboarding tab.
//   2. Keep the Firebase Auth ID token fresh in the background so
//      content scripts (which can't refresh on their own) always have
//      a valid token to send to Firestore. Without this, the token
//      expires ~60 min after sign-in and any LeetCode-side write
//      (tracker, backstop) starts failing with 403 until the user
//      next opens the dashboard.
//   3. Proxy cross-origin fetches for content scripts. MV3 content
//      scripts run in the host page's origin (leetcode.com) and
//      don't inherit the extension's host_permissions CORS bypass.
//      The background worker is an extension page and DOES have that
//      bypass, so it can call our Cloud Functions freely. See the
//      onMessage handler below.
//   4. Check GitHub for a newer release and badge the toolbar icon when
//      there is one. See update-check.js.
import { forceRefresh, getIdToken } from "./auth.js";
import { routeOutboxMessage } from "./canvas-outbox-worker.js";
import { checkForUpdate, showStoredUpdate } from "./update-check.js";

const PUSH_MY_RECENT_GRADE_URL =
  "https://cs393-496021.web.app/api/pushMyRecentGrade";

const REFRESH_ALARM = "firebaseAuthRefresh";
// Firebase ID tokens last 60 min. Refreshing every 30 min keeps a fresh
// one in storage continuously — never an expired window for content
// scripts to hit.
const REFRESH_PERIOD_MINUTES = 30;

function ensureRefreshAlarm() {
  chrome.alarms.create(REFRESH_ALARM, {
    delayInMinutes: REFRESH_PERIOD_MINUTES,
    periodInMinutes: REFRESH_PERIOD_MINUTES,
  });
}

const UPDATE_ALARM = "updateCheck";
// Often enough that a release reaches everyone the same day, rarely enough
// that a classroom sharing one IP stays under GitHub's 60-an-hour limit.
const UPDATE_PERIOD_MINUTES = 6 * 60;

function ensureUpdateAlarm() {
  chrome.alarms.create(UPDATE_ALARM, {
    delayInMinutes: UPDATE_PERIOD_MINUTES,
    periodInMinutes: UPDATE_PERIOD_MINUTES,
  });
}

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("onboard.html") });
  }
  ensureRefreshAlarm();
  ensureUpdateAlarm();
  // An "update" here is usually the student installing the version the
  // badge told them about. Clear it now rather than hours from now.
  await showStoredUpdate();
  await checkForUpdate();
});

chrome.runtime.onStartup.addListener(async () => {
  ensureRefreshAlarm();
  ensureUpdateAlarm();
  await showStoredUpdate();
  await checkForUpdate();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === UPDATE_ALARM) {
    await checkForUpdate();
    return;
  }
  if (alarm.name !== REFRESH_ALARM) return;
  await forceRefresh();
});

// ---- Cross-origin proxy for content scripts ----------------------------
//
// leetcode-tracker.js sends { type: "pushMyRecentGrade", slug } when
// a student solves a problem. We do the fetch here (extension origin,
// no CORS restriction) and forward Cloud Function's response back.
//
// The onMessage listener must return `true` when responding
// asynchronously — otherwise Chrome closes the message channel before
// sendResponse fires.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // In-browser Canvas submission. See canvas-outbox-worker.js.
  if (routeOutboxMessage(message, sender, sendResponse)) return true;

  if (message?.type === "pushMyRecentGrade") {
    (async () => {
      try {
        const idToken = await getIdToken();
        if (!idToken) {
          sendResponse({ outcome: "no-auth", note: "no ID token cached" });
          return;
        }
        const response = await fetch(PUSH_MY_RECENT_GRADE_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${idToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ slug: message.slug }),
        });
        const result = await response.json().catch(() => null);
        sendResponse(result ?? { status: response.status });
      } catch (error) {
        console.error("[CS 393 Buddy] background push failed:", error);
        sendResponse({ outcome: "error", error: error.message ?? String(error) });
      }
    })();
    return true;
  }

  // Unknown message type — ignore. Returning false (implicit) closes the
  // channel without sendResponse, which is fine.
});
