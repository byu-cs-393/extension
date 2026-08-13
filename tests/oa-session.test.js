// Tests for the pure helpers exported by src/oa-session.js.
//
// Everything here is deterministic — no chrome.*, no fetch, no
// filesystem. Imports resolve fine because these modules have no
// module-level side effects (chrome APIs are only touched inside
// functions we don't call here).
import { describe, it, expect } from "vitest";
import {
  solvedInWindow,
  attemptPassed,
  getRemainingMs,
  formatRemaining,
} from "../src/data/oa-session.js";

describe("solvedInWindow", () => {
  const attempt = {
    problems: [
      { slug: "two-sum" },
      { slug: "valid-parentheses" },
      { slug: "3sum" },
    ],
  };
  const startedAt = 1000;
  const finishedAt = 2000;

  it("returns empty when solves is empty", () => {
    expect(solvedInWindow(attempt, {}, startedAt, finishedAt)).toEqual([]);
  });

  it("returns only slugs whose timestamp falls in [startedAt, finishedAt]", () => {
    const solves = {
      "two-sum": 1500,
      "valid-parentheses": 500, // before window
      "3sum": 2500, // after window
    };
    expect(solvedInWindow(attempt, solves, startedAt, finishedAt)).toEqual([
      "two-sum",
    ]);
  });

  it("includes solves exactly at startedAt (inclusive)", () => {
    const solves = { "two-sum": startedAt };
    expect(solvedInWindow(attempt, solves, startedAt, finishedAt)).toEqual([
      "two-sum",
    ]);
  });

  it("includes solves exactly at finishedAt (inclusive)", () => {
    const solves = { "two-sum": finishedAt };
    expect(solvedInWindow(attempt, solves, startedAt, finishedAt)).toEqual([
      "two-sum",
    ]);
  });

  it("ignores slugs solved but not in the attempt's problem list", () => {
    const solves = { "climbing-stairs": 1500 };
    expect(solvedInWindow(attempt, solves, startedAt, finishedAt)).toEqual([]);
  });

  it("handles a missing or empty attemptSpec gracefully", () => {
    expect(
      solvedInWindow(null, { "two-sum": 1500 }, startedAt, finishedAt)
    ).toEqual([]);
    expect(
      solvedInWindow({}, { "two-sum": 1500 }, startedAt, finishedAt)
    ).toEqual([]);
    expect(
      solvedInWindow(
        { problems: [] },
        { "two-sum": 1500 },
        startedAt,
        finishedAt
      )
    ).toEqual([]);
  });

  it("filters null/undefined timestamps but tolerates numeric-string coercion", () => {
    // solvedInWindow only guards `ts != null`. Real data always writes
    // numbers (Date.now() / LeetCode's timestamp*1000), so we don't
    // add stricter type checking here. This test pins that behavior
    // so a future refactor doesn't accidentally tighten it.
    const solves = { "two-sum": null, "3sum": undefined };
    expect(solvedInWindow(attempt, solves, startedAt, finishedAt)).toEqual([]);
  });
});

describe("attemptPassed", () => {
  const threeProblems = {
    problems: [{ slug: "a" }, { slug: "b" }, { slug: "c" }],
  };

  it("returns false when attemptSpec is null", () => {
    expect(attemptPassed(null, 5)).toBe(false);
  });

  it("uses problems.length as the requirement when requiredSolves is null", () => {
    expect(attemptPassed(threeProblems, 3)).toBe(true);
    expect(attemptPassed(threeProblems, 2)).toBe(false);
    expect(attemptPassed(threeProblems, 4)).toBe(true); // more than needed still passes
  });

  it("uses explicit requiredSolves when set", () => {
    const attempt = { ...threeProblems, requiredSolves: 2 };
    expect(attemptPassed(attempt, 2)).toBe(true);
    expect(attemptPassed(attempt, 1)).toBe(false);
    expect(attemptPassed(attempt, 3)).toBe(true);
  });

  it("returns false when required is 0 (no threshold to meet)", () => {
    const attempt = { ...threeProblems, requiredSolves: 0 };
    // Guard: 0-requirement OAs are meaningless; explicit false avoids
    // accidental auto-pass when the catalog is misconfigured.
    expect(attemptPassed(attempt, 5)).toBe(false);
  });

  it("returns false when problems is empty and requiredSolves is null", () => {
    expect(attemptPassed({ problems: [] }, 5)).toBe(false);
  });
});

describe("getRemainingMs", () => {
  it("returns null when session is null", () => {
    expect(getRemainingMs(null)).toBe(null);
  });

  it("returns null when session has no deadline (untimed attempts 2/3)", () => {
    expect(getRemainingMs({ deadlineMs: null })).toBe(null);
    expect(getRemainingMs({})).toBe(null);
  });

  it("returns the difference when deadline is in the future", () => {
    expect(getRemainingMs({ deadlineMs: 5000 }, 3000)).toBe(2000);
  });

  it("clamps to 0 when the deadline has passed", () => {
    expect(getRemainingMs({ deadlineMs: 1000 }, 5000)).toBe(0);
  });

  it("returns 0 exactly at the deadline", () => {
    expect(getRemainingMs({ deadlineMs: 5000 }, 5000)).toBe(0);
  });
});

describe("formatRemaining", () => {
  it("returns — when ms is null", () => {
    expect(formatRemaining(null)).toBe("—");
  });

  it("formats under a minute as 00:SS", () => {
    expect(formatRemaining(45_000)).toBe("00:45");
    expect(formatRemaining(0)).toBe("00:00");
    expect(formatRemaining(5_000)).toBe("00:05");
  });

  it("formats under an hour as MM:SS", () => {
    expect(formatRemaining(90_000)).toBe("01:30");
    expect(formatRemaining(59 * 60 * 1000 + 59_000)).toBe("59:59");
  });

  it("formats an hour or more as H:MM:SS", () => {
    expect(formatRemaining(60 * 60 * 1000)).toBe("1:00:00");
    expect(formatRemaining(90 * 60 * 1000)).toBe("1:30:00");
    expect(formatRemaining(2 * 60 * 60 * 1000 + 5 * 60 * 1000 + 7_000)).toBe(
      "2:05:07"
    );
  });
});
