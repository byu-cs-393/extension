// Unit tests for src/lib/extension-lifecycle.js.
//
// The behaviour under test is what a content script does when the
// extension is reloaded out from under it. Getting this wrong is not
// cosmetic: the keystroke tracker used to retry forever behind a badge
// that still said "recording", so a student could work for an hour and
// lose all of it.
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  extensionContextAlive,
  isContextInvalidatedError,
  createLifecycleGuard,
} from "../src/lib/extension-lifecycle.js";

afterEach(() => {
  delete globalThis.chrome;
});

describe("extensionContextAlive", () => {
  it("is true while chrome.runtime.id exists", () => {
    globalThis.chrome = { runtime: { id: "abc123" } };
    expect(extensionContextAlive()).toBe(true);
  });

  it("is false once the id is gone", () => {
    globalThis.chrome = { runtime: {} };
    expect(extensionContextAlive()).toBe(false);
  });

  it("is false with no chrome at all", () => {
    expect(extensionContextAlive()).toBe(false);
  });

  it("is false when touching chrome.runtime throws", () => {
    // Chrome can make the accessor itself throw on an orphaned script.
    globalThis.chrome = {
      get runtime() {
        throw new Error("Extension context invalidated.");
      },
    };
    expect(extensionContextAlive()).toBe(false);
  });
});

describe("isContextInvalidatedError", () => {
  it("recognises Chrome's wording", () => {
    expect(isContextInvalidatedError(new Error("Extension context invalidated."))).toBe(true);
    expect(isContextInvalidatedError(new Error("The message port closed before a response"))).toBe(true);
  });

  it("is case-insensitive and accepts a bare string", () => {
    expect(isContextInvalidatedError("EXTENSION CONTEXT INVALIDATED")).toBe(true);
  });

  it("leaves ordinary failures alone", () => {
    // A 503 must stay retryable — treating it as terminal would stop
    // recording for the rest of the tab's life over a blip.
    expect(isContextInvalidatedError(new Error("Firestore PATCH 503"))).toBe(false);
    expect(isContextInvalidatedError(new Error("no Firebase ID token cached"))).toBe(false);
    expect(isContextInvalidatedError(null)).toBe(false);
  });
});

describe("createLifecycleGuard", () => {
  it("reports alive while the context is healthy", () => {
    globalThis.chrome = { runtime: { id: "abc" } };
    const onInvalidated = vi.fn();
    const guard = createLifecycleGuard(onInvalidated);

    expect(guard.alive()).toBe(true);
    expect(guard.invalidated()).toBe(false);
    expect(onInvalidated).not.toHaveBeenCalled();
  });

  it("trips on a dead context and shuts down once", () => {
    globalThis.chrome = { runtime: {} };
    const onInvalidated = vi.fn();
    const guard = createLifecycleGuard(onInvalidated);

    expect(guard.alive()).toBe(false);
    expect(guard.alive()).toBe(false);
    expect(guard.invalidated()).toBe(true);
    // Once, not once per failed write.
    expect(onInvalidated).toHaveBeenCalledTimes(1);
  });

  it("trips on a terminal error surfaced from a call already in flight", () => {
    globalThis.chrome = { runtime: { id: "abc" } };
    const onInvalidated = vi.fn();
    const guard = createLifecycleGuard(onInvalidated);

    expect(guard.failed(new Error("Extension context invalidated."))).toBe(true);
    expect(guard.invalidated()).toBe(true);
    expect(onInvalidated).toHaveBeenCalledTimes(1);
  });

  it("does not trip on a transient error", () => {
    globalThis.chrome = { runtime: { id: "abc" } };
    const onInvalidated = vi.fn();
    const guard = createLifecycleGuard(onInvalidated);

    expect(guard.failed(new Error("Firestore PATCH 503"))).toBe(false);
    expect(guard.invalidated()).toBe(false);
    expect(guard.alive()).toBe(true);
    expect(onInvalidated).not.toHaveBeenCalled();
  });

  it("stays dead once tripped, even if chrome comes back", () => {
    globalThis.chrome = { runtime: {} };
    const guard = createLifecycleGuard(() => {});
    expect(guard.alive()).toBe(false);

    globalThis.chrome = { runtime: { id: "back" } };
    // This tab's script is still orphaned; a live chrome elsewhere
    // doesn't reconnect it. Only a page reload does.
    expect(guard.alive()).toBe(false);
    expect(guard.invalidated()).toBe(true);
  });

  it("works without a callback", () => {
    globalThis.chrome = { runtime: {} };
    const guard = createLifecycleGuard();
    expect(() => guard.alive()).not.toThrow();
    expect(guard.invalidated()).toBe(true);
  });
});
