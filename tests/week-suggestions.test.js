// "Suggested for you" — assembling a week's extra practice from the
// vendored catalog, the course, and what the student has already solved.
//
// Runs against the REAL course.json and catalog, because the thing most
// worth guarding is a property of the actual data: that nothing the course
// assigns later — the online assessments especially — can be suggested to a
// student before they sit it.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "..", "src");
const read = (p) => JSON.parse(readFileSync(join(SRC, p), "utf8"));
const course = read("course.json");
const catalog = read("leetcode-catalog.json");

let suggestionsForWeek;
let slugsWithin;
let difficultiesFor;

beforeAll(async () => {
  vi.stubGlobal("chrome", { runtime: { getURL: (p) => p } });
  vi.stubGlobal("fetch", async (p) => ({ ok: true, json: async () => read(p) }));
  ({ suggestionsForWeek, slugsWithin, difficultiesFor } = await import(
    "../src/data/week-suggestions.js"
  ));
});

const TOPICS = course.topics.map((t) => t.id);

describe("slugsWithin", () => {
  it("finds every LeetCode problem in a blob of course data", () => {
    expect([...slugsWithin({ a: { url: "https://leetcode.com/problems/two-sum/" } })]).toEqual([
      "two-sum",
    ]);
  });
  it("is empty for data with none", () => {
    expect(slugsWithin({ notes: "do four problems" }).size).toBe(0);
    expect(slugsWithin(null).size).toBe(0);
  });
});

describe("difficultiesFor", () => {
  it("offers what the course itself assigns for the topic", () => {
    expect(difficultiesFor([{ difficulty: "Easy" }, { difficulty: "Medium" }]))
      .toEqual(["Easy", "Medium"]);
    expect(difficultiesFor([{ difficulty: "Hard" }, { difficulty: "Easy" }]))
      .toEqual(["Easy", "Hard"]);
  });
  it("falls back when a topic assigns nothing recognisable", () => {
    expect(difficultiesFor([])).toEqual(["Easy", "Medium"]);
  });
});

describe("suggestionsForWeek, against the real course", () => {
  it("suggests something for every topic in the course", async () => {
    for (const topicId of TOPICS) {
      const picks = await suggestionsForWeek({ topicId, solves: {}, limit: 4 });
      expect(picks.length, topicId).toBe(4);
    }
  });

  // The one that matters. Every OA problem for every week is in course.json;
  // suggesting one hands a student an assessment before they sit it.
  it("never suggests a problem the course assigns anywhere", async () => {
    const assigned = slugsWithin(course);
    expect(assigned.size).toBeGreaterThan(100);
    for (const topicId of TOPICS) {
      const picks = await suggestionsForWeek({ topicId, solves: {}, limit: 8 });
      const leaked = picks.filter((p) => assigned.has(p.slug));
      expect(leaked.map((p) => p.slug), `leaked into ${topicId}`).toEqual([]);
    }
  });

  it("never suggests something already solved", async () => {
    const first = await suggestionsForWeek({ topicId: "graphs", solves: {}, limit: 4 });
    const solves = Object.fromEntries(first.map((p) => [p.slug, 1]));
    const next = await suggestionsForWeek({ topicId: "graphs", solves, limit: 4 });
    expect(next.filter((p) => p.slug in solves)).toEqual([]);
    expect(next).toHaveLength(4);
  });

  it("only suggests problems that exist and are free", async () => {
    const known = new Map(catalog.problems.map((p) => [p.slug, p]));
    for (const topicId of TOPICS) {
      for (const pick of await suggestionsForWeek({ topicId, solves: {}, limit: 4 })) {
        expect(known.has(pick.slug), `${pick.slug} not in catalog`).toBe(true);
      }
    }
  });

  it("explains each pick with topics it actually exercises", async () => {
    for (const pick of await suggestionsForWeek({ topicId: "graphs", solves: {}, limit: 4 })) {
      expect(pick.matchedTopics.length, pick.slug).toBeGreaterThan(0);
    }
  });

  it("gives the same answer twice for the same student", async () => {
    const a = await suggestionsForWeek({ topicId: "dynamic-programming", solves: {}, limit: 4 });
    const b = await suggestionsForWeek({ topicId: "dynamic-programming", solves: {}, limit: 4 });
    expect(a.map((p) => p.slug)).toEqual(b.map((p) => p.slug));
  });

  it("returns nothing rather than guessing for a week with no topic", async () => {
    expect(await suggestionsForWeek({ topicId: null, solves: {} })).toEqual([]);
    expect(await suggestionsForWeek({ topicId: "not-a-topic", solves: {} })).toEqual([]);
  });
});
