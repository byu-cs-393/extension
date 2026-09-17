// The background worker's half of in-browser Canvas submission.
//
// The content script on Canvas only performs POSTs. Everything that needs
// Firestore, rendering, or cross-tab coordination happens here:
//
//   canvasOutbox:list         what's pending, rendered and ready to POST
//   canvasOutbox:result       record one outcome
//   canvasOutbox:notSignedIn  on Canvas but logged out — show the tab
//   canvasOutbox:done         a drain finished — close the tab we opened
//   canvasOutbox:drain        from an extension page — send now if we can
import { fetchCollection, fetchDoc, patchDoc } from "./firestore.js";
import { getRole } from "./auth.js";
import { fillSubmissionTemplate } from "../data/submission-templates.js";
import {
  pendingSubmissions,
  canvasSubmissionFields,
} from "../data/canvas-outbox.js";
import { ASSIGNMENT_PROGRESS_CACHE_KEY } from "../data/assignment-progress.js";

const CANVAS_HOME = "https://byu.instructure.com/courses/35464";

// How long a handed-out item is withheld from other tabs. Long enough for
// a slow POST; short enough that a tab closed mid-send doesn't strand the
// item for the rest of the session.
const IN_FLIGHT_MS = 60_000;

let deployMapPromise = null;
function loadDeployMap() {
  deployMapPromise ??= fetch(chrome.runtime.getURL("deploy.fall-2026.json")).then((r) =>
    r.json(),
  );
  return deployMapPromise;
}

const keyFor = (assignmentId, queuedAt) => `${assignmentId}@${queuedAt}`;

// Two Canvas tabs open at once would both ask for the list and both submit.
// Canvas would just record a second attempt, but it's avoidable: an item
// handed to one tab is withheld from the others until it resolves.
// storage.session survives the service worker being torn down between
// messages, which a module-level variable would not.
async function claimUnclaimed(keys) {
  const { outboxInFlight = {} } = await chrome.storage.session.get("outboxInFlight");
  const now = Date.now();
  const fresh = Object.fromEntries(
    Object.entries(outboxInFlight).filter(([, at]) => now - at < IN_FLIGHT_MS),
  );
  const claimed = keys.filter((k) => !(k in fresh));
  for (const k of claimed) fresh[k] = now;
  await chrome.storage.session.set({ outboxInFlight: fresh });
  return new Set(claimed);
}

async function release(key) {
  const { outboxInFlight = {} } = await chrome.storage.session.get("outboxInFlight");
  delete outboxInFlight[key];
  await chrome.storage.session.set({ outboxInFlight });
}

async function currentNetID() {
  const { netID } = await chrome.storage.sync.get("netID");
  return typeof netID === "string" && netID ? netID : null;
}

// Returns { queue, anyRequested }. anyRequested means this student has a
// signoff waiting on a TA — the only situation where something can appear
// in their queue while they sit on a Canvas page. The content script uses
// it to decide whether polling is worth a Firestore read; most students
// never have one open, so most never poll.
async function listPending() {
  const netID = await currentNetID();
  if (!netID) return { queue: [], anyRequested: false };
  // Canvas refuses a submission from anyone with a teaching role, so
  // anything queued on a TA's own record can never send. Without this it
  // would be retried — and refused — on every Canvas page the TA opens,
  // indefinitely. A TA's record only acquired queued items through the
  // cache bug fixed in recordSignoffDecision, but existing ones linger
  // until cleared, and this stops them spinning in the meantime.
  if ((await getRole()) === "ta") return { queue: [], anyRequested: false };
  const docs = await fetchCollection(`students/${netID}/assignmentProgress`);
  const byId = Object.fromEntries(docs.map((d) => [d.assignmentId, d]));
  return {
    queue: pendingSubmissions(byId),
    anyRequested: docs.some((d) => d?.status === "requested"),
  };
}

async function handleList() {
  const [{ queue, anyRequested }, map] = await Promise.all([listPending(), loadDeployMap()]);
  const claimed = await claimUnclaimed(queue.map((q) => keyFor(q.assignmentId, q.queuedAt)));
  const items = [];
  for (const q of queue) {
    if (!claimed.has(keyFor(q.assignmentId, q.queuedAt))) continue;
    const canvasAssignmentId = map.assignments?.[q.assignmentId];
    if (!canvasAssignmentId) {
      // A stable id with no Canvas assignment behind it. Leaving it queued
      // would retry forever on every Canvas page load, so say so loudly.
      console.error(`[CS 393 Buddy] no Canvas assignment for ${q.assignmentId}; left queued`);
      continue;
    }
    items.push({
      assignmentId: q.assignmentId,
      queuedAt: q.queuedAt,
      courseId: map.course,
      canvasAssignmentId,
      fields: canvasSubmissionFields({
        submissionType: q.submissionType,
        body:
          q.submissionType === "online_url"
            ? null
            : fillSubmissionTemplate({ type: q.type, assignmentId: q.assignmentId, data: q.data }),
        url: q.data?.url,
      }),
    });
  }
  return { items, pollAdvised: anyRequested };
}

async function handleResult(message) {
  const key = keyFor(message.assignmentId, message.queuedAt);
  try {
    if (!message.ok) {
      console.error(
        `[CS 393 Buddy] Canvas submission failed for ${message.assignmentId} ` +
          `(HTTP ${message.status}); left queued:`,
        message.error,
      );
      return { ok: false };
    }
    const netID = await currentNetID();
    if (!netID) return { ok: false };
    const path = `students/${netID}/assignmentProgress/${message.assignmentId}`;

    // The count only moves on a send Canvas accepted, so it means what the
    // resubmission UI says it means: attempts Canvas actually has. A legacy
    // doc with a timestamp but no count was one submission.
    const current = await fetchDoc(path).catch(() => null);
    const priorCount = Number.isFinite(current?.canvasSubmitCount)
      ? current.canvasSubmitCount
      : current?.canvasSubmittedAt
        ? 1
        : 0;

    const submittedAt = Date.now();
    const fields = {
      canvasSubmittedAt: submittedAt,
      canvasSubmitCount: priorCount + 1,
      ...(message.submissionId != null ? { canvasSubmissionId: message.submissionId } : {}),
    };
    // updateMask names only these fields, so the doc's type and signoff
    // state are untouched — and canvasSubmittedAt now postdates queuedAt,
    // which is exactly what takes it out of the queue.
    await patchDoc(path, fields);

    const cached = await chrome.storage.local.get(ASSIGNMENT_PROGRESS_CACHE_KEY);
    const bundle = cached[ASSIGNMENT_PROGRESS_CACHE_KEY];
    if (bundle?.progress?.[message.assignmentId]) {
      bundle.progress[message.assignmentId] = { ...bundle.progress[message.assignmentId], ...fields };
      await chrome.storage.local.set({ [ASSIGNMENT_PROGRESS_CACHE_KEY]: bundle });
    }
    console.log(`[CS 393 Buddy] submitted ${message.assignmentId} to Canvas`);
    return { ok: true };
  } finally {
    await release(key);
  }
}

// Tabs this worker opened for a drain, so only those are closed or raised.
// A student's own Canvas tab is never touched.
async function drainTabs() {
  const { outboxDrainTabs = [] } = await chrome.storage.session.get("outboxDrainTabs");
  return outboxDrainTabs;
}

async function handleDrain() {
  const { queue: pending } = await listPending();
  if (pending.length === 0) return { opened: false, pending: 0 };
  const tab = await chrome.tabs.create({ url: CANVAS_HOME, active: false });
  const tabs = await drainTabs();
  await chrome.storage.session.set({ outboxDrainTabs: [...tabs, tab.id] });
  return { opened: true, pending: pending.length };
}

async function forgetDrainTab(tabId) {
  const tabs = await drainTabs();
  await chrome.storage.session.set({ outboxDrainTabs: tabs.filter((t) => t !== tabId) });
}

async function handleDone(sender) {
  const tabId = sender?.tab?.id;
  if (tabId == null || !(await drainTabs()).includes(tabId)) return {};
  await forgetDrainTab(tabId);
  await chrome.tabs.remove(tabId).catch(() => {});
  return {};
}

async function handleNotSignedIn(sender) {
  const tabId = sender?.tab?.id;
  if (tabId == null || !(await drainTabs()).includes(tabId)) return {};
  // Leave it open and bring it forward: the student needs to log in, and a
  // tab that silently vanished would be the shady version of this.
  await chrome.tabs.update(tabId, { active: true }).catch(() => {});
  await forgetDrainTab(tabId);
  return {};
}

const HANDLERS = {
  "canvasOutbox:list": () => handleList(),
  "canvasOutbox:result": (message) => handleResult(message),
  "canvasOutbox:done": (_m, sender) => handleDone(sender),
  "canvasOutbox:notSignedIn": (_m, sender) => handleNotSignedIn(sender),
  "canvasOutbox:drain": () => handleDrain(),
};

// Returns true if it took the message (and will respond asynchronously).
export function routeOutboxMessage(message, sender, sendResponse) {
  const handler = HANDLERS[message?.type];
  if (!handler) return false;
  handler(message, sender)
    .then((result) => sendResponse(result ?? {}))
    .catch((err) => {
      console.error(`[CS 393 Buddy] ${message.type} failed:`, err);
      sendResponse({ error: String(err?.message ?? err) });
    });
  return true;
}
