// Read layer over the keystroke capture written by keystroke-tracker.js.
// Pure functions only — data in, data out. No chrome.*, no fetch, no DOM,
// so every rule in here is unit-testable (see tests/keystroke-analysis.test.js).
//
// Capture shapes this module consumes, as written by keystroke-tracker.js:
//
//   session  students/{netID}/keystrokeSessions/{sessionId}
//     { sessionId, netID, problemSlug, problemTitle, startedAt,
//       lastActivityAt, deltaCount, chunkCount, endReason?, endedAt? }
//
//   chunk    .../keystrokeSessions/{sessionId}/chunks/{chunkIndex}
//     { chunkIndex, writtenAt, events: [Event, ...] }
//
//   Event (all carry `t` = performance.now(), page-relative, and
//   `wallMs` = Date.now(), the only clock comparable across chunks):
//     { kind: "delta",    offset, length, text }   length = chars REPLACED
//     { kind: "snapshot", text, language }          baseline at hook time
//     { kind: "paste",    length, preview }         preview = first 200 chars
//     { kind: "copy",     length, preview }
//     { kind: "tab_blur" } | { kind: "tab_focus" }
//
// IMPORTANT — on interpreting any of this:
//
// These functions emit SIGNALS, never verdicts. Every pattern here has an
// innocent reading: a student pastes their own code back after refactoring
// in an IDE; a strong student who has internalized a pattern types it
// cleanly on the first pass. `suspicionSignals()` deliberately returns a
// list of observations with reasons attached, so a TA looks at a timeline
// and decides. Do not build a UI that renders these as an accusation, and
// do not auto-flag on them.

// ---- Tunables ----------------------------------------------------------

// Gaps longer than this between events don't count toward active time.
// Set above "reading the problem statement" but well below "left the tab
// open over lunch". Typing pauses to think are still active.
export const MAX_ACTIVE_GAP_MS = 120_000;

// A paste at or above this many characters is worth a TA's attention.
// Below it you're in variable-name and import-line territory.
export const NOTABLE_PASTE_CHARS = 40;

// Single-delta insertions this large didn't come from one keystroke —
// they're an autocomplete acceptance, an editor snippet, or a paste that
// didn't fire a clipboard event.
export const LARGE_INSERT_CHARS = 30;

// Inter-keystroke stats need enough samples to mean anything.
export const MIN_SAMPLES_FOR_CADENCE = 20;

// ---- Event access ------------------------------------------------------

// Flattens chunk docs into one event list ordered by wall clock.
//
// Chunks arrive in arbitrary order (Firestore listing order isn't
// guaranteed to match chunkIndex), and `t` is performance.now() — it
// resets on every page load, so it's only comparable within a session
// that never reloaded. wallMs is the only cross-chunk clock. Events
// without a usable wallMs are dropped rather than sorted to the epoch.
export function flattenChunks(chunks) {
  if (!Array.isArray(chunks)) return [];

  // Order by chunkIndex, then keep each chunk's events in the order they
  // were captured. Do NOT re-sort by wallMs.
  //
  // wallMs is Date.now() stamped when the content script receives the
  // message, so an entire Monaco change event — auto-closing a bracket,
  // auto-indenting a new line, applying a paste — arrives as several
  // deltas sharing one millisecond. Monaco emits those in reverse offset
  // order specifically so they can be applied one after another without
  // invalidating each other, which makes their relative order part of
  // the data. A wallMs sort can't see that order and, because chunks come
  // back from Firestore in arbitrary order, could interleave two chunks'
  // same-millisecond events and silently reverse it. The symptom is
  // offsets that no longer match the document: clamped edits and
  // characters missing from the replay.
  //
  // Capture order is chronological by construction, so chunkIndex plus
  // array position IS the correct order. wallMs is only a fallback for
  // chunks written before chunkIndex existed.
  const ordered = [...chunks].sort((a, b) => {
    const ai = Number.isFinite(a?.chunkIndex) ? a.chunkIndex : Infinity;
    const bi = Number.isFinite(b?.chunkIndex) ? b.chunkIndex : Infinity;
    return ai - bi;
  });

  const events = [];
  for (const chunk of ordered) {
    for (const event of chunk?.events ?? []) {
      if (event && Number.isFinite(event.wallMs)) events.push(event);
    }
  }

  // Chunks with no index at all can't be ordered that way; fall back to
  // a stable wallMs sort, which at least keeps within-chunk order.
  if (ordered.some((chunk) => !Number.isFinite(chunk?.chunkIndex))) {
    return events.sort((a, b) => a.wallMs - b.wallMs);
  }
  return events;
}

export function eventsOfKind(events, kind) {
  return (events ?? []).filter((e) => e?.kind === kind);
}

// ---- Editors -----------------------------------------------------------
//
// LeetCode mounts more than one Monaco editor: the solution buffer plus
// at least the custom-testcase pane. Deltas from each carry an editorId,
// because `offset` is only meaningful against that editor's own
// document. Anything that reads offsets (replay) or measures how the
// student typed (typingStats) has to work on ONE editor's stream — mixing
// them silently corrupts both.
//
// Sessions captured before editorId existed have none. Those degrade to
// "treat every delta as one stream", which is what the old code did; the
// summary flags it via `editorIdsPresent` so a caller can say so rather
// than quietly presenting mixed-editor numbers as clean ones.

// Model languages that mean "not the solution buffer". A denylist rather
// than an allowlist of programming languages, so a language nobody
// thought of doesn't get mistaken for the testcase pane.
const NON_CODE_LANGUAGES = new Set(["plaintext", "text", "json", "markdown"]);

export function editorIdsIn(events) {
  const ids = new Set();
  for (const event of events ?? []) {
    if (event?.editorId) ids.add(event.editorId);
  }
  return [...ids];
}

// The editor holding the student's solution.
//
// Prefers editors whose snapshot declares a code language, then falls
// back to whichever took the most edits — you type far more into the
// solution than into a testcase pane. Returns null when the capture has
// no editor ids at all (pre-editorId sessions).
export function primaryEditorId(events) {
  const ids = editorIdsIn(events);
  if (ids.length === 0) return null;
  if (ids.length === 1) return ids[0];

  const codeIds = new Set();
  for (const snap of eventsOfKind(events, "snapshot")) {
    const language = snap.language ? String(snap.language).toLowerCase() : null;
    if (snap.editorId && language && !NON_CODE_LANGUAGES.has(language)) {
      codeIds.add(snap.editorId);
    }
  }

  const candidates = ids.filter((id) => codeIds.size === 0 || codeIds.has(id));
  const deltaCounts = new Map(candidates.map((id) => [id, 0]));
  for (const delta of eventsOfKind(events, "delta")) {
    if (deltaCounts.has(delta.editorId)) {
      deltaCounts.set(delta.editorId, deltaCounts.get(delta.editorId) + 1);
    }
  }

  let best = candidates[0] ?? null;
  for (const [id, count] of deltaCounts) {
    if (count > (deltaCounts.get(best) ?? -1)) best = id;
  }
  return best;
}

// Narrows an event list to one editor's edits, keeping the session-level
// events (paste, copy, tab focus) that aren't tied to any editor — those
// still bound the timeline and still matter to active time.
export function eventsForEditor(events, editorId) {
  if (!editorId) return events ?? [];
  return (events ?? []).filter((event) => {
    if (event?.kind !== "delta" && event?.kind !== "snapshot") return true;
    return event.editorId === editorId;
  });
}

// ---- Time on task ------------------------------------------------------

// Spans where the tab was hidden, as [startMs, endMs) pairs.
//
// Unbalanced pairs are the normal case, not an error: a session that ends
// while hidden never emits the closing tab_focus, and a session that
// starts on a background tab can open with a focus. Both are handled —
// a dangling blur closes at `until`.
export function hiddenSpans(events, until = null) {
  const spans = [];
  let blurAt = null;
  for (const event of events ?? []) {
    if (event.kind === "tab_blur" && blurAt === null) {
      blurAt = event.wallMs;
    } else if (event.kind === "tab_focus" && blurAt !== null) {
      spans.push([blurAt, event.wallMs]);
      blurAt = null;
    }
  }
  if (blurAt !== null && Number.isFinite(until) && until > blurAt) {
    spans.push([blurAt, until]);
  }
  return spans;
}

// Milliseconds the student was plausibly working, from the event stream.
//
// Walks consecutive event pairs and sums the gaps, with two corrections:
// a gap longer than maxGapMs counts as maxGapMs (they wandered off), and
// any part of a gap spent with the tab hidden doesn't count at all.
//
// Deliberately NOT (lastActivityAt - startedAt): that counts a tab left
// open all afternoon as an afternoon of study, which is exactly the
// number a student would notice they can inflate for free.
export function activeMs(events, { maxGapMs = MAX_ACTIVE_GAP_MS } = {}) {
  const ordered = (events ?? []).filter((e) => Number.isFinite(e?.wallMs));
  if (ordered.length < 2) return 0;

  const spans = hiddenSpans(ordered, ordered[ordered.length - 1].wallMs);
  let total = 0;
  for (let i = 1; i < ordered.length; i += 1) {
    const from = ordered[i - 1].wallMs;
    const to = ordered[i].wallMs;
    const gap = to - from;
    if (gap <= 0) continue;
    total += Math.min(gap, maxGapMs) - hiddenOverlapMs(spans, from, to);
  }
  return Math.max(0, Math.round(total));
}

function hiddenOverlapMs(spans, from, to) {
  let overlap = 0;
  for (const [start, end] of spans) {
    overlap += Math.max(0, Math.min(to, end) - Math.max(from, start));
  }
  return overlap;
}

// ---- Pastes and the edits they produce ---------------------------------
//
// A paste shows up TWICE in the stream: once as a `paste` event from the
// document listener, and once as a `delta` from Monaco actually inserting
// the text. Treating those independently causes three wrong readings, all
// seen in a real session:
//
//   - pasted characters counted as typed
//   - a paste-only session showing zero deletions, so "no backtracking"
//     fires on someone who typed nothing at all
//   - a paste that never landed still counted, doubling the total
//
// So each paste is matched to the delta it produced. A paste with no
// matching delta didn't take effect — usually the editor wasn't focused,
// and the student pastes again a second later. That's the duplicate
// "Pasted 607 characters" pair: two attempts, one insert.
//
// Matching is by time and size rather than content, because the delta
// doesn't carry the text for large inserts and the editor may normalise
// line endings or re-indent on the way in.

export const PASTE_MATCH_WINDOW_MS = 1000;

// Monaco can insert slightly less than was copied (CRLF collapsing to LF)
// or slightly more (auto-indent), so an exact length match is too strict.
const PASTE_MIN_RATIO = 0.5;
const PASTE_MAX_RATIO = 1.5;

// Returns { pastes, pastedDeltas } where `pastes` carries a `landed` flag
// and `pastedDeltas` is a Set of the delta objects a paste produced.
export function correlatePastes(events, { windowMs = PASTE_MATCH_WINDOW_MS } = {}) {
  const ordered = events ?? [];
  const pastedDeltas = new Set();
  const pastes = [];

  for (const paste of ordered) {
    if (paste?.kind !== "paste") continue;
    const length = Number.isFinite(paste.length) ? paste.length : 0;

    let match = null;
    for (const event of ordered) {
      if (event.kind !== "delta") continue;
      if (pastedDeltas.has(event)) continue;
      const gap = event.wallMs - paste.wallMs;
      // The paste event fires before the editor applies it, so the delta
      // always follows. A tiny negative gap is clock jitter between the
      // two capture paths, not a delta that preceded the paste.
      if (gap < -50 || gap > windowMs) continue;
      const inserted = typeof event.text === "string" ? event.text.length : 0;
      if (length > 0 && inserted < length * PASTE_MIN_RATIO) continue;
      if (length > 0 && inserted > length * PASTE_MAX_RATIO) continue;
      if (length === 0 && inserted !== 0) continue;
      match = event;
      break;
    }

    if (match) pastedDeltas.add(match);
    pastes.push({ ...paste, landed: Boolean(match) });
  }

  return { pastes, pastedDeltas };
}

// ---- Typing shape ------------------------------------------------------

// Monaco reports a delta as "replace `length` chars at `offset` with
// `text`". So a pure insert has length 0, a pure delete has empty text,
// and a selection-overwrite has both.
// `pastedDeltas` (from correlatePastes) is excluded, so these describe
// what the student actually TYPED. Counting a paste as typing inflates
// insertedChars and drives the deletion ratio to zero, which is what made
// "almost no edits or deletions" fire on a session that was pasted rather
// than written.
export function typingStats(events, { pastedDeltas = new Set() } = {}) {
  const deltas = eventsOfKind(events, "delta").filter((d) => !pastedDeltas.has(d));
  let insertedChars = 0;
  let deletedChars = 0;
  let insertCount = 0;
  let deleteCount = 0;
  let largeInserts = 0;

  for (const d of deltas) {
    const text = typeof d.text === "string" ? d.text : "";
    const replaced = Number.isFinite(d.length) ? d.length : 0;
    if (text.length > 0) {
      insertCount += 1;
      insertedChars += text.length;
      if (text.length >= LARGE_INSERT_CHARS) largeInserts += 1;
    }
    if (replaced > 0) {
      deleteCount += 1;
      deletedChars += replaced;
    }
  }

  const gaps = interEventGaps(deltas);
  return {
    deltaCount: deltas.length,
    insertCount,
    deleteCount,
    insertedChars,
    deletedChars,
    largeInserts,
    // Share of edits that removed something. Writing code is iterative;
    // a ratio near zero means the text arrived already correct.
    deletionRatio: deltas.length === 0 ? null : deleteCount / deltas.length,
    medianGapMs: median(gaps),
    // Coefficient of variation of inter-keystroke gaps: stddev / mean.
    // Human typing is bursty (high CV) — pauses to think, then a run of
    // fast keys. A low CV over many samples is metronomic, which is what
    // transcribing from a reference looks like.
    cadenceCv: gaps.length >= MIN_SAMPLES_FOR_CADENCE ? coefficientOfVariation(gaps) : null,
    sampleCount: gaps.length,
  };
}

function interEventGaps(events) {
  const gaps = [];
  for (let i = 1; i < events.length; i += 1) {
    const gap = events[i].wallMs - events[i - 1].wallMs;
    // Drop non-positive gaps (same-ms deltas from one keystroke) and
    // long thinking pauses, which would swamp the cadence stats.
    if (gap > 0 && gap <= MAX_ACTIVE_GAP_MS) gaps.push(gap);
  }
  return gaps;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function coefficientOfVariation(values) {
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return null;
  const variance =
    values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

// ---- Clipboard ---------------------------------------------------------

export function pasteEvents(events, { minLength = NOTABLE_PASTE_CHARS } = {}) {
  return eventsOfKind(events, "paste")
    .filter((e) => Number.isFinite(e.length) && e.length >= minLength)
    .map((e) => ({
      wallMs: e.wallMs,
      length: e.length,
      preview: e.preview ?? "",
    }));
}

export function copyEvents(events, { minLength = NOTABLE_PASTE_CHARS } = {}) {
  return eventsOfKind(events, "copy")
    .filter((e) => Number.isFinite(e.length) && e.length >= minLength)
    .map((e) => ({
      wallMs: e.wallMs,
      length: e.length,
      preview: e.preview ?? "",
    }));
}

// ---- Session rollup ----------------------------------------------------

// Everything a TA view needs for one session, in one object.
export function summarizeSession(session, chunks, opts = {}) {
  const events = flattenChunks(chunks);
  // Typing shape is measured on the solution editor alone. Edits to the
  // testcase pane would otherwise inflate the character counts and skew
  // both the deletion ratio and the cadence — the two inputs to the
  // "typed it straight through" signals.
  const editorIds = editorIdsIn(events);
  const editorId = primaryEditorId(events);
  // Pastes are correlated across ALL events, because the paste listener
  // is document-level and doesn't know which editor received it.
  const { pastes: correlated, pastedDeltas } = correlatePastes(events, opts);
  const typing = typingStats(eventsForEditor(events, editorId), { pastedDeltas });
  // Only pastes that actually reached the editor. One that didn't land
  // inserted nothing, so counting it would double a single paste.
  const landed = correlated.filter((p) => p.landed);
  const minLength = opts.minLength ?? NOTABLE_PASTE_CHARS;
  const pastes = landed
    .filter((p) => Number.isFinite(p.length) && p.length >= minLength)
    .map((p) => ({ wallMs: p.wallMs, length: p.length, preview: p.preview ?? "" }));
  const copies = copyEvents(events, opts);
  const active = activeMs(events, opts);

  return {
    sessionId: session?.sessionId ?? null,
    netID: session?.netID ?? null,
    problemSlug: session?.problemSlug ?? null,
    problemTitle: resolveProblemTitle(session),
    startedAt: session?.startedAt ?? null,
    endedAt: session?.endedAt ?? session?.lastActivityAt ?? null,
    endReason: session?.endReason ?? null,
    // Wall-clock span of the visit, for contrast with activeMs. A big
    // gap between the two is just an idle tab, not a finding.
    elapsedMs:
      Number.isFinite(session?.startedAt) &&
      Number.isFinite(session?.lastActivityAt)
        ? Math.max(0, session.lastActivityAt - session.startedAt)
        : null,
    activeMs: active,
    hiddenMs: hiddenSpans(events, events[events.length - 1]?.wallMs ?? null)
      .reduce((sum, [start, end]) => sum + Math.max(0, end - start), 0),
    eventCount: events.length,
    // Which editor the typing numbers describe, and whether the capture
    // distinguished editors at all. False means a pre-editorId session:
    // the numbers below mix every Monaco instance on the page and should
    // be presented as approximate.
    editorId,
    editorCount: editorIds.length,
    editorIdsPresent: editorIds.length > 0,
    typing,
    pastes,
    copies,
    pastedChars: pastes.reduce((sum, p) => sum + p.length, 0),
    // Attempts that produced no edit. Not a finding on its own — a
    // mis-focused paste is ordinary — but it explains why a TA might
    // remember more pasting than the numbers show.
    unlandedPastes: correlated.length - landed.length,
  };
}

// ---- Signals -----------------------------------------------------------

// Observations worth a TA's eyes, each with the reason it fired and the
// most obvious innocent explanation. Returns [] for an ordinary session.
//
// There is intentionally no aggregate score and no boolean. Combining
// these into one number invites reading it as a probability of cheating,
// which is not what any of them measure.
export function suspicionSignals(summary) {
  const signals = [];
  if (!summary) return signals;
  const { typing, pastes, activeMs: active, pastedChars } = summary;

  for (const paste of pastes) {
    signals.push({
      code: "large-paste",
      label: `Pasted ${paste.length} characters`,
      detail: `At ${new Date(paste.wallMs).toISOString()}. Preview: ${truncate(paste.preview, 80)}`,
      innocentReading:
        "Moving their own code back in after editing it elsewhere, or pasting a test harness.",
    });
  }

  if (typing.deltaCount > 0 && pastedChars > typing.insertedChars * 0.5 && pastedChars > 0) {
    signals.push({
      code: "paste-dominant",
      label: "More characters arrived by paste than by typing",
      detail: `${pastedChars} pasted vs ${typing.insertedChars} typed.`,
      innocentReading:
        "Drafting in a local editor and pasting the result is a normal workflow.",
    });
  }

  if (
    typing.deletionRatio !== null &&
    typing.deletionRatio < 0.02 &&
    typing.deltaCount >= MIN_SAMPLES_FOR_CADENCE
  ) {
    signals.push({
      code: "no-backtracking",
      label: "Almost no edits or deletions",
      detail: `${typing.deleteCount} deletions across ${typing.deltaCount} edits.`,
      innocentReading:
        "A student who has solved this pattern before may well type it straight through.",
    });
  }

  if (typing.cadenceCv !== null && typing.cadenceCv < 0.5) {
    signals.push({
      code: "metronomic-typing",
      label: "Unusually even typing rhythm",
      detail: `Cadence variation ${typing.cadenceCv.toFixed(2)} over ${typing.sampleCount} intervals; human typing is usually above 0.8.`,
      innocentReading:
        "Fast touch-typists transcribing their own notes look like this too.",
    });
  }

  if (typing.largeInserts > 0) {
    signals.push({
      code: "large-inserts",
      label: `${typing.largeInserts} multi-character insert(s) with no paste event`,
      detail: `Single edits of ${LARGE_INSERT_CHARS}+ characters.`,
      innocentReading:
        "Editor autocomplete, snippet expansion, and AI assistants in the browser all produce these.",
    });
  }

  if (active === 0 && typing.insertedChars > 0) {
    signals.push({
      code: "no-active-time",
      label: "Code appeared with no recorded working time",
      detail: `${typing.insertedChars} characters inserted, ${active}ms active.`,
      innocentReading:
        "Capture may have started mid-session, or the tab was hidden throughout.",
    });
  }

  return signals;
}

function truncate(text, max) {
  const str = String(text ?? "");
  return str.length <= max ? str : `${str.slice(0, max)}…`;
}

// ---- Problem titles ----------------------------------------------------
//
// The slug comes from location.href and is always right. The stored
// problemTitle came from document.title, which on a single-page app can
// lag a navigation — sessions captured before that was fixed in
// keystroke-tracker.js may carry the PREVIOUS problem's name. So the
// stored title is only used when it slugifies back to the stored slug;
// otherwise it's rebuilt from the slug. That repairs historical rows at
// read time, with no migration.
//
// keystroke-tracker.js has its own inline copy of this rule: MV3 content
// scripts can't import modules, the same reason it inlines its Firestore
// helpers. Keep the two in step.

export function titleToSlug(title) {
  return String(title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function slugToTitle(slug) {
  return String(slug ?? "")
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function resolveProblemTitle(session) {
  const slug = session?.problemSlug;
  const stored = session?.problemTitle;
  if (!slug) return stored || "(unknown problem)";
  if (stored && titleToSlug(stored) === slug) return stored;
  return slugToTitle(slug);
}

// Total active time across sessions that started inside [startMs, endMs),
// read from the `activeMs` the tracker records on each session doc.
//
// Deliberately reads session METADATA only. The same number could be
// derived by folding every session's events, but that means fetching
// thousands of chunk documents to answer one question the dashboard asks
// on every render.
//
// Sessions captured before the tracker recorded activeMs contribute 0,
// so this undercounts historical weeks rather than inventing a figure —
// `trackedSessions` vs `sessions` lets a caller say so.
export function trackedActiveMsInWindow(sessions, startMs, endMs) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return { activeMs: 0, sessions: 0, trackedSessions: 0 };
  }
  let activeMs = 0;
  let count = 0;
  let tracked = 0;
  for (const session of sessions ?? []) {
    const startedAt = session?.startedAt;
    if (!Number.isFinite(startedAt) || startedAt < startMs || startedAt >= endMs) {
      continue;
    }
    count += 1;
    if (Number.isFinite(session.activeMs)) {
      activeMs += session.activeMs;
      tracked += 1;
    }
  }
  return { activeMs, sessions: count, trackedSessions: tracked };
}

// ---- Cross-session aggregates ------------------------------------------

// Total active time across many session summaries — "time spent on
// LeetCode" for a student, a week, or a problem, depending on what the
// caller filtered down to before passing them in.
export function totalActiveMs(summaries) {
  return (summaries ?? []).reduce((sum, s) => sum + (s?.activeMs ?? 0), 0);
}

// Rolls summaries up per problem, most time-spent first.
export function activeMsByProblem(summaries) {
  const bySlug = new Map();
  for (const summary of summaries ?? []) {
    const slug = summary?.problemSlug;
    if (!slug) continue;
    const entry = bySlug.get(slug) ?? {
      problemSlug: slug,
      problemTitle: summary.problemTitle ?? slug,
      activeMs: 0,
      sessionCount: 0,
      pastedChars: 0,
    };
    entry.activeMs += summary.activeMs ?? 0;
    entry.sessionCount += 1;
    entry.pastedChars += summary.pastedChars ?? 0;
    bySlug.set(slug, entry);
  }
  return [...bySlug.values()].sort((a, b) => b.activeMs - a.activeMs);
}

// Buckets summaries into [startMs, endMs) windows — the shape
// course-data.js's parseScheduleDates already returns, so a caller can
// ask "how much time did this student spend during week 6?".
export function activeMsInWindow(summaries, startMs, endMs) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;
  return totalActiveMs(
    (summaries ?? []).filter(
      (s) => Number.isFinite(s?.startedAt) && s.startedAt >= startMs && s.startedAt < endMs,
    ),
  );
}

// "1h 12m" / "8m" / "45s" — for card and table display.
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "0m";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
