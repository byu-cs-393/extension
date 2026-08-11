// GENERATED FILE — DO NOT EDIT.
// Built from src/content/ by scripts/build-content-scripts.js.
// Edit the source there and run: npm run build

(() => {
  // src/content/canvas-auth.js
  async function fetchSelfProfile() {
    const response = await fetch("/api/v1/users/self/profile", {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" }
    });
    if (!response.ok) {
      throw new Error(`Canvas /users/self/profile ${response.status}: ${response.statusText}`);
    }
    return response.json();
  }
  function extractNetID(user) {
    if (user?.login_id) return String(user.login_id).toLowerCase();
    const email = user?.primary_email ?? user?.email ?? null;
    if (typeof email === "string") {
      const m = email.toLowerCase().match(/^([a-z][a-z0-9]+)@byu\.edu$/);
      if (m) return m[1];
    }
    return null;
  }
  function cleanName(user) {
    const raw = user?.short_name ?? user?.name ?? null;
    if (typeof raw !== "string") return null;
    return raw.replace(/\s+/g, " ").trim() || null;
  }
  (async () => {
    let auth = {
      signedIn: false,
      netID: null,
      name: null,
      canvasUserId: null,
      ltiUserId: null,
      checkedAt: Date.now()
    };
    try {
      const user = await fetchSelfProfile();
      const netID = extractNetID(user);
      if (netID) {
        auth = {
          signedIn: true,
          netID,
          name: cleanName(user),
          canvasUserId: user?.id ?? null,
          // lti_user_id is a stable per-user hash visible only via the
          // user's own Canvas session. Phase 2's Cloud Function will
          // verify this against an instructor-token Canvas lookup to
          // prove the student is who they say they are — no typed
          // soft secret needed.
          ltiUserId: user?.lti_user_id ?? null,
          checkedAt: Date.now()
        };
        console.log(`[CS 393 Buddy] Canvas: signed in as ${auth.netID}`);
      } else {
        console.log(
          "[CS 393 Buddy] Canvas: profile returned but no login_id or @byu.edu email \u2014 can't extract netID"
        );
      }
    } catch (error) {
      console.error("[CS 393 Buddy] failed to fetch Canvas /users/self/profile:", error);
    }
    await chrome.storage.local.set({ canvasAuth: auth });
  })();
})();
