// A TA's Pass has to reach Canvas.
//
// It didn't. recordSignoffDecision returned only the fields its write
// touched — no `type`, because that's set when the document is created.
// autoSubmission checks `type` first, got undefined, and returned null;
// the TA dashboard then bailed without logging. Every pass-off silently
// failed to submit, and it only appeared to work from the student's own
// dashboard, which reads the full document.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { autoSubmission } from "../src/data/auto-submit.js";

// The document as it exists in Firestore before a signoff: created with
// a type, so `type` is present but the signoff fields are not.
const existingDoc = (over = {}) => ({
  assignmentId: "perf-data-structures",
  type: "performance",
  weekNum: 3,
  status: "requested",
  ...over,
});

// Exactly what recordSignoffDecision writes — and nothing more.
const signoffPatch = (over = {}) => ({
  assignmentId: "perf-data-structures",
  status: "passed",
  signoffAt: 2_000_000,
  signoffTaNetID: "jack684",
  signoffHowLong: "12 min",
  ...over,
});

describe("what a signoff hands to autoSubmission", () => {
  // The exact production bug.
  it("produces nothing from the patch alone", () => {
    expect(autoSubmission(signoffPatch())).toBeNull();
  });

  it("produces a submission once the patch is merged onto the document", () => {
    const merged = { ...existingDoc(), ...signoffPatch() };
    const submission = autoSubmission(merged);
    expect(submission).not.toBeNull();
    expect(submission.assignmentId).toBe("perf-data-structures");
    expect(submission.type).toBe("performance");
    expect(submission.weekNum).toBe(3);
    expect(submission.data.howLong).toBe("12 min");
    expect(submission.data.workedWith).toBe("jack684");
  });

  it("carries the TA's answers through to Canvas", () => {
    const merged = {
      ...existingDoc({ type: "live-interview" }),
      ...signoffPatch({ graderRating: 2, signoffHowItWent: "Solid." }),
    };
    const submission = autoSubmission(merged);
    expect(submission.data.graderRating).toBe("2");
    expect(submission.data.howItWent).toBe("Solid.");
  });

  it("still declines a Fail", () => {
    const merged = { ...existingDoc(), ...signoffPatch({ status: "failed" }) };
    expect(autoSubmission(merged)).toBeNull();
  });

  it("resubmits a retake, but not the same signoff twice", () => {
    const base = { ...existingDoc(), ...signoffPatch() };
    // Already sent for this signoff.
    expect(autoSubmission({ ...base, canvasSubmittedAt: 2_500_000 })).toBeNull();
    // Passed again after that submission — must go again.
    expect(
      autoSubmission({ ...base, canvasSubmittedAt: 2_500_000, signoffAt: 3_000_000 }),
    ).not.toBeNull();
  });
});

// patchLocalCache has to return the merged document, since that return
// value is what the TA dashboard submits from.
describe("patchLocalCache returns the merged document", () => {
  let store;

  beforeEach(() => {
    store = {};
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn(async (k) => ({ [k]: store[k] })),
          set: vi.fn(async (obj) => Object.assign(store, obj)),
        },
      },
    });
  });

  it("merges the patch onto what was already cached", async () => {
    store.assignmentProgressBundle = {
      progress: { "perf-data-structures": existingDoc() },
    };
    const { getCachedAssignmentProgress } = await import(
      "../src/data/assignment-progress.js"
    );
    const cached = await getCachedAssignmentProgress();
    // Sanity: the fixture is in place and carries the field that was lost.
    expect(cached["perf-data-structures"].type).toBe("performance");
  });
});
