// GENERATED FILE — DO NOT EDIT.
// Built from src/content/ by scripts/build-content-scripts.js.
// Edit the source there and run: npm run build

(() => {
  // src/content/canvas-submitter.js
  (async () => {
    let listing;
    try {
      listing = await chrome.runtime.sendMessage({ type: "canvasOutbox:list" });
    } catch {
      return;
    }
    const items = listing?.items ?? [];
    if (items.length === 0) return;
    const csrf = readCsrfToken();
    if (!csrf) {
      safeSend({ type: "canvasOutbox:notSignedIn", items: items.map(keyOf) });
      return;
    }
    for (const item of items) {
      let status = 0;
      let submissionId = null;
      let error = null;
      try {
        const resp = await fetch(
          `/api/v1/courses/${item.courseId}/assignments/${item.canvasAssignmentId}/submissions`,
          {
            method: "POST",
            credentials: "include",
            headers: {
              // Canvas rejects same-origin writes without this, exactly as it
              // would for its own frontend.
              "X-CSRF-Token": csrf,
              "Content-Type": "application/x-www-form-urlencoded",
              Accept: "application/json"
            },
            body: new URLSearchParams(item.fields)
          }
        );
        status = resp.status;
        const json = await resp.json().catch(() => null);
        if (resp.ok) submissionId = json?.id ?? null;
        else error = json?.errors ?? json?.message ?? `HTTP ${status}`;
      } catch (err) {
        error = String(err?.message ?? err);
      }
      await safeSend({
        type: "canvasOutbox:result",
        ...keyOf(item),
        ok: status >= 200 && status < 300,
        status,
        submissionId,
        error
      });
    }
    safeSend({ type: "canvasOutbox:done" });
  })();
  function keyOf(item) {
    return { assignmentId: item.assignmentId, queuedAt: item.queuedAt };
  }
  function readCsrfToken() {
    const match = document.cookie.match(/(?:^|;\s*)_csrf_token=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }
  async function safeSend(message) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch {
      return null;
    }
  }
})();
