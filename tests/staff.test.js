// Unit tests for src/data/staff.js — the list a student picks from when
// requesting a signoff.
//
// The behaviour that matters: a TA who joins mid-semester should appear
// without an extension release. That means reading Firestore, with the
// bundled course.json list as a fallback rather than the source.
import { describe, it, expect, beforeEach, vi } from "vitest";

const fetchCollection = vi.fn();
const patchDoc = vi.fn();
const bundled = vi.fn();

vi.mock("../src/platform/firestore.js", () => ({ fetchCollection, patchDoc }));
vi.mock("../src/data/course-data.js", () => ({ getSignoffStaff: bundled }));

const { getSignoffStaff, registerAsStaff } = await import("../src/data/staff.js");

const store = {};
beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
  fetchCollection.mockReset();
  patchDoc.mockReset();
  bundled.mockReset().mockResolvedValue([]);
  globalThis.chrome = {
    storage: {
      local: {
        get: vi.fn(async (key) => ({ [key]: store[key] })),
        set: vi.fn(async (obj) => Object.assign(store, obj)),
      },
    },
  };
});

const ta = (netID, name) => ({ netID, name, role: "ta" });

describe("getSignoffStaff", () => {
  it("reads the live list from Firestore", async () => {
    fetchCollection.mockResolvedValue([ta("jack684", "Jack"), ta("sam2", "Sam")]);
    const staff = await getSignoffStaff({ force: true });
    expect(fetchCollection).toHaveBeenCalledWith("staff");
    expect(staff.map((s) => s.netID)).toEqual(["jack684", "sam2"]);
  });

  it("includes a TA who only exists in Firestore", async () => {
    // The whole point: someone who joined after the last release.
    bundled.mockResolvedValue([ta("jack684", "Jack")]);
    fetchCollection.mockResolvedValue([ta("newta", "New TA")]);
    const staff = await getSignoffStaff({ force: true });
    expect(staff.map((s) => s.netID).sort()).toEqual(["jack684", "newta"]);
  });

  it("prefers Firestore over the bundled copy for the same person", async () => {
    // A corrected name should not need a release either.
    bundled.mockResolvedValue([ta("jack684", "Stale Name")]);
    fetchCollection.mockResolvedValue([ta("jack684", "Jack Leonard")]);
    const staff = await getSignoffStaff({ force: true });
    expect(staff).toHaveLength(1);
    expect(staff[0].name).toBe("Jack Leonard");
  });

  it("falls back to the bundled list when Firestore can't be read", async () => {
    // Rules not deployed, or offline. A student must still be able to
    // request a signoff.
    bundled.mockResolvedValue([ta("jack684", "Jack")]);
    fetchCollection.mockRejectedValue(new Error("permission denied"));
    const staff = await getSignoffStaff({ force: true });
    expect(staff.map((s) => s.netID)).toEqual(["jack684"]);
  });

  it("returns [] when neither source has anyone", async () => {
    // Degrades to "any TA" rather than blocking the request.
    fetchCollection.mockResolvedValue([]);
    expect(await getSignoffStaff({ force: true })).toEqual([]);
  });

  it("puts the instructor first, then TAs by name", async () => {
    fetchCollection.mockResolvedValue([
      ta("zoe", "Zoe"),
      { netID: "mtr26", name: "Michael Reynolds", role: "instructor" },
      ta("adam", "Adam"),
    ]);
    const staff = await getSignoffStaff({ force: true });
    expect(staff.map((s) => s.netID)).toEqual(["mtr26", "adam", "zoe"]);
  });

  it("drops entries with no netID and defaults a missing name", async () => {
    fetchCollection.mockResolvedValue([{ name: "Nameless" }, { netID: "solo" }]);
    const staff = await getSignoffStaff({ force: true });
    expect(staff).toEqual([{ netID: "solo", name: "solo", role: "ta" }]);
  });

  it("serves a cached list without refetching", async () => {
    fetchCollection.mockResolvedValue([ta("jack684", "Jack")]);
    await getSignoffStaff({ force: true });
    fetchCollection.mockClear();

    expect((await getSignoffStaff()).map((s) => s.netID)).toEqual(["jack684"]);
    expect(fetchCollection).not.toHaveBeenCalled();
  });

  it("refetches once the cache is stale", async () => {
    fetchCollection.mockResolvedValue([ta("jack684", "Jack")]);
    await getSignoffStaff({ force: true });
    store.signoffStaff.syncedAt = Date.now() - 7 * 60 * 60 * 1000;

    fetchCollection.mockResolvedValue([ta("jack684", "Jack"), ta("newta", "New")]);
    expect((await getSignoffStaff()).map((s) => s.netID).sort()).toEqual([
      "jack684",
      "newta",
    ]);
  });
});

describe("registerAsStaff", () => {
  it("writes the TA's own doc", async () => {
    await registerAsStaff({ netID: "jack684", name: "Jack Leonard" });
    expect(patchDoc).toHaveBeenCalledWith(
      "staff/jack684",
      expect.objectContaining({ netID: "jack684", name: "Jack Leonard", role: "ta" }),
    );
  });

  it("falls back to the netID when there's no display name", async () => {
    await registerAsStaff({ netID: "jack684" });
    expect(patchDoc.mock.calls[0][1].name).toBe("jack684");
  });

  it("does nothing without a netID", async () => {
    await registerAsStaff({});
    expect(patchDoc).not.toHaveBeenCalled();
  });
});

describe("a roster of one", () => {
  it("returns the single TA", async () => {
    // The dropdown doesn't render below two names — the card falls back
    // to sending the request to whoever is on the list.
    fetchCollection.mockResolvedValue([]);
    bundled.mockResolvedValue([ta("jack684", "Jack Leonard")]);
    const staff = await getSignoffStaff({ force: true });
    expect(staff).toEqual([{ netID: "jack684", name: "Jack Leonard", role: "ta" }]);
  });

  it("grows without a release when a second TA registers", async () => {
    // The whole reason this reads Firestore: someone joining mid-semester
    // appears from their own dashboard login.
    bundled.mockResolvedValue([ta("jack684", "Jack Leonard")]);
    fetchCollection.mockResolvedValue([ta("newta", "New TA")]);
    const staff = await getSignoffStaff({ force: true });
    expect(staff.map((s) => s.netID).sort()).toEqual(["jack684", "newta"]);
  });
});
