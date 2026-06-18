// Content script that runs on BYU Canvas. Reads the signed-in user's
// info from /api/v1/users/self — same-origin so Canvas's session cookie
// attaches automatically. Writes the result to chrome.storage.local
// under `canvasAuth`; onboarding watches that key to auto-fill the
// netID + name inputs without the student having to type them.
//
// Wrapped in an IIFE to keep declarations scope-local, mirroring the
// leetcode-auth.js pattern.
(() => {
  "use strict";

  async function fetchSelf() {
    const response = await fetch("/api/v1/users/self", {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`Canvas /users/self ${response.status}: ${response.statusText}`);
    }
    return response.json();
  }

  (async () => {
    let auth = {
      signedIn: false,
      netID: null,
      name: null,
      canvasUserId: null,
      checkedAt: Date.now(),
    };
    try {
      const user = await fetchSelf();
      if (user?.login_id) {
        auth = {
          signedIn: true,
          netID: String(user.login_id).toLowerCase(),
          name: user.name ?? user.short_name ?? null,
          canvasUserId: user.id ?? null,
          checkedAt: Date.now(),
        };
        console.log(`[CS 393 Buddy] Canvas: signed in as ${auth.netID}`);
      } else {
        console.log("[CS 393 Buddy] Canvas: not signed in / no login_id returned");
      }
    } catch (error) {
      console.error("[CS 393 Buddy] failed to fetch Canvas /users/self:", error);
    }
    await chrome.storage.local.set({ canvasAuth: auth });
  })();
})();
