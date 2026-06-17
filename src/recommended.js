// Shared catalog of recommended problems + week-window helpers. Used by
// the dashboard's Week 6 card and the toolbar popup. Eventually this
// list will come from per-class Firestore config.
//
// Difficulties are best-guess; double-check on LeetCode if it matters.
export const RECOMMENDED_PROBLEMS = [
  { slug: "min-cost-climbing-stairs", title: "Min Cost Climbing Stairs", difficulty: "Easy" },
  { slug: "climbing-stairs", title: "Climbing Stairs", difficulty: "Easy" },
  { slug: "coin-change", title: "Coin Change", difficulty: "Medium" },
  { slug: "coin-change-ii", title: "Coin Change II", difficulty: "Medium" },
  { slug: "range-sum-query-immutable", title: "Range Sum Query - Immutable", difficulty: "Easy" },
  { slug: "range-sum-query-2d-immutable", title: "Range Sum Query 2D - Immutable", difficulty: "Medium" },
  { slug: "sum-of-distances", title: "Sum of Distances", difficulty: "Hard" },
];

// Monday 00:00 (local time) of the current week, in epoch ms.
export function getCurrentWeekStart() {
  const now = new Date();
  const dow = now.getDay(); // 0 = Sunday, 1 = Monday, ...
  const daysFromMonday = (dow + 6) % 7;
  const monday = new Date(now);
  monday.setDate(now.getDate() - daysFromMonday);
  monday.setHours(0, 0, 0, 0);
  return monday.getTime();
}

export function getCurrentWeekEnd() {
  return getCurrentWeekStart() + 7 * 24 * 60 * 60 * 1000;
}

// Given the cached `solvedProblems` bundle ({ solves: { slug: ts }, ...}),
// return a Set of slugs that count as solved during the current week.
export function solvedSlugsThisWeek(cached) {
  const start = getCurrentWeekStart();
  const end = getCurrentWeekEnd();
  const solves = cached?.solves ?? {};
  return new Set(
    Object.entries(solves)
      .filter(([, ts]) => ts >= start && ts < end)
      .map(([slug]) => slug)
  );
}

// First recommended problem not yet solved this week, or null if all done.
export function firstUnsolved(cached) {
  const solved = solvedSlugsThisWeek(cached);
  return RECOMMENDED_PROBLEMS.find((p) => !solved.has(p.slug)) ?? null;
}
