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
import { fetchCollection as firestoreFetchCollection } from "./firestore.js";
import {
  summarizeSession,
  suspicionSignals,
  resolveProblemTitle,
  totalActiveMs,
  activeMsByProblem,
  formatDuration,
} from "./keystroke-analysis.js";

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

async function loadSessionSummary(netID, session, deps) {
  const cached = sessionSummaryCache.get(session.sessionId);
  if (cached) return cached;
  const fetchCollection = deps.fetchCollection ?? firestoreFetchCollection;
  const chunks = await fetchCollection(
    `students/${netID}/keystrokeSessions/${session.sessionId}/chunks`,
  );
  const summary = summarizeSession(session, chunks);
  sessionSummaryCache.set(session.sessionId, summary);
  return summary;
}

export function renderKeystrokeSection(body, netID, sessions, deps = {}) {
  const h2 = document.createElement("h2");
  h2.textContent = "LeetCode sessions";
  h2.className = "student-detail-section";
  body.appendChild(h2);

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
    if (loaded) return sessionSummaryCache.get(session.sessionId);
    if (loading) return loading;
    loading = (async () => {
      try {
        const summary = await loadSessionSummary(netID, session, deps);
        renderSessionDetail(detail, summary);
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

function renderSessionDetail(container, summary) {
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
