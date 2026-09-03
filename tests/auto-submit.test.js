// Unit tests for src/data/auto-submit.js — deciding which TA-approved
// assignments submit themselves, and with what.
//
// The risk being guarded here is a submission that goes out claiming
// something nobody said: the TA's grader rating reported as the student's
// self-rating, or a problem URL passed off as proof of a solve.
import { describe, it, expect } from "vitest";
import {
  autoSubmission,
  pendingAutoSubmissions,
  isAutoSubmitType,
} from "../src/data/auto-submit.js";

const SIGNOFF_AT = Date.parse("2026-09-15T18:30:00Z");

const perfItem = (over = {}) => ({
  type: "performance",
  assignmentId: "perf-data-structures",
  assignment: {
    question: { name: "LRU Cache", url: "https://leetcode.com/problems/lru-cache/" },
  },
  ...over,
});

const liveItem = (over = {}) => ({
  type: "live-interview",
  assignmentId: "live-1",
  ...over,
});

const passed = (over = {}) => ({
  status: "passed",
  signoffAt: SIGNOFF_AT,
  signoffTaNetID: "jack684",
  ...over,
});

describe("isAutoSubmitType", () => {
  it("covers the TA-gated types and nothing else", () => {
    expect(isAutoSubmitType("performance")).toBe(true);
    expect(isAutoSubmitType("live-interview")).toBe(true);
    // Nobody signs these off — the student is the only source for who
    // they met and how it went, so they stay manual.
    expect(isAutoSubmitType("peer-mock")).toBe(false);
    expect(isAutoSubmitType("professional-mock")).toBe(false);
    expect(isAutoSubmitType("study")).toBe(false);
    expect(isAutoSubmitType("oa")).toBe(false);
  });
});

describe("when it does nothing", () => {
  it("skips an assignment with no signoff yet", () => {
    expect(autoSubmission(perfItem(), null)).toBe(null);
    expect(autoSubmission(perfItem(), { status: "requested" })).toBe(null);
  });

  it("skips a failed signoff", () => {
    expect(autoSubmission(perfItem(), { status: "failed" })).toBe(null);
  });

  it("skips one that has already been submitted", () => {
    // Otherwise every dashboard load would file a fresh Canvas attempt.
    const progress = passed({ canvasSubmittedAt: Date.now() });
    expect(autoSubmission(perfItem(), progress)).toBe(null);
  });

  it("skips types that aren't TA-gated", () => {
    expect(autoSubmission({ ...perfItem(), type: "peer-mock" }, passed())).toBe(null);
  });

  it("skips junk input", () => {
    expect(autoSubmission(null, passed())).toBe(null);
    expect(autoSubmission({ type: "performance" }, passed())).toBe(null);
  });
});

describe("performance exams", () => {
  it("fills every field from what the TA recorded", () => {
    // No solution link: the TA watched it happen, and the editor session
    // is recorded. That was the one field the TA couldn't supply, and
    // dropping it is what removes the last manual step.
    const out = autoSubmission(perfItem(), passed({ signoffHowLong: "12 min" }));

    expect(out.assignmentId).toBe("perf-data-structures");
    expect(out.data).toEqual({
      date: "2026-09-15",
      workedWith: "jack684",
      howLong: "12 min",
      attemptNum: 1,
    });
  });

  it("dates the submission from the signoff, not from now", () => {
    // A student who opens the dashboard three days later still gets the
    // date the exam actually happened.
    const out = autoSubmission(perfItem(), passed());
    expect(out.data.date).toBe("2026-09-15");
  });



  it("reports a retake as attempt 2", () => {
    const out = autoSubmission(perfItem(), passed({ failedAt: SIGNOFF_AT - 86_400_000 }));
    expect(out.data.attemptNum).toBe(2);
  });

  it("survives a TA who left the duration blank", () => {
    const out = autoSubmission(perfItem(), passed());
    expect(out.data.howLong).toBe("");
  });
});

describe("live interviews", () => {
  it("uses the TA's summary", () => {
    const out = autoSubmission(liveItem(), passed({ signoffHowItWent: "Strong communication." }));
    expect(out.data.howItWent).toBe("Strong communication.");
    expect(out.data.date).toBe("2026-09-15");
  });

  it("does NOT pass the grader's rating off as the student's self-rating", () => {
    // They measure different things, and a TA's 3 in a field labelled
    // "Self-rating" misreports who said it.
    const out = autoSubmission(liveItem(), passed({ graderRating: 3 }));
    expect(out.data.selfRating).toBe("");
  });

  it("includes the self-rating once the student has actually given one", () => {
    const out = autoSubmission(liveItem(), passed({ graderRating: 3, selfRating: 2 }));
    expect(out.data.selfRating).toBe("2");
  });
});

describe("pendingAutoSubmissions", () => {
  it("returns only the items that are ready", () => {
    const items = [
      perfItem(),
      liveItem(),
      { type: "peer-mock", assignmentId: "peer-mock-w3" },
    ];
    const progress = {
      "perf-data-structures": passed({ signoffHowLong: "10 min" }),
      "live-1": { status: "requested" },
      "peer-mock-w3": passed(),
    };
    const out = pendingAutoSubmissions(items, progress);
    expect(out.map((s) => s.assignmentId)).toEqual(["perf-data-structures"]);
  });

  it("returns nothing for an empty week", () => {
    expect(pendingAutoSubmissions([], {})).toEqual([]);
    expect(pendingAutoSubmissions(null, null)).toEqual([]);
  });
});
