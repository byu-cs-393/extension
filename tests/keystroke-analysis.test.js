// Unit tests for src/keystroke-analysis.js. Pure functions only — plain
// data in, plain data out, no chrome.*, no fetch, no DOM.
//
// Event fixtures below mirror exactly what keystroke-tracker.js writes;
// if that capture shape changes, these break, which is the point.
import { describe, it, expect } from "vitest";
import {
  flattenChunks,
  hiddenSpans,
  activeMs,
  typingStats,
  pasteEvents,
  copyEvents,
  summarizeSession,
  suspicionSignals,
  totalActiveMs,
  activeMsByProblem,
  activeMsInWindow,
  formatDuration,
  MAX_ACTIVE_GAP_MS,
  MIN_SAMPLES_FOR_CADENCE,
} from "../src/keystroke-analysis.js";

const T0 = 1_756_900_000_000; // arbitrary fixed epoch, keeps tests deterministic

// A single-character insert at `offset`, `atMs` after T0.
const type = (atMs, text = "x", offset = 0) => ({
  kind: "delta",
  t: atMs,
  wallMs: T0 + atMs,
  offset,
  length: 0,
  text,
});

// A deletion of `chars` characters.
const del = (atMs, chars = 1, offset = 0) => ({
  kind: "delta",
  t: atMs,
  wallMs: T0 + atMs,
  offset,
  length: chars,
  text: "",
});

const paste = (atMs, length, preview = "") => ({
  kind: "paste",
  t: atMs,
  wallMs: T0 + atMs,
  length,
  preview,
});

const copy = (atMs, length, preview = "") => ({
  kind: "copy",
  t: atMs,
  wallMs: T0 + atMs,
  length,
  preview,
});

const blur = (atMs) => ({ kind: "tab_blur", t: atMs, wallMs: T0 + atMs });
const focus = (atMs) => ({ kind: "tab_focus", t: atMs, wallMs: T0 + atMs });

// Steady typing every `gapMs`, starting at `fromMs`.
const typeRun = (count, gapMs, fromMs = 0) =>
  Array.from({ length: count }, (_, i) => type(fromMs + i * gapMs));

describe("flattenChunks", () => {
  it("returns [] for non-arrays", () => {
    expect(flattenChunks(null)).toEqual([]);
    expect(flattenChunks(undefined)).toEqual([]);
    expect(flattenChunks({})).toEqual([]);
  });

  it("merges chunks and orders by wallMs, not by chunk order", () => {
    // Firestore listing order isn't guaranteed to match chunkIndex.
    const chunks = [
      { chunkIndex: 1, events: [type(2000), type(3000)] },
      { chunkIndex: 0, events: [type(0), type(1000)] },
    ];
    expect(flattenChunks(chunks).map((e) => e.wallMs - T0)).toEqual([
      0, 1000, 2000, 3000,
    ]);
  });

  it("drops events with no usable wallMs rather than sorting them to the epoch", () => {
    const chunks = [
      {
        events: [
          type(1000),
          { kind: "delta", t: 5, text: "y", length: 0 }, // no wallMs
          { kind: "delta", wallMs: null, text: "z", length: 0 },
          null,
        ],
      },
    ];
    expect(flattenChunks(chunks)).toHaveLength(1);
  });

  it("tolerates chunks with no events array", () => {
    expect(flattenChunks([{ chunkIndex: 0 }, { events: null }])).toEqual([]);
  });
});

describe("hiddenSpans", () => {
  it("pairs blur with the following focus", () => {
    const events = [type(0), blur(1000), focus(4000), type(5000)];
    expect(hiddenSpans(events)).toEqual([[T0 + 1000, T0 + 4000]]);
  });

  it("closes a dangling blur at `until` (session ended while hidden)", () => {
    const events = [type(0), blur(1000)];
    expect(hiddenSpans(events, T0 + 3000)).toEqual([[T0 + 1000, T0 + 3000]]);
  });

  it("leaves a dangling blur open when no `until` is given", () => {
    expect(hiddenSpans([blur(1000)])).toEqual([]);
  });

  it("ignores a leading focus (session started on a background tab)", () => {
    const events = [focus(500), type(1000), blur(2000), focus(3000)];
    expect(hiddenSpans(events)).toEqual([[T0 + 2000, T0 + 3000]]);
  });

  it("ignores repeated blurs without an intervening focus", () => {
    const events = [blur(1000), blur(2000), focus(3000)];
    expect(hiddenSpans(events)).toEqual([[T0 + 1000, T0 + 3000]]);
  });
});

describe("activeMs", () => {
  it("returns 0 for fewer than two events", () => {
    expect(activeMs([])).toBe(0);
    expect(activeMs([type(0)])).toBe(0);
    expect(activeMs(null)).toBe(0);
  });

  it("sums gaps between consecutive events", () => {
    expect(activeMs([type(0), type(1000), type(2500)])).toBe(2500);
  });

  it("caps a single long gap at maxGapMs", () => {
    // 30 min of nothing counts as maxGapMs, not 30 min.
    const events = [type(0), type(30 * 60 * 1000)];
    expect(activeMs(events)).toBe(MAX_ACTIVE_GAP_MS);
  });

  it("respects a caller-supplied maxGapMs", () => {
    const events = [type(0), type(60_000)];
    expect(activeMs(events, { maxGapMs: 10_000 })).toBe(10_000);
  });

  it("excludes time the tab was hidden", () => {
    // Type at 0, blur at 1s, focus at 61s, type at 62s.
    // Active = 1s (0→1s) + 0s (hidden 1s→61s) + 1s (61s→62s).
    const events = [type(0), blur(1000), focus(61_000), type(62_000)];
    expect(activeMs(events)).toBe(2000);
  });

  it("does not go negative when a hidden span covers a capped gap", () => {
    const events = [type(0), blur(100), focus(600_000), type(600_100)];
    expect(activeMs(events)).toBeGreaterThanOrEqual(0);
  });

  it("ignores non-positive gaps from same-millisecond deltas", () => {
    const events = [type(0), type(0), type(0), type(500)];
    expect(activeMs(events)).toBe(500);
  });

  it("counts paste and visibility events as activity, not just deltas", () => {
    expect(activeMs([type(0), paste(1000, 200), type(2000)])).toBe(2000);
  });
});

describe("typingStats", () => {
  it("returns zeroed stats with null ratios for an empty stream", () => {
    const stats = typingStats([]);
    expect(stats.deltaCount).toBe(0);
    expect(stats.deletionRatio).toBe(null);
    expect(stats.cadenceCv).toBe(null);
    expect(stats.medianGapMs).toBe(null);
  });

  it("separates inserts from deletions", () => {
    const stats = typingStats([type(0, "abc"), del(100, 2), type(200, "d")]);
    expect(stats.insertCount).toBe(2);
    expect(stats.insertedChars).toBe(4);
    expect(stats.deleteCount).toBe(1);
    expect(stats.deletedChars).toBe(2);
    expect(stats.deletionRatio).toBeCloseTo(1 / 3);
  });

  it("counts a selection-overwrite as both an insert and a delete", () => {
    // Monaco: replace `length` chars at offset with `text`.
    const overwrite = { kind: "delta", t: 0, wallMs: T0, offset: 5, length: 4, text: "abcd" };
    const stats = typingStats([overwrite]);
    expect(stats.insertCount).toBe(1);
    expect(stats.deleteCount).toBe(1);
  });

  it("flags single inserts at or above LARGE_INSERT_CHARS", () => {
    const stats = typingStats([type(0, "a".repeat(30)), type(100, "b".repeat(29))]);
    expect(stats.largeInserts).toBe(1);
  });

  it("ignores non-delta events", () => {
    const stats = typingStats([type(0), paste(100, 500), blur(200), focus(300)]);
    expect(stats.deltaCount).toBe(1);
  });

  it("reports null cadenceCv below the sample threshold", () => {
    const stats = typingStats(typeRun(MIN_SAMPLES_FOR_CADENCE - 5, 100));
    expect(stats.cadenceCv).toBe(null);
  });

  it("gives a near-zero cadenceCv for perfectly even typing", () => {
    const stats = typingStats(typeRun(60, 100));
    expect(stats.cadenceCv).toBeCloseTo(0, 5);
  });

  it("gives a high cadenceCv for bursty human-like typing", () => {
    // Fast runs punctuated by thinking pauses.
    const events = [];
    let at = 0;
    for (let burst = 0; burst < 8; burst += 1) {
      for (let i = 0; i < 8; i += 1) {
        events.push(type(at));
        at += 60;
      }
      at += 4000;
    }
    expect(typingStats(events).cadenceCv).toBeGreaterThan(0.8);
  });

  it("excludes long thinking pauses from cadence samples", () => {
    // One huge gap shouldn't dominate; it's dropped, not clamped.
    const events = [...typeRun(30, 100), type(30 * 100 + MAX_ACTIVE_GAP_MS * 2)];
    const stats = typingStats(events);
    expect(stats.sampleCount).toBe(29);
    expect(stats.cadenceCv).toBeCloseTo(0, 5);
  });

  it("computes the median gap", () => {
    const events = [type(0), type(100), type(300), type(1300)];
    expect(typingStats(events).medianGapMs).toBe(200);
  });
});

describe("pasteEvents / copyEvents", () => {
  it("keeps pastes at or above the threshold", () => {
    const events = [paste(0, 10), paste(100, 40), paste(200, 500)];
    expect(pasteEvents(events).map((p) => p.length)).toEqual([40, 500]);
  });

  it("honours a custom minLength", () => {
    const events = [paste(0, 10), paste(100, 40)];
    expect(pasteEvents(events, { minLength: 5 })).toHaveLength(2);
  });

  it("carries the preview through, defaulting to empty string", () => {
    const events = [paste(0, 100, "def solve(self):"), { ...paste(100, 100), preview: undefined }];
    const out = pasteEvents(events);
    expect(out[0].preview).toBe("def solve(self):");
    expect(out[1].preview).toBe("");
  });

  it("drops pastes with a non-numeric length", () => {
    expect(pasteEvents([{ kind: "paste", wallMs: T0, length: null }])).toEqual([]);
  });

  it("picks up copies separately from pastes", () => {
    const events = [paste(0, 100), copy(100, 200)];
    expect(pasteEvents(events)).toHaveLength(1);
    expect(copyEvents(events)).toHaveLength(1);
    expect(copyEvents(events)[0].length).toBe(200);
  });
});

describe("summarizeSession", () => {
  const session = {
    sessionId: "two-sum-123-abc",
    netID: "jack684",
    problemSlug: "two-sum",
    problemTitle: "Two Sum",
    startedAt: T0,
    lastActivityAt: T0 + 300_000,
    endReason: "idle",
  };

  it("rolls up a session into one object", () => {
    const chunks = [
      { chunkIndex: 0, events: [type(0, "def "), type(500, "s"), paste(1000, 120, "return []")] },
      { chunkIndex: 1, events: [del(1500, 3), type(2000, "x")] },
    ];
    const summary = summarizeSession(session, chunks);

    expect(summary.sessionId).toBe("two-sum-123-abc");
    expect(summary.problemSlug).toBe("two-sum");
    expect(summary.eventCount).toBe(5);
    expect(summary.activeMs).toBe(2000);
    expect(summary.elapsedMs).toBe(300_000);
    expect(summary.pastes).toHaveLength(1);
    expect(summary.pastedChars).toBe(120);
    expect(summary.typing.insertedChars).toBe(6);
  });

  it("separates wall-clock elapsed from active time", () => {
    // Tab open five minutes, two seconds of actual work. Both reported;
    // the gap between them is an idle tab, not a finding.
    const chunks = [{ events: [type(0), type(2000)] }];
    const summary = summarizeSession(session, chunks);
    expect(summary.elapsedMs).toBe(300_000);
    expect(summary.activeMs).toBe(2000);
  });

  it("reports hiddenMs", () => {
    const chunks = [{ events: [type(0), blur(1000), focus(5000), type(6000)] }];
    expect(summarizeSession(session, chunks).hiddenMs).toBe(4000);
  });

  it("survives a null session doc and empty chunks", () => {
    const summary = summarizeSession(null, []);
    expect(summary.sessionId).toBe(null);
    expect(summary.activeMs).toBe(0);
    expect(summary.elapsedMs).toBe(null);
    expect(summary.eventCount).toBe(0);
  });

  it("falls back to lastActivityAt when endedAt is absent", () => {
    expect(summarizeSession(session, []).endedAt).toBe(T0 + 300_000);
  });
});

describe("suspicionSignals", () => {
  const summarize = (events, session = { sessionId: "s", startedAt: T0, lastActivityAt: T0 }) =>
    summarizeSession(session, [{ events }]);

  it("returns [] for ordinary bursty typing with edits", () => {
    const events = [];
    let at = 0;
    for (let burst = 0; burst < 8; burst += 1) {
      for (let i = 0; i < 8; i += 1) {
        events.push(type(at));
        at += 70;
      }
      events.push(del(at, 2));
      at += 3000;
    }
    expect(suspicionSignals(summarize(events))).toEqual([]);
  });

  it("returns [] for a null summary", () => {
    expect(suspicionSignals(null)).toEqual([]);
  });

  it("flags a large paste", () => {
    const signals = suspicionSignals(summarize([type(0), paste(1000, 800, "class Solution:")]));
    expect(signals.map((s) => s.code)).toContain("large-paste");
  });

  it("flags paste-dominant sessions", () => {
    const signals = suspicionSignals(summarize([type(0, "ab"), paste(1000, 900)]));
    expect(signals.map((s) => s.code)).toContain("paste-dominant");
  });

  it("flags a session with no backtracking", () => {
    const signals = suspicionSignals(summarize(typeRun(80, 1500)));
    expect(signals.map((s) => s.code)).toContain("no-backtracking");
  });

  it("flags metronomic typing", () => {
    const signals = suspicionSignals(summarize(typeRun(60, 100)));
    expect(signals.map((s) => s.code)).toContain("metronomic-typing");
  });

  it("flags large inserts with no paste event", () => {
    const signals = suspicionSignals(summarize([type(0, "a".repeat(60)), type(100, "b")]));
    expect(signals.map((s) => s.code)).toContain("large-inserts");
  });

  it("attaches an innocent reading to every signal", () => {
    // The UI contract: a TA never sees a signal without its counter-case.
    const signals = suspicionSignals(summarize([type(0, "a"), paste(500, 900), ...typeRun(60, 100, 1000)]));
    expect(signals.length).toBeGreaterThan(0);
    for (const signal of signals) {
      expect(signal.innocentReading).toBeTruthy();
      expect(signal.label).toBeTruthy();
      expect(signal.code).toBeTruthy();
    }
  });

  it("emits no aggregate score or boolean verdict", () => {
    // Guards the design decision: signals are for a human to weigh.
    const signals = suspicionSignals(summarize([paste(0, 900), ...typeRun(60, 100, 500)]));
    for (const signal of signals) {
      expect(signal).not.toHaveProperty("score");
      expect(signal).not.toHaveProperty("suspicious");
      expect(signal).not.toHaveProperty("confidence");
    }
  });
});

describe("cross-session aggregates", () => {
  const summaries = [
    { problemSlug: "two-sum", problemTitle: "Two Sum", activeMs: 60_000, startedAt: T0, pastedChars: 0 },
    { problemSlug: "two-sum", problemTitle: "Two Sum", activeMs: 30_000, startedAt: T0 + 1000, pastedChars: 100 },
    { problemSlug: "lru-cache", problemTitle: "LRU Cache", activeMs: 120_000, startedAt: T0 + 2000, pastedChars: 0 },
  ];

  it("totals active time", () => {
    expect(totalActiveMs(summaries)).toBe(210_000);
    expect(totalActiveMs([])).toBe(0);
    expect(totalActiveMs(null)).toBe(0);
  });

  it("groups by problem, most time first", () => {
    const rows = activeMsByProblem(summaries);
    expect(rows).toHaveLength(2);
    expect(rows[0].problemSlug).toBe("lru-cache");
    expect(rows[1].problemSlug).toBe("two-sum");
    expect(rows[1].sessionCount).toBe(2);
    expect(rows[1].activeMs).toBe(90_000);
    expect(rows[1].pastedChars).toBe(100);
  });

  it("skips summaries with no problem slug", () => {
    expect(activeMsByProblem([{ activeMs: 1000 }])).toEqual([]);
  });

  it("filters to a [startMs, endMs) window", () => {
    // Inclusive start, exclusive end — same convention as classifyWeek.
    expect(activeMsInWindow(summaries, T0, T0 + 2000)).toBe(90_000);
    expect(activeMsInWindow(summaries, T0 + 2000, T0 + 3000)).toBe(120_000);
    expect(activeMsInWindow(summaries, T0 - 1000, T0)).toBe(0);
  });

  it("returns 0 for a non-numeric window", () => {
    expect(activeMsInWindow(summaries, null, T0)).toBe(0);
  });
});

describe("formatDuration", () => {
  it("handles zero and nonsense", () => {
    expect(formatDuration(0)).toBe("0m");
    expect(formatDuration(-5)).toBe("0m");
    expect(formatDuration(null)).toBe("0m");
    expect(formatDuration(NaN)).toBe("0m");
  });

  it("formats seconds, minutes, and hours", () => {
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(8 * 60_000)).toBe("8m");
    expect(formatDuration(72 * 60_000)).toBe("1h 12m");
    expect(formatDuration(120 * 60_000)).toBe("2h 0m");
  });
});
