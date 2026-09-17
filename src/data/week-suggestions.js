// "Suggested for you" — the problems to work on beyond the assigned ones.
//
// Every week in course.json has an `outside` placement for self-directed
// work, and in 9 of the 14 weeks it says some version of "do 4 other
// problems" with none named. This answers that.
//
// Entirely deterministic and offline: it reads the vendored catalog and the
// student's own solves, and needs no API key. A model may later rank this
// shortlist and write a line about each pick, but the picks themselves are
// made here, so the feature works with or without one.
import { topicProfile, suggestProblems } from "./problem-suggestions.js";
import { loadCourse, getOA } from "./course-data.js";

let catalogPromise = null;
function loadCatalog() {
  catalogPromise ??= fetch(chrome.runtime.getURL("leetcode-catalog.json")).then(
    (response) => {
      if (!response.ok) throw new Error(`catalog fetch failed: ${response.status}`);
      return response.json();
    },
  );
  return catalogPromise;
}

// Every LeetCode problem mentioned anywhere in a blob of course data.
export function slugsWithin(value) {
  const text = JSON.stringify(value ?? null) ?? "";
  const found = text.match(/leetcode\.com\/problems\/([a-z0-9-]+)/g) ?? [];
  return new Set(found.map((url) => url.split("/").pop()));
}

// The difficulties worth suggesting for a topic: the ones the course itself
// assigns for it. A graphs week that never sets a Hard shouldn't start
// suggesting them, and a later topic that does shouldn't be held to Easy.
export function difficultiesFor(assignedProblems) {
  const present = new Set(assignedProblems.map((p) => p.difficulty));
  const ordered = ["Easy", "Medium", "Hard"].filter((d) => present.has(d));
  return ordered.length > 0 ? ordered : ["Easy", "Medium"];
}

// Returns the shortlist for a week, or [] when there's nothing sensible to
// suggest (no topic on the week, catalog missing, profile empty).
//
//   difficulty  "Easy" | "Medium" | "Hard", or "Any" to let the course's own
//               level decide. A student who explicitly asks for Hard gets
//               Hard, even on a topic the course never sets one for — they
//               asked, and every topic has plenty in the catalog.
//   seen        slugs already shown to this student, so "show another"
//               actually shows another.
export async function suggestionsForWeek({
  topicId,
  solves,
  limit = 4,
  difficulty = "Any",
  seen,
}) {
  if (!topicId) return [];

  let course;
  let catalog;
  try {
    [course, catalog] = await Promise.all([loadCourse(), loadCatalog()]);
  } catch (error) {
    // Suggestions are a bonus; never take the dashboard down for them.
    console.error("[CS 393 Buddy] couldn't load suggestion data:", error);
    return [];
  }

  const bySlug = new Map((catalog.problems ?? []).map((p) => [p.slug, p]));

  // What this topic MEANS is defined by the problems the course assigns for
  // it — its weeks plus its online assessment — rather than by a hand-kept
  // mapping from course topics to LeetCode tags.
  const topicSlugs = new Set();
  for (const entry of course.schedule ?? []) {
    if (entry.topic !== topicId || typeof entry.week !== "number") continue;
    const week = (course.weeks ?? []).find((w) => w.week === entry.week);
    if (week) for (const slug of slugsWithin(week.placements)) topicSlugs.add(slug);
  }
  const oa = await getOA(topicId);
  if (oa) for (const slug of slugsWithin(oa)) topicSlugs.add(slug);

  const assignedProblems = [...topicSlugs]
    .map((slug) => bySlug.get(slug))
    .filter(Boolean);
  const profile = topicProfile(assignedProblems, catalog);
  if (profile.size === 0) return [];

  // Exclude every problem the course names ANYWHERE, not just this week's.
  // The online assessments for later weeks are all in course.json, and
  // suggesting one hands a student an assessment before they sit it.
  const exclude = slugsWithin(course);
  for (const slug of Object.keys(solves ?? {})) exclude.add(slug);
  for (const slug of seen ?? []) exclude.add(slug);

  return suggestProblems({
    catalog,
    profile,
    exclude,
    difficulties:
      difficulty && difficulty !== "Any"
        ? [difficulty]
        : difficultiesFor(assignedProblems),
    limit,
  });
}
