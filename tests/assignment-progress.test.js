// Unit tests for src/data/assignment-progress.js.
//
// These writes go straight to a student's record, and both callers now
// patch rather than read-modify-write. That only holds if the field set
// they send is complete AND the local cache merges the same way Firestore
// does — otherwise the card renders from a cache that disagrees with the
// server until the next refresh.
import { describe, it, expect, beforeEach, vi } from "vitest";

const patchDoc = vi.fn();
const fetchCollection = vi.fn();
vi.mock("../src/platform/firestore.js", () => ({ patchDoc, fetchCollection }));

const { requestSignoff, recordSignoffDecision, ASSIGNMENT_PROGRESS_CACHE_KEY } =
  await import("../src/data/assignment-progress.js");

const store = {};
beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
  patchDoc.mockReset().mockResolvedValue({});
  fetchCollection.mockReset().mockResolvedValue([]);
  globalThis.chrome = {
    storage: {
      local: {
        get: vi.fn(async (key) => ({ [key]: store[key] })),
        set: vi.fn(async (obj) => Object.assign(store, obj)),
      },
    },
  };
});

const cacheEntry = (assignmentId) =>
  store[ASSIGNMENT_PROGRESS_CACHE_KEY]?.progress?.[assignmentId];

describe("requestSignoff", () => {
  it("writes to the student's own assignment doc", async () => {
    await requestSignoff({
      netID: "jack684",
      assignmentId: "perf-graphs",
      type: "performance",
      weekNum: 6,
    });
    expect(patchDoc.mock.calls[0][0]).toBe(
      "students/jack684/assignmentProgress/perf-graphs",
    );
    expect(patchDoc.mock.calls[0][1]).toMatchObject({
      assignmentId: "perf-graphs",
      type: "performance",
      weekNum: 6,
      status: "requested",
    });
  });

  it("records who the request is addressed to", async () => {
    await requestSignoff({
      netID: "jack684",
      assignmentId: "perf-graphs",
      type: "performance",
      requestedTaNetID: "sam2",
    });
    expect(patchDoc.mock.calls[0][1].requestedTaNetID).toBe("sam2");
  });

  it("omits the addressee when there isn't one", async () => {
    // Requests with no addressee stay visible to every TA, so an absent
    // field has to mean "anyone" rather than an empty string nobody
    // matches.
    await requestSignoff({ netID: "jack684", assignmentId: "perf-graphs", type: "performance" });
    expect(patchDoc.mock.calls[0][1]).not.toHaveProperty("requestedTaNetID");
  });

  it("does not read the document first", async () => {
    // The read 404s the first time a student requests anything, which is
    // handled but shows up in the console looking like a failure. The
    // updateMask makes it unnecessary.
    await requestSignoff({ netID: "jack684", assignmentId: "perf-graphs", type: "performance" });
    expect(patchDoc).toHaveBeenCalledTimes(1);
  });

  it("keeps fields from an earlier cycle in the cache", async () => {
    // Re-requesting after a fail must not blank out a previous
    // submission marker locally while Firestore still has it.
    store[ASSIGNMENT_PROGRESS_CACHE_KEY] = {
      progress: { "perf-graphs": { canvasSubmittedAt: 111, graderRating: 2 } },
    };
    await requestSignoff({ netID: "jack684", assignmentId: "perf-graphs", type: "performance" });
    expect(cacheEntry("perf-graphs")).toMatchObject({
      canvasSubmittedAt: 111,
      graderRating: 2,
      status: "requested",
    });
  });
});

describe("recordSignoffDecision", () => {
  it("records a pass with the TA and the duration", async () => {
    await recordSignoffDecision({
      studentNetID: "jack684",
      taNetID: "sam2",
      assignmentId: "perf-graphs",
      outcome: "passed",
      signoffHowLong: "12 min",
    });
    expect(patchDoc.mock.calls[0][1]).toMatchObject({
      status: "passed",
      signoffTaNetID: "sam2",
      signoffHowLong: "12 min",
    });
  });

  it("carries the grader rating and summary for a live interview", async () => {
    await recordSignoffDecision({
      studentNetID: "jack684",
      taNetID: "sam2",
      assignmentId: "live-1",
      outcome: "passed",
      graderRating: 3,
      signoffHowItWent: "Strong communication.",
    });
    expect(patchDoc.mock.calls[0][1]).toMatchObject({
      graderRating: 3,
      signoffHowItWent: "Strong communication.",
    });
  });

  it("omits optional fields a TA left blank", async () => {
    // An empty string would overwrite a previous value with nothing.
    await recordSignoffDecision({
      studentNetID: "jack684",
      assignmentId: "perf-graphs",
      outcome: "failed",
    });
    const written = patchDoc.mock.calls[0][1];
    expect(written).not.toHaveProperty("signoffHowLong");
    expect(written).not.toHaveProperty("graderRating");
    expect(written.status).toBe("failed");
  });

  it("sends everything the auto-submit needs", async () => {
    // If any of these stop being written, submissions silently go out
    // with blank fields — the TA is the only source for them.
    await recordSignoffDecision({
      studentNetID: "jack684",
      taNetID: "sam2",
      assignmentId: "perf-graphs",
      outcome: "passed",
      signoffHowLong: "12 min",
    });
    const written = patchDoc.mock.calls[0][1];
    for (const field of ["status", "signoffAt", "signoffTaNetID", "signoffHowLong"]) {
      expect(written[field]).toBeDefined();
    }
  });
});
