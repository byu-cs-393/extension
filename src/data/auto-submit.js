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

// Everything needed to send one submission, or null if this item isn't
// ready. Null is the normal case — most cards, most of the time.
//
// `solutionUrls` is { slug -> accepted submission URL } from the tracker.
// Each performance exam names one problem in course.json, so the passing
// solution can be looked up rather than typed.
export function autoSubmission(item, progress, { solutionUrls = {} } = {}) {
  if (!item || !isAutoSubmitType(item.type)) return null;
  if (!item.assignmentId) return null;
  if (progress?.status !== "passed") return null;
  // Already sent. Resubmission stays possible from the card, but it isn't
  // automatic — re-sending on every dashboard load would spam Canvas with
  // a fresh attempt each time.
  if (progress?.canvasSubmittedAt) return null;

  const date = new Date(progress.signoffAt ?? Date.now())
    .toISOString()
    .slice(0, 10);

  if (item.type === "performance") {
    const slug = leetcodeSlug(item.assignment?.question?.url);
    return {
      assignmentId: item.assignmentId,
      type: item.type,
      data: {
        date,
        workedWith: progress.signoffTaNetID ?? "",
        howLong: progress.signoffHowLong ?? "",
        attemptNum: attemptNumberFrom(progress),
        acceptedUrl: (slug ? solutionUrls[slug] : null) ?? "",
      },
    };
  }

  // live-interview. The student's own 1/2/3 self-rating is deliberately
  // NOT filled from the TA's grader rating — they measure different
  // things, and putting the TA's number in a field labelled "self-rating"
  // would misreport who said it. It goes out blank and fills in when the
  // student rates, which triggers a resubmission.
  return {
    assignmentId: item.assignmentId,
    type: item.type,
    data: {
      date,
      howItWent: progress.signoffHowItWent ?? "",
      selfRating: progress.selfRating != null ? String(progress.selfRating) : "",
      acceptedUrl: "",
    },
  };
}

// A student who failed and retook passed on a later attempt. Nothing
// counts attempts explicitly, so this reads the retry chain: a doc that
// was ever failed and is now passed took at least two.
function attemptNumberFrom(progress) {
  if (Number.isInteger(progress?.attemptNum)) return progress.attemptNum;
  return progress?.failedAt || progress?.signoffFailedCount ? 2 : 1;
}

function leetcodeSlug(url) {
  const match = String(url ?? "").match(
    /^https:\/\/leetcode\.com\/problems\/([^/?#]+)/,
  );
  return match ? match[1] : null;
}

// Everything on a week that should submit itself, in one call.
export function pendingAutoSubmissions(items, assignmentProgress, options) {
  return (items ?? [])
    .map((item) =>
      autoSubmission(item, assignmentProgress?.[item?.assignmentId], options),
    )
    .filter(Boolean);
}
