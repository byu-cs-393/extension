// Service worker. Runs in its own short-lived context — no DOM, no
// window. Two responsibilities:
//
//   1. On install, open the onboarding tab.
//   2. Keep the Firebase Auth ID token fresh in the background so
//      content scripts (which can't refresh on their own) always have
//      a valid token to send to Firestore. Without this, the token
//      expires ~60 min after sign-in and any LeetCode-side write
//      (tracker, backstop) starts failing with 403 until the user
//      next opens the dashboard.
import { forceRefresh } from "./auth.js";

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

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("onboard.html") });
  }
  ensureRefreshAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  ensureRefreshAlarm();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== REFRESH_ALARM) return;
  await forceRefresh();
});
