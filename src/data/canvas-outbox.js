// Submissions waiting to be sent to Canvas from the student's own browser.
//
// Why this exists: the course's Canvas token cannot create a submission for
// a student. Canvas reserves authorship to the author, and the token lacks
// become_user. The only thing that can submit as a student is the student's
// own logged-in Canvas session — which also satisfies the course rule that
// the extension never does anything a student couldn't do themselves.
//
// That session isn't always available when a submission is ready: a TA
// signs someone off while they're elsewhere, or they submit while signed
// out of Canvas. So a submission is queued, and sent the next time the
// student's browser is on Canvas.
//
// There is no separate queue table. The queue is a field on the progress
// doc the submission belongs to, and "pending" is derived:
//
//   pendingSubmission exists AND canvasSubmittedAt is not at or after it
//
// so it clears itself when the submission lands, works from any device,
// and cannot drift out of step with what Canvas actually has.
//
// Only the template INPUTS are stored, never rendered HTML. The body is
// rendered at send time by fillSubmissionTemplate — the same function the
// TA's grade comment uses — so both records carry identical text.

export function queuedSubmission({
  type,
  assignmentId,
  weekNum,
  data,
  submissionType = "online_text_entry",
  now = Date.now(),
}) {
  return {
    type,
    assignmentId,
    ...(Number.isFinite(weekNum) ? { weekNum } : {}),
    data: data ?? {},
    submissionType,
    queuedAt: now,
  };
}

export function isPending(progress) {
  const queued = progress?.pendingSubmission;
  if (!queued || !Number.isFinite(queued.queuedAt)) return false;
  const sent = progress?.canvasSubmittedAt;
  // Strictly "not yet sent for THIS queueing". A resubmission queues again
  // with a newer queuedAt, and must go even if an older send exists.
  return !(Number.isFinite(sent) && sent >= queued.queuedAt);
}

// Everything pending across a student's progress docs, oldest first so
// Canvas receives them in the order they happened.
export function pendingSubmissions(progressDocs) {
  return Object.values(progressDocs ?? {})
    .filter(isPending)
    .map((p) => p.pendingSubmission)
    .sort((a, b) => a.queuedAt - b.queuedAt);
}

// The form fields for Canvas's create-submission endpoint.
export function canvasSubmissionFields({ submissionType, body, url }) {
  if (submissionType === "online_url") {
    return [
      ["submission[submission_type]", "online_url"],
      ["submission[url]", url ?? ""],
    ];
  }
  return [
    ["submission[submission_type]", "online_text_entry"],
    ["submission[body]", body ?? ""],
  ];
}
