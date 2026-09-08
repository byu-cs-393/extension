// The two pure pieces of the client layer, tested against the real
// course.json and the real catalog. Everything else in suggestions.js is
// chrome/fetch glue.
//
// These matter because they decide what a student is NOT shown.
import { describe, it, expect } from "vitest";
import { assignedSlugs, profileForTopic } from "../src/data/suggestions.js";
import { suggestProblems } from "../src/data/problem-suggestions.js";
import course from "../src/course.json";
import catalog from "../src/leetcode-catalog.json";

describe("assignedSlugs", () => {
  it("collects the problems the course assigns", () => {
    const slugs = assignedSlugs(course);
    expect(slugs.size).toBeGreaterThan(100);
    expect(slugs.has("lru-cache")).toBe(true);       // week 2, in class
  });

  // The exclusion set has to span the whole file, not the current week.
  // Every later week's OA problems are sitting in course.json, and a
  // suggestion that names one hands a student the assessment early.
  it("includes OA problems from every topic, not just early ones", () => {
    const slugs = assignedSlugs(course);
    const lastOa = course.oas[String(course.topics.length - 1)] ?? course.oas[course.topics.length - 1];
    const oaSlugs = (JSON.stringify(lastOa).match(/leetcode\.com\/problems\/([a-z0-9-]+)/g) ?? []).map(
      (m) => m.split("/").pop(),
    );
    expect(oaSlugs.length).toBeGreaterThan(0);
    for (const slug of oaSlugs) expect(slugs.has(slug)).toBe(true);
  });
});

describe("profileForTopic", () => {
  it("builds a profile that reflects the topic, for every course topic", () => {
    for (const topic of course.topics) {
      const profile = profileForTopic(course, catalog, topic.id);
      expect(profile.size, topic.id).toBeGreaterThan(0);
      expect(Math.max(...profile.values()), topic.id).toBeCloseTo(1);
    }
  });

  it("puts the expected tag at the top of each topic", () => {
    const strongest = (topicId) => {
      const profile = profileForTopic(course, catalog, topicId);
      return [...profile.entries()].sort((a, b) => b[1] - a[1])[0][0];
    };
    expect(strongest("graphs")).toBe("depth-first-search");
    expect(strongest("dynamic-programming")).toBe("dynamic-programming");
    expect(strongest("sorting-two-pointer")).toBe("sorting");
    expect(strongest("data-structures")).toBe("linked-list");
  });

  it("returns an empty profile for a topic that isn't in the course", () => {
    expect(profileForTopic(course, catalog, "quantum-computing").size).toBe(0);
  });
});

describe("end to end, against real data", () => {
  // The failure this guards against is the one that would be least
  // visible in the UI: a suggestion the student is going to meet again
  // as an assessment question.
  it("never suggests a problem the course assigns", () => {
    const assigned = assignedSlugs(course);
    for (const topic of course.topics) {
      const picks = suggestProblems({
        catalog,
        profile: profileForTopic(course, catalog, topic.id),
        exclude: assigned,
        difficulties: ["Easy", "Medium"],
        limit: 10,
      });
      expect(picks.length, topic.id).toBeGreaterThan(0);
      for (const pick of picks) {
        expect(assigned.has(pick.slug), `${topic.id} suggested ${pick.slug}`).toBe(false);
      }
    }
  });

  it("never suggests a problem the student has already solved", () => {
    const solved = new Set(["invert-binary-tree", "island-perimeter", "counting-bits"]);
    const picks = suggestProblems({
      catalog,
      profile: profileForTopic(course, catalog, "graphs"),
      exclude: new Set([...assignedSlugs(course), ...solved]),
      difficulties: ["Easy", "Medium"],
      limit: 10,
    });
    for (const pick of picks) expect(solved.has(pick.slug)).toBe(false);
  });

  it("only suggests problems that exist in the catalog", () => {
    const known = new Set(catalog.problems.map((p) => p.slug));
    const picks = suggestProblems({
      catalog,
      profile: profileForTopic(course, catalog, "graphs"),
      exclude: assignedSlugs(course),
      limit: 10,
    });
    for (const pick of picks) expect(known.has(pick.slug)).toBe(true);
  });
});
