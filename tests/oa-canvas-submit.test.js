// @vitest-environment jsdom
//
// The OA's "Submit to Canvas" button, moved off the server path.
//
// It used to POST through a Cloud Function that masqueraded as the student.
// That never worked for a real student — the course token has no
// become_user — so every OA submission failed. It now queues through the
// same outbox as every other card and is sent from the student's own
// Canvas session.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../src/platform/firestore.js", () => ({ fetchCollection: vi.fn(), patchDoc: vi.fn() }));
vi.mock("../src/data/oa-session.js", () => ({
  startAttempt: vi.fn(), endActiveAttempt: vi.fn(), getRemainingMs: vi.fn(() => 0),
  formatRemaining: vi.fn(() => ""), solvedInWindow: vi.fn(() => new Set()), resetOa: vi.fn(),
}));
vi.mock("../src/data/assignment-progress.js", () => ({ requestSignoff: vi.fn() }));

const sendCanvasSubmission = vi.fn();
vi.mock("../src/ui/submission-form.js", () => ({
  openSubmissionForm: vi.fn(),
  sendCanvasSubmission,
}));

globalThis.chrome = { runtime: { sendMessage: vi.fn(() => Promise.resolve()) } };

const { createThirdCardSection } = await import("../src/ui/third-card.js");

const oaShape = {
  type: "onlineAssessment",
  topic: "graphs",
  attempts: [{ problems: [] }, { problems: [] }, { problems: [] }],
};

const passed = {
  finalStatus: "passed",
  currentAttempt: 1,
  attempts: [{ solvedSlugs: ["two-sum", "clone-graph"] }],
};

const ctxWith = (assignmentProgress = {}) => ({
  netID: "stu123",
  weekNum: 5,
  oaShapes: { graphs: oaShape },
  solutionUrls: { "two-sum": "https://leetcode.com/submissions/detail/111/" },
  assignmentProgress,
});

function render(progress, ctx) {
  document.body.innerHTML = "";
  const card = createThirdCardSection({ type: "oa", topic: "graphs" }, progress, "current", ctx);
  document.body.appendChild(card);
  return card;
}

const buttonNamed = (card, text) =>
  [...card.querySelectorAll("button")].find((b) => b.textContent === text);

const click = async (el) => {
  el.click();
  await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  sendCanvasSubmission.mockReset();
  sendCanvasSubmission.mockResolvedValue({ ok: true, queued: true, result: { outcome: "queued" } });
  chrome.runtime.sendMessage.mockClear();
  globalThis.alert = vi.fn();
});

describe("a passed OA with nothing sent yet", () => {
  it("offers Submit to Canvas", () => {
    expect(buttonNamed(render(passed, ctxWith()), "Submit to Canvas")).toBeTruthy();
  });

  it("queues through the outbox instead of calling the server", async () => {
    const card = render(passed, ctxWith());
    await click(buttonNamed(card, "Submit to Canvas"));

    expect(sendCanvasSubmission).toHaveBeenCalledTimes(1);
    const call = sendCanvasSubmission.mock.calls[0][0];
    expect(call).toMatchObject({
      type: "oa",
      assignmentId: "oa-graphs",
      netID: "stu123",
      weekNum: 5,
      drain: true,
    });
    // Never the old masquerading server route.
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "submitCanvasAssignment" }),
      expect.anything(),
    );
  });

  it("captures the passing attempt, preferring each accepted-submission URL", async () => {
    const card = render(passed, ctxWith());
    await click(buttonNamed(card, "Submit to Canvas"));
    expect(sendCanvasSubmission.mock.calls[0][0].data).toEqual({
      attemptNum: 1,
      acceptedUrls: [
        "https://leetcode.com/submissions/detail/111/",
        // No recorded submission URL: fall back to the problem page.
        "https://leetcode.com/problems/clone-graph/",
      ],
    });
  });

  it("says so and lets them retry if queueing fails", async () => {
    sendCanvasSubmission.mockResolvedValue({
      ok: false, queued: false, result: { outcome: "queue-failed", error: "offline" },
    });
    const card = render(passed, ctxWith());
    const btn = buttonNamed(card, "Submit to Canvas");
    await click(btn);
    expect(alert).toHaveBeenCalled();
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe("Submit to Canvas");
  });
});

describe("a queued OA submission", () => {
  const queued = {
    "oa-graphs": {
      assignmentId: "oa-graphs",
      type: "oa",
      pendingSubmission: { type: "oa", assignmentId: "oa-graphs", data: {}, queuedAt: 5000 },
    },
  };

  it("says it's waiting for Canvas, with no second Submit button", () => {
    const card = render(passed, ctxWith(queued));
    expect(card.textContent).toContain("Queued for Canvas");
    expect(buttonNamed(card, "Submit to Canvas")).toBeUndefined();
    expect(buttonNamed(card, "Send now")).toBeTruthy();
  });

  // Re-queueing would only push the timestamp forward; the useful action is
  // retrying the send — e.g. after signing back in to Canvas.
  it("retries the send rather than queueing again", async () => {
    const card = render(passed, ctxWith(queued));
    await click(buttonNamed(card, "Send now"));
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: "canvasOutbox:drain" });
    expect(sendCanvasSubmission).not.toHaveBeenCalled();
  });
});

describe("a sent OA submission", () => {
  it("shows the receipt from assignmentProgress and offers a resubmit", () => {
    const card = render(passed, ctxWith({
      "oa-graphs": {
        assignmentId: "oa-graphs", type: "oa",
        pendingSubmission: { queuedAt: 1000 }, canvasSubmittedAt: Date.now() - 60_000,
        canvasSubmitCount: 2,
      },
    }));
    expect(card.textContent).toContain("✓ Submitted to Canvas");
    expect(card.textContent).toContain("2 submissions");
    expect(buttonNamed(card, "Submit again")).toBeTruthy();
  });

  // Before the move, a receipt lived on weekProgress. It must not vanish.
  it("still honours a receipt written to weekProgress before the move", () => {
    const card = render({ ...passed, canvasSubmittedAt: Date.now() - 60_000 }, ctxWith());
    expect(card.textContent).toContain("✓ Submitted to Canvas");
    expect(buttonNamed(card, "Submit again")).toBeTruthy();
  });
});

describe("what the OA move depends on", () => {
  const root = join(import.meta.dirname, "..");
  const read = (p) => readFileSync(join(root, p), "utf8");

  // Without this the queue write is rejected by Firestore, and the button
  // fails for every student the moment it's clicked.
  it("lets the rules record an OA on assignmentProgress", () => {
    const rules = read("firestore.rules");
    const fn = rules.slice(rules.indexOf("function isValidAssignmentProgress"));
    expect(fn.slice(0, fn.indexOf("}"))).toMatch(/'oa'/);
  });

  it("can render an OA body at send time", async () => {
    vi.doUnmock("../src/data/submission-templates.js");
    const { fillSubmissionTemplate } = await vi.importActual("../src/data/submission-templates.js");
    const body = fillSubmissionTemplate({
      type: "oa",
      assignmentId: "oa-graphs",
      data: { attemptNum: 2, acceptedUrls: ["https://leetcode.com/problems/two-sum/"] },
    });
    expect(body).toContain("two-sum");
  });

  // The whole point: nothing in the extension uses the masquerading route.
  it("leaves no client code sending the old server submission", () => {
    const { execSync } = require("node:child_process");
    const hits = execSync(
      `grep -rn '"submitCanvasAssignment"' src --include=*.js || true`,
      { cwd: root, encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean)
      .filter((l) => !l.includes("/generated/"))
      .filter((l) => !/:\s*\/\//.test(l.split(":").slice(2).join(":")));
    expect(hits).toEqual([]);
  });
});
