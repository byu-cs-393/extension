// Unit tests for src/keystroke-replay.js — reconstructing what was in a
// student's editor at any point in a session. Pure functions, no DOM.
//
// The property that matters most here is that folding the deltas
// reproduces the document exactly. A replay that's subtly wrong is worse
// than no replay: it looks like evidence.
import { describe, it, expect } from "vitest";
import {
  applyDelta,
  buildReplayTimeline,
  textAtStep,
  stepIndexAtTime,
  offsetMsAtStep,
  canReplay,
  compressIdleGaps,
  stepIndexAtPlaybackMs,
  KEYFRAME_INTERVAL,
  LEAD_IN_MS,
} from "../src/keystroke-replay.js";

const T0 = 1_756_900_000_000;
const EDITOR = "sol";

const snapshot = (at, text, over = {}) => ({
  kind: "snapshot", t: at, wallMs: T0 + at, editorId: EDITOR,
  text, language: "python", ...over,
});

const delta = (at, offset, length, text, over = {}) => ({
  kind: "delta", t: at, wallMs: T0 + at, editorId: EDITOR,
  offset, length, text, ...over,
});

// Types `text` one character at a time at the end of the document,
// mirroring what Monaco emits for ordinary typing.
function typeOut(startAt, startOffset, text, gapMs = 100) {
  return [...text].map((ch, i) =>
    delta(startAt + i * gapMs, startOffset + i, 0, ch),
  );
}

describe("applyDelta", () => {
  it("inserts at an offset", () => {
    expect(applyDelta("hello world", { offset: 5, length: 0, text: "," })).toBe(
      "hello, world",
    );
  });

  it("deletes a range", () => {
    expect(applyDelta("hello world", { offset: 5, length: 6, text: "" })).toBe("hello");
  });

  it("replaces a selection", () => {
    expect(applyDelta("hello world", { offset: 6, length: 5, text: "there" })).toBe(
      "hello there",
    );
  });

  it("clamps an out-of-range offset instead of throwing", () => {
    // Desync — a dropped chunk, or two editors merged. Keep going.
    expect(applyDelta("abc", { offset: 99, length: 0, text: "x" })).toBe("abcx");
  });

  it("clamps a delete that runs past the end", () => {
    expect(applyDelta("abc", { offset: 1, length: 99, text: "" })).toBe("a");
  });

  it("tolerates missing or non-string fields", () => {
    expect(applyDelta("abc", {})).toBe("abc");
    expect(applyDelta("abc", { offset: 1, length: 1, text: null })).toBe("ac");
    expect(applyDelta("abc", { offset: NaN, length: 0, text: "z" })).toBe("zabc");
  });
});

describe("canReplay", () => {
  it("refuses a session with no editor ids", () => {
    // Pre-editorId capture: possibly two documents interleaved, and
    // there's no way to tell now. A convincing wrong replay is the
    // failure mode being avoided.
    const events = [{ kind: "delta", wallMs: T0, offset: 0, length: 0, text: "x" }];
    const verdict = canReplay(events);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/two editors|interleaved/i);
  });

  it("refuses a session with no edits at all", () => {
    expect(canReplay([snapshot(0, "class Solution:")]).ok).toBe(false);
    expect(canReplay([]).reason).toMatch(/no recorded edits/i);
  });

  it("accepts a tagged session with edits", () => {
    const events = [snapshot(0, ""), ...typeOut(100, 0, "ab")];
    expect(canReplay(events)).toEqual({ ok: true, reason: null });
  });
});

describe("buildReplayTimeline", () => {
  it("uses the first snapshot as the baseline", () => {
    const events = [snapshot(0, "class Solution:"), ...typeOut(100, 15, "\n    pass")];
    const timeline = buildReplayTimeline(events);
    expect(timeline.baseline).toBe("class Solution:");
    expect(timeline.language).toBe("python");
    expect(timeline.steps).toHaveLength(9);
  });

  it("reproduces the final document exactly", () => {
    const events = [snapshot(0, "def f():\n    pass"), ...typeOut(100, 17, "\n    return 1")];
    const timeline = buildReplayTimeline(events);
    expect(timeline.finalText).toBe("def f():\n    pass\n    return 1");
    expect(textAtStep(timeline, timeline.steps.length - 1)).toBe(timeline.finalText);
  });

  it("only takes the requested editor's stream", () => {
    // The testcase pane's offsets are relative to its own document;
    // folding them into the solution corrupts everything after.
    const events = [
      snapshot(0, "sol", { editorId: "sol" }),
      snapshot(1, "[1,2]", { editorId: "tests", language: "plaintext" }),
      delta(100, 3, 0, "!", { editorId: "sol" }),
      delta(200, 0, 5, "", { editorId: "tests" }),
    ];
    const timeline = buildReplayTimeline(events, { editorId: "sol" });
    expect(timeline.steps).toHaveLength(1);
    expect(timeline.finalText).toBe("sol!");
  });

  it("picks the solution editor by itself when none is named", () => {
    const events = [
      snapshot(0, "[1,2]", { editorId: "tests", language: "plaintext" }),
      snapshot(1, "class Solution:", { editorId: "sol", language: "python" }),
      delta(100, 15, 0, "!", { editorId: "sol" }),
    ];
    expect(buildReplayTimeline(events).editorId).toBe("sol");
  });

  it("treats a second snapshot as a reset, not a baseline", () => {
    // LeetCode rebuilds the editor on language change. Everything typed
    // before the switch stays in the timeline; the document is replaced.
    const events = [
      snapshot(0, "class Solution:"),
      ...typeOut(100, 15, "ab"),
      snapshot(500, "public class Solution {", { language: "java" }),
      ...typeOut(600, "public class Solution {".length, "cd"),
    ];
    const timeline = buildReplayTimeline(events);
    expect(timeline.steps.filter((s) => s.kind === "reset")).toHaveLength(1);
    expect(timeline.baseline).toBe("class Solution:");
    expect(timeline.finalText).toBe("public class Solution {cd");
    // The pre-switch typing is still visible earlier in the replay.
    expect(textAtStep(timeline, 1)).toBe("class Solution:ab");
  });

  it("warns when recording started mid-edit", () => {
    const events = typeOut(0, 0, "abc");
    const timeline = buildReplayTimeline(events, { editorId: EDITOR });
    expect(timeline.baseline).toBe("");
    expect(timeline.warnings.join(" ")).toMatch(/started mid-edit/i);
  });

  it("warns when edits don't line up with the document", () => {
    const events = [snapshot(0, "abc"), delta(100, 50, 0, "x")];
    const timeline = buildReplayTimeline(events);
    expect(timeline.warnings.join(" ")).toMatch(/didn't line up|clamped/i);
  });

  it("has no warnings for a clean session", () => {
    const events = [snapshot(0, "abc"), ...typeOut(100, 3, "def")];
    expect(buildReplayTimeline(events).warnings).toEqual([]);
  });

  it("reports the wall-clock span", () => {
    const events = [snapshot(0, ""), ...typeOut(1000, 0, "abcd", 500)];
    const timeline = buildReplayTimeline(events);
    expect(timeline.startMs).toBe(T0 + 1000);
    expect(timeline.endMs).toBe(T0 + 2500);
    expect(timeline.durationMs).toBe(1500);
  });

  it("handles a session with no events", () => {
    const timeline = buildReplayTimeline([]);
    expect(timeline.steps).toEqual([]);
    expect(timeline.durationMs).toBe(0);
    expect(textAtStep(timeline, 5)).toBe("");
  });
});

describe("textAtStep", () => {
  const events = [snapshot(0, "start:"), ...typeOut(100, 6, "abcdef")];
  const timeline = buildReplayTimeline(events);

  it("returns the baseline before any step", () => {
    expect(textAtStep(timeline, -1)).toBe("start:");
    expect(textAtStep(timeline, -99)).toBe("start:");
  });

  it("walks forward one step at a time", () => {
    expect(textAtStep(timeline, 0)).toBe("start:a");
    expect(textAtStep(timeline, 2)).toBe("start:abc");
    expect(textAtStep(timeline, 5)).toBe("start:abcdef");
  });

  it("clamps past the end", () => {
    expect(textAtStep(timeline, 999)).toBe("start:abcdef");
  });

  it("matches a naive fold at every step", () => {
    // The keyframe shortcut must not change the answer anywhere.
    let naive = timeline.baseline;
    for (let i = 0; i < timeline.steps.length; i += 1) {
      const step = timeline.steps[i];
      naive = step.kind === "reset" ? step.text : applyDelta(naive, step);
      expect(textAtStep(timeline, i)).toBe(naive);
    }
  });

  it("stays correct across keyframe boundaries", () => {
    // Long enough to build several keyframes, so the shortcut is
    // actually exercised rather than trivially skipped.
    const long = [
      snapshot(0, ""),
      ...typeOut(100, 0, "x".repeat(KEYFRAME_INTERVAL * 2 + 25), 10),
    ];
    const big = buildReplayTimeline(long);
    expect(big.keyframes.length).toBeGreaterThanOrEqual(2);

    for (const index of [0, KEYFRAME_INTERVAL - 1, KEYFRAME_INTERVAL, KEYFRAME_INTERVAL + 1, big.steps.length - 1]) {
      expect(textAtStep(big, index)).toBe("x".repeat(index + 1));
    }
  });
});

describe("stepIndexAtTime", () => {
  const timeline = buildReplayTimeline([snapshot(0, ""), ...typeOut(1000, 0, "abcd", 500)]);

  it("returns -1 before the first edit", () => {
    expect(stepIndexAtTime(timeline, T0)).toBe(-1);
    expect(stepIndexAtTime(timeline, T0 + 999)).toBe(-1);
  });

  it("finds the last step at or before a time", () => {
    expect(stepIndexAtTime(timeline, T0 + 1000)).toBe(0);
    expect(stepIndexAtTime(timeline, T0 + 1499)).toBe(0);
    expect(stepIndexAtTime(timeline, T0 + 1500)).toBe(1);
    expect(stepIndexAtTime(timeline, T0 + 999_999)).toBe(3);
  });

  it("handles empty timelines and junk input", () => {
    expect(stepIndexAtTime(buildReplayTimeline([]), T0)).toBe(-1);
    expect(stepIndexAtTime(timeline, NaN)).toBe(-1);
  });

  it("agrees with a linear scan", () => {
    for (let ms = 0; ms < 3000; ms += 97) {
      const expected = timeline.steps.reduce(
        (acc, step, i) => (step.wallMs <= T0 + ms ? i : acc),
        -1,
      );
      expect(stepIndexAtTime(timeline, T0 + ms)).toBe(expected);
    }
  });
});

describe("offsetMsAtStep", () => {
  const timeline = buildReplayTimeline([snapshot(0, ""), ...typeOut(1000, 0, "abcd", 500)]);

  it("measures from the first edit, not the snapshot", () => {
    expect(offsetMsAtStep(timeline, 0)).toBe(0);
    expect(offsetMsAtStep(timeline, 2)).toBe(1000);
  });

  it("returns 0 for a negative index or empty timeline", () => {
    expect(offsetMsAtStep(timeline, -1)).toBe(0);
    expect(offsetMsAtStep(buildReplayTimeline([]), 3)).toBe(0);
  });
});

describe("compressIdleGaps", () => {
  it("caps long thinking pauses so the replay stays watchable", () => {
    // 100ms, then a 5-minute pause, then 100ms.
    const events = [
      snapshot(0, ""),
      delta(100, 0, 0, "a"),
      delta(200, 1, 0, "b"),
      delta(300_200, 2, 0, "c"),
    ];
    const timeline = compressIdleGaps(buildReplayTimeline(events), {
      maxGapMs: 3000,
      leadInMs: 0,
    });
    expect(timeline.playbackMs).toEqual([0, 100, 3100]);
    expect(timeline.playbackDurationMs).toBe(3100);
  });

  it("leaves ordinary typing untouched", () => {
    const timeline = compressIdleGaps(
      buildReplayTimeline([snapshot(0, ""), ...typeOut(100, 0, "abcd", 200)]),
      { leadInMs: 0 },
    );
    expect(timeline.playbackMs).toEqual([0, 200, 400, 600]);
  });

  it("leads in so the starting document is visible at position zero", () => {
    const timeline = compressIdleGaps(
      buildReplayTimeline([snapshot(0, "start"), ...typeOut(100, 5, "ab", 200)]),
    );
    expect(timeline.playbackMs[0]).toBe(LEAD_IN_MS);
    expect(stepIndexAtPlaybackMs(timeline, 0)).toBe(-1);
    expect(textAtStep(timeline, stepIndexAtPlaybackMs(timeline, 0))).toBe("start");
  });

  it("handles an empty timeline", () => {
    expect(compressIdleGaps(buildReplayTimeline([])).playbackMs).toEqual([]);
  });
});

describe("stepIndexAtPlaybackMs", () => {
  const timeline = compressIdleGaps(
    buildReplayTimeline([snapshot(0, ""), ...typeOut(100, 0, "abcd", 200)]),
    { leadInMs: 0 },
  );

  it("maps compressed playback time back to a step", () => {
    expect(stepIndexAtPlaybackMs(timeline, 0)).toBe(0);
    expect(stepIndexAtPlaybackMs(timeline, 199)).toBe(0);
    expect(stepIndexAtPlaybackMs(timeline, 200)).toBe(1);
    expect(stepIndexAtPlaybackMs(timeline, 99_999)).toBe(3);
  });

  it("returns -1 before the start and for junk", () => {
    expect(stepIndexAtPlaybackMs(timeline, -5)).toBe(-1);
    expect(stepIndexAtPlaybackMs(timeline, NaN)).toBe(-1);
    expect(stepIndexAtPlaybackMs({ playbackMs: [] }, 0)).toBe(-1);
  });
});

describe("stale baselines from navigation and code resets", () => {
  it("ignores a snapshot that another snapshot immediately supersedes", () => {
    // The navigation race: the session opens when the URL changes and
    // asks for a baseline, but Monaco still holds the PREVIOUS problem's
    // model. The real starter code lands a moment later.
    const events = [
      snapshot(0, "class PreviousProblem:"),
      snapshot(50, "class Solution:"),
      ...typeOut(100, 15, "\n    pass"),
    ];
    const timeline = buildReplayTimeline(events);
    expect(timeline.baseline).toBe("class Solution:");
    expect(timeline.steps.filter((s) => s.kind === "reset")).toHaveLength(0);
    expect(timeline.finalText).toBe("class Solution:\n    pass");
  });

  it("collapses a whole run of superseded snapshots", () => {
    const events = [
      snapshot(0, "one"),
      snapshot(10, "two"),
      snapshot(20, "three"),
      ...typeOut(100, 5, "!"),
    ];
    expect(buildReplayTimeline(events).baseline).toBe("three");
  });

  it("keeps a snapshot that follows real edits as a reset", () => {
    // "Reset to default code" mid-session: the document genuinely
    // changed and the earlier typing still happened.
    const events = [
      snapshot(0, "class Solution:"),
      ...typeOut(100, 15, "abc"),
      snapshot(500, "class Solution:"),
      ...typeOut(600, 15, "xy"),
    ];
    const timeline = buildReplayTimeline(events);
    expect(timeline.baseline).toBe("class Solution:");
    expect(timeline.steps.filter((s) => s.kind === "reset")).toHaveLength(1);
    expect(textAtStep(timeline, 2)).toBe("class Solution:abc");
    expect(timeline.finalText).toBe("class Solution:xy");
  });

  it("produces no desync warning for the navigation race", () => {
    // Before the fix, edits were measured against the previous problem's
    // text and clamped, which is what made the replay look empty.
    const events = [
      snapshot(0, "a much longer previous problem body"),
      snapshot(50, "short"),
      ...typeOut(100, 5, "!!"),
    ];
    expect(buildReplayTimeline(events).warnings).toEqual([]);
  });

  it("does not collapse across editors", () => {
    // Two editors each posting a baseline is not a supersede — they're
    // different documents. The solution editor's own baseline must
    // survive being adjacent to the testcase pane's.
    const events = [
      snapshot(0, "[1,2]", { editorId: "tests", language: "plaintext" }),
      snapshot(10, "class Solution:", { editorId: "sol" }),
      delta(100, 15, 0, "!", { editorId: "sol" }),
    ];
    const timeline = buildReplayTimeline(events, { editorId: "sol" });
    expect(timeline.baseline).toBe("class Solution:");
    expect(timeline.finalText).toBe("class Solution:!");
  });
});
