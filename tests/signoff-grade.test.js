// How a TA's signoff becomes points in Canvas.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { signoffScore, SIGNOFF_TYPES } = require("../functions/signoff-grade.js");

describe("signoffScore", () => {
  it("gives full marks for a passed performance exam", () => {
    expect(signoffScore({ type: "performance", outcome: "passed", pointsPossible: 5 })).toBe(5);
  });

  it("uses the TA's rating as the live-interview score", () => {
    for (const r of [1, 2, 3]) {
      expect(
        signoffScore({ type: "live-interview", outcome: "passed", graderRating: r, pointsPossible: 3 }),
      ).toBe(r);
    }
  });

  // Retakes are allowed; a zero would read to the student as a final result.
  it("posts nothing for a Fail", () => {
    expect(signoffScore({ type: "performance", outcome: "failed", pointsPossible: 5 })).toBeNull();
    expect(
      signoffScore({ type: "live-interview", outcome: "failed", graderRating: 2, pointsPossible: 3 }),
    ).toBeNull();
  });

  it("refuses a rating the assignment can't hold rather than clamping it", () => {
    const base = { type: "live-interview", outcome: "passed", pointsPossible: 3 };
    expect(signoffScore({ ...base, graderRating: 7 })).toBeNull();
    expect(signoffScore({ ...base, graderRating: 0 })).toBeNull();
    expect(signoffScore({ ...base, graderRating: 2.5 })).toBeNull();
    expect(signoffScore({ ...base, graderRating: undefined })).toBeNull();
  });

  // The professor's rule: nothing a student initiates is graded. Only
  // TA-observed types can produce a score at all.
  it("never scores a type a student submits for themselves", () => {
    for (const type of ["study", "peer-mock", "extra-credit", "connect-with-class"]) {
      expect(signoffScore({ type, outcome: "passed", pointsPossible: 13 })).toBeNull();
    }
  });

  it("refuses without a usable points value from Canvas", () => {
    expect(signoffScore({ type: "performance", outcome: "passed", pointsPossible: 0 })).toBeNull();
    expect(signoffScore({ type: "performance", outcome: "passed", pointsPossible: null })).toBeNull();
  });

  it("covers exactly the TA-observed types", () => {
    expect([...SIGNOFF_TYPES].sort()).toEqual(["live-interview", "performance"]);
  });
});

// The endpoint's gates, checked against the source. The role check is the
// whole security story, so it must be the first thing after auth.
describe("gradeSignoff endpoint", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "functions", "index.js"), "utf8");
  const body = src.slice(src.indexOf("exports.gradeSignoff"), src.indexOf("// ---- Problem suggestions"));

  it("refuses any caller without the TA role", () => {
    expect(body).toMatch(/decoded\.role !== "ta"/);
    // ...before it reads the request body.
    expect(body.indexOf('decoded.role !== "ta"')).toBeLessThan(body.indexOf("req.body"));
  });

  it("takes the assignment type from Firestore, not from the request", () => {
    expect(body).not.toMatch(/const \{[^}]*\btype\b[^}]*\} = req\.body/);
    expect(body).toMatch(/progressSnap\.data\(\)\?\.type/);
  });

  it("resolves the student's Canvas id from the roster", () => {
    expect(body).toMatch(/findEnrolledUser\(forNetID/);
    expect(body).not.toMatch(/\.canvasUserId/);
  });
});
