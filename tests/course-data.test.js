// Unit tests for the pure helpers in src/course-data.js. Everything
// tested here is deterministic — takes plain data in, returns plain
// data out. No fetch, no chrome.*, no DOM.
//
// The async accessors (getCourseMeta, getSchedule, getCardsForWeek,
// etc.) all funnel through loadCourse(), which calls
// chrome.runtime.getURL — those aren't covered here. Exercise them
// in the extension itself; the DOM-side + Firestore-side glue is
// integration territory, not unit-test territory.
import { describe, it, expect } from "vitest";
import {
  parseScheduleDates,
  classifyWeek,
  solvedSlugsInWeek,
  flattenPlacementsToProblems,
  deriveScheduleItemId,
  studyAssignmentIdForWeek,
  studyProblemsForWeek,
  firstUnsolvedProblem,
  translateOaToRuntimeShape,
} from "../src/course-data.js";

describe("parseScheduleDates", () => {
  it("returns null for non-strings", () => {
    expect(parseScheduleDates(null)).toBe(null);
    expect(parseScheduleDates(undefined)).toBe(null);
    expect(parseScheduleDates(42)).toBe(null);
  });

  it("parses a single-month range ('Sep 7–12')", () => {
    const r = parseScheduleDates("Sep 7–12");
    expect(r).not.toBe(null);
    // startMs = Sep 7 00:00 local, endMs = Sep 13 00:00 local (exclusive).
    const start = new Date(r.startMs);
    const end = new Date(r.endMs);
    expect(start.getMonth()).toBe(8); // Sep = 8
    expect(start.getDate()).toBe(7);
    expect(end.getMonth()).toBe(8);
    expect(end.getDate()).toBe(13);
  });

  it("parses a same-month short-hand ('Nov 23–24')", () => {
    const r = parseScheduleDates("Nov 23–24");
    expect(new Date(r.startMs).getDate()).toBe(23);
    expect(new Date(r.endMs).getDate()).toBe(25); // exclusive end
  });

  it("parses a spanning range ('Nov 30–Dec 5')", () => {
    const r = parseScheduleDates("Nov 30–Dec 5");
    expect(new Date(r.startMs).getMonth()).toBe(10); // Nov
    expect(new Date(r.startMs).getDate()).toBe(30);
    expect(new Date(r.endMs).getMonth()).toBe(11); // Dec
    expect(new Date(r.endMs).getDate()).toBe(6); // exclusive
  });

  it("parses the finals sentinel format ('Thu Dec 17, 7–10 am')", () => {
    const r = parseScheduleDates("Thu Dec 17, 7–10 am");
    // Special path returns a single-day window.
    expect(r).not.toBe(null);
    expect(new Date(r.startMs).getMonth()).toBe(11);
    expect(new Date(r.startMs).getDate()).toBe(17);
    expect(new Date(r.endMs).getDate()).toBe(18);
  });

  it("handles the hyphen character in addition to en-dash", () => {
    // Just in case a stray ASCII '-' shows up somewhere.
    const r = parseScheduleDates("Sep 7-12");
    expect(r).not.toBe(null);
    expect(new Date(r.startMs).getDate()).toBe(7);
  });

  it("returns null for a string that doesn't match any pattern", () => {
    expect(parseScheduleDates("Sometime in September")).toBe(null);
    expect(parseScheduleDates("")).toBe(null);
  });

  it("returns null for an unknown month abbreviation", () => {
    expect(parseScheduleDates("Foo 7–12")).toBe(null);
  });
});

describe("classifyWeek", () => {
  const cards = (startMs, endMs) => ({ startMs, endMs });

  it("returns 'past' when now is at or beyond endMs (endMs is exclusive)", () => {
    expect(classifyWeek(cards(1000, 2000), 2000)).toBe("past");
    expect(classifyWeek(cards(1000, 2000), 2500)).toBe("past");
  });

  it("returns 'future' when now is before startMs", () => {
    expect(classifyWeek(cards(1000, 2000), 500)).toBe("future");
  });

  it("returns 'current' during the window (inclusive start, exclusive end)", () => {
    expect(classifyWeek(cards(1000, 2000), 1000)).toBe("current");
    expect(classifyWeek(cards(1000, 2000), 1500)).toBe("current");
    expect(classifyWeek(cards(1000, 2000), 1999)).toBe("current");
  });

  it("returns 'future' for null/undefined cards or missing time bounds", () => {
    expect(classifyWeek(null, 1500)).toBe("future");
    expect(classifyWeek({ startMs: null, endMs: null }, 1500)).toBe("future");
  });
});

describe("solvedSlugsInWeek", () => {
  const cards = { startMs: 1000, endMs: 2000 };

  it("returns an empty Set for null/empty bundles", () => {
    expect(solvedSlugsInWeek(cards, null).size).toBe(0);
    expect(solvedSlugsInWeek(cards, {}).size).toBe(0);
    expect(solvedSlugsInWeek(cards, { solves: {} }).size).toBe(0);
  });

  it("includes solves inside [startMs, endMs)", () => {
    const bundle = { solves: { "two-sum": 1500, "lru-cache": 1999 } };
    const set = solvedSlugsInWeek(cards, bundle);
    expect(set.has("two-sum")).toBe(true);
    expect(set.has("lru-cache")).toBe(true);
    expect(set.size).toBe(2);
  });

  it("excludes solves before startMs and at/after endMs", () => {
    const bundle = { solves: { "before": 999, "at-end": 2000, "after": 3000 } };
    expect(solvedSlugsInWeek(cards, bundle).size).toBe(0);
  });

  it("includes solves at the exact startMs (inclusive)", () => {
    expect(solvedSlugsInWeek(cards, { solves: { "on-start": 1000 } }).has("on-start")).toBe(true);
  });

  it("returns empty Set for cards without time bounds", () => {
    expect(solvedSlugsInWeek(null, { solves: { x: 1500 } }).size).toBe(0);
    expect(solvedSlugsInWeek({}, { solves: { x: 1500 } }).size).toBe(0);
  });
});

describe("flattenPlacementsToProblems", () => {
  it("walks every bucket and returns trackable LeetCode items", () => {
    const placements = {
      class: [
        { name: "Two Sum", url: "https://leetcode.com/problems/two-sum/", tag: "in class" },
      ],
      class2: [
        { name: "LRU Cache", url: "https://leetcode.com/problems/lru-cache/", tag: "required" },
      ],
      outside: [
        { name: "3Sum", url: "https://leetcode.com/problems/3sum/", tag: "recommended" },
      ],
    };
    const out = flattenPlacementsToProblems(placements);
    expect(out).toHaveLength(3);
    expect(out.map((p) => p.slug)).toEqual(["two-sum", "lru-cache", "3sum"]);
    expect(out[1].tag).toBe("required");
  });

  it("drops items without a LeetCode URL (free-form notes, non-leetcode links)", () => {
    const placements = {
      outside: [
        { notes: "Do 5 more easy problems", tag: "recommended" },
        { name: "External reading", url: "https://example.com/reading" },
      ],
    };
    expect(flattenPlacementsToProblems(placements)).toEqual([]);
  });

  it("dedups by slug across buckets (first occurrence wins)", () => {
    // Same slug appears twice — should only show up once.
    const placements = {
      class1: [{ name: "Two Sum", url: "https://leetcode.com/problems/two-sum/" }],
      class2: [{ name: "Two Sum (again)", url: "https://leetcode.com/problems/two-sum/" }],
    };
    const out = flattenPlacementsToProblems(placements);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("Two Sum");
  });

  it("handles empty/undefined placements", () => {
    expect(flattenPlacementsToProblems(null)).toEqual([]);
    expect(flattenPlacementsToProblems({})).toEqual([]);
    expect(flattenPlacementsToProblems({ class: [] })).toEqual([]);
  });
});

describe("deriveScheduleItemId", () => {
  it("uses `ref` directly when present", () => {
    expect(deriveScheduleItemId({ ref: "instructor-interview" }, 5)).toBe("instructor-interview");
  });

  it("derives peer-mock id from the week number", () => {
    expect(deriveScheduleItemId({ type: "peer-mock" }, 8)).toBe("peer-mock-w8");
  });

  it("derives oa/performance ids from topic", () => {
    expect(deriveScheduleItemId({ type: "oa", topic: "graphs" }, 5)).toBe("oa-graphs");
    expect(deriveScheduleItemId({ type: "performance", topic: "dynamic-programming" }, 10)).toBe("perf-dynamic-programming");
  });

  it("derives live-interview id from index", () => {
    expect(deriveScheduleItemId({ type: "live-interview", index: 2 }, 7)).toBe("live-2");
  });

  it("returns fixed ids for singleton assignments", () => {
    expect(deriveScheduleItemId({ type: "professional-mock" }, 14)).toBe("professional-mock");
    expect(deriveScheduleItemId({ type: "final" }, 15)).toBe("final");
  });

  it("returns null when a required field is missing", () => {
    expect(deriveScheduleItemId({ type: "oa" }, 5)).toBe(null); // no topic
    expect(deriveScheduleItemId({ type: "performance" }, 5)).toBe(null);
    expect(deriveScheduleItemId({ type: "live-interview" }, 5)).toBe(null); // no index
  });

  it("returns null for unknown types + garbage input", () => {
    expect(deriveScheduleItemId({ type: "reminder" }, 5)).toBe(null);
    expect(deriveScheduleItemId(null, 5)).toBe(null);
    expect(deriveScheduleItemId("nope", 5)).toBe(null);
  });
});

describe("studyAssignmentIdForWeek", () => {
  it("formats as study-w{N}", () => {
    expect(studyAssignmentIdForWeek(1)).toBe("study-w1");
    expect(studyAssignmentIdForWeek(14)).toBe("study-w14");
  });
});

describe("studyProblemsForWeek", () => {
  const cards = {
    placements: {
      class1: [
        { name: "A", url: "https://leetcode.com/problems/a/", tag: "in class" },
        { name: "B", url: "https://leetcode.com/problems/b/", tag: "recommended" },
      ],
      class2: [
        { name: "C", url: "https://leetcode.com/problems/c/", tag: "required" },
      ],
      outside: [
        // No URL — dropped even though it's tagged required.
        { notes: "solve 4 more", tag: "required" },
        // Recommended-tagged — dropped by the required/in-class filter.
        { name: "D", url: "https://leetcode.com/problems/d/", tag: "recommended" },
      ],
    },
  };

  it("keeps required + in-class items with URLs", () => {
    const out = studyProblemsForWeek(cards);
    expect(out.map((p) => p.url)).toEqual([
      "https://leetcode.com/problems/a/",
      "https://leetcode.com/problems/c/",
    ]);
    expect(out.map((p) => p.tag)).toEqual(["in class", "required"]);
  });

  it("drops recommended-tagged items even with URLs", () => {
    // (Covered by the fixture above — 'B' and 'D' are recommended and shouldn't appear.)
    const urls = studyProblemsForWeek(cards).map((p) => p.url);
    expect(urls).not.toContain("https://leetcode.com/problems/b/");
    expect(urls).not.toContain("https://leetcode.com/problems/d/");
  });

  it("returns [] for null/empty cards", () => {
    expect(studyProblemsForWeek(null)).toEqual([]);
    expect(studyProblemsForWeek({})).toEqual([]);
    expect(studyProblemsForWeek({ placements: {} })).toEqual([]);
  });
});

describe("firstUnsolvedProblem", () => {
  const cards = {
    startMs: 1000,
    endMs: 2000,
    placements: {
      class: [
        { name: "Two Sum", url: "https://leetcode.com/problems/two-sum/" },
        { name: "3Sum", url: "https://leetcode.com/problems/3sum/" },
      ],
    },
  };

  it("returns the first placement problem when nothing is solved this week", () => {
    expect(firstUnsolvedProblem(cards, { solves: {} })?.slug).toBe("two-sum");
  });

  it("skips solves within the week window", () => {
    expect(firstUnsolvedProblem(cards, { solves: { "two-sum": 1500 } })?.slug).toBe("3sum");
  });

  it("returns null when every problem is solved in-window", () => {
    const solves = { "two-sum": 1500, "3sum": 1600 };
    expect(firstUnsolvedProblem(cards, { solves })).toBe(null);
  });

  it("does NOT count out-of-window solves as complete", () => {
    // A solve before this week's startMs doesn't count.
    expect(firstUnsolvedProblem(cards, { solves: { "two-sum": 500 } })?.slug).toBe("two-sum");
  });

  it("returns null for null cards", () => {
    expect(firstUnsolvedProblem(null, { solves: { x: 1500 } })).toBe(null);
  });
});

describe("translateOaToRuntimeShape", () => {
  it("returns null for null input", () => {
    expect(translateOaToRuntimeShape(null)).toBe(null);
  });

  it("translates course.json OA shape to runtime shape", () => {
    const oa = {
      topic: "graphs",
      attempts: [
        {
          n: 1,
          desc: "Solve all",
          problems: [
            { name: "Two Sum", url: "https://leetcode.com/problems/two-sum/" },
            { name: "3Sum", url: "https://leetcode.com/problems/3sum/", notes: "hard" },
          ],
        },
      ],
    };
    const rt = translateOaToRuntimeShape(oa);
    expect(rt.type).toBe("onlineAssessment");
    expect(rt.topic).toBe("graphs");
    expect(rt.attempts).toHaveLength(1);
    expect(rt.attempts[0].timeLimitMin).toBe(null);
    expect(rt.attempts[0].requiredSolves).toBe(null);
    expect(rt.attempts[0].helpAllowed).toBe(false);
    expect(rt.attempts[0].desc).toBe("Solve all");
    expect(rt.attempts[0].problems).toEqual([
      { slug: "two-sum", title: "Two Sum", note: undefined },
      { slug: "3sum", title: "3Sum", note: "hard" },
    ]);
  });

  it("drops problems without a parseable LeetCode slug", () => {
    const oa = {
      topic: "data-structures",
      attempts: [
        {
          n: 1,
          problems: [
            { name: "External", url: "https://example.com/foo" },
            { name: "Two Sum", url: "https://leetcode.com/problems/two-sum/" },
          ],
        },
      ],
    };
    const rt = translateOaToRuntimeShape(oa);
    expect(rt.attempts[0].problems).toHaveLength(1);
    expect(rt.attempts[0].problems[0].slug).toBe("two-sum");
  });

  it("handles OAs with no attempts", () => {
    const rt = translateOaToRuntimeShape({ topic: "x", attempts: undefined });
    expect(rt.attempts).toEqual([]);
  });
});
