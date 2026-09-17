// Two students passed on the same assignment, back to back, from one TA's
// browser.
//
// That is exactly the case that broke. recordSignoffDecision merged each
// signoff onto chrome.storage.local — the TA's own cache, keyed by
// assignment id with no student in the key. Passing Porter on
// perf-data-structures wrote his signoff into the TA's own entry for that
// assignment; the TA's dashboard then queued it onto the TA's record; and
// passing Catherine next inherited that queued item, so autoSubmission
// thought she was already pending and nothing reached Canvas.
//
// The first pass looked like it worked, which is why a single test
// couldn't find this.
import { describe, it, expect, vi, beforeEach } from "vitest";

const firestoreWrites = [];
vi.mock("../src/platform/firestore.js", () => ({
  patchDoc: vi.fn(async (path, fields) => firestoreWrites.push({ path, fields })),
  fetchDoc: vi.fn(),
  fetchCollection: vi.fn(),
}));

let localStore;
function installChrome() {
  localStore = {};
  globalThis.chrome = {
    storage: {
      local: {
        get: vi.fn(async (k) => ({ [k]: localStore[k] })),
        set: vi.fn(async (obj) => Object.assign(localStore, obj)),
      },
    },
  };
}

const { recordSignoffDecision } = await import("../src/data/assignment-progress.js");
const { autoSubmission } = await import("../src/data/auto-submit.js");

// Each student's document as the TA dashboard loads it from Firestore.
const requested = (netID) => ({
  assignmentId: "perf-data-structures",
  type: "performance",
  weekNum: 3,
  status: "requested",
  requestedTaNetID: "jack684",
});

// The TA's OWN cached entry for the same assignment — present because the
// TA had tested it as a student. This is what used to leak in.
const tasOwnCachedEntry = {
  assignmentId: "perf-data-structures",
  type: "performance",
  status: "passed",
  signoffAt: 1_000,
  pendingSubmission: {
    type: "performance",
    assignmentId: "perf-data-structures",
    data: {},
    queuedAt: 1_500,
  },
};

function pass(netID) {
  return recordSignoffDecision({
    studentNetID: netID,
    taNetID: "jack684",
    assignmentId: "perf-data-structures",
    outcome: "passed",
    signoffHowLong: "10 min",
    studentProgress: requested(netID),
  });
}

beforeEach(() => {
  installChrome();
  firestoreWrites.length = 0;
  // The TA's cache already holds their own polluted entry.
  localStore.assignmentProgressBundle = {
    progress: { "perf-data-structures": structuredClone(tasOwnCachedEntry) },
  };
});

describe("passing two students on one assignment from one TA browser", () => {
  it("produces a Canvas submission for BOTH, not just the first", async () => {
    const porter = await pass("pn282");
    const catherine = await pass("cater922");
    expect(autoSubmission(porter)).not.toBeNull();
    expect(autoSubmission(catherine)).not.toBeNull();
  });

  it("describes each student's own document, never the TA's", async () => {
    const catherine = await pass("cater922");
    expect(catherine.status).toBe("passed");
    expect(catherine.type).toBe("performance");
    expect(catherine.weekNum).toBe(3);
    // Nothing from the TA's cached entry bleeds through.
    expect(catherine.pendingSubmission).toBeUndefined();
    expect(catherine.signoffAt).not.toBe(1_000);
  });

  // The pollution itself: a student's decision must never land in the TA's
  // cache, where the TA's own dashboard would act on it.
  it("never writes a student's decision into the TA's cache", async () => {
    await pass("pn282");
    await pass("cater922");
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect(localStore.assignmentProgressBundle.progress["perf-data-structures"])
      .toEqual(tasOwnCachedEntry);
  });

  it("writes each decision to that student's own record", async () => {
    await pass("pn282");
    await pass("cater922");
    expect(firestoreWrites.map((w) => w.path)).toEqual([
      "students/pn282/assignmentProgress/perf-data-structures",
      "students/cater922/assignmentProgress/perf-data-structures",
    ]);
  });

  it("still gives autoSubmission a type when the loaded doc has one", async () => {
    // The original reason the full doc is returned: a bare patch has no
    // type, and autoSubmission rejects it silently.
    const result = await pass("pn282");
    expect(autoSubmission(result)?.type).toBe("performance");
  });
});
