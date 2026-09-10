// Reading a connection code back out of a Canvas submission.
//
// How onboarding proves identity, end to end:
//
//   1. The extension generates a random code and shows it to the student
//   2. The student pastes it into the "Connect Your Account" assignment
//      in Canvas and submits — from their own browser, their own session
//   3. The extension sends (netID, code) to verifyStudent
//   4. verifyStudent reads that student's submission with the course's
//      Canvas token and checks the code is there
//
// Step 2 is the whole proof. Canvas attributes a submission to the
// authenticated user who made it, and nobody can submit as somebody
// else. So a code sitting in student X's submission means whoever put it
// there controlled X's Canvas session. Step 4 observes that
// independently, with a credential the student doesn't influence.
//
// What this replaced, and why: verification used to compare identifiers
// the student's own browser reported. That can't work — the extension
// loads unpacked, so a student can edit it, and they can skip it and
// call the function directly anyway. Nothing self-reported is evidence.
// Later attempts foundered on Canvas permissions: a TA token can't
// resolve a netID through SIS, can't read anyone else's lti_user_id, and
// can't masquerade on the profile endpoint. All three were tested. The
// submission channel needs none of them.

// Canvas wraps online_text_entry submissions in HTML, so what comes back
// is more like "<p>7F3K-92QR</p>\n" than the raw string. Students also
// paste with stray whitespace, smart quotes from a word processor, or a
// lowercased retype. Normalising to bare uppercase alphanumerics makes
// all of that irrelevant while keeping the code's actual entropy.
function normalizeCode(value) {
  if (typeof value !== "string") return "";
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// Codes are 8 characters from a 32-symbol alphabet. Anything shorter
// isn't one of ours, and being strict here means a student who submits
// "done" or "I connected my account" gets a clear failure rather than a
// confusing partial match.
const CODE_LENGTH = 8;

// Pull the code out of a submission body.
//
// Deliberately does NOT just normalise the whole body and compare: a
// student who writes "my code is 7F3K-92QR thanks!" would otherwise
// normalise to MYCODEIS7F3K92QRTHANKS and fail. Find the code inside
// whatever they wrote instead.
function extractCodeFromSubmission(body, expectedCode) {
  const expected = normalizeCode(expectedCode);
  if (expected.length !== CODE_LENGTH) return null;

  // Strip tags, then decode the entities Canvas's editor introduces.
  // &amp; must come last or it double-decodes.
  const text = String(body ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&");

  const normalized = normalizeCode(text);
  return normalized.includes(expected) ? expected : null;
}

// Whether a submission proves possession of this code.
//
// The comparison is over normalised forms, so presentation differences
// (case, the dash, surrounding prose) don't matter — only the characters
// the student actually pasted.
function submissionMatchesCode(body, expectedCode) {
  return extractCodeFromSubmission(body, expectedCode) !== null;
}

module.exports = {
  CODE_LENGTH,
  normalizeCode,
  extractCodeFromSubmission,
  submissionMatchesCode,
};
