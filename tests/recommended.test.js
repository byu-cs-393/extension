// Tests for the pure helpers exported by src/recommended.js.
import { describe, it, expect } from "vitest";
import {
  classifyWeek,
  getCurrentWeek,
  solvedSlugsInWeek,
  firstUnsolved,
} from "../src/recommended.js";

const week = {
  weekNum: 4,
  startDate: 1000,
  endDate: 2000,
  problems: [
    { slug: "two-sum", title: "Two Sum" },
    { slug: "valid-parentheses", title: "Valid Parentheses" },
    { slug: "3sum", title: "3Sum" },
  ],
};

describe("classifyWeek", () => {
  it("returns 'past' after the week has ended", () => {
    expect(classifyWeek(week, 2500)).toBe("past");
  });

  it("returns 'past' at the exact endDate (endDate is exclusive)", () => {
    expect(classifyWeek(week, 2000)).toBe("past");
  });

  it("returns 'future' before the week has started", () => {
    expect(classifyWeek(week, 500)).toBe("future");
  });

  it("returns 'current' during the week", () => {
    expect(classifyWeek(week, 1000)).toBe("current"); // inclusive start
    expect(classifyWeek(week, 1500)).toBe("current");
    expect(classifyWeek(week, 1999)).toBe("current");
  });
});

describe("getCurrentWeek", () => {
  const weeks = [
    { weekNum: 3, startDate: 0, endDate: 1000, problems: [] },
    { weekNum: 4, startDate: 1000, endDate: 2000, problems: [] },
    { weekNum: 5, startDate: 2000, endDate: 3000, problems: [] },
  ];

  it("returns the week that contains `now`", () => {
    expect(getCurrentWeek(weeks, 1500)).toBe(weeks[1]);
  });

  it("returns the boundary week at the exact startDate", () => {
    expect(getCurrentWeek(weeks, 1000)).toBe(weeks[1]);
  });

  it("returns null when no week is current", () => {
    expect(getCurrentWeek(weeks, 5000)).toBe(null);
  });

  it("returns null for an empty weeks list", () => {
    expect(getCurrentWeek([], 1500)).toBe(null);
  });
});

describe("solvedSlugsInWeek", () => {
  it("returns an empty set for missing or empty solves bundle", () => {
    expect(solvedSlugsInWeek(week, null).size).toBe(0);
    expect(solvedSlugsInWeek(week, {}).size).toBe(0);
    expect(solvedSlugsInWeek(week, { solves: {} }).size).toBe(0);
  });

  it("returns slugs solved during the week window", () => {
    const bundle = {
      solves: {
        "two-sum": 1500,
        "valid-parentheses": 1600,
      },
    };
    const solved = solvedSlugsInWeek(week, bundle);
    expect(solved.has("two-sum")).toBe(true);
    expect(solved.has("valid-parentheses")).toBe(true);
    expect(solved.size).toBe(2);
  });

  it("excludes solves before startDate", () => {
    const bundle = { solves: { "two-sum": 500 } };
    expect(solvedSlugsInWeek(week, bundle).size).toBe(0);
  });

  it("excludes solves at or after endDate (endDate is exclusive)", () => {
    const bundle = { solves: { "two-sum": 2000, "3sum": 2500 } };
    expect(solvedSlugsInWeek(week, bundle).size).toBe(0);
  });

  it("includes solves at the exact startDate (startDate is inclusive)", () => {
    const bundle = { solves: { "two-sum": 1000 } };
    const solved = solvedSlugsInWeek(week, bundle);
    expect(solved.has("two-sum")).toBe(true);
  });

  it("includes slugs solved during the window even if not on the week's problem list — filtering by week is the responsibility of the caller", () => {
    const bundle = { solves: { "climbing-stairs": 1500 } };
    // solvedSlugsInWeek is a time filter, not a slug-list filter.
    // Callers combine it with week.problems separately.
    expect(solvedSlugsInWeek(week, bundle).has("climbing-stairs")).toBe(true);
  });
});

describe("firstUnsolved", () => {
  it("returns the first problem when nothing is solved", () => {
    const bundle = { solves: {} };
    expect(firstUnsolved(week, bundle)?.slug).toBe("two-sum");
  });

  it("skips solved problems", () => {
    const bundle = { solves: { "two-sum": 1500 } };
    expect(firstUnsolved(week, bundle)?.slug).toBe("valid-parentheses");
  });

  it("returns null when every problem is solved", () => {
    const bundle = {
      solves: {
        "two-sum": 1500,
        "valid-parentheses": 1500,
        "3sum": 1500,
      },
    };
    expect(firstUnsolved(week, bundle)).toBe(null);
  });

  it("treats an old-week solve as not counting (respects week window)", () => {
    // A solve before this week's startDate shouldn't count.
    const bundle = { solves: { "two-sum": 500 } };
    expect(firstUnsolved(week, bundle)?.slug).toBe("two-sum");
  });
});
