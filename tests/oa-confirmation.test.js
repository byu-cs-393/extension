// The message a student reads before spending an OA attempt. Worth
// pinning: the numbers come from course.json's attempt rules, and a
// wrong one here misleads someone at the exact moment the choice
// becomes irreversible.
import { describe, it, expect } from "vitest";
import { startAttemptWarning } from "../src/ui/third-card.js";

const attempt = (over = {}) => ({
  timeLimitMin: null,
  requiredSolves: null,
  helpAllowed: false,
  problems: [{ slug: "a" }, { slug: "b" }, { slug: "c" }],
  ...over,
});

describe("startAttemptWarning", () => {
  it("numbers the attempt from one, not zero", () => {
    expect(startAttemptWarning(attempt(), 0, 3)).toContain(
      "Start attempt 1 of 3?"
    );
    expect(startAttemptWarning(attempt(), 2, 3)).toContain(
      "Start attempt 3 of 3?"
    );
  });

  // requiredSolves: null in course.json means "all of them".
  it("reads a null requiredSolves as every problem", () => {
    expect(startAttemptWarning(attempt(), 0, 3)).toContain("Solve all 3 problems");
  });

  it("states the partial target when only some solves are required", () => {
    const partial = attempt({
      requiredSolves: 3,
      problems: Array.from({ length: 24 }, (_, i) => ({ slug: `p${i}` })),
    });
    expect(startAttemptWarning(partial, 1, 3)).toContain("Solve 3 of 24 problems");
  });

  it("warns that the clock starts now when there is a time limit", () => {
    const timed = attempt({ timeLimitMin: 90 });
    expect(startAttemptWarning(timed, 0, 3)).toContain(
      "90 minute time limit, starting now"
    );
  });

  it("says so plainly when there is no time limit", () => {
    expect(startAttemptWarning(attempt(), 1, 3)).toContain("No time limit");
  });

  it("flips the help rule with helpAllowed", () => {
    expect(startAttemptWarning(attempt(), 0, 3)).toContain("No help");
    expect(startAttemptWarning(attempt({ helpAllowed: true }), 2, 3)).toContain(
      "may ask other people for help"
    );
  });

  // A student weighing "should I start now?" needs to know whether a bad
  // run is recoverable.
  it("points to the next attempt, or names this one as the last", () => {
    expect(startAttemptWarning(attempt(), 0, 3)).toContain("attempt 2");
    expect(startAttemptWarning(attempt(), 2, 3)).toContain("last attempt");
  });
});
