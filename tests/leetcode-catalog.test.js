// Integrity of the vendored problem catalog.
//
// The catalog is the guardrail on the suggestion feature: a model may
// only recommend problems that appear here, so anything wrong with this
// file becomes a wrong or dead recommendation in a student's dashboard.
// It's fetched by a script rather than hand-written, which makes it
// exactly the kind of file nobody reads before committing.
import { describe, it, expect } from "vitest";
import catalog from "../src/leetcode-catalog.json";
import course from "../src/course.json";

const DIFFICULTIES = ["Easy", "Medium", "Hard"];

describe("catalog shape", () => {
  it("carries a provenance stamp", () => {
    expect(catalog.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(catalog.source).toContain("leetcode.com");
  });

  it("has enough problems to be worth recommending from", () => {
    // A truncated fetch is the failure mode this catches — the fetch
    // script pages 100 at a time, and a silent short read used to leave
    // a catalog that looked fine at a glance.
    expect(catalog.problems.length).toBeGreaterThan(3000);
    expect(catalog.counts.problems).toBe(catalog.problems.length);
  });

  it("gives every problem the fields a recommendation needs", () => {
    for (const p of catalog.problems) {
      expect(typeof p.slug, p.slug).toBe("string");
      expect(p.slug.length, p.slug).toBeGreaterThan(0);
      expect(typeof p.title, p.slug).toBe("string");
      expect(DIFFICULTIES, p.slug).toContain(p.difficulty);
      expect(Array.isArray(p.topics), p.slug).toBe(true);
      expect(typeof p.acceptance, p.slug).toBe("number");
    }
  });

  it("has no duplicate slugs", () => {
    const seen = new Set();
    const dupes = [];
    for (const p of catalog.problems) {
      if (seen.has(p.slug)) dupes.push(p.slug);
      seen.add(p.slug);
    }
    expect(dupes).toEqual([]);
  });

  it("draws every topic tag from the declared topic list", () => {
    const declared = new Set(catalog.topics);
    const stray = catalog.problems
      .flatMap((p) => p.topics)
      .filter((t) => !declared.has(t));
    expect([...new Set(stray)]).toEqual([]);
  });
});

describe("catalog against the course", () => {
  // The recommender subtracts the assigned problems so it never suggests
  // work the course already requires. That subtraction is by slug, so a
  // slug present in course.json but absent here silently subtracts
  // nothing — and the student gets told to go do next week's OA problem.
  const assigned = [
    ...new Set(
      (JSON.stringify(course).match(/leetcode\.com\/problems\/([a-z0-9-]+)/g) ?? []).map(
        (m) => m.split("/").pop(),
      ),
    ),
  ];

  it("finds the course's problems in course.json at all", () => {
    expect(assigned.length).toBeGreaterThan(100);
  });

  it("contains every problem the course assigns", () => {
    const known = new Set(catalog.problems.map((p) => p.slug));
    expect(assigned.filter((slug) => !known.has(slug))).toEqual([]);
  });
});
