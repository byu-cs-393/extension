// Unit tests for src/lib/extra-credit-catalog.js.
//
// The interesting part is that course.json's 15 extra-credit assignments
// are not 15 things a student does. Five of them are "Real Interview
// Report 1..5" — one task, up to five times.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  extraCreditCards,
  cardState,
  extraCreditTotals,
} from "../src/lib/extra-credit-catalog.js";

const COURSE = JSON.parse(
  readFileSync(new URL("../src/course.json", import.meta.url), "utf8"),
);

const submitted = (at = 1_756_900_000_000) => ({ canvasSubmittedAt: at });

describe("extraCreditCards", () => {
  it("ignores assignments outside the extra-credit category", () => {
    expect(
      extraCreditCards([
        { id: "perf-graphs", category: "performance" },
        { id: "final", category: "final" },
      ]),
    ).toEqual([]);
    expect(extraCreditCards([])).toEqual([]);
    expect(extraCreditCards(null)).toEqual([]);
  });

  it("collapses numbered siblings into one repeatable card", () => {
    const cards = extraCreditCards([
      { id: "ec-r-1", title: "Report 1", category: "extra-credit", points: 3 },
      { id: "ec-r-2", title: "Report 2", category: "extra-credit", points: 3 },
      { id: "ec-r-3", title: "Report 3", category: "extra-credit", points: 3 },
    ]);
    expect(cards).toHaveLength(1);
    expect(cards[0].kind).toBe("repeatable");
    expect(cards[0].slots).toEqual(["ec-r-1", "ec-r-2", "ec-r-3"]);
    // The card names the task, not the slot.
    expect(cards[0].title).toBe("Report");
    // Points are PER submission, not a total for the card.
    expect(cards[0].points).toBe(3);
  });

  it("orders slots numerically, whatever order they arrive in", () => {
    const cards = extraCreditCards([
      { id: "ec-r-3", title: "Report 3", category: "extra-credit" },
      { id: "ec-r-1", title: "Report 1", category: "extra-credit" },
      { id: "ec-r-2", title: "Report 2", category: "extra-credit" },
    ]);
    expect(cards[0].slots).toEqual(["ec-r-1", "ec-r-2", "ec-r-3"]);
  });

  it("keeps distinct ids separate even when they share a prefix", () => {
    // "ec-amazing-project-personal" is its own project, not slot
    // "personal" of a repeatable — the suffix isn't a number.
    const cards = extraCreditCards([
      { id: "ec-amazing-project-personal", title: "P", category: "extra-credit" },
      { id: "ec-amazing-project-paid", title: "M", category: "extra-credit" },
    ]);
    expect(cards).toHaveLength(2);
    expect(cards.every((c) => c.kind === "single")).toBe(true);
  });

  it("marks a tbd assignment unavailable with no slots", () => {
    const cards = extraCreditCards([
      { id: "ec-feature-fix", title: "Fix a Bug", category: "extra-credit", tbd: true, points: 0 },
    ]);
    expect(cards[0].kind).toBe("unavailable");
    expect(cards[0].slots).toEqual([]);
    expect(cards[0].reason).toMatch(/no Canvas assignment/i);
  });

  it("carries the submission type through for URL submissions", () => {
    const cards = extraCreditCards([
      { id: "ec-p", title: "P", category: "extra-credit", submit: "online_url" },
      { id: "ec-q", title: "Q", category: "extra-credit" },
    ]);
    expect(cards[0].submissionType).toBe("online_url");
    expect(cards[1].submissionType).toBe("online_text_entry");
  });
});

describe("against the real course.json", () => {
  const cards = extraCreditCards(COURSE.assignments);

  it("turns 15 assignments into 9 cards", () => {
    const ec = COURSE.assignments.filter((a) => a.category === "extra-credit");
    expect(ec).toHaveLength(15);
    expect(cards).toHaveLength(9);
  });

  it("finds both repeatables with the right slot counts", () => {
    const repeatable = cards.filter((c) => c.kind === "repeatable");
    expect(repeatable.map((c) => [c.title, c.slots.length])).toEqual([
      ["Real Interview Report", 5],
      ["Real Offer Report", 3],
    ]);
  });

  it("covers every extra-credit assignment exactly once", () => {
    // A slot missed here is an assignment a student can never submit.
    const slotted = cards.flatMap((c) => c.slots);
    const ec = COURSE.assignments
      .filter((a) => a.category === "extra-credit" && !a.tbd)
      .map((a) => a.id);
    expect(slotted.slice().sort()).toEqual(ec.slice().sort());
  });

  it("leaves ec-feature-fix unavailable", () => {
    const fix = cards.find((c) => c.title === "Add a Feature or Fix a Bug");
    expect(fix.kind).toBe("unavailable");
  });
});

describe("cardState", () => {
  const card = { points: 3, slots: ["ec-r-1", "ec-r-2", "ec-r-3"] };

  it("points at the first slot when nothing is submitted", () => {
    const state = cardState(card, {});
    expect(state.nextSlot).toBe("ec-r-1");
    expect(state.submittedCount).toBe(0);
    expect(state.earnedPoints).toBe(0);
    expect(state.maxPoints).toBe(9);
  });

  it("advances to the next unused slot", () => {
    const state = cardState(card, { "ec-r-1": submitted() });
    expect(state.nextSlot).toBe("ec-r-2");
    expect(state.submittedCount).toBe(1);
    expect(state.earnedPoints).toBe(3);
  });

  it("skips a gap rather than assuming slots fill in order", () => {
    // A student could submit slot 2 first if a card were ever rendered
    // mid-migration. Take the first genuinely free one.
    const state = cardState(card, { "ec-r-2": submitted() });
    expect(state.nextSlot).toBe("ec-r-1");
    expect(state.submittedCount).toBe(1);
  });

  it("reports no next slot once every one is used", () => {
    const state = cardState(card, {
      "ec-r-1": submitted(),
      "ec-r-2": submitted(),
      "ec-r-3": submitted(),
    });
    expect(state.nextSlot).toBe(null);
    expect(state.earnedPoints).toBe(9);
  });

  it("ignores progress docs with no submission timestamp", () => {
    // A doc can exist from a signoff request without ever being submitted.
    const state = cardState(card, { "ec-r-1": { status: "requested" } });
    expect(state.submittedCount).toBe(0);
    expect(state.nextSlot).toBe("ec-r-1");
  });

  it("handles a card with no slots", () => {
    const state = cardState({ points: 0, slots: [] }, {});
    expect(state.nextSlot).toBe(null);
    expect(state.maxPoints).toBe(0);
  });
});

describe("extraCreditTotals", () => {
  const cards = extraCreditCards(COURSE.assignments);

  it("totals the maximum available across every card", () => {
    // 8 + 5*3 + 3*5 + 3 + 5 + 5 + 5 + 5 = 61
    expect(extraCreditTotals(cards, {}).max).toBe(61);
    expect(extraCreditTotals(cards, {}).earned).toBe(0);
  });

  it("excludes the unavailable card from the maximum", () => {
    const totals = extraCreditTotals(cards, {});
    const unavailable = cards.find((c) => c.kind === "unavailable");
    expect(unavailable).toBeTruthy();
    // It contributes nothing, so students aren't shown points they
    // cannot possibly earn.
    expect(totals.max).toBe(61);
  });

  it("adds up what's been submitted", () => {
    const totals = extraCreditTotals(cards, {
      "ec-interview-ready": submitted(),
      "ec-real-interview-report-1": submitted(),
      "ec-real-interview-report-2": submitted(),
    });
    expect(totals.earned).toBe(8 + 3 + 3);
    expect(totals.submissions).toBe(3);
  });
});
