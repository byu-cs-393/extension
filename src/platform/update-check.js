// Telling a student there's a newer release than the one they're running.
//
// Chrome never updates an unpacked extension on its own (it only updates
// what it installed from the Web Store), and an extension can't rewrite
// its own folder. So until there's a store listing, updating stays a
// manual download. What this removes is having to hear about it: the
// background worker asks GitHub for the latest release, and if it's newer
// the toolbar icon says so and the popup links straight to the zip.
//
// No new permission: api.github.com answers cross-origin requests from
// anywhere, so the service worker can fetch it without a host permission.
//
// Unauthenticated GitHub API calls are limited to 60 an hour per IP, and a
// lecture hall shares a handful of IPs. Checking every few hours stays well
// under that; a check that gets rate-limited, or fails for any other
// reason, changes nothing and the next one tries again.
//
// Covered by tests/update-check.test.js.

const LATEST_RELEASE_API =
  "https://api.github.com/repos/byu-cs-393/extension/releases/latest";

export const RELEASES_PAGE_URL =
  "https://github.com/byu-cs-393/extension/releases/latest";

// chrome.storage.local: { version, releaseUrl, zipUrl, checkedAt }, or
// absent when this copy is current.
export const UPDATE_KEY = "updateAvailable";

// "v1.0.9" -> [1, 0, 9]. Chrome versions are up to four dot-separated
// integers; release tags put a "v" in front.
export function parseVersion(value) {
  const match = /(\d+(?:\.\d+){0,3})/.exec(String(value ?? ""));
  return match ? match[1].split(".").map(Number) : null;
}

// Compared number by number, so 1.0.10 is newer than 1.0.9. As strings
// it wouldn't be.
export function isNewerVersion(candidate, current) {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

// The bits of a GitHub release the popup needs. Null if it isn't one.
export function readRelease(release) {
  const version = parseVersion(release?.tag_name)?.join(".");
  if (!version) return null;
  const zip = (release.assets ?? []).find((asset) =>
    String(asset?.name ?? "").endsWith(".zip"),
  );
  return {
    version,
    releaseUrl: release.html_url ?? RELEASES_PAGE_URL,
    zipUrl: zip?.browser_download_url ?? null,
  };
}

function runningVersion() {
  return chrome.runtime.getManifest().version;
}

async function showBadge(update) {
  const name = chrome.runtime.getManifest().action?.default_title ?? "CS 393 Buddy";
  if (update) {
    await chrome.action.setBadgeBackgroundColor({ color: "#2563eb" });
    await chrome.action.setBadgeText({ text: "NEW" });
    await chrome.action.setTitle({ title: `${name}: version ${update.version} is available` });
  } else {
    await chrome.action.setBadgeText({ text: "" });
    await chrome.action.setTitle({ title: name });
  }
}

// What the popup reads. Null unless a newer version is on record, which
// also covers a student who has just installed the version it was about.
export async function getAvailableUpdate() {
  const { [UPDATE_KEY]: update } = await chrome.storage.local.get(UPDATE_KEY);
  if (!update || !isNewerVersion(update.version, runningVersion())) return null;
  return update;
}

// The badge doesn't survive a browser restart, and the check that would
// set it again can fail (offline, rate-limited). Re-show what's on record
// first so it doesn't flicker off; forget it if it's now out of date.
export async function showStoredUpdate() {
  const update = await getAvailableUpdate();
  if (!update) await chrome.storage.local.remove(UPDATE_KEY);
  await showBadge(update);
  return update;
}

// Asks GitHub for the latest release and records whether it's newer than
// this copy. Returns the update, null if current, or undefined if the
// check couldn't be made, in which case whatever was known before stands.
//
// No status check: a rate limit or a 404 comes back as JSON with no
// tag_name, which readRelease rejects, and a captive-portal page isn't
// JSON at all.
export async function checkForUpdate({ fetchImpl = fetch, now = Date.now } = {}) {
  let release;
  try {
    const response = await fetchImpl(LATEST_RELEASE_API, {
      headers: { Accept: "application/vnd.github+json" },
    });
    release = readRelease(await response.json());
  } catch (error) {
    console.warn("[CS 393 Buddy] update check failed:", error);
    return undefined;
  }
  if (!release) return undefined;

  if (!isNewerVersion(release.version, runningVersion())) {
    await chrome.storage.local.remove(UPDATE_KEY);
    await showBadge(null);
    return null;
  }
  const update = { ...release, checkedAt: now() };
  await chrome.storage.local.set({ [UPDATE_KEY]: update });
  await showBadge(update);
  return update;
}
