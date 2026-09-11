// Two installed copies of the extension, and the recording slot they
// compete for.
//
// This area shipped broken once already: mountBadge() fell off the end
// of its create path returning undefined, claimRecordingSlot() read that
// as "someone else owns the slot", and a SINGLE installed copy displayed
// "two copies installed" and recorded nothing. It was invisible because
// nothing here was tested.
import { describe, it, expect, beforeEach } from "vitest";
import { dedupeSessions } from "../src/data/keystroke-analysis.js";

const session = (over = {}) => ({
  sessionId: "s1",
  problemSlug: "two-sum",
  startedAt: 1_000_000,
  deltaCount: 100,
  activeMs: 60_000,
  ...over,
});

describe("dedupeSessions", () => {
  it("collapses the same work recorded twice", () => {
    // Two copies start within a second of each other on the same page.
    const kept = dedupeSessions([
      session({ sessionId: "a" }),
      session({ sessionId: "b", startedAt: 1_000_800 }),
    ]);
    expect(kept).toHaveLength(1);
  });

  it("keeps the fuller of two duplicates", () => {
    // The copy that lost the race can hold truncated typing; dropping
    // the complete record would understate the student's work.
    const kept = dedupeSessions([
      session({ sessionId: "thin", deltaCount: 10, activeMs: 5_000 }),
      session({ sessionId: "full", startedAt: 1_000_500, deltaCount: 400, activeMs: 90_000 }),
    ]);
    expect(kept.map((s) => s.sessionId)).toEqual(["full"]);
  });

  it("keeps a genuine second attempt at the same problem", () => {
    const kept = dedupeSessions([
      session({ sessionId: "first" }),
      session({ sessionId: "later", startedAt: 1_000_000 + 15 * 60_000 }),
    ]);
    expect(kept).toHaveLength(2);
  });

  it("never merges different problems", () => {
    const kept = dedupeSessions([
      session({ sessionId: "a", problemSlug: "two-sum" }),
      session({ sessionId: "b", problemSlug: "lru-cache", startedAt: 1_000_100 }),
    ]);
    expect(kept).toHaveLength(2);
  });

  // The bug this caught: comparing `slug` instead of the stored
  // `problemSlug` made every session compare undefined to undefined,
  // which is true — so unrelated sessions merged on timing alone.
  it("keeps sessions that carry no problem slug", () => {
    const kept = dedupeSessions([
      { sessionId: "old", startedAt: 5_000 },
      { sessionId: "new", startedAt: 9_000 },
    ]);
    expect(kept.map((s) => s.sessionId).sort()).toEqual(["new", "old"]);
  });

  it("reads the stored field name, not the tracker's in-memory one", () => {
    expect(
      dedupeSessions([
        { sessionId: "a", problemSlug: "two-sum", startedAt: 1000 },
        { sessionId: "b", problemSlug: "two-sum", startedAt: 1500 },
      ]),
    ).toHaveLength(1);
  });

  it("survives empty and malformed input", () => {
    expect(dedupeSessions([])).toEqual([]);
    expect(dedupeSessions(null)).toEqual([]);
    expect(dedupeSessions([null, undefined, session()])).toHaveLength(1);
  });
});

// ---- The recording slot itself -----------------------------------------
//
// claimRecordingSlot lives in a content script that can't be imported
// (it's a classic script touching chrome.*), so these exercise the same
// logic against a real DOM the way the bundle would.
describe("recording slot", () => {
  let doc;
  const BADGE_ID = "cs393-recording-badge";
  const STALE_MS = 20000;

  // A faithful transcription of the shipped logic.
  function makeCopy(extensionId, now = () => Date.now()) {
    return {
      claim() {
        const existing = doc.getElementById(BADGE_ID);
        if (existing) {
          if (existing.dataset.cs393ExtensionId === extensionId) return true;
          const beat = Number(existing.dataset.cs393Heartbeat);
          const stale = !Number.isFinite(beat) || now() - beat > STALE_MS;
          if (!stale) return false;
          existing.remove();
        }
        const badge = doc.createElement("div");
        badge.id = BADGE_ID;
        badge.dataset.cs393ExtensionId = extensionId;
        badge.dataset.cs393Heartbeat = String(now());
        doc.body.appendChild(badge);
        return true;
      },
    };
  }

  beforeEach(() => {
    doc = new (require("jsdom").JSDOM)("<!doctype html><body></body>").window.document;
  });

  // The exact regression: one copy, nothing else on the page.
  it("lets a single installed copy record", () => {
    expect(makeCopy("ext-a").claim()).toBe(true);
  });

  it("is idempotent — the same copy re-claiming still owns the slot", () => {
    const a = makeCopy("ext-a");
    expect(a.claim()).toBe(true);
    expect(a.claim()).toBe(true);
  });

  it("refuses the second copy while the first is alive", () => {
    expect(makeCopy("ext-a").claim()).toBe(true);
    expect(makeCopy("ext-b").claim()).toBe(false);
  });

  // The other half of the student's report: they removed a copy and the
  // error stayed. An uninstalled copy leaves its badge in the page, so
  // the survivor must be able to take a dead claim over.
  it("takes over a claim whose heartbeat has stopped", () => {
    let clock = 1_000_000;
    expect(makeCopy("ext-a", () => clock).claim()).toBe(true);
    clock += STALE_MS + 1000; // ext-a is gone; nothing refreshes its badge
    expect(makeCopy("ext-b", () => clock).claim()).toBe(true);
    expect(doc.getElementById(BADGE_ID).dataset.cs393ExtensionId).toBe("ext-b");
  });

  it("does not take over a claim that is still beating", () => {
    let clock = 1_000_000;
    expect(makeCopy("ext-a", () => clock).claim()).toBe(true);
    clock += 3000;
    expect(makeCopy("ext-b", () => clock).claim()).toBe(false);
  });

  it("treats a badge with no heartbeat as abandoned", () => {
    // Left by a build from before heartbeats existed.
    const stray = doc.createElement("div");
    stray.id = BADGE_ID;
    stray.dataset.cs393ExtensionId = "ext-old";
    doc.body.appendChild(stray);
    expect(makeCopy("ext-b").claim()).toBe(true);
  });
});
