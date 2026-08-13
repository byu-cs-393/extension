// @vitest-environment jsdom
//
// DOM tests for resubmission on the Canvas submit affordance.
//
// Canvas keeps every attempt and grades the most recent, so a second
// submission supersedes the first. The UI has to make that legible: an
// already-submitted card still offers a button, and says what pressing
// it will do.
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/platform/firestore.js", () => ({ fetchCollection: vi.fn(), patchDoc: vi.fn() }));
vi.mock("../src/data/oa-session.js", () => ({
  startAttempt: vi.fn(), endActiveAttempt: vi.fn(), getRemainingMs: vi.fn(),
  formatRemaining: vi.fn(), solvedInWindow: vi.fn(() => new Set()), resetOa: vi.fn(),
}));
vi.mock("../src/data/assignment-progress.js", () => ({
  requestSignoff: vi.fn(), submitSelfRating: vi.fn(),
}));
vi.mock("../src/data/submission-templates.js", () => ({ fillOaTemplate: vi.fn(() => "") }));

const openSubmissionForm = vi.fn();
vi.mock("../src/ui/submission-form.js", () => ({ openSubmissionForm }));

const { appendCanvasSubmitAffordance } = await import("../src/ui/third-card.js");

const ctx = { netID: "jack684", weekNum: 3 };
const item = { type: "study", assignmentId: "study-w3" };

let article;
beforeEach(() => {
  document.body.innerHTML = "";
  article = document.createElement("article");
  document.body.appendChild(article);
  openSubmissionForm.mockClear();
});

const $ = (sel) => article.querySelector(sel);

describe("first submission", () => {
  it("offers a primary Submit button and no receipt", () => {
    appendCanvasSubmitAffordance(article, item, null, ctx);
    expect($("button").textContent).toBe("Submit to Canvas");
    expect($("button").className).toBe("btn-primary");
    expect($(".canvas-submit-receipt")).toBe(null);
  });

  it("does not mark the form as a resubmission", () => {
    appendCanvasSubmitAffordance(article, item, null, ctx);
    $("button").click();
    expect(openSubmissionForm.mock.calls[0][0].isResubmission).toBe(false);
  });
});

describe("after submitting", () => {
  const submitted = {
    canvasSubmittedAt: Date.now() - 60_000,
    canvasSubmitCount: 1,
    canvasSubmissionData: { collabHours: 4, personalHours: 5 },
  };

  it("shows a receipt AND still offers a button", () => {
    // The whole point: submitting once must not lock the student out.
    appendCanvasSubmitAffordance(article, item, submitted, ctx);
    expect($(".canvas-submit-receipt").textContent).toMatch(/Submitted to Canvas/);
    expect($("button").textContent).toBe("Submit again");
  });

  it("de-emphasises the repeat button", () => {
    appendCanvasSubmitAffordance(article, item, submitted, ctx);
    expect($("button").className).toBe("btn-secondary");
    expect($("button").title).toMatch(/replaces/i);
  });

  it("prefills from what was submitted last time", () => {
    // Correcting one field shouldn't mean retyping the rest.
    appendCanvasSubmitAffordance(article, item, submitted, ctx, {
      prefill: { collabHours: 0, personalHours: 0 },
    });
    $("button").click();
    const arg = openSubmissionForm.mock.calls[0][0];
    expect(arg.prefill.collabHours).toBe(4);
    expect(arg.prefill.personalHours).toBe(5);
    expect(arg.isResubmission).toBe(true);
  });

  it("recomputes the derived data instead of reusing it", () => {
    // Solved problems and tracked time must reflect NOW, not the state
    // at first submission — that's the main reason to resubmit.
    const extraSubmitData = { problems: [{ title: "Two Sum", solved: true }], trackedMs: 999 };
    appendCanvasSubmitAffordance(article, item, submitted, ctx, { extraSubmitData });
    $("button").click();
    expect(openSubmissionForm.mock.calls[0][0].extraSubmitData).toEqual(extraSubmitData);
  });

  it("counts repeat submissions once there's more than one", () => {
    appendCanvasSubmitAffordance(article, item, { ...submitted, canvasSubmitCount: 3 }, ctx);
    expect($(".canvas-submit-receipt").textContent).toMatch(/3 submissions/);
  });

  it("treats a legacy doc with no count as one submission", () => {
    const legacy = { canvasSubmittedAt: Date.now() };
    appendCanvasSubmitAffordance(article, item, legacy, ctx);
    expect($(".canvas-submit-receipt").textContent).not.toMatch(/submissions/);
    expect($("button").textContent).toBe("Submit again");
  });
});
