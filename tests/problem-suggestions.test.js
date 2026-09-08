// The deterministic half of the suggestion feature. These are the rules
// a model never gets to override: what's excluded, what counts as
// on-topic, and how much variety a shortlist has to carry.
import { describe, it, expect } from "vitest";
import {
  topicProfile,
  scoreProblem,
  suggestProblems,
} from "../src/data/problem-suggestions.js";

// A small synthetic catalog. Deliberately tiny — the real one has 3,264
// problems and would make every expectation here a guess.
const problem = (slug, difficulty, topics, extra = {}) => ({
  slug,
  title: slug,
  difficulty,
  topics,
  acceptance: 60,
  id: 100,
  ...extra,
});

const catalog = {
  problems: [
    problem("tree-a", "Easy", ["tree", "depth-first-search"]),
    problem("tree-b", "Easy", ["tree", "depth-first-search"]),
    problem("tree-c", "Medium", ["tree", "depth-first-search"]),
    problem("grid-easy", "Easy", ["matrix", "breadth-first-search"]),
    problem("grid", "Medium", ["matrix", "breadth-first-search"]),
    problem("arr-1", "Easy", ["array"]),
    problem("arr-2", "Easy", ["array"]),
    problem("arr-3", "Medium", ["array"]),
    problem("arr-4", "Medium", ["array"]),
  ],
};

// By slug, not by index — an index-based fixture reference breaks the
// moment a problem is inserted above it, and the failure looks like a
// bug in the code under test rather than in the test.
const find = (slug) => catalog.problems.find((p) => p.slug === slug);

describe("topicProfile", () => {
  it("weights a tag by how characteristic it is, not how common", () => {
    // `array` is on half the catalog; `tree` is on three of eight. An
    // assigned set carrying both should rank `tree` higher, because
    // `array` says almost nothing about what the topic is.
    const profile = topicProfile([find("tree-a"), find("arr-1")], catalog);
    expect(profile.get("tree")).toBeGreaterThan(profile.get("array"));
  });

  it("normalises the strongest tag to 1", () => {
    const profile = topicProfile([find("tree-a")], catalog);
    expect(Math.max(...profile.values())).toBeCloseTo(1);
  });

  it("returns an empty profile rather than throwing on empty input", () => {
    expect(topicProfile([], catalog).size).toBe(0);
    expect(topicProfile([find("tree-a")], { problems: [] }).size).toBe(0);
  });
});

describe("scoreProblem", () => {
  const profile = new Map([["tree", 1]]);

  it("prefers the more approachable of two equally relevant problems", () => {
    const easy = problem("x", "Easy", ["tree"], { acceptance: 70 });
    const brutal = problem("y", "Easy", ["tree"], { acceptance: 20 });
    expect(scoreProblem(easy, profile)).toBeGreaterThan(scoreProblem(brutal, profile));
  });

  it("stops rewarding acceptance past the point it means 'trivial'", () => {
    const high = problem("x", "Easy", ["tree"], { acceptance: 75 });
    const absurd = problem("y", "Easy", ["tree"], { acceptance: 99 });
    expect(scoreProblem(absurd, profile)).toBe(scoreProblem(high, profile));
  });

  it("nudges toward long-standing problems", () => {
    const classic = problem("x", "Easy", ["tree"], { id: 200 });
    const recent = problem("y", "Easy", ["tree"], { id: 3200 });
    expect(scoreProblem(classic, profile)).toBeGreaterThan(scoreProblem(recent, profile));
  });
});

describe("suggestProblems", () => {
  const profile = new Map([
    ["tree", 1],
    ["depth-first-search", 0.9],
    ["breadth-first-search", 0.8],
    ["matrix", 0.6],
    ["array", 0.1],
  ]);

  it("never suggests something already solved or assigned", () => {
    const exclude = new Set(["tree-a", "tree-c"]);
    const out = suggestProblems({ catalog, profile, exclude, limit: 8 });
    expect(out.map((p) => p.slug)).not.toContain("tree-a");
    expect(out.map((p) => p.slug)).not.toContain("tree-c");
  });

  // The exclusion set is how future OA problems stay unseen. If this
  // ever silently stops applying, the recommender starts handing out
  // next week's assessment.
  it("excludes every slug it is given, even the highest scoring one", () => {
    const all = new Set(catalog.problems.map((p) => p.slug));
    expect(suggestProblems({ catalog, profile, exclude: all })).toEqual([]);
  });

  it("drops problems that only match generic tags", () => {
    // `array` sits at 0.1 — below the peak floor — so no amount of
    // approachability should let an array-only problem through.
    const out = suggestProblems({ catalog, profile, limit: 8 });
    expect(out.map((p) => p.slug)).not.toContain("arr-1");
  });

  it("does not fill the list with near-identical problems", () => {
    // tree-a and tree-b have identical tags and identical scores. Both
    // outrank grid-easy on relevance, so a pure ranking returns the pair
    // — which is the six-identical-tree-problems bug in miniature.
    const out = suggestProblems({
      catalog,
      profile,
      difficulties: ["Easy"],
      limit: 2,
    });
    expect(out).toHaveLength(2);
    expect(out.map((p) => p.slug).sort()).not.toEqual(["tree-a", "tree-b"]);
  });

  it("spreads picks across the requested difficulties", () => {
    const out = suggestProblems({
      catalog,
      profile,
      difficulties: ["Easy", "Medium"],
      limit: 4,
    });
    expect(out.some((p) => p.difficulty === "Easy")).toBe(true);
    expect(out.some((p) => p.difficulty === "Medium")).toBe(true);
  });

  it("returns the same shortlist every time", () => {
    const once = suggestProblems({ catalog, profile, limit: 5 });
    const twice = suggestProblems({ catalog, profile, limit: 5 });
    expect(once.map((p) => p.slug)).toEqual(twice.map((p) => p.slug));
  });

  it("explains each pick with the topics it actually matched", () => {
    const [first] = suggestProblems({ catalog, profile, limit: 1 });
    expect(first.matchedTopics.length).toBeGreaterThan(0);
    // Strongest first, so the UI and the model can lead with it.
    const weights = first.matchedTopics.map((t) => profile.get(t));
    expect([...weights].sort((a, b) => b - a)).toEqual(weights);
  });

  it("returns nothing rather than guessing when there is no profile", () => {
    expect(suggestProblems({ catalog, profile: new Map() })).toEqual([]);
    expect(suggestProblems({ catalog: { problems: [] }, profile })).toEqual([]);
    expect(suggestProblems()).toEqual([]);
  });
});
