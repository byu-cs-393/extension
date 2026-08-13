// The "LeetCode sessions" section of the TA student-detail view. Reads
// what keystroke-tracker.js writes and runs it through
// keystroke-analysis.js.
//
// Split out of ta-dashboard.js so it can be rendered in a test with a
// fake chunk loader — see tests/ta-keystroke-view.test.js. Firestore
// access is injected rather than imported directly for the same reason:
// the real fetchCollection reaches auth.js, which reaches chrome.storage.
//
// Two-stage loading, on purpose:
//
//   1. The session list comes from metadata docs alone — one collection
//      fetch, cheap, and enough to show what was worked on and when.
//   2. Active time, typing shape and signals need the actual events,
//      which live in a chunks/ subcollection per session. A semester of
//      work is easily thousands of chunk docs, so those load only when
//      a TA asks for a specific session (or presses Analyze all).
//
// Everything a TA sees here is an observation with its counter-reading
// attached. There is no score and no verdict; see the header comment in
// keystroke-analysis.js for why.
import { fetchCollection as firestoreFetchCollection } from "../platform/firestore.js";
import {
  canReplay,
  buildReplayTimeline,
  compressIdleGaps,
  textAtStep,
  stepIndexAtPlaybackMs,
  offsetMsAtStep,
} from "../data/keystroke-replay.js";
import {
  summarizeSession,
  suspicionSignals,
  resolveProblemTitle,
  flattenChunks,
  totalActiveMs,
  activeMsByProblem,
  formatDuration,
} from "../data/keystroke-analysis.js";

// Summaries already computed this page-load, keyed by sessionId, so
// re-expanding a row doesn't refetch its chunks.
const sessionSummaryCache = new Map();

// Summaries are per-student; callers drop them when switching students
// so this doesn't grow unboundedly over a long TA session.
export function clearSessionCache() {
  sessionSummaryCache.clear();
}

export async function fetchKeystrokeSessions(netID, deps = {}) {
  const fetchCollection = deps.fetchCollection ?? firestoreFetchCollection;
  const sessions = await fetchCollection(`students/${netID}/keystrokeSessions`);
  return sessions
    .filter((s) => s?.sessionId)
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

// Returns { summary, events } — the player needs the raw event stream to
// rebuild the document, and refetching it on every Replay click would be
// wasteful when a TA is already looking at the session.
async function loadSessionSummary(netID, session, deps) {
  const cached = sessionSummaryCache.get(session.sessionId);
  if (cached) return cached;
  const fetchCollection = deps.fetchCollection ?? firestoreFetchCollection;
  const chunks = await fetchCollection(
    `students/${netID}/keystrokeSessions/${session.sessionId}/chunks`,
  );
  const entry = {
    summary: summarizeSession(session, chunks),
    events: flattenChunks(chunks),
  };
  sessionSummaryCache.set(session.sessionId, entry);
  return entry;
}

export function renderKeystrokeSection(body, netID, sessions, deps = {}) {
  const h2 = document.createElement("h2");
  h2.textContent = "LeetCode sessions";
  h2.className = "student-detail-section";
  body.appendChild(h2);

  // Sessions land in Firestore while a TA is looking at the page. Rather
  // than make them reload the whole dashboard, this re-lists just this
  // section in place.
  const refreshBtn = document.createElement("button");
  refreshBtn.type = "button";
  refreshBtn.className = "ks-refresh-btn";
  refreshBtn.textContent = "↻ Refresh";
  body.appendChild(refreshBtn);

  const panel = document.createElement("div");
  panel.className = "ks-panel";
  body.appendChild(panel);

  refreshBtn.addEventListener("click", async () => {
    refreshBtn.disabled = true;
    refreshBtn.textContent = "↻ Refreshing…";
    try {
      // Drop cached summaries too — a session that was still being
      // written when it was last analyzed has more chunks by now.
      clearSessionCache();
      const fresh = await fetchKeystrokeSessions(netID, deps);
      panel.innerHTML = "";
      renderSessionPanel(panel, netID, fresh, deps);
    } catch (err) {
      console.error("Failed to refresh keystroke sessions:", err);
      panel.innerHTML = `<p class="ta-empty">Failed to refresh: ${err.message}</p>`;
    } finally {
      refreshBtn.disabled = false;
      refreshBtn.textContent = "↻ Refresh";
    }
  });

  renderSessionPanel(panel, netID, sessions, deps);
}

function renderSessionPanel(body, netID, sessions, deps) {
  if (sessions.length === 0) {
    const empty = document.createElement("p");
    empty.className = "ta-empty";
    empty.textContent =
      "No captured sessions. The tracker records on leetcode.com/problems/* " +
      "once the student has completed onboarding.";
    body.appendChild(empty);
    return;
  }

  const help = document.createElement("p");
  help.className = "ta-help";
  help.textContent =
    `${sessions.length} session${sessions.length === 1 ? "" : "s"}. ` +
    "Expand one to load its events and see active time, typing shape, and " +
    "anything worth a look. Signals are prompts to investigate, never conclusions.";
  body.appendChild(help);

  const totals = document.createElement("div");
  totals.className = "ks-totals";
  totals.textContent = "Active time not computed yet.";
  body.appendChild(totals);

  const analyzeBtn = document.createElement("button");
  analyzeBtn.type = "button";
  analyzeBtn.className = "ks-analyze-btn";
  analyzeBtn.textContent = "Analyze all sessions";
  body.appendChild(analyzeBtn);

  const list = document.createElement("div");
  list.className = "ks-list";
  body.appendChild(list);

  const rows = sessions.map((session) => {
    const row = renderSessionRow(netID, session, deps);
    list.appendChild(row.element);
    return row;
  });

  analyzeBtn.addEventListener("click", async () => {
    analyzeBtn.disabled = true;
    analyzeBtn.textContent = "Loading events…";
    try {
      const summaries = [];
      // Sequential rather than Promise.all: each session is its own
      // paginated chunks fetch, and a semester of them fired at once
      // would hammer Firestore for no latency win a TA would notice.
      for (const [index, row] of rows.entries()) {
        analyzeBtn.textContent = `Loading events… (${index + 1}/${rows.length})`;
        summaries.push(await row.analyze());
      }
      renderTotals(totals, summaries);
      analyzeBtn.textContent = "Analyzed";
    } catch (err) {
      console.error("Failed to analyze sessions:", err);
      analyzeBtn.textContent = "Analyze all sessions";
      analyzeBtn.disabled = false;
      totals.textContent = `Failed to load events: ${err.message}`;
    }
  });
}

function renderTotals(container, summaries) {
  container.innerHTML = "";

  const headline = document.createElement("div");
  headline.className = "ks-totals-headline";
  const active = totalActiveMs(summaries);
  const pasted = summaries.reduce((sum, s) => sum + (s?.pastedChars ?? 0), 0);
  headline.textContent =
    `${formatDuration(active)} active across ${summaries.length} session` +
    `${summaries.length === 1 ? "" : "s"} · ${pasted.toLocaleString()} characters pasted`;
  container.appendChild(headline);

  const note = document.createElement("div");
  note.className = "ks-totals-note";
  note.textContent =
    "Active time counts gaps between events, capped at 2 minutes each, with " +
    "tab-hidden spans removed — so an idle open tab doesn't read as study time.";
  container.appendChild(note);

  const byProblem = activeMsByProblem(summaries);
  if (byProblem.length === 0) return;

  const table = document.createElement("div");
  table.className = "ks-problem-table";
  for (const entry of byProblem.slice(0, 10)) {
    const row = document.createElement("div");
    row.className = "ks-problem-row";

    const name = document.createElement("span");
    name.className = "ks-problem-name";
    name.textContent = entry.problemTitle;

    const meta = document.createElement("span");
    meta.className = "ks-problem-meta";
    const bits = [
      formatDuration(entry.activeMs),
      `${entry.sessionCount} session${entry.sessionCount === 1 ? "" : "s"}`,
    ];
    if (entry.pastedChars > 0) bits.push(`${entry.pastedChars} chars pasted`);
    meta.textContent = bits.join(" · ");

    row.append(name, meta);
    table.appendChild(row);
  }
  container.appendChild(table);
}

// One collapsible session row. Returns { element, analyze } so the
// Analyze-all button can drive every row through the same path a manual
// expand uses.
function renderSessionRow(netID, session, deps) {
  const element = document.createElement("div");
  element.className = "ks-session";

  const head = document.createElement("button");
  head.type = "button";
  head.className = "ks-session-head";

  const title = document.createElement("span");
  title.className = "ks-session-title";
  // Repaired at read time — see resolveProblemTitle. Sessions captured
  // before the SPA-title fix can carry the previous problem's name.
  title.textContent = resolveProblemTitle(session);

  const meta = document.createElement("span");
  meta.className = "ks-session-meta";
  const when = Number.isFinite(session.startedAt)
    ? new Date(session.startedAt).toLocaleString()
    : "unknown time";
  const elapsed =
    Number.isFinite(session.startedAt) && Number.isFinite(session.lastActivityAt)
      ? formatDuration(session.lastActivityAt - session.startedAt)
      : "—";
  // Wall-clock here, deliberately labelled as such: it's all the metadata
  // doc knows. Active time appears once the events are loaded.
  meta.textContent = `${when} · ${elapsed} open · ${session.deltaCount ?? 0} edits`;

  const chevron = document.createElement("span");
  chevron.className = "ks-session-chevron";
  chevron.textContent = "▸";

  head.append(chevron, title, meta);
  element.appendChild(head);

  const detail = document.createElement("div");
  detail.className = "ks-session-detail";
  detail.hidden = true;
  element.appendChild(detail);

  let loaded = false;
  let loading = null;

  async function analyze() {
    if (loaded) return sessionSummaryCache.get(session.sessionId)?.summary;
    if (loading) return loading;
    loading = (async () => {
      try {
        const { summary, events } = await loadSessionSummary(netID, session, deps);
        renderSessionDetail(detail, summary, events);
        loaded = true;
        return summary;
      } finally {
        // finally, not just the success path: leaving a rejected promise
        // in `loading` would make every later retry re-return that same
        // failure, so a transient network blip would look permanent.
        loading = null;
      }
    })();
    return loading;
  }

  head.addEventListener("click", async () => {
    const opening = detail.hidden;
    detail.hidden = !opening;
    chevron.textContent = opening ? "▾" : "▸";
    // Collapsing while a replay is playing would leave a timer running
    // against a hidden panel.
    if (!opening) detail.__stopReplay?.();
    if (!opening || loaded) return;
    detail.innerHTML = '<p class="ta-empty">Loading events…</p>';
    try {
      await analyze();
    } catch (err) {
      console.error("Failed to load session events:", err);
      detail.innerHTML = `<p class="ta-empty">Failed to load events: ${err.message}</p>`;
    }
  });

  return { element, analyze };
}

function renderSessionDetail(container, summary, events = []) {
  container.innerHTML = "";

  const stats = document.createElement("div");
  stats.className = "ks-stat-grid";
  const { typing } = summary;
  addStat(stats, "Active", formatDuration(summary.activeMs));
  addStat(stats, "Tab open", formatDuration(summary.elapsedMs ?? 0));
  addStat(stats, "Hidden", formatDuration(summary.hiddenMs));
  addStat(stats, "Typed", `${typing.insertedChars} chars`);
  addStat(stats, "Deleted", `${typing.deletedChars} chars`);
  addStat(
    stats,
    "Edits",
    `${typing.deltaCount} (${typing.deleteCount} deletions)`,
  );
  if (typing.medianGapMs !== null) {
    addStat(stats, "Median keystroke gap", `${Math.round(typing.medianGapMs)} ms`);
  }
  if (typing.cadenceCv !== null) {
    addStat(stats, "Rhythm variation", typing.cadenceCv.toFixed(2));
  }
  container.appendChild(stats);

  // LeetCode runs two Monaco editors. Sessions recorded before the
  // capture told them apart have their solution edits mixed with
  // testcase-pane edits, which nudges every number above — say so rather
  // than present mixed data as clean.
  if (!summary.editorIdsPresent) {
    const caveat = document.createElement("p");
    caveat.className = "ks-caveat";
    caveat.textContent =
      "Recorded before per-editor capture — these numbers combine the " +
      "solution editor with the testcase pane, so treat them as approximate.";
    container.appendChild(caveat);
  }

  const stopReplay = appendReplayControl(container, events);
  container.__stopReplay = stopReplay;

  const signals = suspicionSignals(summary);
  if (signals.length === 0) {
    const none = document.createElement("p");
    none.className = "ks-no-signals";
    none.textContent = "Nothing flagged for review in this session.";
    container.appendChild(none);
    return;
  }

  const heading = document.createElement("div");
  heading.className = "ks-signals-heading";
  heading.textContent = `${signals.length} thing${signals.length === 1 ? "" : "s"} worth a look`;
  container.appendChild(heading);

  for (const signal of signals) {
    const card = document.createElement("div");
    card.className = "ks-signal";

    const label = document.createElement("div");
    label.className = "ks-signal-label";
    label.textContent = signal.label;

    const detail = document.createElement("div");
    detail.className = "ks-signal-detail";
    detail.textContent = signal.detail;

    // The counter-reading is not optional garnish — it's the whole
    // reason this view shows observations instead of accusations.
    const innocent = document.createElement("div");
    innocent.className = "ks-signal-innocent";
    innocent.textContent = `Could just be: ${signal.innocentReading}`;

    card.append(label, detail, innocent);
    container.appendChild(card);
  }
}

// ---- Replay player -----------------------------------------------------

// Tick cadence for playback. Coarse enough to be cheap, fine enough that
// typing looks like typing rather than a slideshow.
const TICK_MS = 50;

// Appends a "Replay session" control. Sessions the capture can't
// faithfully reconstruct get the reason instead of a player — see
// canReplay() for why a wrong replay is worse than none.
function appendReplayControl(container, events) {
  const verdict = canReplay(events);
  if (!verdict.ok) {
    const note = document.createElement("p");
    note.className = "ks-replay-unavailable";
    note.textContent = `Replay unavailable. ${verdict.reason}`;
    container.appendChild(note);
    return () => {};
  }

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ks-replay-btn";
  btn.textContent = "▶ Replay session";
  container.appendChild(btn);

  const mount = document.createElement("div");
  mount.className = "ks-replay-mount";
  container.appendChild(mount);

  let teardown = () => {};
  btn.addEventListener("click", () => {
    if (mount.childElementCount > 0) {
      teardown();
      teardown = () => {};
      mount.innerHTML = "";
      btn.textContent = "▶ Replay session";
      return;
    }
    teardown = renderReplayPlayer(mount, events);
    btn.textContent = "▼ Hide replay";
  });

  // Returned so collapsing the session row can stop a running playback
  // instead of leaving a timer ticking against a hidden panel.
  return () => teardown();
}

function renderReplayPlayer(mount, events) {
  const timeline = compressIdleGaps(buildReplayTimeline(events));
  const lastIndex = timeline.steps.length - 1;
  const totalMs = timeline.playbackDurationMs ?? 0;

  for (const warning of timeline.warnings) {
    const el = document.createElement("p");
    el.className = "ks-caveat";
    el.textContent = warning;
    mount.appendChild(el);
  }

  const code = document.createElement("pre");
  code.className = "ks-replay-code";
  // textContent, never innerHTML — this is student-authored source and
  // would otherwise execute in the TA's page.
  code.textContent = timeline.baseline;
  mount.appendChild(code);

  const controls = document.createElement("div");
  controls.className = "ks-replay-controls";

  const playBtn = document.createElement("button");
  playBtn.type = "button";
  playBtn.className = "ks-replay-play";
  playBtn.textContent = "▶";
  playBtn.setAttribute("aria-label", "Play");

  const scrubber = document.createElement("input");
  scrubber.type = "range";
  scrubber.className = "ks-replay-scrubber";
  scrubber.min = "0";
  scrubber.max = String(Math.max(totalMs, 1));
  scrubber.value = "0";
  scrubber.setAttribute("aria-label", "Position in replay");

  const speed = document.createElement("select");
  speed.className = "ks-replay-speed";
  for (const [value, label] of [["1", "1×"], ["4", "4×"], ["16", "16×"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    if (value === "4") option.selected = true;
    speed.appendChild(option);
  }

  const position = document.createElement("span");
  position.className = "ks-replay-position";

  controls.append(playBtn, scrubber, speed, position);
  mount.appendChild(controls);

  let offsetMs = 0;
  let timer = null;

  function render() {
    const index = stepIndexAtPlaybackMs(timeline, offsetMs);
    code.textContent = textAtStep(timeline, index);
    scrubber.value = String(Math.round(offsetMs));
    const shown = index < 0 ? 0 : index + 1;
    // Elapsed shows REAL time into the session, not compressed playback
    // time — a TA reading "12m in" wants the student's clock, not ours.
    position.textContent =
      `${shown}/${timeline.steps.length} edits · ` +
      `${formatDuration(offsetMsAtStep(timeline, index))} in`;
  }

  function stop() {
    if (timer !== null) clearInterval(timer);
    timer = null;
    playBtn.textContent = "▶";
    playBtn.setAttribute("aria-label", "Play");
  }

  function start() {
    if (timer !== null) return;
    if (offsetMs >= totalMs) offsetMs = 0; // replay again from the top
    playBtn.textContent = "❚❚";
    playBtn.setAttribute("aria-label", "Pause");
    timer = setInterval(() => {
      offsetMs += TICK_MS * Number(speed.value);
      if (offsetMs >= totalMs) {
        offsetMs = totalMs;
        render();
        stop();
        return;
      }
      render();
    }, TICK_MS);
  }

  playBtn.addEventListener("click", () => (timer === null ? start() : stop()));
  scrubber.addEventListener("input", () => {
    stop();
    offsetMs = Number(scrubber.value);
    render();
  });

  render();
  return stop;
}

function addStat(grid, label, value) {
  const cell = document.createElement("div");
  cell.className = "ks-stat";

  const l = document.createElement("span");
  l.className = "ks-stat-label";
  l.textContent = label;

  const v = document.createElement("span");
  v.className = "ks-stat-value";
  v.textContent = value;

  cell.append(l, v);
  grid.appendChild(cell);
}
