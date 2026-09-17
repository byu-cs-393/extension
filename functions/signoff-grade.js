// What score a TA signoff puts into Canvas.
//
// Kept apart from index.js so the rule can be tested without Firebase, and
// so there is exactly one place deciding how a Pass becomes points.
//
// Only a TA's decision ever reaches here — gradeSignoff refuses callers
// without the `role: ta` claim. The course's standing rule is that the
// extension never lets a student do anything they couldn't do themselves
// in Canvas, and a student cannot grade their own work.

// Types graded from a signoff. A student cannot self-grade any of these;
// every one is observed by a TA.
const SIGNOFF_TYPES = new Set(["performance", "live-interview"]);

// Returns the score to post, or null to post nothing.
//
//   performance     pass/fail observed by a TA — full marks on a Pass
//   live-interview  the TA's 1–3 grader rating is the score (3 points)
//
// A Fail posts nothing on purpose. Both types allow retakes, so writing a
// zero would stamp a grade the student may yet replace, and would look to
// them like a final result.
function signoffScore({ type, outcome, graderRating, pointsPossible }) {
  if (!SIGNOFF_TYPES.has(type)) return null;
  if (outcome !== "passed") return null;

  const max = Number(pointsPossible);
  if (!Number.isFinite(max) || max <= 0) return null;

  if (type === "performance") return max;

  // live-interview: the rating must be a whole number the assignment can
  // hold. Anything else is refused rather than rounded — a rating of 7 on a
  // 3-point assignment is a bug upstream, not a score to clamp into range.
  const rating = Number(graderRating);
  if (!Number.isInteger(rating) || rating < 1 || rating > max) return null;
  return rating;
}

module.exports = { SIGNOFF_TYPES, signoffScore };
