// Sends queued Canvas submissions, as the student, from their own session.
//
// Runs on byu.instructure.com. It is deliberately the smallest possible
// thing that can do this job:
//
//   - It never reads the page. No DOM queries, no scraping, no profile
//     lookups. The only thing it takes from Canvas is the CSRF cookie
//     every same-origin write requires.
//   - It does nothing at all unless the extension has a submission queued
//     for this student. On every other Canvas page load it asks once, gets
//     an empty list, and stops.
//   - It sends exactly what it's handed. The background worker decides what
//     is pending and renders each body; this only performs the POST.
//
// Why it has to run here: the course's Canvas token cannot submit for a
// student, and no server can. A submission is authored by whoever is
// logged in, so the student's own browser, on Canvas, is the only place it
// can come from — which is also the course rule that the extension only
// ever does what a student could do by hand.

(async () => {
  let listing;
  try {
    listing = await chrome.runtime.sendMessage({ type: "canvasOutbox:list" });
  } catch {
    // Extension reloaded or updated under this page. Nothing to do; the
    // next page load will ask again.
    return;
  }
  const items = listing?.items ?? [];
  if (items.length === 0) return;

  const csrf = readCsrfToken();
  if (!csrf) {
    // On a Canvas page but not logged in — the login screen, say. Tell the
    // background so it can bring this tab forward for the student.
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
            Accept: "application/json",
          },
          body: new URLSearchParams(item.fields),
        },
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
      error,
    });
  }
  safeSend({ type: "canvasOutbox:done" });
})();

function keyOf(item) {
  return { assignmentId: item.assignmentId, queuedAt: item.queuedAt };
}

// Canvas stores its CSRF token URL-encoded in a readable cookie, which its
// own JavaScript echoes back in a header. Doing the same is what makes this
// request indistinguishable from the student clicking Submit.
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
