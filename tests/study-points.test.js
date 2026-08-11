// Unit tests for src/lib/study-points.js — the Weekly Study rubric.
//
// Source of truth is ../course/weekly/README.md:
//   13 pts/week: 4 collaborative (4 hrs), 4 problems done, 5 personal (5 hrs).
import { describe, it, expect } from "vitest";
import {
  studyPointsBreakdown,
  STUDY_TOTAL_POINTS,
} from "../src/lib/study-points.js";

describe("studyPointsBreakdown", () => {
  it("awards full marks for the rubric's stated hours and all problems", () => {
    const b = studyPointsBreakdown({
      collabHours: 4,
      personalHours: 5,
      solvedCount: 7,
      totalCount: 7,
    });
    expect(b.collaborative.points).toBe(4);
    expect(b.problems.points).toBe(4);
    expect(b.personal.points).toBe(5);
    expect(b.total).toBe(STUDY_TOTAL_POINTS);
  });

  it("prorates problems by how many were solved", () => {
    // The case from the rehearsal: 4 of 7.
    const b = studyPointsBreakdown({ solvedCount: 4, totalCount: 7 });
    expect(b.problems.points).toBe(2.5); // 4 * 4/7 = 2.29 → nearest half
    expect(b.problems.detail).toBe("4 of 7 solved");
  });

  it("caps each hours line at its maximum", () => {
    const b = studyPointsBreakdown({ collabHours: 40, personalHours: 40 });
    expect(b.collaborative.points).toBe(4);
    expect(b.personal.points).toBe(5);
  });

  it("gives one point per hour below the cap", () => {
    const b = studyPointsBreakdown({ collabHours: 2, personalHours: 3 });
    expect(b.collaborative.points).toBe(2);
    expect(b.personal.points).toBe(3);
  });

  it("rounds half hours to half points", () => {
    const b = studyPointsBreakdown({ collabHours: 2.5, personalHours: 1.25 });
    expect(b.collaborative.points).toBe(2.5);
    expect(b.personal.points).toBe(1.5);
  });

  it("scores zero for missing, zero or negative hours", () => {
    for (const hours of [undefined, null, 0, -3, "", "abc", NaN]) {
      const b = studyPointsBreakdown({ collabHours: hours, personalHours: hours });
      expect(b.collaborative.points).toBe(0);
      expect(b.personal.points).toBe(0);
    }
  });

  it("accepts hours as numeric strings, which is what a form gives you", () => {
    const b = studyPointsBreakdown({ collabHours: "4", personalHours: "2.5" });
    expect(b.collaborative.points).toBe(4);
    expect(b.personal.points).toBe(2.5);
  });

  it("gives full problem marks for a week with none assigned", () => {
    // Nothing to solve isn't a failure to solve anything.
    const b = studyPointsBreakdown({ solvedCount: 0, totalCount: 0 });
    expect(b.problems.points).toBe(4);
    expect(b.problems.detail).toBe("none assigned this week");
  });

  it("scores zero problems when none of several were solved", () => {
    const b = studyPointsBreakdown({ solvedCount: 0, totalCount: 5 });
    expect(b.problems.points).toBe(0);
  });

  it("can't exceed the maximum from a bad solved count", () => {
    const b = studyPointsBreakdown({ solvedCount: 99, totalCount: 7 });
    expect(b.problems.points).toBe(4);
    expect(b.problems.detail).toBe("7 of 7 solved");
  });

  it("totals the three lines and never exceeds 13", () => {
    const b = studyPointsBreakdown({
      collabHours: 100,
      personalHours: 100,
      solvedCount: 100,
      totalCount: 3,
    });
    expect(b.total).toBe(13);
    expect(b.max).toBe(13);
  });

  it("returns all three lines in rubric order for rendering", () => {
    const b = studyPointsBreakdown({});
    expect(b.lines.map((l) => l.label)).toEqual([
      "Collaborative study",
      "Required + in-class problems",
      "Personal study",
    ]);
  });

  it("survives being called with nothing at all", () => {
    const b = studyPointsBreakdown();
    expect(b.total).toBe(4); // no problems assigned → full problem marks
    expect(b.collaborative.points).toBe(0);
  });
});
