// Unit tests for src/lib/problem-url.js.
//
// This logic lives in the LeetCode content scripts, which until bundling
// could not be imported by a test — and it was wrong in production twice:
// once labelling a session with the previous problem's title, and again
// in leetcode-tracker.js, whose copy never got the fix.
import { describe, it, expect } from "vitest";
import {
  parseProblemSlug,
  slugToTitle,
  titleToSlug,
  strippedDocumentTitle,
  titleMatchesSlug,
  getProblemTitle,
} from "../src/lib/problem-url.js";

describe("parseProblemSlug", () => {
  it("pulls the slug from a problem URL", () => {
    expect(parseProblemSlug("https://leetcode.com/problems/two-sum/")).toBe("two-sum");
  });

  it("ignores trailing path, query and hash", () => {
    expect(
      parseProblemSlug("https://leetcode.com/problems/lru-cache/submissions/123/"),
    ).toBe("lru-cache");
    expect(parseProblemSlug("https://leetcode.com/problems/two-sum?envType=x")).toBe("two-sum");
    expect(parseProblemSlug("https://leetcode.com/problems/two-sum#solution")).toBe("two-sum");
  });

  it("returns null off a problem page", () => {
    expect(parseProblemSlug("https://leetcode.com/problemset/all/")).toBe(null);
    expect(parseProblemSlug("https://example.com/problems/two-sum")).toBe(null);
    expect(parseProblemSlug("http://leetcode.com/problems/two-sum")).toBe(null);
    expect(parseProblemSlug(null)).toBe(null);
    expect(parseProblemSlug(undefined)).toBe(null);
  });
});

describe("slugToTitle / titleToSlug", () => {
  it("title-cases a slug", () => {
    expect(slugToTitle("two-sum")).toBe("Two Sum");
    expect(slugToTitle("longest-palindromic-substring")).toBe("Longest Palindromic Substring");
  });

  it("survives empty and malformed slugs", () => {
    expect(slugToTitle("")).toBe("");
    expect(slugToTitle(null)).toBe("");
    expect(slugToTitle("--odd--slug--")).toBe("Odd Slug");
  });

  it("normalizes a display title to slug form", () => {
    expect(titleToSlug("Two Sum")).toBe("two-sum");
    expect(titleToSlug("Pow(x, n)")).toBe("pow-x-n");
    expect(titleToSlug("  Spaced  Out  ")).toBe("spaced-out");
    expect(titleToSlug(null)).toBe("");
  });

  it("round-trips ordinary slugs", () => {
    for (const slug of ["two-sum", "valid-parentheses", "lru-cache", "3sum"]) {
      expect(titleToSlug(slugToTitle(slug))).toBe(slug);
    }
  });
});

describe("strippedDocumentTitle", () => {
  it("removes LeetCode's suffix, with either dash", () => {
    expect(strippedDocumentTitle("Two Sum - LeetCode")).toBe("Two Sum");
    expect(strippedDocumentTitle("Two Sum – LeetCode")).toBe("Two Sum");
    expect(strippedDocumentTitle("Two Sum")).toBe("Two Sum");
  });

  it("handles an empty or missing title", () => {
    expect(strippedDocumentTitle("")).toBe("");
    expect(strippedDocumentTitle(null)).toBe("");
  });
});

describe("titleMatchesSlug", () => {
  it("accepts a title belonging to the slug", () => {
    expect(titleMatchesSlug("Two Sum - LeetCode", "two-sum")).toBe(true);
    expect(titleMatchesSlug("3Sum - LeetCode", "3sum")).toBe(true);
  });

  it("rejects a title from a different problem", () => {
    // The SPA-navigation bug: the URL moved on, document.title hadn't.
    expect(titleMatchesSlug("Two Sum - LeetCode", "add-two-numbers")).toBe(false);
  });

  it("rejects an empty title", () => {
    expect(titleMatchesSlug("", "two-sum")).toBe(false);
    expect(titleMatchesSlug(" - LeetCode", "two-sum")).toBe(false);
  });
});

describe("getProblemTitle", () => {
  it("keeps LeetCode's own casing when the title checks out", () => {
    expect(
      getProblemTitle("Median of Two Sorted Arrays - LeetCode", "median-of-two-sorted-arrays"),
    ).toBe("Median of Two Sorted Arrays");
    expect(getProblemTitle("3Sum - LeetCode", "3sum")).toBe("3Sum");
  });

  it("falls back to the slug when the title names another problem", () => {
    expect(getProblemTitle("Two Sum - LeetCode", "add-two-numbers")).toBe("Add Two Numbers");
  });

  it("falls back when there's no title at all", () => {
    expect(getProblemTitle("", "lru-cache")).toBe("Lru Cache");
    expect(getProblemTitle(null, "two-sum")).toBe("Two Sum");
  });

  it("falls back for titles that don't round-trip", () => {
    // "Pow(x, n)" slugifies to "pow-x-n", not "powx-n". Plainer beats wrong.
    expect(getProblemTitle("Pow(x, n) - LeetCode", "powx-n")).toBe("Powx N");
  });
});
