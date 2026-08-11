// Weekly Study point arithmetic, from the professor's rubric in
// ../course/weekly/README.md:
//
//     13 pts/week
//      4  Collaborative study — 4 hrs
//      4  Required and "in class" problems done
//      5  Personal study — 5 hrs
//
// Both hour lines work out to 1 point per hour up to their cap, and the
// problems line is prorated by how many of the week's assigned problems
// were actually solved.
//
// This is a SUGGESTION printed into the submission so a grader can read
// the number off instead of recomputing it. It is not authoritative and
// the submission says so: the hours are self-reported, and only the
// grader can judge whether the work behind them was real.
//
// Covered by tests/study-points.test.js.

export const STUDY_TOTAL_POINTS = 13;
export const COLLAB_MAX_POINTS = 4;
export const PROBLEMS_MAX_POINTS = 4;
export const PERSONAL_MAX_POINTS = 5;

// Half points — fine enough that prorating problems isn't lost to
// rounding, coarse enough that a grader isn't reading three decimals.
function roundToHalf(n) {
  return Math.round(n * 2) / 2;
}

function hoursToPoints(hours, max) {
  const n = Number(hours);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return roundToHalf(Math.min(n, max));
}

// Returns { collaborative, problems, personal, total, max, lines } where
// each entry is { points, max, detail } and `lines` is a ready-to-render
// ordered list.
export function studyPointsBreakdown({
  collabHours,
  personalHours,
  solvedCount,
  totalCount,
} = {}) {
  const collaborative = {
    label: "Collaborative study",
    points: hoursToPoints(collabHours, COLLAB_MAX_POINTS),
    max: COLLAB_MAX_POINTS,
    detail: `${formatHours(collabHours)} reported`,
  };

  const total = Number(totalCount);
  const solved = Number(solvedCount);
  const hasProblems = Number.isFinite(total) && total > 0;
  const solvedSafe = Number.isFinite(solved) ? Math.max(0, Math.min(solved, total)) : 0;
  const problems = {
    label: "Required + in-class problems",
    // No assigned problems is full marks, not zero — the student can't
    // be penalised for a week that didn't ask for any.
    points: hasProblems
      ? roundToHalf((PROBLEMS_MAX_POINTS * solvedSafe) / total)
      : PROBLEMS_MAX_POINTS,
    max: PROBLEMS_MAX_POINTS,
    detail: hasProblems
      ? `${solvedSafe} of ${total} solved`
      : "none assigned this week",
  };

  const personal = {
    label: "Personal study",
    points: hoursToPoints(personalHours, PERSONAL_MAX_POINTS),
    max: PERSONAL_MAX_POINTS,
    detail: `${formatHours(personalHours)} reported`,
  };

  const lines = [collaborative, problems, personal];
  return {
    collaborative,
    problems,
    personal,
    lines,
    total: roundToHalf(lines.reduce((sum, l) => sum + l.points, 0)),
    max: STUDY_TOTAL_POINTS,
  };
}

function formatHours(hours) {
  const n = Number(hours);
  if (!Number.isFinite(n) || n < 0) return "0 hrs";
  // "1 hr", "1.5 hrs", "4 hrs" — drop a trailing .0.
  const text = Number.isInteger(n) ? String(n) : String(n);
  return `${text} ${n === 1 ? "hr" : "hrs"}`;
}
