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

// One progress document is all autoSubmission needs — it no longer takes
// a week's card, because the dashboard doesn't load every week and a
// signoff can be requested for a future one.
const perfDoc = (over = {}) => ({
  type: "performance",
  assignmentId: "perf-data-structures",
  weekNum: 3,
  status: "passed",
  signoffAt: SIGNOFF_AT,
  signoffTaNetID: "jack684",
  ...over,
});

const liveDoc = (over = {}) => ({
  type: "live-interview",
  assignmentId: "live-1",
  weekNum: 4,
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
    expect(autoSubmission(null)).toBe(null);
    expect(autoSubmission(perfDoc({ status: "requested" }))).toBe(null);
  });

  it("skips a failed signoff", () => {
    expect(autoSubmission(perfDoc({ status: "failed" }))).toBe(null);
  });

  it("skips one that has already been submitted", () => {
    // Otherwise every dashboard load would file a fresh Canvas attempt.
    // The submission has to be AFTER the signoff it covers — an earlier
    // one means the student has since passed again.
    expect(
      autoSubmission(perfDoc({ canvasSubmittedAt: SIGNOFF_AT + 60_000 })),
    ).toBe(null);
  });

  it("skips types that aren't TA-gated", () => {
    expect(autoSubmission(perfDoc({ type: "peer-mock" }))).toBe(null);
  });

  it("skips junk input", () => {
    expect(autoSubmission(null)).toBe(null);
    expect(autoSubmission({ type: "performance", status: "passed" })).toBe(null);
  });
});

describe("performance exams", () => {
  it("fills every field from what the TA recorded", () => {
    // No solution link: the TA watched it happen, and the editor session
    // is recorded. That was the one field the TA couldn't supply, and
    // dropping it is what removes the last manual step.
    const out = autoSubmission(perfDoc({ signoffHowLong: "12 min" }));

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
    const out = autoSubmission(perfDoc());
    expect(out.data.date).toBe("2026-09-15");
  });



  it("reports a retake as attempt 2", () => {
    const out = autoSubmission(perfDoc({ failedAt: SIGNOFF_AT - 86_400_000 }));
    expect(out.data.attemptNum).toBe(2);
  });

  it("survives a TA who left the duration blank", () => {
    const out = autoSubmission(perfDoc());
    expect(out.data.howLong).toBe("");
  });
});

describe("live interviews", () => {
  it("uses the TA's summary", () => {
    const out = autoSubmission(liveDoc({ signoffHowItWent: "Strong communication." }));
    expect(out.data.howItWent).toBe("Strong communication.");
    expect(out.data.date).toBe("2026-09-15");
  });

  it("carries the TA's rating, labelled as the TA's", () => {
    const out = autoSubmission(liveDoc({ graderRating: 3 }));
    expect(out.data.graderRating).toBe("3");
  });

  it("asks the student for nothing at all", () => {
    // No self-rating field: making a student grade themselves after a TA
    // had already signed them off was the last manual step in this flow.
    const out = autoSubmission(liveDoc({ graderRating: 3 }));
    expect(Object.keys(out.data).sort()).toEqual(["date", "graderRating", "howItWent"]);
  });

  it("survives a TA who skipped the rating", () => {
    expect(autoSubmission(liveDoc()).data.graderRating).toBe("");
  });
});

describe("pendingAutoSubmissions", () => {
  it("returns only the ones that are ready", () => {
    const out = pendingAutoSubmissions({
      "perf-data-structures": perfDoc({ signoffHowLong: "10 min" }),
      "live-1": liveDoc({ status: "requested" }),
      "peer-mock-w3": perfDoc({ type: "peer-mock", assignmentId: "peer-mock-w3" }),
    });
    expect(out.map((s) => s.assignmentId)).toEqual(["perf-data-structures"]);
  });

  it("finds one in a week the dashboard hasn't loaded", () => {
    // The bug this signature change fixes: the dashboard only loads past
    // and current weeks, but a student can request a signoff for a future
    // week's exam from the full-course page. Scanning cards skipped
    // exactly those, and the submission never went out.
    const out = pendingAutoSubmissions({
      "perf-data-structures": perfDoc({ weekNum: 13, signoffHowLong: "9 min" }),
    });
    expect(out).toHaveLength(1);
    expect(out[0].weekNum).toBe(13);
  });

  it("returns nothing for an empty map", () => {
    expect(pendingAutoSubmissions({})).toEqual([]);
    expect(pendingAutoSubmissions(null)).toEqual([]);
  });
});

describe("the student's only action is requesting", () => {
  // The flow is: pick a TA, request. Everything after that is the TA's,
  // and the submission goes out on its own. Nothing here should ever
  // produce a field a student has to fill in.
  it("needs nothing from the student for either type", () => {
    const perfOut = autoSubmission(perfDoc({ signoffHowLong: "12 min" }));
    const liveOut = autoSubmission(liveDoc({ signoffHowItWent: "Good", graderRating: 2 }));

    for (const out of [perfOut, liveOut]) {
      for (const value of Object.values(out.data)) {
        expect(typeof value === "string" || typeof value === "number").toBe(true);
      }
    }
    // Every value traces to the signoff or the clock — none to a form.
    expect(perfOut.data.workedWith).toBe("jack684");
    expect(perfOut.data.howLong).toBe("12 min");
    expect(liveOut.data.howItWent).toBe("Good");
    expect(liveOut.data.graderRating).toBe("2");
  });

  it("retries on the next load rather than needing a button", () => {
    // Nothing marks a failed attempt, so an unsubmitted pass stays
    // pending and the next dashboard load tries again. That's why the
    // card can safely have no fallback button.
    const progress = perfDoc({ signoffHowLong: "12 min" });
    expect(autoSubmission(progress)).not.toBe(null);
    expect(autoSubmission(progress)).not.toBe(null);
  });
});

describe("retakes", () => {
  // A student fails, re-requests, and passes again. The second result has
  // to reach Canvas — testing only for the PRESENCE of a submission meant
  // the first one silently blocked every later attempt.
  const submittedAt = SIGNOFF_AT + 60_000;

  it("skips a pass that has already been submitted", () => {
    expect(autoSubmission(perfDoc({ canvasSubmittedAt: submittedAt }))).toBe(null);
  });

  it("resubmits when the student passed again afterwards", () => {
    const retake = perfDoc({
      canvasSubmittedAt: submittedAt,
      signoffAt: submittedAt + 86_400_000, // passed again the next day
      signoffHowLong: "9 min",
    });
    const out = autoSubmission(retake);
    expect(out).not.toBe(null);
    expect(out.data.howLong).toBe("9 min");
  });

  it("uses the new signoff's date, not the old submission's", () => {
    const laterSignoff = Date.parse("2026-09-22T17:00:00Z");
    const out = autoSubmission(
      perfDoc({ canvasSubmittedAt: submittedAt, signoffAt: laterSignoff }),
    );
    expect(out.data.date).toBe("2026-09-22");
  });

  it("does not resubmit once the retake has been sent too", () => {
    const later = SIGNOFF_AT + 86_400_000;
    expect(
      autoSubmission(perfDoc({ signoffAt: later, canvasSubmittedAt: later + 1000 })),
    ).toBe(null);
  });

  it("treats an exactly-simultaneous submission as covering the signoff", () => {
    expect(
      autoSubmission(perfDoc({ signoffAt: SIGNOFF_AT, canvasSubmittedAt: SIGNOFF_AT })),
    ).toBe(null);
  });

  it("doesn't resubmit forever when a signoff has no timestamp", () => {
    // Older docs predate signoffAt. Resubmitting on every dashboard load
    // would file a fresh Canvas attempt each time.
    expect(
      autoSubmission({
        type: "performance",
        assignmentId: "perf-graphs",
        status: "passed",
        canvasSubmittedAt: submittedAt,
      }),
    ).toBe(null);
  });

  it("still submits a retake for a live interview", () => {
    const out = autoSubmission(
      liveDoc({
        canvasSubmittedAt: submittedAt,
        signoffAt: submittedAt + 3600_000,
        graderRating: 3,
      }),
    );
    expect(out).not.toBe(null);
    expect(out.data.graderRating).toBe("3");
  });
});
