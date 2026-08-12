// @vitest-environment jsdom
//
// DOM tests for the Extra Credit section on the full-course page.
//
// What matters here is that a student can tell what they can still do:
// which repeatable slots are left, which card is unavailable and why,
// and that submitting again targets the NEXT slot rather than
// overwriting the one they just filled.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderExtraCreditSection } from "../src/extra-credit-view.js";

const COURSE = JSON.parse(
  readFileSync(new URL("../src/course.json", import.meta.url), "utf8"),
);
const ASSIGNMENTS = COURSE.assignments;

const submitted = (over = {}) => ({
  canvasSubmittedAt: 1_756_900_000_000,
  ...over,
});

let container;
let openForm;

beforeEach(() => {
  document.body.innerHTML = "";
  container = document.createElement("div");
  document.body.appendChild(container);
  openForm = vi.fn();
});

const render = (assignmentProgress = {}, over = {}) =>
  renderExtraCreditSection(container, {
    assignments: ASSIGNMENTS,
    assignmentProgress,
    netID: "jack684",
    openForm,
    ...over,
  });

const $ = (sel) => container.querySelector(sel);
const $$ = (sel) => [...container.querySelectorAll(sel)];
const cardTitled = (title) =>
  $$(".ec-card").find((c) => c.querySelector(".card-title").textContent === title);

describe("section shell", () => {
  it("renders one card per extra-credit task", () => {
    render();
    expect($$(".ec-card")).toHaveLength(9);
    expect($(".ec-heading").textContent).toBe("Extra credit");
  });

  it("frames it as optional before anything is submitted", () => {
    render();
    expect($(".ec-summary").textContent).toMatch(/optional/i);
    expect($(".ec-summary").textContent).toMatch(/61 points/);
  });

  it("switches to earned points once something is submitted", () => {
    render({ "ec-interview-ready": submitted() });
    expect($(".ec-summary").textContent).toBe(
      "8 of 61 possible points from 1 submission.",
    );
  });

  it("renders nothing when there's no extra credit at all", () => {
    renderExtraCreditSection(container, { assignments: [], netID: "jack684", openForm });
    expect($(".ec-section")).toBe(null);
  });
});

describe("single cards", () => {
  it("offers a submit button and marks it done afterwards", () => {
    render();
    const card = cardTitled("Get a Friend an Interview");
    expect(card.querySelector("button").textContent).toBe("Submit to Canvas");
    expect(card.querySelector(".card-status")).toBe(null);

    render({ "ec-friend-interview": submitted() });
    const done = cardTitled("Get a Friend an Interview");
    expect(done.querySelector(".card-status").textContent).toBe("✓ Submitted");
  });

  it("shows the per-card points", () => {
    render();
    expect(cardTitled("Interview Ready Chrome Extension")
      .querySelector(".ec-points").textContent).toBe("8 pts");
  });
});

describe("repeatable cards", () => {
  it("counts slots used", () => {
    render({
      "ec-real-interview-report-1": submitted(),
      "ec-real-interview-report-2": submitted(),
    });
    const card = cardTitled("Real Interview Report");
    expect(card.querySelector(".card-status").textContent).toBe("2 of 5 submitted");
  });

  it("says points are per submission, not a cap", () => {
    // "3 pts" on a five-slot card would read as the total available.
    render();
    expect(cardTitled("Real Interview Report")
      .querySelector(".ec-points").textContent).toBe("3 pts each");
  });

  it("targets the next free slot, not the one just filled", () => {
    render({ "ec-real-interview-report-1": submitted() });
    cardTitled("Real Interview Report").querySelector("button").click();
    expect(openForm.mock.calls[0][0].assignmentId).toBe("ec-real-interview-report-2");
    expect(openForm.mock.calls[0][0].isResubmission).toBe(false);
  });

  it("invites another submission once one is in", () => {
    render({ "ec-real-interview-report-1": submitted() });
    expect(cardTitled("Real Interview Report").querySelector("button").textContent)
      .toBe("Submit another");
  });

  it("offers to replace the last one when every slot is used", () => {
    const full = Object.fromEntries(
      [1, 2, 3, 4, 5].map((n) => [`ec-real-interview-report-${n}`, submitted()]),
    );
    render(full);
    const btn = cardTitled("Real Interview Report").querySelector("button");
    expect(btn.textContent).toBe("Replace last submission");
    expect(btn.title).toMatch(/All 5 submissions used/);

    btn.click();
    expect(openForm.mock.calls[0][0].assignmentId).toBe("ec-real-interview-report-5");
    expect(openForm.mock.calls[0][0].isResubmission).toBe(true);
  });

  it("prefills a replacement from what was submitted to that slot", () => {
    render({
      "ec-friend-offer": submitted({ canvasSubmissionData: { friendName: "Sam" } }),
    });
    cardTitled("Get a Friend an Offer").querySelector("button").click();
    expect(openForm.mock.calls[0][0].prefill).toEqual({ friendName: "Sam" });
  });
});

describe("the unavailable card", () => {
  it("is shown, but with no submit button and a reason", () => {
    // Hiding it would leave students wondering why the syllabus lists
    // something the extension doesn't.
    render();
    const card = cardTitled("Add a Feature or Fix a Bug");
    expect(card).toBeTruthy();
    expect(card.querySelector("button")).toBe(null);
    expect(card.querySelector(".ec-unavailable").textContent).toMatch(/hasn't finalised/i);
  });

  it("contributes nothing to the points total", () => {
    render();
    expect($(".ec-summary").textContent).toMatch(/61 points/);
  });
});

describe("without a netID", () => {
  it("still lists the cards but offers no buttons", () => {
    render({}, { netID: null });
    expect($$(".ec-card")).toHaveLength(9);
    expect($$("button")).toHaveLength(0);
  });
});
