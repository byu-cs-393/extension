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

// How the queue gets noticed. A page load alone isn't enough: a student
// signed off while sitting on a Canvas page would never see it, because
// nothing reloads. So three triggers, all running the same routine:
//
//   load        they just opened or refreshed a Canvas page
//   focus       they came back to a Canvas tab they'd left
//   poll        they're sitting on the page while a TA signs them off
//
// The poll only runs when the student has a signoff actually waiting on a
// TA — the one case where something can appear in their queue without them
// doing anything. Most students never have one, so most never poll.
const MIN_GAP_MS = 10_000;
const POLL_MS = 90_000;

let lastRunAt = 0;
let running = false;
let pollTimer = null;

async function drain() {
  // Flipping between tabs shouldn't mean a Firestore read per flip, and two
  // overlapping runs would ask for the same items twice.
  if (running || Date.now() - lastRunAt < MIN_GAP_MS) return;
  running = true;
  lastRunAt = Date.now();
  try {
    const listing = await safeSend({ type: "canvasOutbox:list" });
    if (listing === null) {
      // Extension reloaded under this page; nothing can reach it again.
      stopPolling();
      return;
    }
    setPolling(listing?.pollAdvised === true);

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
  } finally {
    running = false;
  }
}

function setPolling(on) {
  if (on === Boolean(pollTimer)) return;
  if (!on) return stopPolling();
  pollTimer = setInterval(() => {
    if (document.visibilityState === "visible") drain();
  }, POLL_MS);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

// visibilitychange covers switching browser tabs; focus covers switching
// away from the browser entirely. Neither fires reliably for both.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") drain();
});
window.addEventListener("focus", () => drain());

drain();

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
