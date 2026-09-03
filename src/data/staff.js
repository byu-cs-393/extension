// Who a student can request a signoff from.
//
// Read from Firestore, NOT from the bundled course.json. A staff list
// baked into the extension would mean a TA joining mid-semester needed a
// new release and every student re-downloading it — for a name in a
// dropdown. Here a TA logs into the TA dashboard once and appears for
// everyone on their next dashboard load.
//
// Registration is self-service: the TA dashboard writes the signed-in
// TA's own doc. Firestore rules require the `role: ta` claim, which
// verifyStudent mints only after confirming the person's Canvas
// enrolment, so a student can't add themselves.
//
// course.json's `staff` array remains a fallback for a first run against
// a project whose rules predate the collection, and so the instructor is
// present before anyone has opened the TA dashboard.
//
// Covered by tests/staff.test.js.
import { fetchCollection, patchDoc } from "../platform/firestore.js";
import { getSignoffStaff as bundledStaff } from "./course-data.js";

const CACHE_KEY = "signoffStaff";
// Long enough that it isn't refetched on every dashboard open, short
// enough that a new TA shows up the same day.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function normalise(entry) {
  if (!entry?.netID) return null;
  return {
    netID: entry.netID,
    name: entry.name || entry.netID,
    role: entry.role === "instructor" ? "instructor" : "ta",
  };
}

// Instructor first, then TAs by name — a stable order so the dropdown
// doesn't reshuffle between loads.
function ordered(people) {
  return people.sort((a, b) => {
    if (a.role !== b.role) return a.role === "instructor" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

// Merges Firestore over course.json, keyed by netID: someone listed in
// both gets the Firestore version, which is the one that can be corrected
// without a release.
function merge(bundled, live) {
  const byNetID = new Map();
  for (const entry of [...bundled, ...live]) {
    const person = normalise(entry);
    if (person) byNetID.set(person.netID, person);
  }
  return ordered([...byNetID.values()]);
}

export async function getSignoffStaff({ force = false } = {}) {
  const cached = await readCache();
  if (!force && cached) return cached;

  const bundled = await bundledStaff().catch(() => []);
  let live = [];
  try {
    live = await fetchCollection("staff");
  } catch (error) {
    // Rules not deployed yet, or offline. The bundled list still works,
    // and an empty result degrades to "any TA" rather than blocking a
    // student from requesting a signoff at all.
    console.warn("[CS 393 Buddy] couldn't read the staff list:", error);
  }

  const staff = merge(bundled, live);
  await writeCache(staff);
  return staff;
}

async function readCache() {
  try {
    const { [CACHE_KEY]: entry } = await chrome.storage.local.get(CACHE_KEY);
    if (!entry || !Array.isArray(entry.staff)) return null;
    if (Date.now() - (entry.syncedAt ?? 0) > CACHE_TTL_MS) return null;
    return entry.staff;
  } catch (_error) {
    return null;
  }
}

async function writeCache(staff) {
  try {
    await chrome.storage.local.set({
      [CACHE_KEY]: { staff, syncedAt: Date.now() },
    });
  } catch (_error) {
    // Caching is an optimisation; a failure just means the next load
    // fetches again.
  }
}

// Called by the TA dashboard on load. Idempotent — it rewrites the same
// doc every time, which also keeps a changed display name current.
export async function registerAsStaff({ netID, name, role = "ta" }) {
  if (!netID) return;
  await patchDoc(`staff/${netID}`, {
    netID,
    name: name || netID,
    role,
    lastSeenAt: Date.now(),
  });
}
