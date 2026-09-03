// Per-assignment progress — the new-model equivalent of weekProgress,
// keyed by the stable assignment ID from course.json instead of by week.
// See firestore.rules for the schema notes.
//
// Cached in chrome.storage.local under `assignmentProgressBundle` so
// dashboard + TA views can re-render via storage.onChanged the moment
// a write lands. Same pattern as weekProgressBundle in third-card.js.
//
// Shape of an assignmentProgress doc (fields vary by type):
//
//   performance:
//     { assignmentId, type: "performance", weekNum,
//       status: "requested" | "passed" | "failed",
//       requestedAt, signoffAt?, signoffTaNetID?, signoffNote? }
//
//   live-interview:
//     { assignmentId, type: "live-interview",
//       status: "requested" | "passed" | "failed",
//       requestedAt, signoffAt?, signoffTaNetID?,
//       graderRating?: 1|2|3, signoffNote?,
//       signoffHowLong?, signoffHowItWent?, requestedTaNetID? }
//
//   peer-mock:
//     { assignmentId, type: "peer-mock", weekNum,
//       status: "completed",
//       completedAt, partnerNetID?, selfRating?: 1|2|3 }
//
//   professional-mock:
//     { assignmentId, type: "professional-mock",
//       status: "completed",
//       completedAt, whoWith?, selfRating?: 1|2|3 }

import { fetchCollection, patchDoc } from "../platform/firestore.js";

export const ASSIGNMENT_PROGRESS_CACHE_KEY = "assignmentProgressBundle";

// ---- Cache read/refresh -----------------------------------------------

// Returns the cached { [assignmentId]: doc } map, or {} if nothing cached yet.
export async function getCachedAssignmentProgress() {
  const { [ASSIGNMENT_PROGRESS_CACHE_KEY]: bundle } =
    await chrome.storage.local.get(ASSIGNMENT_PROGRESS_CACHE_KEY);
  return bundle?.progress ?? {};
}

// Full pull from Firestore. Writes to cache; storage.onChanged fires
// re-render on any listening page.
export async function refreshAssignmentProgress(netID) {
  try {
    const docs = await fetchCollection(`students/${netID}/assignmentProgress`);
    const progress = {};
    for (const d of docs) {
      if (typeof d?.assignmentId === "string") {
        progress[d.assignmentId] = d;
      }
    }
    await chrome.storage.local.set({
      [ASSIGNMENT_PROGRESS_CACHE_KEY]: { progress, syncedAt: Date.now() },
    });
  } catch (error) {
    console.error("[CS 393 Buddy] failed to refresh assignment progress:", error);
  }
}

// Update a single entry in the cache without a full refetch. Called
// after a client-side write so the UI reacts within a paint frame.
// Merges, matching what patchDoc does to Firestore. Replacing the entry
// would drop fields the caller didn't name — canvasSubmittedAt from an
// earlier cycle, say — leaving the cache disagreeing with the server
// until the next refresh, and the card rendering the wrong state in
// between.
async function patchLocalCache(assignmentId, doc) {
  const cached = await chrome.storage.local.get(ASSIGNMENT_PROGRESS_CACHE_KEY);
  const bundle = cached[ASSIGNMENT_PROGRESS_CACHE_KEY] ?? { progress: {} };
  const existing = bundle.progress?.[assignmentId] ?? {};
  bundle.progress = {
    ...(bundle.progress ?? {}),
    [assignmentId]: { ...existing, ...doc },
  };
  bundle.syncedAt = Date.now();
  await chrome.storage.local.set({ [ASSIGNMENT_PROGRESS_CACHE_KEY]: bundle });
}

// ---- Student-side writes ----------------------------------------------

// Student requests signoff on a performance or live-interview
// assignment. Preserves prior fields (retry chain history) via a
// pre-read of the existing doc.
export async function requestSignoff({
  netID,
  assignmentId,
  type,
  weekNum,
  // Who the student arranged this with. The request then only appears on
  // that person's queue — with several TAs, an unaddressed queue means
  // everyone sees everything and nobody knows whose it is.
  requestedTaNetID,
}) {
  const now = Date.now();
  // No read-before-write. patchDoc sends an updateMask naming only these
  // fields, so anything already on the doc is left untouched — the read
  // was spreading existing values back over themselves for no effect.
  //
  // It also cost a request that 404s the first time a student requests
  // anything, which is handled but shows up in the console looking like
  // a failure.
  //
  // Fields from a previous decision (graderRating, signoffHowLong) are
  // deliberately left in place: a re-request after a fail keeps the
  // history, and the next Pass overwrites them.
  const newDoc = {
    assignmentId,
    type,
    ...(Number.isFinite(weekNum) ? { weekNum } : {}),
    status: "requested",
    requestedAt: now,
    ...(requestedTaNetID ? { requestedTaNetID } : {}),
  };
  await patchDoc(`students/${netID}/assignmentProgress/${assignmentId}`, newDoc);
  await patchLocalCache(assignmentId, newDoc);
  return newDoc;
}

// ---- TA-side writes ---------------------------------------------------

// TA records the signoff decision. For live-interview, includes
// graderRating. For performance, no rating — just pass/fail. Passing
// caller's netID lets us record who signed off.
export async function recordSignoffDecision({
  studentNetID,
  taNetID,
  assignmentId,
  outcome, // "passed" | "failed"
  graderRating, // required for live-interview when outcome === "passed"
  note,
  // Details only the TA can supply, captured at signoff so the student's
  // own session can auto-submit to Canvas without asking them anything.
  // submitCanvasAssignment derives the student from the CALLER's token,
  // so a TA can't submit on their behalf — the TA records, the student's
  // client sends.
  signoffHowLong, // performance exam: how long it took
  signoffHowItWent, // live interview: the TA's summary
}) {
  const path = `students/${studentNetID}/assignmentProgress/${assignmentId}`;
  const now = Date.now();
  // Same as requestSignoff: no read-before-write. The updateMask names
  // only these fields and leaves the rest of the document alone.
  const newDoc = {
    assignmentId,
    status: outcome,
    signoffAt: now,
    ...(taNetID ? { signoffTaNetID: taNetID } : {}),
    ...(Number.isInteger(graderRating) ? { graderRating } : {}),
    ...(note ? { signoffNote: note } : {}),
    ...(signoffHowLong ? { signoffHowLong } : {}),
    ...(signoffHowItWent ? { signoffHowItWent } : {}),
  };
  await patchDoc(path, newDoc);
  await patchLocalCache(assignmentId, newDoc);
  return newDoc;
}
