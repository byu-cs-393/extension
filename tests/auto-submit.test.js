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

  it("carries the TA's rating, labelled as the TA's", () => {
    const out = autoSubmission(liveItem(), passed({ graderRating: 3 }));
    expect(out.data.graderRating).toBe("3");
  });

  it("asks the student for nothing at all", () => {
    // No self-rating field: making a student grade themselves after a TA
    // had already signed them off was the last manual step in this flow.
    const out = autoSubmission(liveItem(), passed({ graderRating: 3 }));
    expect(Object.keys(out.data).sort()).toEqual(["date", "graderRating", "howItWent"]);
  });

  it("survives a TA who skipped the rating", () => {
    expect(autoSubmission(liveItem(), passed()).data.graderRating).toBe("");
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

describe("the student's only action is requesting", () => {
  // The flow is: pick a TA, request. Everything after that is the TA's,
  // and the submission goes out on its own. Nothing here should ever
  // produce a field a student has to fill in.
  it("needs nothing from the student for either type", () => {
    const perf = autoSubmission(perfItem(), passed({ signoffHowLong: "12 min" }));
    const live = autoSubmission(liveItem(), passed({ signoffHowItWent: "Good", graderRating: 2 }));

    for (const out of [perf, live]) {
      for (const value of Object.values(out.data)) {
        expect(typeof value === "string" || typeof value === "number").toBe(true);
      }
    }
    // Every value traces to the signoff or the clock — none to a form.
    expect(perf.data.workedWith).toBe("jack684");
    expect(perf.data.howLong).toBe("12 min");
    expect(live.data.howItWent).toBe("Good");
    expect(live.data.graderRating).toBe("2");
  });

  it("retries on the next load rather than needing a button", () => {
    // Nothing marks a failed attempt, so an unsubmitted pass stays
    // pending and the next dashboard load tries again. That's why the
    // card can safely have no fallback button.
    const progress = passed({ signoffHowLong: "12 min" });
    expect(autoSubmission(perfItem(), progress)).not.toBe(null);
    expect(autoSubmission(perfItem(), progress)).not.toBe(null);
  });
});
