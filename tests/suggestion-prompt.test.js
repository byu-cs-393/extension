// Prompt building and — the part that matters — holding the model's
// reply to the shortlist it was given.
//
// These run against the CJS module the Cloud Function uses, so a broken
// guardrail fails here rather than in production on a student's
// dashboard.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  MAX_CANDIDATES,
  sanitizeCandidates,
  describeStudent,
  buildRequest,
  pickFromCandidates,
  fallbackPicks,
} = require("../functions/suggestion-prompt.js");

const candidate = (slug, over = {}) => ({
  slug,
  title: `Title of ${slug}`,
  difficulty: "Medium",
  topics: ["tree"],
  acceptance: 60,
  ...over,
});

// A tool_use reply in the shape the Anthropic API returns.
const reply = (picks) => ({
  content: [{ type: "tool_use", name: "recommend", input: { picks } }],
});

describe("sanitizeCandidates", () => {
  it("caps how many candidates a caller can submit", () => {
    const many = Array.from({ length: 200 }, (_, i) => candidate(`p-${i}`));
    expect(sanitizeCandidates(many)).toHaveLength(MAX_CANDIDATES);
  });

  it("drops malformed and duplicate slugs", () => {
    const out = sanitizeCandidates([
      candidate("two-sum"),
      candidate("two-sum"),
      candidate("Two Sum"),      // spaces and capitals aren't slugs
      candidate(""),
      { title: "no slug at all" },
    ]);
    expect(out.map((c) => c.slug)).toEqual(["two-sum"]);
  });

  it("survives junk instead of an array", () => {
    expect(sanitizeCandidates(null)).toEqual([]);
    expect(sanitizeCandidates("nope")).toEqual([]);
  });
});

describe("describeStudent", () => {
  it("says so plainly when there is no history", () => {
    expect(describeStudent({})).toContain("No practice history");
    expect(describeStudent()).toContain("No practice history");
  });

  it("reports only the signals it was actually given", () => {
    const text = describeStudent({ solvedAllTime: 12 });
    expect(text).toContain("12 problems solved");
    expect(text).not.toContain("minutes");
  });
});

describe("buildRequest", () => {
  it("forces the model to answer through the tool", () => {
    const { body } = buildRequest({ candidates: [candidate("a")], model: "m" });
    expect(body.tool_choice).toEqual({ type: "tool", name: "recommend" });
    expect(body.tools[0].name).toBe("recommend");
  });

  it("never asks for more picks than there are candidates", () => {
    const { body } = buildRequest({
      candidates: [candidate("a"), candidate("b")],
      limit: 4,
      model: "m",
    });
    expect(body.tools[0].input_schema.properties.picks.maxItems).toBe(2);
    expect(body.system).toContain("exactly 2 problems");
  });

  it("puts every candidate slug in the prompt", () => {
    const { body } = buildRequest({
      candidates: [candidate("two-sum"), candidate("lru-cache")],
      model: "m",
    });
    const text = body.messages[0].content;
    expect(text).toContain("two-sum");
    expect(text).toContain("lru-cache");
  });
});

describe("pickFromCandidates", () => {
  const candidates = sanitizeCandidates([candidate("a"), candidate("b")]);

  it("keeps picks that were on the shortlist", () => {
    const out = pickFromCandidates(
      reply([{ slug: "a", reason: "Practises recursion." }]),
      candidates,
    );
    expect(out).toHaveLength(1);
    expect(out[0].slug).toBe("a");
    expect(out[0].url).toBe("https://leetcode.com/problems/a/");
  });

  // The whole feature rests on this. The catalog stops the model
  // inventing a problem that doesn't exist; this stops it returning a
  // real one that wasn't offered — an already-solved problem, or one
  // sitting on a later week's OA.
  it("drops any pick that was not offered", () => {
    const out = pickFromCandidates(
      reply([
        { slug: "a", reason: "ok" },
        { slug: "not-offered", reason: "should vanish" },
        { slug: "next-weeks-oa-problem", reason: "definitely should vanish" },
      ]),
      candidates,
    );
    expect(out.map((p) => p.slug)).toEqual(["a"]);
  });

  it("drops repeats", () => {
    const out = pickFromCandidates(
      reply([
        { slug: "a", reason: "one" },
        { slug: "a", reason: "two" },
      ]),
      candidates,
    );
    expect(out).toHaveLength(1);
  });

  it("returns nothing rather than throwing on a malformed reply", () => {
    expect(pickFromCandidates({}, candidates)).toEqual([]);
    expect(pickFromCandidates({ content: [] }, candidates)).toEqual([]);
    expect(pickFromCandidates({ content: [{ type: "text", text: "hi" }] }, candidates)).toEqual([]);
    expect(pickFromCandidates(reply("not an array"), candidates)).toEqual([]);
    expect(pickFromCandidates(null, candidates)).toEqual([]);
  });

  it("tolerates a missing reason", () => {
    const out = pickFromCandidates(reply([{ slug: "a" }]), candidates);
    expect(out[0].reason).toBe("");
  });
});

describe("fallbackPicks", () => {
  // The shortlist arrives already ordered by the deterministic scorer,
  // so losing the model costs the explanations, not the suggestions.
  it("still returns usable problems when the model is unavailable", () => {
    const out = fallbackPicks(sanitizeCandidates([candidate("a"), candidate("b")]), 2);
    expect(out.map((p) => p.slug)).toEqual(["a", "b"]);
    expect(out[0].url).toContain("leetcode.com/problems/a/");
    expect(out[0].reason.length).toBeGreaterThan(0);
  });
});
