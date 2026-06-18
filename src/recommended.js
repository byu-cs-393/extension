// Per-week assignment catalog.
//
// Each week lives at `classes/{CLASS_ID}/weeks/{weekNum}` in Firestore
// with `weekNum`, `startDate` (Monday 00:00, epoch ms), `endDate`
// (next Monday 00:00, exclusive), and `problems: [{slug, title,
// difficulty}, ...]`. Clients read from chrome.storage.local for instant
// render and refresh from Firestore in the background.
//
// On first run (subcollection empty), three test weeks are auto-seeded
// with dates computed from today — current week and the two prior. When
// the real semester starts, the professor wipes these and writes the
// real week docs (eventually via a small admin UI).
import { fetchCollection, patchDoc } from "./firestore.js";

const CLASS_ID = "cs393";
const WEEKS_PATH = `classes/${CLASS_ID}/weeks`;

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Default problem list used to seed every freshly-created week. The
// professor will replace per-week later.
const DEFAULT_PROBLEMS = [
  { slug: "min-cost-climbing-stairs", title: "Min Cost Climbing Stairs", difficulty: "Easy" },
  { slug: "climbing-stairs", title: "Climbing Stairs", difficulty: "Easy" },
  { slug: "coin-change", title: "Coin Change", difficulty: "Medium" },
  { slug: "coin-change-ii", title: "Coin Change II", difficulty: "Medium" },
  { slug: "range-sum-query-immutable", title: "Range Sum Query - Immutable", difficulty: "Easy" },
  { slug: "range-sum-query-2d-immutable", title: "Range Sum Query 2D - Immutable", difficulty: "Medium" },
  { slug: "sum-of-distances", title: "Sum of Distances", difficulty: "Hard" },
];

function mondayOf(timestampMs) {
  const d = new Date(timestampMs);
  const dow = d.getDay(); // 0 = Sunday, 1 = Monday, ...
  const daysFromMonday = (dow + 6) % 7;
  d.setDate(d.getDate() - daysFromMonday);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Generate three weeks centered on `now`: previous two and current.
// Used as the auto-seed payload when the subcollection is empty.
function makeSeedWeeks(now) {
  const currentMonday = mondayOf(now);
  return [4, 5, 6].map((weekNum, i) => ({
    weekNum,
    startDate: currentMonday - (2 - i) * ONE_WEEK_MS,
    endDate: currentMonday - (1 - i) * ONE_WEEK_MS,
    problems: DEFAULT_PROBLEMS,
  }));
}

// ---- Public API ---------------------------------------------------------

// Cached weeks. Empty array if none cached yet — caller should call
// refreshWeeks() to load from Firestore.
export async function getWeeks() {
  const { weeksCatalog } = await chrome.storage.local.get("weeksCatalog");
  const cached = weeksCatalog?.weeks;
  return Array.isArray(cached) ? cached : [];
}

// Fetch all week docs from Firestore. If none exist, auto-seed three
// test weeks. Writes the result to chrome.storage.local; any listening
// surface re-renders via storage.onChanged.
export async function refreshWeeks() {
  try {
    const docs = await fetchCollection(WEEKS_PATH);
    let weeks = docs
      .filter(
        (d) =>
          Number.isFinite(d?.weekNum) &&
          Number.isFinite(d?.startDate) &&
          Number.isFinite(d?.endDate) &&
          Array.isArray(d?.problems)
      )
      .map((d) => ({
        weekNum: d.weekNum,
        startDate: d.startDate,
        endDate: d.endDate,
        problems: d.problems,
      }));

    if (weeks.length === 0) {
      weeks = makeSeedWeeks(Date.now());
      for (const w of weeks) {
        await patchDoc(`${WEEKS_PATH}/${w.weekNum}`, w);
      }
      console.log(`[CS 393 Buddy] seeded ${WEEKS_PATH} with ${weeks.length} test weeks`);
    }

    weeks.sort((a, b) => a.weekNum - b.weekNum);
    await cacheWeeks(weeks);
  } catch (error) {
    console.error("[CS 393 Buddy] failed to refresh weeks:", error);
  }
}

async function cacheWeeks(weeks) {
  await chrome.storage.local.set({
    weeksCatalog: { weeks, syncedAt: Date.now() },
  });
}

// ---- Week classification + per-week helpers -----------------------------

// "current" | "past" | "future" relative to now.
export function classifyWeek(week, now = Date.now()) {
  if (week.endDate <= now) return "past";
  if (week.startDate > now) return "future";
  return "current";
}

export function getCurrentWeek(weeks, now = Date.now()) {
  return weeks.find((w) => w.startDate <= now && now < w.endDate) ?? null;
}

// Set of slugs solved inside this week's window.
export function solvedSlugsInWeek(week, solvesBundle) {
  const solves = solvesBundle?.solves ?? {};
  return new Set(
    Object.entries(solves)
      .filter(([, ts]) => ts >= week.startDate && ts < week.endDate)
      .map(([slug]) => slug)
  );
}

// First problem in `week.problems` not yet solved during the week, or
// null if everything is done.
export function firstUnsolved(week, solvesBundle) {
  const solved = solvedSlugsInWeek(week, solvesBundle);
  return week.problems.find((p) => !solved.has(p.slug)) ?? null;
}
