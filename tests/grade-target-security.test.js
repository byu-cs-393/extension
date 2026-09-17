// Whose Canvas record a grade lands on must come from Canvas, never from a
// document the student can write.
//
// Firestore rules let a student write `canvasUserId` on their own student
// doc. Three server paths used that field to choose the target of a grade
// write — the nightly batch, pushMyRecentGrade, and submitCanvasAssignment.
// A student could set it to a classmate's id and have their own grade
// written onto the classmate's record, through manage_grades, a permission
// the course token genuinely holds. No sign it was ever exploited; it was
// found while designing the TA grading path, which would have inherited it.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(
  join(import.meta.dirname, "..", "functions", "index.js"),
  "utf8",
);

function loadHelpers() {
  const decls = SOURCE.slice(0, SOURCE.indexOf("exports."));
  const fn = new Function(
    "require", "console", "fetch", "module",
    `${decls}\n return { fetchRosterIdMap, findEnrolledUser };`,
  );
  return fn(
    (id) => (id.endsWith(".json") ? {} : new Proxy({}, { get: () => () => {} })),
    console,
    (...a) => globalThis.fetch(...a),
    { exports: {} },
  );
}

const { fetchRosterIdMap } = loadHelpers();

const page = (users, link) => ({
  ok: true,
  status: 200,
  json: async () => users,
  headers: { get: (h) => (h.toLowerCase() === "link" ? link ?? null : null) },
});

beforeEach(() => vi.restoreAllMocks());

describe("fetchRosterIdMap", () => {
  it("maps netIDs to Canvas ids across every page", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        page([{ id: 1, login_id: "alice1" }], '<https://x/p2>; rel="next"'),
      )
      .mockResolvedValueOnce(page([{ id: 2, login_id: "BOB2" }]));
    const ids = await fetchRosterIdMap(35464, "tok");
    expect(ids.get("alice1")).toBe(1);
    expect(ids.get("bob2")).toBe(2); // case-folded
  });

  it("skips entries without a login or a numeric id", async () => {
    globalThis.fetch = vi.fn(async () =>
      page([{ id: 3 }, { login_id: "noid" }, { id: 4, login_id: "carol" }]),
    );
    const ids = await fetchRosterIdMap(35464, "tok");
    expect([...ids.keys()]).toEqual(["carol"]);
  });

  it("throws on a Canvas error rather than returning a partial map", async () => {
    // A partial map would silently skip students whose page failed.
    globalThis.fetch = vi.fn(async () => ({
      ok: false, status: 503, text: async () => "down", headers: { get: () => null },
    }));
    await expect(fetchRosterIdMap(35464, "tok")).rejects.toThrow(/503/);
  });
});

// The invariant itself, checked against the source. Brittle on purpose:
// reintroducing this pattern should fail the build, not pass review.
describe("no server path trusts a student-writable canvasUserId", () => {
  it("never reads canvasUserId off a Firestore student document", () => {
    const offenders = SOURCE.split("\n")
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => !line.trim().startsWith("//"))
      .filter(({ line }) =>
        /(student|studentSnap\.data\(\)|studentDoc\.data\(\))\??\.canvasUserId/.test(line),
      );
    expect(offenders.map((o) => `${o.n}: ${o.line.trim()}`)).toEqual([]);
  });
});
