// @vitest-environment jsdom
//
// "Suggest a problem" — one pick at a difficulty the student chooses.
//
// It used to show four problems permanently on the week card. A list makes
// you choose twice: which of these, and whether to do it at all. One pick is
// a recommendation.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createSuggestionsCard } from "../src/ui/suggestions-card.js";

const pick = (over = {}) => ({
  slug: "invert-binary-tree",
  title: "Invert Binary Tree",
  difficulty: "Easy",
  matchedTopics: ["depth-first-search", "breadth-first-search", "binary-tree"],
  ...over,
});

let requestPick;
beforeEach(() => {
  document.body.innerHTML = "";
  requestPick = vi.fn(async () => pick());
});

function render(opts = {}) {
  const card = createSuggestionsCard({ requestPick, ...opts });
  document.body.appendChild(card);
  return card;
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const chip = (label) => $$(".difficulty-choice").find((b) => b.textContent === label);
const activeChip = () => $$(".difficulty-choice").find((b) => b.getAttribute("aria-pressed") === "true");

async function openCard(card) {
  const details = card.querySelector("details");
  details.open = true;
  details.dispatchEvent(new Event("toggle"));
  await settle();
  return details;
}

describe("opening", () => {
  it("starts closed and asks for nothing", () => {
    render();
    expect($("details").open).toBe(false);
    // A collapsed card shouldn't spend a lookup on a problem nobody reads.
    expect(requestPick).not.toHaveBeenCalled();
  });

  it("fetches a problem when opened", async () => {
    await openCard(render());
    expect(requestPick).toHaveBeenCalledTimes(1);
    expect($(".suggestion-title").textContent).toBe("Invert Binary Tree");
  });

  it("fetches immediately when it starts open", async () => {
    render({ open: true });
    await settle();
    expect(requestPick).toHaveBeenCalledTimes(1);
  });

  it("reports opening and closing so the caller can remember it", async () => {
    const onToggle = vi.fn();
    const details = await openCard(render({ onToggle }));
    expect(onToggle).toHaveBeenLastCalledWith(true);
    details.open = false;
    details.dispatchEvent(new Event("toggle"));
    expect(onToggle).toHaveBeenLastCalledWith(false);
  });
});

describe("choosing a difficulty", () => {
  it("offers Any, Easy, Medium and Hard", () => {
    render();
    expect($$(".difficulty-choice").map((b) => b.textContent)).toEqual([
      "Any", "Easy", "Medium", "Hard",
    ]);
  });

  it("starts on the level the caller remembered", () => {
    render({ difficulty: "Hard" });
    expect(activeChip().textContent).toBe("Hard");
  });

  it("asks for that level, and reports the choice", async () => {
    const onDifficulty = vi.fn();
    await openCard(render({ onDifficulty }));
    chip("Medium").click();
    await settle();
    expect(onDifficulty).toHaveBeenCalledWith("Medium");
    expect(requestPick).toHaveBeenLastCalledWith("Medium");
    expect(activeChip().textContent).toBe("Medium");
  });

  it("ignores a click on the level already chosen", async () => {
    await openCard(render());
    requestPick.mockClear();
    chip("Any").click();
    await settle();
    expect(requestPick).not.toHaveBeenCalled();
  });
});

describe("showing another", () => {
  it("asks again at the same level", async () => {
    await openCard(render({ difficulty: "Hard" }));
    requestPick.mockClear();
    $(".suggestion-another").click();
    await settle();
    expect(requestPick).toHaveBeenCalledWith("Hard");
  });

  it("replaces the problem rather than appending", async () => {
    await openCard(render());
    requestPick.mockResolvedValue(pick({ title: "Max Area of Island", difficulty: "Medium" }));
    $(".suggestion-another").click();
    await settle();
    expect($$(".suggestion-pick")).toHaveLength(1);
    expect($(".suggestion-title").textContent).toBe("Max Area of Island");
  });

  // Two requests at once would race, and the loser could overwrite the
  // winner's problem.
  it("won't start a second request while one is in flight", async () => {
    let release;
    requestPick.mockImplementation(() => new Promise((r) => { release = r; }));
    await openCard(render());
    $(".suggestion-another").click();
    $(".suggestion-another").click();
    expect(requestPick).toHaveBeenCalledTimes(1);
    release(pick());
    await settle();
  });

  it("disables the button while it's working", async () => {
    let release;
    requestPick.mockImplementation(() => new Promise((r) => { release = r; }));
    render({ open: true });
    await settle();
    expect($(".suggestion-another").disabled).toBe(true);
    release(pick());
    await settle();
    expect($(".suggestion-another").disabled).toBe(false);
  });
});

describe("what a pick shows", () => {
  it("links to LeetCode without navigating away from the dashboard", async () => {
    await openCard(render());
    const link = $(".suggestion-title");
    expect(link.href).toBe("https://leetcode.com/problems/invert-binary-tree/");
    expect(link.target).toBe("_blank");
    expect(link.rel).toContain("noopener");
  });

  it("tags difficulty with the style already defined for it", async () => {
    requestPick.mockResolvedValue(pick({ difficulty: "Hard" }));
    await openCard(render());
    const tag = $(".problem-diff");
    expect(tag.textContent).toBe("Hard");
    expect(tag.className).toContain("diff-hard");
  });

  it("says what the problem exercises", async () => {
    await openCard(render());
    expect($(".suggestion-why").textContent).toContain("depth-first-search");
  });

  it("caps the reason so one problem can't take over the card", async () => {
    requestPick.mockResolvedValue(pick({ matchedTopics: ["a", "b", "c", "d", "e"] }));
    await openCard(render());
    expect($(".suggestion-why").textContent.split(" · ")).toHaveLength(3);
  });

  it("omits the reason rather than leaving an empty line", async () => {
    requestPick.mockResolvedValue(pick({ matchedTopics: [] }));
    await openCard(render());
    expect($(".suggestion-why")).toBeNull();
  });
});

describe("running out", () => {
  // Real, not hypothetical: easy dynamic-programming problems run out at 7.
  it("names a way forward when a level is exhausted", async () => {
    requestPick.mockResolvedValue(null);
    await openCard(render({ difficulty: "Easy" }));
    expect($(".suggestion-message").textContent).toMatch(/nothing easy left/i);
    expect($(".suggestion-message").textContent).toMatch(/another level/i);
  });

  it("says something different when every level is exhausted", async () => {
    requestPick.mockResolvedValue(null);
    await openCard(render({ difficulty: "Any" }));
    expect($(".suggestion-message").textContent).toMatch(/seen everything/i);
  });

  it("survives the lookup failing", async () => {
    requestPick.mockRejectedValue(new Error("catalog missing"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await openCard(render());
    expect($(".suggestion-message")).not.toBeNull();
    // And can still be retried.
    expect($(".suggestion-another").disabled).toBe(false);
  });

  it("works with no requestPick at all", async () => {
    document.body.appendChild(createSuggestionsCard({ open: true }));
    await settle();
    expect($(".suggestion-message")).not.toBeNull();
  });
});
