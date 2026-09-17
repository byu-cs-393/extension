// @vitest-environment jsdom
//
// The "Suggested for you" card. Collapsed by default: it's optional
// practice sitting beneath the week's actual assigned work, so it
// shouldn't occupy four rows until someone asks for it.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createSuggestionsCard } from "../src/ui/suggestions-card.js";

const pick = (over = {}) => ({
  slug: "invert-binary-tree",
  title: "Invert Binary Tree",
  difficulty: "Easy",
  acceptance: 80.4,
  id: 226,
  matchedTopics: ["depth-first-search", "breadth-first-search", "binary-tree"],
  ...over,
});

const picks = [
  pick(),
  pick({ slug: "max-area-of-island", title: "Max Area of Island", difficulty: "Medium", id: 695 }),
];

let host;
beforeEach(() => {
  document.body.innerHTML = "";
  host = document.body;
});

const render = (opts) => {
  const card = createSuggestionsCard(picks, opts);
  host.appendChild(card);
  return card;
};

describe("opening and closing", () => {
  it("starts closed", () => {
    expect(render().querySelector("details").open).toBe(false);
  });

  it("opens when told to — so it survives a re-render", () => {
    // renderWeeks rebuilds the DOM on every progress change; without this
    // the list would snap shut under a student mid-read.
    expect(render({ open: true }).querySelector("details").open).toBe(true);
  });

  it("reports the change so the caller can remember it", () => {
    const onToggle = vi.fn();
    const details = render({ onToggle }).querySelector("details");
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    expect(onToggle).toHaveBeenCalledWith(true);

    details.open = false;
    details.dispatchEvent(new Event("toggle"));
    expect(onToggle).toHaveBeenLastCalledWith(false);
  });

  it("works with no handler given", () => {
    const details = render().querySelector("details");
    expect(() => details.dispatchEvent(new Event("toggle"))).not.toThrow();
  });

  it("puts the count in the header, so it's useful while closed", () => {
    expect(render().querySelector("summary").textContent).toContain("2");
  });
});

describe("what's in the list", () => {
  it("links each problem to LeetCode", () => {
    const links = [...render().querySelectorAll("a.problem-link")];
    expect(links.map((a) => a.textContent)).toEqual(["Invert Binary Tree", "Max Area of Island"]);
    expect(links[0].href).toBe("https://leetcode.com/problems/invert-binary-tree/");
    // Opening LeetCode shouldn't navigate away from the dashboard.
    expect(links[0].target).toBe("_blank");
    expect(links[0].rel).toContain("noopener");
  });

  it("tags difficulty with the style that already existed for it", () => {
    const tags = [...render().querySelectorAll(".problem-diff")];
    expect(tags.map((t) => t.textContent)).toEqual(["Easy", "Medium"]);
    expect(tags[0].className).toContain("diff-easy");
    expect(tags[1].className).toContain("diff-medium");
  });

  // Standing in for the model's one-line reason until the course has an API
  // key — saying why a problem was picked beats a bare list.
  it("says what each problem exercises", () => {
    const why = render().querySelector(".suggestion-why");
    expect(why.textContent).toContain("depth-first-search");
  });

  it("caps the reason so one problem can't take over the card", () => {
    const many = [pick({ matchedTopics: ["a", "b", "c", "d", "e"] })];
    host.appendChild(createSuggestionsCard(many));
    expect(host.querySelector(".suggestion-why").textContent.split(" · ")).toHaveLength(3);
  });

  it("renders a pick with no matched topics without an empty line", () => {
    host.appendChild(createSuggestionsCard([pick({ matchedTopics: [] })]));
    expect(host.querySelector(".suggestion-why")).toBeNull();
  });
});
