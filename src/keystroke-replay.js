// Reconstructs the contents of a student's editor at any point in a
// captured session. Pure functions — data in, data out, no DOM — so the
// reconstruction rules are testable independently of the player UI in
// ta-keystroke-view.js.
//
// How it works: keystroke-injector.js emits a `snapshot` (the buffer at
// hook time, usually LeetCode's starter code) followed by `delta` events,
// each of which is a complete edit operation:
//
//     replace `length` characters at `offset` with `text`
//
// So the document at any step is a fold of those deltas over the
// snapshot. Full text isn't stored per step — a long session is thousands
// of deltas and megabytes of near-identical strings — so keyframes are
// cached every KEYFRAME_INTERVAL steps and the rest is replayed forward
// from the nearest one.
//
// Deltas are tied to ONE Monaco editor. LeetCode runs two (solution and
// testcase pane), and applying one editor's offsets to the other's text
// yields plausible-looking nonsense, so sessions captured before events
// carried an editorId can't be replayed at all. canReplay() says so.
import { eventsOfKind, primaryEditorId, editorIdsIn } from "./keystroke-analysis.js";

// How often to cache a full-text keyframe. 200 keeps scrubbing to a
// bounded amount of re-folding while holding only a handful of copies of
// the document in memory.
export const KEYFRAME_INTERVAL = 200;

// Applies one Monaco change to a string.
//
// Out-of-range offsets mean the stream has desynced from the document —
// a dropped chunk, or (before editorIds) two editors merged into one
// list. Clamping keeps the replay running and legible rather than
// throwing halfway through; the caller records that it happened.
export function applyDelta(text, delta) {
  const offset = clamp(delta?.offset ?? 0, 0, text.length);
  const removeLength = clamp(delta?.length ?? 0, 0, text.length - offset);
  const inserted = typeof delta?.text === "string" ? delta.text : "";
  return text.slice(0, offset) + inserted + text.slice(offset + removeLength);
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function isDesynced(text, delta) {
  const offset = delta?.offset ?? 0;
  const length = delta?.length ?? 0;
  if (!Number.isFinite(offset) || !Number.isFinite(length)) return true;
  return offset < 0 || length < 0 || offset + length > text.length;
}

// Whether a session's events can be replayed, and if not, why.
//
// The blocking case is a capture with no editor ids: LeetCode mounts two
// Monaco editors, so an untagged stream may be two documents interleaved,
// and there's no way to tell after the fact. Refusing is the honest
// answer — a replay built from mixed offsets looks real and isn't.
export function canReplay(events) {
  const deltas = eventsOfKind(events, "delta");
  if (deltas.length === 0) {
    return { ok: false, reason: "This session has no recorded edits." };
  }
  if (editorIdsIn(events).length === 0) {
    return {
      ok: false,
      reason:
        "Recorded before the capture told LeetCode's two editors apart, so " +
        "the edits may be two documents interleaved. Replay would look " +
        "convincing and be wrong.",
    };
  }
  return { ok: true, reason: null };
}

// Builds the replay model for one editor's stream.
//
// Returns { editorId, language, baseline, steps, keyframes, startMs,
//           endMs, durationMs, warnings }.
//
// `steps` are in wall-clock order. A step is either a delta or a "reset"
// — a second snapshot for the same editor, which LeetCode emits when it
// rebuilds the editor on a language change. A reset replaces the whole
// document rather than editing it; treating it as a baseline instead
// would silently drop everything typed before the switch.
// Drops any snapshot that's immediately followed by another snapshot
// with no edit in between — the earlier one never described a document
// the student did anything to.
//
// This is what happens on navigation. The session opens as soon as the
// URL changes and asks for a baseline, but LeetCode hasn't swapped
// Monaco's model yet, so that first snapshot still holds the PREVIOUS
// problem's code. A moment later the real one arrives. Believing the
// first is how a replay opens on the wrong problem and then appears to
// contain no edits at all, since every later offset is measured against
// a document that was never on screen.
//
// The input here is already filtered to snapshots and deltas, so "the
// next event is a snapshot" is exactly "nothing was edited in between".
function dropSupersededSnapshots(events) {
  const kept = [];
  for (let i = 0; i < events.length; i += 1) {
    if (events[i].kind === "snapshot" && events[i + 1]?.kind === "snapshot") {
      continue;
    }
    kept.push(events[i]);
  }
  return kept;
}

export function buildReplayTimeline(events, { editorId = null } = {}) {
  const targetEditor = editorId ?? primaryEditorId(events);
  const warnings = [];

  const relevant = dropSupersededSnapshots(
    (events ?? []).filter(
      (event) =>
        (event?.kind === "delta" || event?.kind === "snapshot") &&
        (targetEditor === null || event.editorId === targetEditor),
    ),
  );

  let baseline = "";
  let language = null;
  const steps = [];
  let seenSnapshot = false;

  for (const event of relevant) {
    if (event.kind === "snapshot") {
      if (!seenSnapshot) {
        baseline = typeof event.text === "string" ? event.text : "";
        language = event.language ?? null;
        seenSnapshot = true;
      } else {
        steps.push({
          kind: "reset",
          wallMs: event.wallMs,
          text: typeof event.text === "string" ? event.text : "",
        });
      }
      continue;
    }
    if (!seenSnapshot && steps.length === 0) {
      // Edits before any snapshot: the injector hooked Monaco late, so
      // the starting text is unknown. Replay still works, it just begins
      // from empty and the early diff looks larger than it was.
      warnings.push(
        "Recording started mid-edit — the first keystrokes have no starting text.",
      );
    }
    steps.push({
      kind: "delta",
      wallMs: event.wallMs,
      offset: event.offset,
      length: event.length,
      text: event.text,
    });
  }

  // Fold once up front to build keyframes, checking for desync as we go.
  const keyframes = [];
  let text = baseline;
  let desyncCount = 0;
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    if (step.kind === "reset") {
      text = step.text;
    } else {
      if (isDesynced(text, step)) desyncCount += 1;
      text = applyDelta(text, step);
    }
    if ((i + 1) % KEYFRAME_INTERVAL === 0) keyframes.push({ index: i, text });
  }
  if (desyncCount > 0) {
    warnings.push(
      `${desyncCount} edit${desyncCount === 1 ? "" : "s"} didn't line up with the ` +
        "document and were clamped — the replay may drift from what was typed.",
    );
  }

  const startMs = steps.length > 0 ? steps[0].wallMs : null;
  const endMs = steps.length > 0 ? steps[steps.length - 1].wallMs : null;

  return {
    editorId: targetEditor,
    language,
    baseline,
    steps,
    keyframes,
    finalText: text,
    startMs,
    endMs,
    durationMs: startMs !== null && endMs !== null ? endMs - startMs : 0,
    warnings,
  };
}

// Document contents after applying steps 0..index. index -1 is the
// baseline, before anything was typed.
export function textAtStep(timeline, index) {
  const steps = timeline?.steps ?? [];
  const target = clamp(index, -1, steps.length - 1);
  if (target < 0) return timeline?.baseline ?? "";

  // Start from the closest keyframe at or before the target.
  let text = timeline.baseline;
  let from = 0;
  for (const keyframe of timeline.keyframes ?? []) {
    if (keyframe.index <= target) {
      text = keyframe.text;
      from = keyframe.index + 1;
    } else {
      break;
    }
  }

  for (let i = from; i <= target; i += 1) {
    const step = steps[i];
    text = step.kind === "reset" ? step.text : applyDelta(text, step);
  }
  return text;
}

// Index of the last step at or before `wallMs`; -1 if it precedes the
// first edit. Binary search — the player calls this on every animation
// frame while scrubbing.
export function stepIndexAtTime(timeline, wallMs) {
  const steps = timeline?.steps ?? [];
  if (steps.length === 0 || !Number.isFinite(wallMs)) return -1;
  if (wallMs < steps[0].wallMs) return -1;

  let low = 0;
  let high = steps.length - 1;
  let answer = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (steps[mid].wallMs <= wallMs) {
      answer = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return answer;
}

// Milliseconds into the replay for a given step, so the player can show
// elapsed time and position a scrubber without knowing about wall clocks.
export function offsetMsAtStep(timeline, index) {
  const steps = timeline?.steps ?? [];
  if (steps.length === 0 || index < 0) return 0;
  const step = steps[clamp(index, 0, steps.length - 1)];
  return Math.max(0, step.wallMs - timeline.startMs);
}

// A short pause before the first edit, so a replay opens on the starter
// code the way a video opens on its first frame. Without it, position
// zero already has keystroke one applied and the student's starting
// point is never visible.
export const LEAD_IN_MS = 400;

// Long idle gaps make a replay unwatchable — a student thinking for four
// minutes is four minutes of a frozen screen. Compressing any gap beyond
// maxGapMs keeps the pacing honest for the parts where typing happens.
export function compressIdleGaps(
  timeline,
  { maxGapMs = 3000, leadInMs = LEAD_IN_MS } = {},
) {
  const steps = timeline?.steps ?? [];
  if (steps.length === 0) return { ...timeline, playbackMs: [] };

  const playbackMs = [leadInMs];
  for (let i = 1; i < steps.length; i += 1) {
    const gap = steps[i].wallMs - steps[i - 1].wallMs;
    playbackMs.push(playbackMs[i - 1] + Math.min(Math.max(gap, 0), maxGapMs));
  }
  return {
    ...timeline,
    playbackMs,
    playbackDurationMs: playbackMs[playbackMs.length - 1],
  };
}

// Index of the last step at or before `playbackOffsetMs` on the
// compressed timeline produced by compressIdleGaps.
export function stepIndexAtPlaybackMs(timeline, playbackOffsetMs) {
  const times = timeline?.playbackMs ?? [];
  if (times.length === 0 || !Number.isFinite(playbackOffsetMs)) return -1;
  if (playbackOffsetMs < times[0]) return -1;

  let low = 0;
  let high = times.length - 1;
  let answer = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (times[mid] <= playbackOffsetMs) {
      answer = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return answer;
}
