// Resolving a netID against the course roster.
//
// The bug this replaces was invisible in testing because it worked
// perfectly for the one person who tested it — a TA can resolve their
// own netID via Canvas's SIS lookup and nobody else's. So these tests
// care most about the cases a TA's own successful sign-in would never
// exercise: somebody else, somebody absent, and page two.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// index.js pulls in firebase-admin at import time, so reach the helpers
// by evaluating the module's source with a stub require instead.
function loadHelpers() {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(
    path.join(import.meta.dirname, "..", "functions", "index.js"),
    "utf8",
  );
  // Everything above the first exports.* is declarations only.
  const decls = src.slice(0, src.indexOf("exports."));
  const sandbox = {
    require: (id) => (id.endsWith(".json") ? {} : new Proxy({}, { get: () => () => {} })),
    console,
    fetch: (...args) => globalThis.fetch(...args),
    module: { exports: {} },
  };
  const fn = new Function(
    ...Object.keys(sandbox),
    `${decls}\n return { findEnrolledUser, nextPageUrl };`,
  );
  return fn(...Object.values(sandbox));
}

const { findEnrolledUser, nextPageUrl } = loadHelpers();

const user = (id, login) => ({ id, login_id: login, name: `User ${id}` });

// Minimal Response stand-in with a Link header.
const page = (users, link) => ({
  ok: true,
  status: 200,
  json: async () => users,
  headers: { get: (h) => (h.toLowerCase() === "link" ? link ?? null : null) },
});

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("nextPageUrl", () => {
  it("finds the next link among several", () => {
    const header =
      '<https://x/api?page=1>; rel="current",' +
      '<https://x/api?page=2>; rel="next",' +
      '<https://x/api?page=9>; rel="last"';
    expect(nextPageUrl(header)).toBe("https://x/api?page=2");
  });

  it("returns null on the last page", () => {
    expect(nextPageUrl('<https://x/api?page=9>; rel="last"')).toBe(null);
    expect(nextPageUrl(null)).toBe(null);
    expect(nextPageUrl("")).toBe(null);
  });
});

describe("findEnrolledUser", () => {
  it("finds a student on the roster", async () => {
    globalThis.fetch = vi.fn(async () => page([user(1, "alice1"), user(2, "bob2")]));
    const hit = await findEnrolledUser("bob2", 35464, "tok");
    expect(hit.id).toBe(2);
  });

  it("returns null for someone not enrolled", async () => {
    globalThis.fetch = vi.fn(async () => page([user(1, "alice1")]));
    expect(await findEnrolledUser("stranger", 35464, "tok")).toBe(null);
  });

  // Canvas caps a page at 100. Not following the Link header would tell
  // student 101 they aren't in the course.
  it("follows pagination to later pages", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(page([user(1, "alice1")], '<https://x/page2>; rel="next"'))
      .mockResolvedValueOnce(page([user(2, "bob2")]));
    const hit = await findEnrolledUser("bob2", 35464, "tok");
    expect(hit.id).toBe(2);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("stops once it finds a match rather than reading every page", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(page([user(1, "alice1")], '<https://x/page2>; rel="next"'))
      .mockResolvedValueOnce(page([user(2, "bob2")]));
    await findEnrolledUser("alice1", 35464, "tok");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("matches netIDs case-insensitively", async () => {
    globalThis.fetch = vi.fn(async () => page([user(7, "Jack684")]));
    expect((await findEnrolledUser("jack684", 35464, "tok")).id).toBe(7);
  });

  it("asks for staff as well as students", async () => {
    globalThis.fetch = vi.fn(async () => page([]));
    await findEnrolledUser("someone", 35464, "tok");
    const url = globalThis.fetch.mock.calls[0][0];
    // A TA onboards through this same path; students-only would lock
    // every staff member out of their own extension.
    expect(url).toContain("enrollment_type[]=student");
    expect(url).toContain("enrollment_type[]=ta");
    expect(url).toContain("enrollment_type[]=teacher");
  });

  it("throws rather than reporting 'not enrolled' when Canvas errors", async () => {
    // A permissions or outage failure must not masquerade as a missing
    // student — that conflation is the whole bug.
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 403,
      text: async () => "forbidden",
      headers: { get: () => null },
    }));
    await expect(findEnrolledUser("bob2", 35464, "tok")).rejects.toThrow(/403/);
  });

  it("survives a roster entry with no login_id", async () => {
    globalThis.fetch = vi.fn(async () => page([{ id: 3, name: "No Login" }, user(4, "carol")]));
    expect((await findEnrolledUser("carol", 35464, "tok")).id).toBe(4);
  });
});
