// @vitest-environment jsdom
//
// DOM tests for src/ta-keystroke-view.js — the TA-facing "LeetCode
// sessions" section.
//
// Unlike the other suites here, these render real elements into a real
// document (jsdom, declared per-file above so the rest of the suite stays
// in plain Node) and then assert on what a TA would actually see and
// click. Firestore is injected as a fake, so nothing touches the network.
//
// What's worth testing at this layer isn't the CSS — it's behaviour the
// markup encodes: that chunk events load lazily rather than on page open,
// that expanding twice doesn't refetch, that a failed load says so
// instead of hanging, and that no signal is ever rendered without its
// counter-reading.
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  renderKeystrokeSection,
  fetchKeystrokeSessions,
  clearSessionCache,
} from "../src/ui/ta-keystroke-view.js";

const T0 = 1_756_900_000_000;

const type = (at, text = "x") => ({
  kind: "delta", t: at, wallMs: T0 + at, offset: 0, length: 0, text,
});
const del = (at, n = 1) => ({
  kind: "delta", t: at, wallMs: T0 + at, offset: 0, length: n, text: "",
});
const paste = (at, length, preview = "class Solution:") => ({
  kind: "paste", t: at, wallMs: T0 + at, length, preview,
});

const session = (over = {}) => ({
  sessionId: "two-sum-1-abc",
  netID: "jack684",
  problemSlug: "two-sum",
  problemTitle: "Two Sum",
  startedAt: T0,
  lastActivityAt: T0 + 600_000,
  deltaCount: 61,
  chunkCount: 1,
  ...over,
});

// Bursty typing with backtracking — the shape that should trip nothing.
function humanEvents() {
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
  return events;
}

// Builds a fake fetchCollection that serves the given chunk events for
// any chunks/ path, and records every path it was asked for.
function fakeFirestore(events) {
  const calls = [];
  return {
    calls,
    deps: {
      fetchCollection: vi.fn(async (path) => {
        calls.push(path);
        if (path.endsWith("/chunks")) return [{ chunkIndex: 0, events }];
        return [];
      }),
    },
  };
}

let container;

beforeEach(() => {
  document.body.innerHTML = "";
  container = document.createElement("div");
  document.body.appendChild(container);
  clearSessionCache();
});

const $ = (sel) => container.querySelector(sel);
const $$ = (sel) => [...container.querySelectorAll(sel)];

// DOM click handlers can't be awaited: dispatchEvent is synchronous and
// discards whatever an async listener returns. So click, then drain the
// task queue until the handler's awaited fetches have settled. Ten ticks
// covers the Analyze-all loop, which awaits once per session.
async function click(element) {
  element.click();
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("empty state", () => {
  it("explains where the data comes from when there are no sessions", () => {
    renderKeystrokeSection(container, "jack684", []);
    expect($(".ta-empty").textContent).toMatch(/no captured sessions/i);
    expect($(".ta-empty").textContent).toMatch(/onboarding/i);
  });

  it("renders no rows, totals, or analyze button", () => {
    renderKeystrokeSection(container, "jack684", []);
    expect($$(".ks-session")).toHaveLength(0);
    expect($(".ks-analyze-btn")).toBe(null);
    expect($(".ks-totals")).toBe(null);
  });
});

describe("session list", () => {
  it("renders one collapsed row per session, newest data intact", () => {
    const { deps } = fakeFirestore([]);
    renderKeystrokeSection(
      container,
      "jack684",
      [
        session(),
        session({ sessionId: "lru-2", problemSlug: "lru-cache", problemTitle: "LRU Cache" }),
      ],
      deps,
    );
    expect($$(".ks-session")).toHaveLength(2);
    expect($$(".ks-session-title").map((e) => e.textContent)).toEqual([
      "Two Sum",
      "LRU Cache",
    ]);
    for (const detail of $$(".ks-session-detail")) {
      expect(detail.hidden).toBe(true);
    }
  });

  it("does NOT fetch chunk events on first render", () => {
    // The whole point of the two-stage design: opening a student's page
    // must not pull a semester of events.
    const { deps } = fakeFirestore(humanEvents());
    renderKeystrokeSection(container, "jack684", [session()], deps);
    expect(deps.fetchCollection).not.toHaveBeenCalled();
  });

  it("labels the metadata number as tab-open time, not active time", () => {
    const { deps } = fakeFirestore([]);
    renderKeystrokeSection(container, "jack684", [session()], deps);
    expect($(".ks-session-meta").textContent).toMatch(/10m open/);
    expect($(".ks-session-meta").textContent).toMatch(/61 edits/);
  });

  it("builds a title from the slug when none was stored", () => {
    const { deps } = fakeFirestore([]);
    renderKeystrokeSection(
      container,
      "jack684",
      [
        session({ problemTitle: null }),
        session({ sessionId: "x", problemTitle: null, problemSlug: null }),
      ],
      deps,
    );
    expect($$(".ks-session-title").map((e) => e.textContent)).toEqual([
      "Two Sum",
      "(unknown problem)",
    ]);
  });

  it("repairs a stored title that names a different problem", () => {
    // Sessions captured before the SPA-title fix carry the PREVIOUS
    // problem's name; the slug is from the URL and is reliable. Existing
    // rows in Firestore display correctly without a migration.
    const { deps } = fakeFirestore([]);
    renderKeystrokeSection(
      container,
      "jack684",
      [session({ problemSlug: "add-two-numbers", problemTitle: "Two Sum" })],
      deps,
    );
    expect($(".ks-session-title").textContent).toBe("Add Two Numbers");
  });

  it("shows a totals placeholder until analysis runs", () => {
    const { deps } = fakeFirestore([]);
    renderKeystrokeSection(container, "jack684", [session()], deps);
    expect($(".ks-totals").textContent).toMatch(/not computed yet/i);
  });
});

describe("expanding a session", () => {
  it("loads chunks and reveals the detail panel", async () => {
    const { deps } = fakeFirestore(humanEvents());
    renderKeystrokeSection(container, "jack684", [session()], deps);

    await click($(".ks-session-head"));

    expect(deps.fetchCollection).toHaveBeenCalledWith(
      "students/jack684/keystrokeSessions/two-sum-1-abc/chunks",
    );
    expect($(".ks-session-detail").hidden).toBe(false);
    expect($(".ks-stat-grid")).not.toBe(null);
  });

  it("shows active time separately from tab-open time", async () => {
    const { deps } = fakeFirestore(humanEvents());
    renderKeystrokeSection(container, "jack684", [session()], deps);
    await click($(".ks-session-head"));

    const labels = $$(".ks-stat-label").map((e) => e.textContent);
    expect(labels).toContain("Active");
    expect(labels).toContain("Tab open");
    // Ten minutes of tab, well under a minute of actual work.
    const stats = Object.fromEntries(
      $$(".ks-stat").map((s) => [
        s.querySelector(".ks-stat-label").textContent,
        s.querySelector(".ks-stat-value").textContent,
      ]),
    );
    expect(stats["Tab open"]).toBe("10m");
    expect(stats["Active"]).not.toBe(stats["Tab open"]);
  });

  it("collapses again without refetching", async () => {
    const { deps } = fakeFirestore(humanEvents());
    renderKeystrokeSection(container, "jack684", [session()], deps);
    const head = $(".ks-session-head");

    await click(head);
    await click(head);
    expect($(".ks-session-detail").hidden).toBe(true);

    await click(head);
    expect($(".ks-session-detail").hidden).toBe(false);
    expect(deps.fetchCollection).toHaveBeenCalledTimes(1);
  });

  it("retries after a failure instead of replaying the old error", async () => {
    // Regression: `loading` used to keep the rejected promise, so every
    // later expand re-returned that same failure and a transient blip
    // looked permanent.
    let failNext = true;
    const deps = {
      fetchCollection: vi.fn(async () => {
        if (failNext) {
          failNext = false;
          throw new Error("transient blip");
        }
        return [{ chunkIndex: 0, events: humanEvents() }];
      }),
    };
    renderKeystrokeSection(container, "jack684", [session()], deps);
    const head = $(".ks-session-head");

    await click(head); // fails
    expect($(".ks-session-detail").textContent).toMatch(/transient blip/);

    await click(head); // collapse
    await click(head); // retry — should succeed now
    expect($(".ks-stat-grid")).not.toBe(null);
    expect($(".ks-session-detail").textContent).not.toMatch(/transient blip/);
  });

  it("surfaces a load failure in the panel instead of hanging", async () => {
    const deps = {
      fetchCollection: vi.fn(async () => {
        throw new Error("permission denied");
      }),
    };
    renderKeystrokeSection(container, "jack684", [session()], deps);

    await click($(".ks-session-head"));
    expect($(".ks-session-detail").textContent).toMatch(/permission denied/);
  });
});

describe("signals in the rendered panel", () => {
  it("says nothing is flagged for ordinary bursty typing", async () => {
    const { deps } = fakeFirestore(humanEvents());
    renderKeystrokeSection(container, "jack684", [session()], deps);
    await click($(".ks-session-head"));

    expect($(".ks-no-signals").textContent).toMatch(/nothing flagged/i);
    expect($$(".ks-signal")).toHaveLength(0);
  });

  it("renders a signal card for a large paste", async () => {
    const { deps } = fakeFirestore([type(0), paste(1000, 900)]);
    renderKeystrokeSection(container, "jack684", [session()], deps);
    await click($(".ks-session-head"));

    const labels = $$(".ks-signal-label").map((e) => e.textContent);
    expect(labels.some((l) => /pasted 900 characters/i.test(l))).toBe(true);
  });

  it("never renders a signal without its counter-reading", async () => {
    // The UI contract. If this fails, the view has started making
    // accusations instead of observations.
    const metronomic = Array.from({ length: 60 }, (_, i) => type(i * 100));
    const { deps } = fakeFirestore([...metronomic, paste(6100, 900)]);
    renderKeystrokeSection(container, "jack684", [session()], deps);
    await click($(".ks-session-head"));

    const signals = $$(".ks-signal");
    expect(signals.length).toBeGreaterThan(0);
    for (const card of signals) {
      const innocent = card.querySelector(".ks-signal-innocent");
      expect(innocent).not.toBe(null);
      expect(innocent.textContent).toMatch(/^Could just be: \S/);
    }
  });

  it("uses the warning tone, never an error tone", async () => {
    // Guards the styling decision: nothing here is a finding.
    const { deps } = fakeFirestore([type(0), paste(1000, 900)]);
    renderKeystrokeSection(container, "jack684", [session()], deps);
    await click($(".ks-session-head"));

    for (const card of $$(".ks-signal")) {
      expect(card.className).not.toMatch(/error|danger|alert/);
    }
  });

  it("counts the flagged items in the heading", async () => {
    const { deps } = fakeFirestore([type(0), paste(1000, 900)]);
    renderKeystrokeSection(container, "jack684", [session()], deps);
    await click($(".ks-session-head"));

    const count = $$(".ks-signal").length;
    expect($(".ks-signals-heading").textContent).toMatch(
      new RegExp(`^${count} thing`),
    );
  });
});

describe("analyze all", () => {
  it("loads every session and renders totals", async () => {
    const { deps } = fakeFirestore(humanEvents());
    renderKeystrokeSection(
      container,
      "jack684",
      [session(), session({ sessionId: "lru-2", problemSlug: "lru-cache", problemTitle: "LRU Cache" })],
      deps,
    );

    await click($(".ks-analyze-btn"));

    expect(deps.fetchCollection).toHaveBeenCalledTimes(2);
    expect($(".ks-totals-headline").textContent).toMatch(/active across 2 sessions/);
    expect($$(".ks-problem-row")).toHaveLength(2);
  });

  it("explains how active time is computed, so the number isn't taken raw", async () => {
    const { deps } = fakeFirestore(humanEvents());
    renderKeystrokeSection(container, "jack684", [session()], deps);
    await click($(".ks-analyze-btn"));

    expect($(".ks-totals-note").textContent).toMatch(/capped at 2 minutes/);
    expect($(".ks-totals-note").textContent).toMatch(/tab-hidden/);
  });

  it("disables the button while loading and marks it done", async () => {
    const { deps } = fakeFirestore(humanEvents());
    renderKeystrokeSection(container, "jack684", [session()], deps);
    const btn = $(".ks-analyze-btn");

    await click(btn);
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toBe("Analyzed");
  });

  it("re-enables the button and reports the error if a fetch fails", async () => {
    const deps = {
      fetchCollection: vi.fn(async () => {
        throw new Error("network down");
      }),
    };
    renderKeystrokeSection(container, "jack684", [session()], deps);
    const btn = $(".ks-analyze-btn");

    await click(btn);
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe("Analyze all sessions");
    expect($(".ks-totals").textContent).toMatch(/network down/);
  });

  it("reuses summaries when a row is expanded afterwards", async () => {
    const { deps } = fakeFirestore(humanEvents());
    renderKeystrokeSection(container, "jack684", [session()], deps);

    await click($(".ks-analyze-btn"));
    await click($(".ks-session-head"));

    expect(deps.fetchCollection).toHaveBeenCalledTimes(1);
    expect($(".ks-session-detail").hidden).toBe(false);
    expect($(".ks-stat-grid")).not.toBe(null);
  });
});

describe("fetchKeystrokeSessions", () => {
  it("sorts newest first and drops docs with no sessionId", async () => {
    const deps = {
      fetchCollection: vi.fn(async () => [
        { sessionId: "old", startedAt: T0 - 5000 },
        { startedAt: T0 }, // malformed — no sessionId
        { sessionId: "new", startedAt: T0 + 5000 },
      ]),
    };
    const sessions = await fetchKeystrokeSessions("jack684", deps);
    expect(sessions.map((s) => s.sessionId)).toEqual(["new", "old"]);
  });

  it("asks for the right collection path", async () => {
    const deps = { fetchCollection: vi.fn(async () => []) };
    await fetchKeystrokeSessions("jack684", deps);
    expect(deps.fetchCollection).toHaveBeenCalledWith(
      "students/jack684/keystrokeSessions",
    );
  });

  it("treats a missing startedAt as oldest rather than throwing", async () => {
    const deps = {
      fetchCollection: vi.fn(async () => [
        { sessionId: "no-date" },
        { sessionId: "dated", startedAt: T0 },
      ]),
    };
    const sessions = await fetchKeystrokeSessions("jack684", deps);
    expect(sessions.map((s) => s.sessionId)).toEqual(["dated", "no-date"]);
  });
});

describe("cross-student cache hygiene", () => {
  it("refetches after clearSessionCache, so one student's data can't show under another", async () => {
    const { deps } = fakeFirestore(humanEvents());
    renderKeystrokeSection(container, "jack684", [session()], deps);
    await click($(".ks-session-head"));
    expect(deps.fetchCollection).toHaveBeenCalledTimes(1);

    clearSessionCache();
    document.body.innerHTML = "";
    container = document.createElement("div");
    document.body.appendChild(container);

    renderKeystrokeSection(container, "other", [session()], deps);
    await click($(".ks-session-head"));
    expect(deps.fetchCollection).toHaveBeenCalledTimes(2);
    expect(deps.fetchCollection).toHaveBeenLastCalledWith(
      "students/other/keystrokeSessions/two-sum-1-abc/chunks",
    );
  });
});

describe("mixed-editor caveat", () => {
  it("warns when a session predates per-editor capture", async () => {
    const { deps } = fakeFirestore(humanEvents()); // no editorId on any event
    renderKeystrokeSection(container, "jack684", [session()], deps);
    await click($(".ks-session-head"));

    expect($(".ks-caveat")).not.toBe(null);
    expect($(".ks-caveat").textContent).toMatch(/testcase pane/);
    expect($(".ks-caveat").textContent).toMatch(/approximate/);
  });

  it("shows no caveat once edits carry an editor id", async () => {
    const withEditor = humanEvents().map((e) => ({ ...e, editorId: "sol" }));
    const { deps } = fakeFirestore(withEditor);
    renderKeystrokeSection(container, "jack684", [session()], deps);
    await click($(".ks-session-head"));

    expect($(".ks-caveat")).toBe(null);
  });
});

describe("replay player", () => {
  const EDITOR = "sol";
  const snap = (at, text) => ({
    kind: "snapshot", t: at, wallMs: T0 + at, editorId: EDITOR,
    text, language: "python",
  });
  const typeAt = (at, offset, ch) => ({
    kind: "delta", t: at, wallMs: T0 + at, editorId: EDITOR,
    offset, length: 0, text: ch,
  });
  const codeEvents = () => [
    snap(0, "class Solution:"),
    ...[..."\n    pass"].map((ch, i) => typeAt(100 + i * 100, 15 + i, ch)),
  ];

  async function openSession(events) {
    const { deps } = fakeFirestore(events);
    renderKeystrokeSection(container, "jack684", [session()], deps);
    await click($(".ks-session-head"));
  }

  it("offers replay for a session with editor ids", async () => {
    await openSession(codeEvents());
    expect($(".ks-replay-btn")).not.toBe(null);
    expect($(".ks-replay-unavailable")).toBe(null);
  });

  it("refuses replay for a pre-editorId session and says why", async () => {
    // A replay folded from two interleaved editors would look real and
    // be wrong, so it isn't offered at all.
    await openSession(humanEvents());
    expect($(".ks-replay-btn")).toBe(null);
    expect($(".ks-replay-unavailable").textContent).toMatch(/two editors|interleaved/i);
  });

  it("shows the starter code before anything is played", async () => {
    await openSession(codeEvents());
    await click($(".ks-replay-btn"));
    expect($(".ks-replay-code").textContent).toBe("class Solution:");
  });

  it("renders student code as text, never as markup", async () => {
    // Student source lands in a TA's page; innerHTML here would execute it.
    const evil = "<img src=x onerror=alert(1)>";
    await openSession([snap(0, evil), typeAt(100, evil.length, "!")]);
    await click($(".ks-replay-btn"));
    const code = $(".ks-replay-code");
    expect(code.textContent).toBe(evil);
    expect(code.querySelector("img")).toBe(null);
  });

  it("scrubbing to the end shows the final document", async () => {
    await openSession(codeEvents());
    await click($(".ks-replay-btn"));

    const scrubber = $(".ks-replay-scrubber");
    scrubber.value = scrubber.max;
    scrubber.dispatchEvent(new Event("input"));

    expect($(".ks-replay-code").textContent).toBe("class Solution:\n    pass");
  });

  it("scrubbing back to zero returns to the starting text", async () => {
    await openSession(codeEvents());
    await click($(".ks-replay-btn"));

    const scrubber = $(".ks-replay-scrubber");
    scrubber.value = scrubber.max;
    scrubber.dispatchEvent(new Event("input"));
    scrubber.value = "0";
    scrubber.dispatchEvent(new Event("input"));

    expect($(".ks-replay-code").textContent).toBe("class Solution:");
  });

  it("reports position as edits applied and elapsed session time", async () => {
    await openSession(codeEvents());
    await click($(".ks-replay-btn"));
    // At rest nothing has been applied yet — the lead-in exists so the
    // starting document is visible before the first keystroke lands.
    expect($(".ks-replay-position").textContent).toMatch(/^0\/9 edits · /);

    const scrubber = $(".ks-replay-scrubber");
    scrubber.value = scrubber.max;
    scrubber.dispatchEvent(new Event("input"));
    expect($(".ks-replay-position").textContent).toMatch(/^9\/9 edits · /);
  });

  it("toggles the player closed again", async () => {
    await openSession(codeEvents());
    const btn = $(".ks-replay-btn");

    await click(btn);
    expect($(".ks-replay-code")).not.toBe(null);
    expect(btn.textContent).toMatch(/hide/i);

    await click(btn);
    expect($(".ks-replay-code")).toBe(null);
    expect(btn.textContent).toMatch(/replay session/i);
  });

  it("surfaces a mid-edit warning from the timeline", async () => {
    // No snapshot — the injector hooked Monaco after typing began.
    const events = [..."abc"].map((ch, i) => typeAt(100 + i * 100, i, ch));
    await openSession(events);
    await click($(".ks-replay-btn"));
    expect($(".ks-caveat").textContent).toMatch(/started mid-edit/i);
  });

  it("stops playback when the session row is collapsed", async () => {
    // Otherwise a timer keeps ticking against a hidden panel.
    await openSession(codeEvents());
    await click($(".ks-replay-btn"));
    await click($(".ks-replay-play"));
    expect($(".ks-replay-play").textContent).not.toBe("▶");

    await click($(".ks-session-head")); // collapse
    expect($(".ks-replay-play").textContent).toBe("▶");
  });
});

describe("refresh", () => {
  it("re-lists sessions recorded while the TA was already looking", async () => {
    // The reason this exists: a student solves a problem mid-review, and
    // reloading the whole dashboard to see it is a poor answer.
    let sessions = [session()];
    const deps = {
      fetchCollection: vi.fn(async (path) => {
        if (path.endsWith("/keystrokeSessions")) return sessions;
        return [{ chunkIndex: 0, events: humanEvents() }];
      }),
    };
    renderKeystrokeSection(container, "jack684", sessions, deps);
    expect($$(".ks-session")).toHaveLength(1);

    sessions = [
      session({ sessionId: "lru-9", problemSlug: "lru-cache", problemTitle: "LRU Cache" }),
      session(),
    ];
    await click($(".ks-refresh-btn"));

    expect($$(".ks-session")).toHaveLength(2);
    expect($$(".ks-session-title").map((e) => e.textContent)).toContain("LRU Cache");
  });

  it("reports a failed refresh instead of blanking the section", async () => {
    const deps = {
      fetchCollection: vi.fn(async () => {
        throw new Error("offline");
      }),
    };
    renderKeystrokeSection(container, "jack684", [session()], deps);
    await click($(".ks-refresh-btn"));

    expect($(".ks-panel").textContent).toMatch(/failed to refresh: offline/i);
    expect($(".ks-refresh-btn").disabled).toBe(false);
  });

  it("goes from empty to populated", async () => {
    let sessions = [];
    const deps = {
      fetchCollection: vi.fn(async (path) =>
        path.endsWith("/keystrokeSessions") ? sessions : [],
      ),
    };
    renderKeystrokeSection(container, "jack684", sessions, deps);
    expect($(".ta-empty")).not.toBe(null);

    sessions = [session()];
    await click($(".ks-refresh-btn"));

    expect($(".ta-empty")).toBe(null);
    expect($$(".ks-session")).toHaveLength(1);
  });
});
