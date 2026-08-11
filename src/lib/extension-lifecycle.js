// Detecting that this content script has been orphaned.
//
// Reloading or updating the extension cuts every already-injected content
// script off from it: chrome.* handles start throwing "Extension context
// invalidated" and nothing can be written from that page again. Chrome
// auto-updates extensions, so this happens to real students mid-problem,
// not just to us reloading during development.
//
// It has to be handled rather than swallowed. The keystroke tracker used
// to re-queue the failed write and try again forever, growing its buffer
// behind a badge that still claimed to be recording — a student could
// work for an hour on that promise and lose all of it.
//
// Covered by tests/extension-lifecycle.test.js.

// chrome.runtime.id disappears once the context dies, which catches the
// case before a write is even attempted.
export function extensionContextAlive() {
  try {
    return Boolean(globalThis.chrome?.runtime?.id);
  } catch (_error) {
    return false;
  }
}

// And this catches it on the way back out of a call that was already in
// flight when the extension went away.
export function isContextInvalidatedError(error) {
  return /extension context invalidated|message port closed/i.test(
    String(error?.message ?? error),
  );
}

// Wires the two together with a one-shot shutdown callback.
//
// Returns { alive, failed, invalidated } — call `alive()` before writing,
// `failed(error)` in a catch (it reports whether the error was terminal),
// and `onInvalidated` fires exactly once however it's detected.
export function createLifecycleGuard(onInvalidated) {
  let invalidated = false;

  function trip() {
    if (invalidated) return true;
    invalidated = true;
    onInvalidated?.();
    return true;
  }

  return {
    invalidated: () => invalidated,
    alive() {
      if (invalidated) return false;
      if (!extensionContextAlive()) {
        trip();
        return false;
      }
      return true;
    },
    failed(error) {
      if (!isContextInvalidatedError(error)) return false;
      return trip();
    },
  };
}
