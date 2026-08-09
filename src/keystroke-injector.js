// Page-context script. Injected by keystroke-tracker.js as a <script>
// tag so it runs in the LeetCode page's own JavaScript world, where
// `window.monaco` is reachable. Content scripts run in an isolated
// world and CAN'T see page globals like monaco, which is why this
// bridge exists.
//
// Communication with the content script is via window.postMessage.
// We tag every message with source: "cs393-keystroke" so the content
// script can filter out unrelated postMessage traffic on the page.

(() => {
  const SOURCE = "cs393-keystroke";
  // Commands travel content script → page. Tagged separately from SOURCE
  // so the injector's own postMessages don't feed back into its listener.
  const CMD_SOURCE = "cs393-keystroke-cmd";

  // keystroke-tracker.js re-injects this file on every SPA navigation.
  // Hooking an editor twice would post every keystroke twice — and four
  // times after two more navigations — so the first instance stays
  // resident and later injections bail out immediately. It keeps polling,
  // so editors mounted later are still picked up.
  if (window.__cs393KeystrokeInjector) {
    window.postMessage(
      { source: SOURCE, type: "injector-already-loaded", t: performance.now() },
      "*",
    );
    return;
  }
  window.__cs393KeystrokeInjector = true;

  // Monaco can take a moment to appear (LeetCode lazy-loads it). Poll
  // until we find it, then hook. Cap the polling so we don't loop
  // forever on non-editor pages (some LeetCode paths reuse the SPA
  // shell without an editor — e.g., the problem list).
  const POLL_INTERVAL_MS = 250;
  const POLL_TIMEOUT_MS = 30_000;
  // A Set, not a WeakSet, because snapshots have to be re-emitted for
  // every hooked editor when a new session opens. A page holds a handful
  // of editors, so retaining them is not a meaningful leak.
  const hookedEditors = new Set();

  function post(payload) {
    window.postMessage({ source: SOURCE, ...payload }, "*");
  }

  // LeetCode mounts MORE THAN ONE Monaco editor — the solution buffer
  // plus at least the custom-testcase pane. Every delta carries the id of
  // the editor it came from, because `offset` is relative to that
  // editor's own document: merging two streams into one list produces
  // offsets that mean nothing, and the corruption looks plausible rather
  // than obviously broken.
  //
  // Ids only need to be consistent within a session. Monaco's own
  // getId() is used when available; otherwise a mount-order counter.
  const editorIds = new WeakMap();
  let nextEditorId = 1;

  function editorIdFor(editor) {
    if (!editorIds.has(editor)) {
      let id = null;
      try {
        id = editor.getId?.() ?? null;
      } catch (_error) {
        id = null;
      }
      editorIds.set(editor, id ? `m${id}` : `e${nextEditorId}`);
      nextEditorId += 1;
    }
    return editorIds.get(editor);
  }

  function snapshotOf(editor) {
    const model = editor.getModel();
    if (!model) return null;
    return {
      type: "snapshot",
      t: performance.now(),
      editorId: editorIdFor(editor),
      text: model.getValue(),
      language: model.getLanguageId?.() ?? null,
      lineCount: model.getLineCount?.() ?? null,
    };
  }

  // Re-emits a baseline for every hooked editor. The tracker asks for
  // this when it opens a session, which matters on SPA navigation:
  // LeetCode swaps the model on the SAME editor instance, so there's no
  // new hook to trigger a snapshot and the next session would otherwise
  // start with no idea what the starter code was.
  function emitSnapshots() {
    for (const editor of hookedEditors) {
      try {
        const snapshot = snapshotOf(editor);
        if (snapshot) post(snapshot);
      } catch (_error) {
        // Editor disposed between navigation and here — skip it.
      }
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data?.source !== CMD_SOURCE) return;
    if (event.data.type === "request-snapshot") emitSnapshots();
  });

  function hookEditor(editor) {
    if (hookedEditors.has(editor)) return;
    hookedEditors.add(editor);
    const editorId = editorIdFor(editor);

    // `isFlush` means the whole buffer was replaced rather than edited:
    // the student pressed "Reset to default code", or LeetCode loaded a
    // different problem's starter code into this same model.
    //
    // Recording it as a delta would be wrong — it isn't a user edit, and
    // it would show up as one enormous insert. But DROPPING it is also
    // wrong, which is what used to happen: the document silently became
    // something else while the replay went on applying edits to the old
    // text, so everything after the reset was offset garbage. Re-emit a
    // snapshot instead, which the read side treats as a new baseline.
    editor.onDidChangeModelContent((event) => {
      if (event.isFlush) {
        try {
          const snapshot = snapshotOf(editor);
          if (snapshot) post(snapshot);
        } catch (_error) {
          // Non-fatal — the replay just re-bases on the next snapshot.
        }
        return;
      }
      for (const change of event.changes) {
        post({
          type: "delta",
          t: performance.now(),
          editorId,
          offset: change.rangeOffset,
          length: change.rangeLength,
          text: change.text,
        });
      }
    });

    // Monaco swaps the MODEL (rather than its contents) when LeetCode
    // moves to a different problem. That's the moment the new starter
    // code actually exists — the URL changed up to a second earlier, so
    // a snapshot taken at navigation time still holds the previous
    // problem's code, which is exactly how a replay ends up opening on
    // the wrong problem.
    if (typeof editor.onDidChangeModel === "function") {
      editor.onDidChangeModel(() => {
        try {
          const snapshot = snapshotOf(editor);
          if (snapshot) post(snapshot);
        } catch (_error) {
          // Editor disposed mid-swap — the next hook will re-baseline.
        }
      });
    }

    // Emit a snapshot of the buffer at hook time so the replay has a
    // baseline. Without this, the first deltas would apply against an
    // empty string, missing the LeetCode-provided starter code.
    //
    // `language` and `lineCount` ride along so the read side can tell
    // the solution buffer from the testcase pane without guessing here —
    // a heuristic baked in at capture time couldn't be revised later
    // without re-recording.
    try {
      const snapshot = snapshotOf(editor);
      if (snapshot) post(snapshot);
    } catch (_error) {
      // Non-fatal — replay just won't have starter code.
    }

    post({ type: "editor-hooked", t: performance.now(), editorId });
  }

  function tryHook() {
    const monaco = window.monaco;
    if (!monaco?.editor?.getEditors) return false;
    const editors = monaco.editor.getEditors();
    if (!editors.length) return false;
    for (const ed of editors) hookEditor(ed);
    return true;
  }

  const started = performance.now();
  const pollTimer = setInterval(() => {
    const found = tryHook();
    if (found) {
      // Keep polling in case additional editors mount later (LeetCode
      // sometimes rebuilds the editor on language change), but slower.
      return;
    }
    if (performance.now() - started > POLL_TIMEOUT_MS) {
      clearInterval(pollTimer);
    }
  }, POLL_INTERVAL_MS);

  // Also re-check on Monaco's onDidCreateEditor if available — catches
  // editors mounted after our initial poll.
  const readyPollTimer = setInterval(() => {
    if (window.monaco?.editor?.onDidCreateEditor) {
      clearInterval(readyPollTimer);
      window.monaco.editor.onDidCreateEditor((editor) => hookEditor(editor));
    }
  }, POLL_INTERVAL_MS);

  post({ type: "injector-loaded", t: performance.now() });
})();
