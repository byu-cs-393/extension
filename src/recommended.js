// Recommended-problem catalog + week-window helpers.
//
// The catalog lives in Firestore at `classes/{CLASS_ID}.recommendedProblems`
// so an instructor can update the list without a code push. Clients read
// from chrome.storage.local for instant render and refresh from Firestore
// in the background. The first client to find a missing doc auto-seeds
// it with DEFAULT_PROBLEMS — convenient for dev, harmless because every
// client would seed the same data.
import { fetchDoc, patchDoc } from "./firestore.js";

const CLASS_ID = "cs393";
const CLASS_PATH = `classes/${CLASS_ID}`;

// Fallback used when Firestore is unreachable and there's no cache yet.
// Also used as the seed value for a missing class doc.
const DEFAULT_PROBLEMS = [
  { slug: "min-cost-climbing-stairs", title: "Min Cost Climbing Stairs", difficulty: "Easy" },
  { slug: "climbing-stairs", title: "Climbing Stairs", difficulty: "Easy" },
  { slug: "coin-change", title: "Coin Change", difficulty: "Medium" },
  { slug: "coin-change-ii", title: "Coin Change II", difficulty: "Medium" },
  { slug: "range-sum-query-immutable", title: "Range Sum Query - Immutable", difficulty: "Easy" },
  { slug: "range-sum-query-2d-immutable", title: "Range Sum Query 2D - Immutable", difficulty: "Medium" },
  { slug: "sum-of-distances", title: "Sum of Distances", difficulty: "Hard" },
];

// Cached catalog (instant render). May fall back to DEFAULT_PROBLEMS if
// neither cache nor Firestore is reachable.
export async function getRecommendedProblems() {
  const { recommendedCatalog } = await chrome.storage.local.get("recommendedCatalog");
  const cached = recommendedCatalog?.problems;
  return Array.isArray(cached) && cached.length ? cached : DEFAULT_PROBLEMS;
}

// Background refresh — fetch from Firestore, overwrite cache. Storage
// change fires a re-render in any listening surface (dashboard, popup).
// Auto-seeds the class doc with defaults if it doesn't exist yet.
export async function refreshRecommendedProblems() {
  try {
    const classDoc = await fetchDoc(CLASS_PATH);
    const fromCloud = Array.isArray(classDoc?.recommendedProblems)
      ? classDoc.recommendedProblems
      : null;

    if (fromCloud === null) {
      // No doc yet, or no `recommendedProblems` field — seed it.
      await patchDoc(CLASS_PATH, { recommendedProblems: DEFAULT_PROBLEMS });
      await cacheCatalog(DEFAULT_PROBLEMS);
      console.log(`[CS 393 Buddy] seeded ${CLASS_PATH} with default recommended catalog`);
      return;
    }

    await cacheCatalog(fromCloud);
  } catch (error) {
    console.error("[CS 393 Buddy] failed to refresh recommended catalog:", error);
  }
}

async function cacheCatalog(problems) {
  await chrome.storage.local.set({
    recommendedCatalog: { problems, syncedAt: Date.now() },
  });
}

// ---- Week-window helpers -----------------------------------------------

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

// First problem in `problems` that hasn't been solved this week, or null
// if everything is done.
export function firstUnsolved(cached, problems) {
  const solved = solvedSlugsThisWeek(cached);
  return problems.find((p) => !solved.has(p.slug)) ?? null;
}
