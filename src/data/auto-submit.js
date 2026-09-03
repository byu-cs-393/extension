// Deciding which TA-approved assignments should submit themselves.
//
// Performance exams and live interviews used to leave a "Submit to
// Canvas" button sitting on the card after a TA passed the student,
// asking them to re-enter facts the TA already knew. Now the TA records
// what only they know at signoff (how long it took, how it went) and the
// student's own session sends it.
//
// Why the student's session and not the TA's: submitCanvasAssignment
// derives the student from the CALLER's Firebase token and explicitly
// ignores any netID in the body. A TA pressing Pass would submit as
// themselves. So the TA records and the student's client sends — which
// means it happens the next time the student opens the dashboard, not
// the instant Pass is clicked.
//
// Pure functions: this decides WHAT to submit and with which fields.
// Actually sending it is the caller's job.
//
// Covered by tests/auto-submit.test.js.

// Only these two are TA-gated in a way that leaves nothing for the
// student to add. Peer and professional mocks stay manual — nobody signs
// those off, and the student is the only source for who they met and how
// it went.
const AUTO_SUBMIT_TYPES = new Set(["performance", "live-interview"]);

export function isAutoSubmitType(type) {
  return AUTO_SUBMIT_TYPES.has(type);
}

// Everything needed to send one submission, or null if this one isn't
// ready. Null is the normal case — most assignments, most of the time.
//
// Driven by the PROGRESS DOCUMENT, not by a week's cards. The dashboard
// only loads past and current weeks, but a student can request a signoff
// for a future week's exam from the full-course page — so scanning cards
// silently skipped exactly those, and the submission never went out. The
// progress doc already carries everything needed.
export function autoSubmission(progress) {
  if (!progress || !isAutoSubmitType(progress.type)) return null;
  if (!progress.assignmentId) return null;
  if (progress?.status !== "passed") return null;
  // Already sent for THIS signoff. Comparing timestamps rather than just
  // testing for a submission is what makes retakes work: a student who
  // fails, re-requests and passes again has a signoffAt newer than their
  // last submission, so the new result goes to Canvas. Testing presence
  // alone meant the first submission silently blocked every later one.
  //
  // Canvas grades the newest attempt, so the resubmission supersedes.
  if (alreadySubmittedForThisSignoff(progress)) return null;

  const date = new Date(progress.signoffAt ?? Date.now())
    .toISOString()
    .slice(0, 10);

  if (progress.type === "performance") {
    // No solution link. A TA watches this one happen, so their word plus
    // the recorded editor session is better evidence than a URL pasted in
    // afterwards — and it was the one field the TA couldn't supply, which
    // is what kept a manual step in the flow.
    return {
      assignmentId: progress.assignmentId,
      type: progress.type,
      weekNum: Number.isFinite(progress.weekNum) ? progress.weekNum : null,
      data: {
        date,
        workedWith: progress.signoffTaNetID ?? "",
        howLong: progress.signoffHowLong ?? "",
        attemptNum: attemptNumberFrom(progress),
      },
    };
  }

  // live-interview. Everything comes from the TA, and the rating is
  // labelled as theirs. There is no student self-rating: asking a student
  // to grade themselves after a TA had already signed them off was the
  // last thing keeping a manual step in this flow.
  return {
    assignmentId: progress.assignmentId,
    type: progress.type,
    weekNum: Number.isFinite(progress.weekNum) ? progress.weekNum : null,
    data: {
      date,
      howItWent: progress.signoffHowItWent ?? "",
      graderRating: Number.isInteger(progress.graderRating)
        ? String(progress.graderRating)
        : "",
    },
  };
}

function alreadySubmittedForThisSignoff(progress) {
  const submittedAt = progress?.canvasSubmittedAt;
  if (!Number.isFinite(submittedAt)) return false;
  const signoffAt = progress?.signoffAt;
  // No signoff timestamp to compare against — treat a submission as
  // covering it, rather than resubmitting on every dashboard load.
  if (!Number.isFinite(signoffAt)) return true;
  return submittedAt >= signoffAt;
}

// A student who failed and retook passed on a later attempt. Nothing
// counts attempts explicitly, so this reads the retry chain: a doc that
// was ever failed and is now passed took at least two.
function attemptNumberFrom(progress) {
  if (Number.isInteger(progress?.attemptNum)) return progress.attemptNum;
  return progress?.failedAt || progress?.signoffFailedCount ? 2 : 1;
}

// Everything awaiting submission, across every week. Takes the whole
// assignmentProgress map, so nothing is missed because its week hasn't
// started yet.
export function pendingAutoSubmissions(assignmentProgress) {
  return Object.values(assignmentProgress ?? {})
    .map((progress) => autoSubmission(progress))
    .filter(Boolean);
}
