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

  // Monaco can take a moment to appear (LeetCode lazy-loads it). Poll
  // until we find it, then hook. Cap the polling so we don't loop
  // forever on non-editor pages (some LeetCode paths reuse the SPA
  // shell without an editor — e.g., the problem list).
  const POLL_INTERVAL_MS = 250;
  const POLL_TIMEOUT_MS = 30_000;
  const hookedEditors = new WeakSet();

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

  function hookEditor(editor) {
    if (hookedEditors.has(editor)) return;
    hookedEditors.add(editor);
    const editorId = editorIdFor(editor);

    // We ignore change events with `isFlush` — Monaco fires those when
    // the whole buffer is reset (e.g., switching problems). Those
    // aren't user edits, they're state transitions; recording them
    // would create huge "insert the entire starter code" deltas.
    editor.onDidChangeModelContent((event) => {
      if (event.isFlush) return;
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

    // Emit a snapshot of the buffer at hook time so the replay has a
    // baseline. Without this, the first deltas would apply against an
    // empty string, missing the LeetCode-provided starter code.
    //
    // `language` and `lineCount` ride along so the read side can tell
    // the solution buffer from the testcase pane without guessing here —
    // a heuristic baked in at capture time couldn't be revised later
    // without re-recording.
    try {
      const model = editor.getModel();
      if (model) {
        post({
          type: "snapshot",
          t: performance.now(),
          editorId,
          text: model.getValue(),
          language: model.getLanguageId?.() ?? null,
          lineCount: model.getLineCount?.() ?? null,
        });
      }
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
