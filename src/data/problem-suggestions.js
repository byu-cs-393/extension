// Picking the "other problems" a student should work on this week.
//
// Every week in course.json has an `outside` placement for self-directed
// work, and in 9 of the 14 weeks it says some version of "do 4 other
// problems" with no problems named. This module fills that in.
//
// It is deliberately the DETERMINISTIC half of the suggestion feature.
// Nothing here calls a model, needs a key, or touches the network: given
// the same inputs it returns the same shortlist, which means it can be
// tested, reasoned about, and debugged from a stack trace. The model's
// job comes after — ranking this shortlist and writing the one-line
// "why this one, for you" — and it can only choose from what it's given.
//
// The whole module is pure. It takes the catalog and the student's
// history as arguments rather than reading them, so tests can hand it
// five problems and a fake profile instead of 3,264 real ones.

// ---- Topic profiles ------------------------------------------------------

// A "profile" is the fingerprint of a course topic in LeetCode's tag
// vocabulary: Map<tag, weight 0..1>, where 1.0 is the tag most
// characteristic of that topic.
//
// The course has 4 broad topics; LeetCode has 172 tags. Rather than
// hand-maintain a mapping between them — which would rot the moment the
// professor swapped a problem — the profile is DERIVED from the problems
// the course already assigns for that topic. The professor's choices
// define what the topic means, and the mapping updates itself when he
// changes them.
//
// Raw tag counts don't work: `array` and `hash-table` are attached to a
// third of all problems, so they dominate every topic and make graph
// week look like array week. The weighting below is TF-IDF — a tag
// counts for more when it's common HERE and rare in the catalog at
// large. That's what pushes `depth-first-search` to the top of the
// graphs profile and drops `array` out of it entirely.
export function topicProfile(assignedProblems, catalog) {
  const problems = catalog?.problems ?? [];
  if (assignedProblems.length === 0 || problems.length === 0) return new Map();

  // How many problems in the whole catalog carry each tag.
  const documentFrequency = new Map();
  for (const problem of problems) {
    for (const tag of problem.topics ?? []) {
      documentFrequency.set(tag, (documentFrequency.get(tag) ?? 0) + 1);
    }
  }

  const weights = new Map();
  for (const problem of assignedProblems) {
    for (const tag of problem.topics ?? []) {
      // +1 so a tag appearing on every problem still scores above zero,
      // and a tag somehow absent from the catalog can't divide by zero.
      const idf = Math.log(problems.length / ((documentFrequency.get(tag) ?? 0) + 1));
      weights.set(tag, (weights.get(tag) ?? 0) + idf);
    }
  }

  // Normalise so the strongest tag is 1.0. Profiles for topics with more
  // assigned problems would otherwise outweigh smaller ones for reasons
  // that have nothing to do with the topic.
  const strongest = Math.max(...weights.values());
  if (!Number.isFinite(strongest) || strongest <= 0) return new Map();
  for (const [tag, weight] of weights) weights.set(tag, weight / strongest);
  return weights;
}

// ---- Scoring -------------------------------------------------------------

// How well one problem matches a topic profile, 0..~1.
//
// Divided by sqrt(tag count) rather than the count itself: a problem
// tagged with six things shouldn't beat a focused one just by collecting
// partial credit, but dividing by the full count over-punishes richly
// tagged problems, which are often the interesting ones.
function relevance(problem, profile) {
  const tags = problem.topics ?? [];
  if (tags.length === 0) return 0;
  const total = tags.reduce((sum, tag) => sum + (profile.get(tag) ?? 0), 0);
  return total / Math.sqrt(tags.length);
}

// Acceptance rate, flattened above 70%. A problem almost nobody passes
// is a bad suggestion for extra practice, but past a point a high rate
// stops meaning "approachable" and starts meaning "trivial", so the
// scale stops rewarding it.
function approachability(problem) {
  return Math.min(problem.acceptance ?? 50, 70) / 70;
}

// A mild preference for long-standing problems. Low-numbered problems
// are the canon interview prep is built around: they have editorials,
// discussion, and video walkthroughs, which matters a lot when a student
// is stuck at 11pm with no TA. It's weighted lightly — enough to break a
// tie toward Two Sum's neighbourhood, not enough to bury everything
// written after 2020.
function canonical(problem) {
  const id = problem.id ?? 9999;
  return id <= 1000 ? 1 : id <= 2000 ? 0.6 : 0.3;
}

export function scoreProblem(problem, profile) {
  return (
    0.65 * relevance(problem, profile) +
    0.2 * approachability(problem) +
    0.15 * canonical(problem)
  );
}

// ---- Diversity -----------------------------------------------------------

// How much two problems overlap, by tags (Jaccard). Used to keep the
// shortlist from being six of the same problem.
function similarity(a, b) {
  const left = new Set(a.topics ?? []);
  const right = b.topics ?? [];
  if (left.size === 0 || right.length === 0) return 0;
  const shared = right.filter((tag) => left.has(tag)).length;
  return shared / (left.size + right.length - shared);
}

// Greedy selection that trades a little score for variety.
//
// Scoring alone produced six binary-tree traversals with identical tag
// sets and identical scores — technically the best matches, useless as a
// week's practice. Each pick is therefore penalised by how much it looks
// like something already picked, so the list moves on once a shape is
// covered.
function selectDiverse(candidates, limit, diversityWeight = 0.5) {
  const picked = [];
  const pool = [...candidates];
  while (picked.length < limit && pool.length > 0) {
    let bestIndex = 0;
    let bestValue = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const overlap = picked.reduce(
        (worst, chosen) => Math.max(worst, similarity(pool[i], chosen)),
        0,
      );
      const value = pool[i].score - diversityWeight * overlap;
      if (value > bestValue) {
        bestValue = value;
        bestIndex = i;
      }
    }
    picked.push(pool[bestIndex]);
    pool.splice(bestIndex, 1);
  }
  return picked;
}

// ---- The shortlist -------------------------------------------------------

const DIFFICULTY_ORDER = ["Easy", "Medium", "Hard"];

// Narrow the catalog to a handful of problems worth suggesting.
//
//   catalog       the vendored problem list
//   profile       Map<tag, weight> from topicProfile()
//   exclude       Set<slug> — everything already solved, plus everything
//                 the course assigns in ANY week. That second part is
//                 not an optimisation: the OA problems for later weeks
//                 are all sitting in course.json, and suggesting one
//                 hands a student next week's assessment.
//   difficulties  which tiers to draw from, in the order they should be
//                 offered. Quotas are spread evenly across them.
//   limit         how many to return
//   minRelevance  floor on overall topic match — better to return four
//                 problems than to pad the list with things off-topic
//   minPeakRelevance
//                 floor on the SINGLE strongest tag match, so a problem
//                 has to hit something characteristic of the week rather
//                 than scraping past on generic tags
export function suggestProblems({
  catalog,
  profile,
  exclude = new Set(),
  difficulties = ["Easy", "Medium"],
  limit = 12,
  minRelevance = 0.25,
  minPeakRelevance = 0.5,
  diversityWeight = 0.9,
} = {}) {
  const problems = catalog?.problems ?? [];
  if (problems.length === 0 || !profile || profile.size === 0) return [];

  const wanted = new Set(difficulties);
  const scored = [];
  for (const problem of problems) {
    if (exclude.has(problem.slug)) continue;
    if (!wanted.has(problem.difficulty)) continue;
    const match = relevance(problem, profile);
    if (match < minRelevance) continue;
    // A problem must exercise something CHARACTERISTIC of the week, not
    // just accumulate partial credit from generic tags. Without this,
    // "Roman to Integer" was a top suggestion for dynamic-programming
    // week: it matched only `math` and `string` faintly, then rode the
    // approachability and canonical bonuses to the top. Relevance alone
    // can be bought with enough weak tags; a peak can't.
    const peak = Math.max(
      0,
      ...(problem.topics ?? []).map((tag) => profile.get(tag) ?? 0),
    );
    if (peak < minPeakRelevance) continue;
    scored.push({
      ...problem,
      score: scoreProblem(problem, profile),
      relevance: match,
      // Which of the week's topics this problem actually exercises,
      // strongest first. The UI shows it, and the model gets it as the
      // grounds for its explanation — so "why this one" is answered
      // from data rather than invented.
      matchedTopics: (problem.topics ?? [])
        .filter((tag) => (profile.get(tag) ?? 0) > 0.2)
        .sort((a, b) => (profile.get(b) ?? 0) - (profile.get(a) ?? 0)),
    });
  }

  // Stable ordering. Ties on score are common — identical tag sets score
  // identically — and an arbitrary tie-break would make the shortlist
  // change between runs for no reason a student could understand.
  scored.sort((a, b) => b.score - a.score || a.id - b.id);

  // Fill each difficulty separately so a week can't come back as twelve
  // Easies. Any quota a tier can't fill is left to the others.
  const perTier = Math.ceil(limit / Math.max(difficulties.length, 1));
  const chosen = [];
  for (const difficulty of difficulties) {
    const tier = scored.filter((p) => p.difficulty === difficulty);
    chosen.push(...selectDiverse(tier, perTier, diversityWeight));
  }
  if (chosen.length < limit) {
    const already = new Set(chosen.map((p) => p.slug));
    const rest = scored.filter((p) => !already.has(p.slug));
    chosen.push(...selectDiverse(rest, limit - chosen.length, diversityWeight));
  }

  return chosen
    .sort(
      (a, b) =>
        DIFFICULTY_ORDER.indexOf(a.difficulty) - DIFFICULTY_ORDER.indexOf(b.difficulty) ||
        b.score - a.score ||
        a.id - b.id,
    )
    .slice(0, limit);
}
