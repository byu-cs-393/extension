// The "a newer version is out" check. See src/platform/update-check.js.
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseVersion,
  isNewerVersion,
  readRelease,
  checkForUpdate,
  showStoredUpdate,
  getAvailableUpdate,
  UPDATE_KEY,
} from "../src/platform/update-check.js";

let local;
let badge;

function installChrome(running = "1.0.8") {
  local = {};
  badge = { text: "", title: "CS 393 Buddy" };
  globalThis.chrome = {
    runtime: {
      getManifest: () => ({ version: running, action: { default_title: "CS 393 Buddy" } }),
    },
    storage: {
      local: {
        get: vi.fn(async (key) => ({ [key]: local[key] })),
        set: vi.fn(async (obj) => Object.assign(local, obj)),
        remove: vi.fn(async (key) => delete local[key]),
      },
    },
    action: {
      setBadgeText: vi.fn(async ({ text }) => (badge.text = text)),
      setBadgeBackgroundColor: vi.fn(async () => {}),
      setTitle: vi.fn(async ({ title }) => (badge.title = title)),
    },
  };
}

// The shape api.github.com/repos/.../releases/latest returns, trimmed.
const release = (tag, extra = {}) => ({
  tag_name: tag,
  html_url: `https://github.com/byu-cs-393/extension/releases/tag/${tag}`,
  assets: [
    {
      name: `cs393-buddy-${tag.replace(/^v/, "")}.zip`,
      browser_download_url: `https://github.com/byu-cs-393/extension/releases/download/${tag}/cs393-buddy-${tag.replace(/^v/, "")}.zip`,
    },
  ],
  ...extra,
});

const respond = (body, { ok = true, status = 200 } = {}) =>
  vi.fn(async () => ({ ok, status, json: async () => body }));

beforeEach(() => installChrome());

describe("parseVersion", () => {
  it("reads a release tag", () => {
    expect(parseVersion("v1.0.9")).toEqual([1, 0, 9]);
    expect(parseVersion("1.2")).toEqual([1, 2]);
  });

  it("returns null for something that isn't a version", () => {
    expect(parseVersion("latest")).toBeNull();
    expect(parseVersion(undefined)).toBeNull();
  });
});

describe("isNewerVersion", () => {
  it("compares numerically, not as text", () => {
    // As strings "1.0.10" < "1.0.9". Getting this wrong would tell
    // everyone on 1.0.10 to "update" to 1.0.9.
    expect(isNewerVersion("1.0.10", "1.0.9")).toBe(true);
    expect(isNewerVersion("1.0.9", "1.0.10")).toBe(false);
  });

  it("is false for the same version, however it's written", () => {
    expect(isNewerVersion("v1.0.8", "1.0.8")).toBe(false);
    expect(isNewerVersion("1.1", "1.1.0")).toBe(false);
  });

  it("is false when either side is unreadable", () => {
    expect(isNewerVersion("garbage", "1.0.8")).toBe(false);
    expect(isNewerVersion("1.0.9", undefined)).toBe(false);
  });
});

describe("readRelease", () => {
  it("links the zip itself, so Download is one click", () => {
    expect(readRelease(release("v1.0.9"))).toEqual({
      version: "1.0.9",
      releaseUrl: "https://github.com/byu-cs-393/extension/releases/tag/v1.0.9",
      zipUrl:
        "https://github.com/byu-cs-393/extension/releases/download/v1.0.9/cs393-buddy-1.0.9.zip",
    });
  });

  it("falls back to the release page when no zip is attached", () => {
    // A release published before its asset finished uploading.
    expect(readRelease(release("v1.0.9", { assets: [] })).zipUrl).toBeNull();
  });

  it("rejects a response that isn't a release", () => {
    // What the API sends back when rate-limited, if it gets this far.
    expect(readRelease({ message: "API rate limit exceeded" })).toBeNull();
  });
});

describe("checkForUpdate", () => {
  it("records a newer release and badges the icon", async () => {
    const update = await checkForUpdate({ fetchImpl: respond(release("v1.0.9")), now: () => 5 });
    expect(update).toMatchObject({ version: "1.0.9", checkedAt: 5 });
    expect(local[UPDATE_KEY]).toMatchObject({ version: "1.0.9" });
    expect(badge.text).toBe("NEW");
    expect(badge.title).toContain("1.0.9");
  });

  it("clears the badge once this copy is current", async () => {
    local[UPDATE_KEY] = { version: "1.0.8" };
    badge.text = "NEW";
    const update = await checkForUpdate({ fetchImpl: respond(release("v1.0.8")) });
    expect(update).toBeNull();
    expect(local[UPDATE_KEY]).toBeUndefined();
    expect(badge.text).toBe("");
    expect(badge.title).toBe("CS 393 Buddy");
  });

  it("never offers an older release to a copy that's ahead of it", async () => {
    // The TA's own copy between bumping the version and publishing it.
    installChrome("1.0.9");
    await checkForUpdate({ fetchImpl: respond(release("v1.0.8")) });
    expect(badge.text).toBe("");
  });

  it("leaves what it knew alone when GitHub says no", async () => {
    local[UPDATE_KEY] = { version: "1.0.9" };
    const update = await checkForUpdate({
      fetchImpl: respond({ message: "API rate limit exceeded" }, { ok: false, status: 403 }),
    });
    expect(update).toBeUndefined();
    expect(local[UPDATE_KEY]).toEqual({ version: "1.0.9" });
    expect(chrome.action.setBadgeText).not.toHaveBeenCalled();
  });

  it("leaves what it knew alone behind a captive portal", async () => {
    // Campus wifi's sign-in page: 200, HTML, not a release.
    local[UPDATE_KEY] = { version: "1.0.9" };
    const portal = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token '<'");
      },
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await checkForUpdate({ fetchImpl: portal })).toBeUndefined();
    expect(local[UPDATE_KEY]).toEqual({ version: "1.0.9" });
    warn.mockRestore();
  });

  it("leaves what it knew alone when offline", async () => {
    local[UPDATE_KEY] = { version: "1.0.9" };
    const offline = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await checkForUpdate({ fetchImpl: offline })).toBeUndefined();
    expect(local[UPDATE_KEY]).toEqual({ version: "1.0.9" });
    warn.mockRestore();
  });
});

describe("showStoredUpdate", () => {
  it("puts the badge back after a restart", async () => {
    local[UPDATE_KEY] = { version: "1.0.9" };
    await showStoredUpdate();
    expect(badge.text).toBe("NEW");
  });

  it("forgets an update the student has since installed", async () => {
    // Recorded on 1.0.8; now running 1.0.9. Without this the badge
    // would ask them to install what they're already running until the
    // next successful check.
    installChrome("1.0.9");
    local[UPDATE_KEY] = { version: "1.0.9" };
    badge.text = "NEW";
    await showStoredUpdate();
    expect(local[UPDATE_KEY]).toBeUndefined();
    expect(badge.text).toBe("");
    expect(await getAvailableUpdate()).toBeNull();
  });
});
