// Unit tests for src/lib/canvas-error.js.
//
// Written after a dress rehearsal surfaced "Couldn't submit to Canvas:
// [object Object]" — Canvas returns errors as an array of objects, and
// the message was being dropped straight into a template literal.
import { describe, it, expect } from "vitest";
import { describeCanvasError, canvasErrorHint } from "../src/lib/canvas-error.js";

describe("describeCanvasError", () => {
  it("reads Canvas's usual array-of-objects shape", () => {
    // The exact payload behind the [object Object] report.
    const result = {
      outcome: "canvas-error",
      canvasStatus: 401,
      canvasError: [{ message: "user not authorized to perform that action" }],
    };
    expect(describeCanvasError(result)).toBe(
      "user not authorized to perform that action",
    );
  });

  it("joins multiple errors", () => {
    const result = {
      canvasError: [{ message: "first problem" }, { message: "second problem" }],
    };
    expect(describeCanvasError(result)).toBe("first problem; second problem");
  });

  it("de-duplicates repeated messages", () => {
    // Canvas often repeats the same message once per field.
    const result = {
      canvasError: [{ message: "not authorized" }, { message: "not authorized" }],
    };
    expect(describeCanvasError(result)).toBe("not authorized");
  });

  it("handles a bare string", () => {
    expect(describeCanvasError({ canvasError: "HTTP 500" })).toBe("HTTP 500");
  });

  it("handles a single object", () => {
    expect(describeCanvasError({ canvasError: { message: "nope" } })).toBe("nope");
  });

  it("unwraps nested errors and `base`", () => {
    expect(
      describeCanvasError({ canvasError: { errors: { base: [{ message: "deep" }] } } }),
    ).toBe("deep");
  });

  it("accepts `description` as well as `message`", () => {
    expect(describeCanvasError({ canvasError: [{ description: "explained" }] })).toBe(
      "explained",
    );
  });

  it("shows the JSON for an unrecognised shape rather than [object Object]", () => {
    const text = describeCanvasError({ canvasError: { weird: 1 } });
    expect(text).toBe('{"weird":1}');
    expect(text).not.toContain("[object Object]");
  });

  it("falls back through the function's own outcome fields", () => {
    // Failures that never reached Canvas still have to say something.
    expect(
      describeCanvasError({
        outcome: "skipped-no-user",
        reason: "student doc missing canvasUserId — check onboarding",
      }),
    ).toMatch(/missing canvasUserId/);
    expect(describeCanvasError({ outcome: "skipped-no-assignment" })).toBe(
      "skipped-no-assignment",
    );
  });

  it("never returns [object Object], whatever it's given", () => {
    for (const canvasError of [
      {},
      [{}],
      [null, undefined],
      { errors: {} },
      new Map(),
      [[{ message: "nested array" }]],
    ]) {
      expect(describeCanvasError({ canvasError })).not.toContain("[object Object]");
    }
  });

  it("says something for a null or empty result", () => {
    expect(describeCanvasError(null)).toBe("unknown error");
    expect(describeCanvasError({})).toBe("unknown error");
  });
});

describe("canvasErrorHint", () => {
  it("explains an authorization refusal as a setup problem", () => {
    const hint = canvasErrorHint({
      canvasError: [{ message: "user not authorized to perform that action" }],
    });
    expect(hint).toMatch(/setup problem/i);
    expect(hint).toMatch(/TA/);
  });

  it("points a missing canvasUserId at onboarding", () => {
    expect(canvasErrorHint({ outcome: "skipped-no-user" })).toMatch(/onboarding/i);
  });

  it("explains an unmapped assignment as not the student's fault", () => {
    const hint = canvasErrorHint({ outcome: "skipped-no-assignment" });
    expect(hint).toMatch(/not something you did/i);
  });

  it("explains a 404 as a stale mapping", () => {
    expect(canvasErrorHint({ canvasStatus: 404, canvasError: "x" })).toMatch(
      /mapping may be out of date/i,
    );
  });

  it("returns null when there's nothing useful to add", () => {
    expect(canvasErrorHint({ canvasError: "some transient blip" })).toBe(null);
    expect(canvasErrorHint(null)).toBe(null);
  });
});
