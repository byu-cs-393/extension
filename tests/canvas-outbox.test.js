// Submissions queued for the student's own browser to send to Canvas.
//
// The course token can't submit as a student — no become_user, and Canvas
// reserves a submission to its author — so submissions are recorded as
// pending and sent from the student's logged-in Canvas session. These pin
// down what counts as pending, since a mistake either strands a submission
// forever or sends it repeatedly.
import { describe, it, expect } from "vitest";
import {
  queuedSubmission,
  isPending,
  pendingSubmissions,
  canvasSubmissionFields,
} from "../src/data/canvas-outbox.js";
import { autoSubmission } from "../src/data/auto-submit.js";

const queued = (over = {}) =>
  queuedSubmission({
    type: "performance",
    assignmentId: "perf-graphs",
    weekNum: 5,
    data: { howLong: "12 min" },
    now: 1000,
    ...over,
  });

describe("isPending", () => {
  it("is pending once queued and never sent", () => {
    expect(isPending({ pendingSubmission: queued() })).toBe(true);
  });

  it("clears itself when a send lands after queueing", () => {
    expect(isPending({ pendingSubmission: queued(), canvasSubmittedAt: 1500 })).toBe(false);
  });

  // A resubmission re-queues with a newer timestamp. An old send must not
  // satisfy it, or the new attempt is silently dropped.
  it("stays pending when an earlier send predates a re-queue", () => {
    expect(
      isPending({ pendingSubmission: queued({ now: 2000 }), canvasSubmittedAt: 1500 }),
    ).toBe(true);
  });

  it("treats a send at exactly the queue time as sent", () => {
    expect(isPending({ pendingSubmission: queued(), canvasSubmittedAt: 1000 })).toBe(false);
  });

  it("is never pending without a well-formed queue entry", () => {
    expect(isPending({})).toBe(false);
    expect(isPending(null)).toBe(false);
    expect(isPending({ pendingSubmission: { assignmentId: "x" } })).toBe(false);
  });
});

describe("pendingSubmissions", () => {
  it("collects only what's still waiting, oldest first", () => {
    const docs = {
      b: { pendingSubmission: queued({ assignmentId: "b", now: 3000 }) },
      a: { pendingSubmission: queued({ assignmentId: "a", now: 1000 }) },
      sent: { pendingSubmission: queued({ assignmentId: "sent", now: 500 }), canvasSubmittedAt: 900 },
      none: { status: "passed" },
    };
    expect(pendingSubmissions(docs).map((p) => p.assignmentId)).toEqual(["a", "b"]);
  });

  it("survives an empty or missing map", () => {
    expect(pendingSubmissions({})).toEqual([]);
    expect(pendingSubmissions(undefined)).toEqual([]);
  });
});

describe("queuedSubmission", () => {
  it("stores the template inputs, not rendered HTML", () => {
    const q = queued();
    expect(q.data).toEqual({ howLong: "12 min" });
    expect(JSON.stringify(q)).not.toMatch(/<p>|<strong>/);
  });

  it("omits a missing week rather than storing NaN", () => {
    expect("weekNum" in queuedSubmission({ type: "study", assignmentId: "x", now: 1 })).toBe(false);
  });
});

describe("canvasSubmissionFields", () => {
  it("builds a text-entry submission", () => {
    expect(canvasSubmissionFields({ submissionType: "online_text_entry", body: "<p>hi</p>" })).toEqual([
      ["submission[submission_type]", "online_text_entry"],
      ["submission[body]", "<p>hi</p>"],
    ]);
  });

  it("builds a URL submission", () => {
    expect(canvasSubmissionFields({ submissionType: "online_url", url: "https://x" })).toEqual([
      ["submission[submission_type]", "online_url"],
      ["submission[url]", "https://x"],
    ]);
  });
});

// The dashboard backfills any passed signoff that never reached Canvas. It
// must not re-queue one already waiting, or it rewrites the record on every
// load and keeps pushing its timestamp forward.
describe("autoSubmission and the queue", () => {
  const passed = {
    assignmentId: "perf-graphs",
    type: "performance",
    status: "passed",
    signoffAt: 1000,
  };

  it("backfills a passed signoff that was never queued", () => {
    expect(autoSubmission(passed)).not.toBeNull();
  });

  it("leaves one that's already queued alone", () => {
    expect(autoSubmission({ ...passed, pendingSubmission: queued({ now: 1200 }) })).toBeNull();
  });

  it("queues again once the earlier queue entry has been sent", () => {
    // Sent, then signed off again on a retake.
    const retake = {
      ...passed,
      signoffAt: 5000,
      pendingSubmission: queued({ now: 1200 }),
      canvasSubmittedAt: 1300,
    };
    expect(autoSubmission(retake)).not.toBeNull();
  });
});
