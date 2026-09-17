// The background worker's half of in-browser Canvas submission.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const docs = {};
const patches = [];

vi.mock("../src/platform/firestore.js", () => ({
  fetchCollection: vi.fn(async () => Object.values(docs)),
  fetchDoc: vi.fn(async (path) => docs[path.split("/").pop()] ?? null),
  patchDoc: vi.fn(async (path, fields) => {
    patches.push({ path, fields });
    const id = path.split("/").pop();
    docs[id] = { ...(docs[id] ?? {}), ...fields };
  }),
}));

function installChrome() {
  const areas = { session: {}, sync: { netID: "stu123" }, local: {} };
  const area = (name) => ({
    get: vi.fn(async (key) => ({ [key]: areas[name][key] })),
    set: vi.fn(async (obj) => Object.assign(areas[name], obj)),
  });
  globalThis.chrome = {
    storage: { session: area("session"), sync: area("sync"), local: area("local") },
    runtime: { getURL: (p) => `chrome-extension://id/${p}` },
    tabs: {
      create: vi.fn(async () => ({ id: 77 })),
      remove: vi.fn(async () => {}),
      update: vi.fn(async () => {}),
    },
  };
  globalThis.fetch = vi.fn(async () => ({
    json: async () => ({ course: 35464, assignments: { "perf-graphs": 1387111, study: 1 } }),
  }));
  return areas;
}

async function freshWorker() {
  vi.resetModules();
  return import("../src/platform/canvas-outbox-worker.js");
}

const send = (route, message, sender = {}) =>
  new Promise((resolve) => route(message, sender, resolve));

const pendingDoc = (id, queuedAt, extra = {}) => ({
  assignmentId: id,
  type: "performance",
  pendingSubmission: {
    type: "performance",
    assignmentId: id,
    data: { date: "2026-09-15", workedWith: "jack684", howLong: "12 min", attemptNum: 1 },
    submissionType: "online_text_entry",
    queuedAt,
  },
  ...extra,
});

beforeEach(() => {
  for (const k of Object.keys(docs)) delete docs[k];
  patches.length = 0;
  installChrome();
});

describe("canvasOutbox:list", () => {
  it("hands out rendered, ready-to-POST submissions", async () => {
    docs["perf-graphs"] = pendingDoc("perf-graphs", 1000);
    const { routeOutboxMessage } = await freshWorker();
    const { items } = await send(routeOutboxMessage, { type: "canvasOutbox:list" });
    expect(items).toHaveLength(1);
    expect(items[0].canvasAssignmentId).toBe(1387111);
    expect(items[0].courseId).toBe(35464);
    const body = new Map(items[0].fields).get("submission[body]");
    expect(body).toContain("12 min");
  });

  // Two Canvas tabs open at once must not both submit the same thing.
  it("gives an item to only one tab while it's in flight", async () => {
    docs["perf-graphs"] = pendingDoc("perf-graphs", 1000);
    const { routeOutboxMessage } = await freshWorker();
    const first = await send(routeOutboxMessage, { type: "canvasOutbox:list" });
    const second = await send(routeOutboxMessage, { type: "canvasOutbox:list" });
    expect(first.items).toHaveLength(1);
    expect(second.items).toHaveLength(0);
  });

  it("releases an item after a failed send so it can be retried", async () => {
    docs["perf-graphs"] = pendingDoc("perf-graphs", 1000);
    const { routeOutboxMessage } = await freshWorker();
    await send(routeOutboxMessage, { type: "canvasOutbox:list" });
    await send(routeOutboxMessage, {
      type: "canvasOutbox:result", assignmentId: "perf-graphs", queuedAt: 1000,
      ok: false, status: 403, error: "nope",
    });
    const again = await send(routeOutboxMessage, { type: "canvasOutbox:list" });
    expect(again.items).toHaveLength(1);
    expect(patches).toHaveLength(0); // a failure records nothing
  });

  it("skips an assignment with no Canvas id instead of retrying it forever", async () => {
    docs.orphan = pendingDoc("orphan", 1000);
    const { routeOutboxMessage } = await freshWorker();
    const { items } = await send(routeOutboxMessage, { type: "canvasOutbox:list" });
    expect(items).toEqual([]);
  });

  it("returns nothing before the student has onboarded", async () => {
    globalThis.chrome.storage.sync.get = vi.fn(async () => ({}));
    docs["perf-graphs"] = pendingDoc("perf-graphs", 1000);
    const { routeOutboxMessage } = await freshWorker();
    expect((await send(routeOutboxMessage, { type: "canvasOutbox:list" })).items).toEqual([]);
  });
});

describe("canvasOutbox:result", () => {
  it("records the send so the item leaves the queue", async () => {
    docs["perf-graphs"] = pendingDoc("perf-graphs", 1000);
    const { routeOutboxMessage } = await freshWorker();
    await send(routeOutboxMessage, {
      type: "canvasOutbox:result", assignmentId: "perf-graphs", queuedAt: 1000,
      ok: true, status: 201, submissionId: 555,
    });
    const { fields } = patches[0];
    expect(fields.canvasSubmittedAt).toBeGreaterThanOrEqual(1000);
    expect(fields.canvasSubmissionId).toBe(555);
    // Only these fields — the signoff state and type are left untouched.
    expect(Object.keys(fields).sort()).toEqual(
      ["canvasSubmissionId", "canvasSubmitCount", "canvasSubmittedAt"],
    );
    const after = await send(routeOutboxMessage, { type: "canvasOutbox:list" });
    expect(after.items).toEqual([]);
  });

  it("counts attempts Canvas actually accepted", async () => {
    docs["perf-graphs"] = pendingDoc("perf-graphs", 9000, {
      canvasSubmittedAt: 500, canvasSubmitCount: 2,
    });
    const { routeOutboxMessage } = await freshWorker();
    await send(routeOutboxMessage, {
      type: "canvasOutbox:result", assignmentId: "perf-graphs", queuedAt: 9000, ok: true, status: 201,
    });
    expect(patches[0].fields.canvasSubmitCount).toBe(3);
  });
});

describe("drain tabs", () => {
  it("opens a background Canvas tab only when something is pending", async () => {
    const { routeOutboxMessage } = await freshWorker();
    expect((await send(routeOutboxMessage, { type: "canvasOutbox:drain" })).opened).toBe(false);
    expect(chrome.tabs.create).not.toHaveBeenCalled();

    docs["perf-graphs"] = pendingDoc("perf-graphs", 1000);
    const res = await send(routeOutboxMessage, { type: "canvasOutbox:drain" });
    expect(res.opened).toBe(true);
    expect(chrome.tabs.create).toHaveBeenCalledWith(expect.objectContaining({ active: false }));
  });

  it("closes the tab it opened once the drain is done", async () => {
    docs["perf-graphs"] = pendingDoc("perf-graphs", 1000);
    const { routeOutboxMessage } = await freshWorker();
    await send(routeOutboxMessage, { type: "canvasOutbox:drain" });
    await send(routeOutboxMessage, { type: "canvasOutbox:done" }, { tab: { id: 77 } });
    expect(chrome.tabs.remove).toHaveBeenCalledWith(77);
  });

  // The student's own Canvas tab must never be closed out from under them.
  it("never closes a Canvas tab it didn't open", async () => {
    const { routeOutboxMessage } = await freshWorker();
    await send(routeOutboxMessage, { type: "canvasOutbox:done" }, { tab: { id: 12 } });
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
  });

  // Signed out: leave it open and bring it forward, rather than a tab that
  // silently vanishes.
  it("raises its tab for sign-in instead of closing it", async () => {
    docs["perf-graphs"] = pendingDoc("perf-graphs", 1000);
    const { routeOutboxMessage } = await freshWorker();
    await send(routeOutboxMessage, { type: "canvasOutbox:drain" });
    await send(routeOutboxMessage, { type: "canvasOutbox:notSignedIn" }, { tab: { id: 77 } });
    expect(chrome.tabs.update).toHaveBeenCalledWith(77, { active: true });
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
  });
});

// A token whose payload carries the given role, as auth.js decodes it.
const tokenWithRole = (role) =>
  `h.${Buffer.from(JSON.stringify({ role })).toString("base64url")}.s`;

describe("a TA's own browser", () => {
  // Canvas refuses submissions from teaching roles, so anything queued on a
  // TA's record can never send. Handing it out would retry — and fail — on
  // every Canvas page the TA opens.
  it("hands out nothing, even with items queued on its record", async () => {
    docs["perf-data-structures"] = pendingDoc("perf-data-structures", 1000);
    const areas = installChrome();
    areas.local.firebaseAuth = { idToken: tokenWithRole("ta") };
    const { routeOutboxMessage } = await freshWorker();
    expect((await send(routeOutboxMessage, { type: "canvasOutbox:list" })).items).toEqual([]);
  });

  it("does not open a drain tab for a TA", async () => {
    docs["perf-data-structures"] = pendingDoc("perf-data-structures", 1000);
    const areas = installChrome();
    areas.local.firebaseAuth = { idToken: tokenWithRole("ta") };
    const { routeOutboxMessage } = await freshWorker();
    expect((await send(routeOutboxMessage, { type: "canvasOutbox:drain" })).opened).toBe(false);
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });

  it("still sends for a student", async () => {
    docs["perf-graphs"] = pendingDoc("perf-graphs", 1000);
    const areas = installChrome();
    areas.local.firebaseAuth = { idToken: tokenWithRole(undefined) };
    const { routeOutboxMessage } = await freshWorker();
    expect((await send(routeOutboxMessage, { type: "canvasOutbox:list" })).items).toHaveLength(1);
  });
});

it("ignores messages that aren't its own", async () => {
  const { routeOutboxMessage } = await freshWorker();
  expect(routeOutboxMessage({ type: "pushMyRecentGrade" }, {}, () => {})).toBe(false);
});

// The content script's promises, checked against its source. Its privacy
// claim is that it never reads the page and does nothing unless something
// is queued; those are exactly the properties a later edit could erode.
describe("canvas-submitter content script", () => {
  const src = readFileSync(
    join(import.meta.dirname, "..", "src", "content", "canvas-submitter.js"),
    "utf8",
  );
  const code = src
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");

  it("never reads the page", () => {
    expect(code).not.toMatch(
      /querySelector|getElementById|getElementsBy|innerHTML|innerText|textContent|outerHTML|document\.body|document\.title/,
    );
  });

  it("stops before doing anything when nothing is queued", () => {
    const stop = code.indexOf("if (items.length === 0) return;");
    expect(stop).toBeGreaterThan(-1);
    expect(stop).toBeLessThan(code.indexOf("readCsrfToken()"));
    expect(stop).toBeLessThan(code.indexOf("fetch("));
  });

  it("only talks to Canvas's own submission endpoint", () => {
    const fetches = [...code.matchAll(/fetch\(\s*`([^`]+)`/g)].map((m) => m[1]);
    expect(fetches).toEqual([
      "/api/v1/courses/${item.courseId}/assignments/${item.canvasAssignmentId}/submissions",
    ]);
  });

  it("sends Canvas's CSRF header, as its own frontend does", () => {
    expect(code).toMatch(/"X-CSRF-Token": csrf/);
  });
});
