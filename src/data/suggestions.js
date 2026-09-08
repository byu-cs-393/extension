// Suggested extra problems for a week — the wiring between the pure
// scorer, the vendored catalog, and the Cloud Function that ranks.
//
// Shape of the whole feature, in order:
//
//   1. leetcode-catalog.json      3,264 real, free problems
//   2. problem-suggestions.js     narrows to ~10 on-topic candidates
//   3. /api/suggestProblems       orders 4 of them and says why
//   4. this module                caches the result and hands it to the UI
//
// Steps 1 and 2 are offline and deterministic. Step 3 is the only part
// that can fail, and when it does the shortlist from step 2 is still a
// good answer — it was already ranked — so the card degrades to problems
// without explanations rather than to nothing.
//
// Only step 4 lives here. The scoring rules are in
// problem-suggestions.js, deliberately free of chrome and fetch so they
// can be tested against a five-problem catalog.
import { topicProfile, suggestProblems } from "./problem-suggestions.js";
import { loadCourse, getCardsForWeek } from "./course-data.js";

const SUGGEST_URL = "https://cs393-496021.web.app/api/suggestProblems";
const CACHE_KEY = "suggestionsBundle";

// A week's suggestions stay put for a day even if nothing else changes.
// Without this, every dashboard open re-asks; with it, a student who
// solves something still gets a fresh list, because the shortlist
// fingerprint changes server-side and misses the cache there.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

let catalogPromise = null;

// Lazy, and inside the function rather than at module scope, so this
// module stays importable in Vitest without a chrome shim.
export async function loadCatalog() {
  if (!catalogPromise) {
    const url = chrome.runtime.getURL("leetcode-catalog.json");
    catalogPromise = fetch(url).then((response) => {
      if (!response.ok) {
        throw new Error(`leetcode-catalog.json fetch failed: ${response.status}`);
      }
      return response.json();
    });
  }
  return catalogPromise;
}

// Every LeetCode slug course.json mentions, in any week.
//
// This is the exclusion set, and its breadth is the point: the OA
// problems for every later week are in that file, so excluding only the
// current week would eventually suggest a student an assessment problem
// before they sat the assessment.
export function assignedSlugs(course) {
  const matches = JSON.stringify(course).match(/leetcode\.com\/problems\/([a-z0-9-]+)/g) ?? [];
  return new Set(matches.map((m) => m.split("/").pop()));
}

// The tag fingerprint of a course topic, built from the problems the
// course assigns for it. See topicProfile for why it's derived rather
// than written down.
export function profileForTopic(course, catalog, topicId) {
  const bySlug = new Map(catalog.problems.map((p) => [p.slug, p]));
  const weeks = course.schedule
    .filter((s) => s.topic === topicId && typeof s.week === "number")
    .map((s) => s.week);

  const slugs = new Set();
  for (const weekNum of weeks) {
    const week = course.weeks.find((w) => w.week === weekNum);
    if (!week) continue;
    for (const m of JSON.stringify(week.placements ?? {}).match(
      /leetcode\.com\/problems\/([a-z0-9-]+)/g,
    ) ?? []) {
      slugs.add(m.split("/").pop());
    }
  }

  // The topic's OA counts too — it's the clearest statement of what the
  // professor thinks the topic requires.
  const oaIndex = course.topics.findIndex((t) => t.id === topicId);
  const oa = course.oas?.[oaIndex] ?? course.oas?.[String(oaIndex)];
  if (oa) {
    for (const m of JSON.stringify(oa).match(/leetcode\.com\/problems\/([a-z0-9-]+)/g) ?? []) {
      slugs.add(m.split("/").pop());
    }
  }

  return topicProfile(
    [...slugs].map((s) => bySlug.get(s)).filter(Boolean),
    catalog,
  );
}

// What the model is told about this student. Everything is a count or a
// title already on the dashboard — nothing new is collected for this.
function buildSignals({ cards, solves, catalog }) {
  const solved = Object.keys(solves ?? {});
  const solvedSet = new Set(solved);
  const bySlug = new Map(catalog.problems.map((p) => [p.slug, p]));

  const assignedThisWeek = (
    JSON.stringify(cards?.placements ?? {}).match(/leetcode\.com\/problems\/([a-z0-9-]+)/g) ?? []
  ).map((m) => m.split("/").pop());

  // Which of the course's four topics this student has touched least,
  // measured over what they've actually solved.
  const tagCounts = new Map();
  for (const slug of solved) {
    for (const tag of bySlug.get(slug)?.topics ?? []) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }

  return {
    solvedAllTime: solved.length,
    assignedThisWeek: assignedThisWeek.length,
    solvedThisWeek: assignedThisWeek.filter((s) => solvedSet.has(s)).length,
    weakTopics: [...tagCounts.entries()]
      .filter(([, n]) => n <= 1)
      .slice(0, 5)
      .map(([tag]) => tag),
  };
}

async function readCache(weekNum) {
  const { [CACHE_KEY]: bundle } = await chrome.storage.local.get(CACHE_KEY);
  const entry = bundle?.[weekNum];
  if (!entry) return null;
  if (Date.now() - (entry.fetchedAt ?? 0) > CACHE_TTL_MS) return null;
  return entry;
}

async function writeCache(weekNum, picks) {
  const { [CACHE_KEY]: bundle } = await chrome.storage.local.get(CACHE_KEY);
  await chrome.storage.local.set({
    [CACHE_KEY]: { ...(bundle ?? {}), [weekNum]: { picks, fetchedAt: Date.now() } },
  });
}

// The one call the UI makes.
//
// Returns { picks, source } where source is "cache" | "model" |
// "offline". Never throws and never returns null: a card that can't
// explain itself is still better than a card that isn't there.
export async function getSuggestionsForWeek(weekNum, { idToken, solves, limit = 4 } = {}) {
  const cached = await readCache(weekNum).catch(() => null);
  if (cached) return { picks: cached.picks, source: "cache" };

  const [course, catalog, cards] = await Promise.all([
    loadCourse(),
    loadCatalog(),
    getCardsForWeek(weekNum),
  ]);

  const scheduled = course.schedule.find((s) => s.week === weekNum);
  const topicId = scheduled?.topic;
  if (!topicId) return { picks: [], source: "offline" };

  const shortlist = suggestProblems({
    catalog,
    profile: profileForTopic(course, catalog, topicId),
    // Solved AND assigned. Both, always — see assignedSlugs.
    exclude: new Set([...assignedSlugs(course), ...Object.keys(solves ?? {})]),
    difficulties: ["Easy", "Medium"],
    limit: 10,
  });
  if (shortlist.length === 0) return { picks: [], source: "offline" };

  // No token means no ranking, but the shortlist is already ordered by
  // the deterministic scorer, so hand back the top few unexplained.
  if (!idToken) return { picks: shortlist.slice(0, limit), source: "offline" };

  const week = course.weeks.find((w) => w.week === weekNum);
  try {
    const response = await fetch(SUGGEST_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({
        weekNum,
        week: {
          title: week?.title ?? null,
          topic: course.topics.find((t) => t.id === topicId)?.label ?? topicId,
          objectives: week?.objectives ?? [],
        },
        candidates: shortlist,
        signals: buildSignals({ cards, solves, catalog }),
        limit,
      }),
    });
    if (!response.ok) throw new Error(`suggestProblems ${response.status}`);
    const { picks } = await response.json();
    if (Array.isArray(picks) && picks.length > 0) {
      await writeCache(weekNum, picks).catch(() => {});
      return { picks, source: "model" };
    }
  } catch (error) {
    console.warn("[CS 393 Buddy] suggestions unavailable:", error);
  }

  return { picks: shortlist.slice(0, limit), source: "offline" };
}
