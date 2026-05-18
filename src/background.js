// Service worker. Runs in its own short-lived context — no DOM, no
// window. Its main job for now: open the onboarding tab the first time
// the extension is installed.

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason !== "install") return;
  chrome.tabs.create({ url: chrome.runtime.getURL("onboard.html") });
});
