// GENERATED FILE — DO NOT EDIT.
// Built from src/content/ by scripts/build-content-scripts.js.
// Edit the source there and run: npm run build

(() => {
  // src/content/keystroke-injector.js
  var SOURCE = "cs393-keystroke";
  var CMD_SOURCE = "cs393-keystroke-cmd";
  function alreadyResident() {
    if (!window.__cs393KeystrokeInjector) return false;
    window.postMessage(
      { source: SOURCE, type: "injector-already-loaded", t: performance.now() },
      "*"
    );
    return true;
  }
  function install() {
    window.__cs393KeystrokeInjector = true;
    const POLL_INTERVAL_MS = 250;
    const POLL_TIMEOUT_MS = 3e4;
    const hookedEditors = /* @__PURE__ */ new Set();
    function post(payload) {
      window.postMessage({ source: SOURCE, ...payload }, "*");
    }
    const editorIds = /* @__PURE__ */ new WeakMap();
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
    function snapshotOf(editor, reason) {
      const model = editor.getModel();
      if (!model) return null;
      return {
        type: "snapshot",
        t: performance.now(),
        editorId: editorIdFor(editor),
        // Why this baseline was taken. "requested" ones are the untrusted
        // kind — the content script asks for one the moment the URL
        // changes, which can be before LeetCode has swapped in the new
        // problem's code. See the read-side rule in keystroke-replay.js.
        reason,
        text: model.getValue(),
        language: model.getLanguageId?.() ?? null,
        lineCount: model.getLineCount?.() ?? null
      };
    }
    function emitSnapshots(reason) {
      for (const editor of hookedEditors) {
        try {
          const snapshot = snapshotOf(editor, reason);
          if (snapshot) post(snapshot);
        } catch (_error) {
        }
      }
    }
    window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      if (event.data?.source !== CMD_SOURCE) return;
      if (event.data.type === "request-snapshot") emitSnapshots("requested");
    });
    function hookEditor(editor) {
      if (hookedEditors.has(editor)) return;
      hookedEditors.add(editor);
      const editorId = editorIdFor(editor);
      editor.onDidChangeModelContent((event) => {
        if (event.isFlush) {
          try {
            const snapshot = snapshotOf(editor, "flush");
            if (snapshot) post(snapshot);
          } catch (_error) {
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
            text: change.text
          });
        }
      });
      if (typeof editor.onDidChangeModel === "function") {
        editor.onDidChangeModel(() => {
          try {
            const snapshot = snapshotOf(editor, "model-change");
            if (snapshot) post(snapshot);
          } catch (_error) {
          }
        });
      }
      try {
        const snapshot = snapshotOf(editor, "hook");
        if (snapshot) post(snapshot);
      } catch (_error) {
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
        return;
      }
      if (performance.now() - started > POLL_TIMEOUT_MS) {
        clearInterval(pollTimer);
      }
    }, POLL_INTERVAL_MS);
    const readyPollTimer = setInterval(() => {
      if (window.monaco?.editor?.onDidCreateEditor) {
        clearInterval(readyPollTimer);
        window.monaco.editor.onDidCreateEditor((editor) => hookEditor(editor));
      }
    }, POLL_INTERVAL_MS);
    function announceNavigation() {
      post({ type: "navigated", t: performance.now(), href: location.href });
    }
    for (const method of ["pushState", "replaceState"]) {
      const original = history[method];
      history[method] = function(...args) {
        const result = original.apply(this, args);
        try {
          announceNavigation();
        } catch (_error) {
        }
        return result;
      };
    }
    window.addEventListener("popstate", announceNavigation);
    post({ type: "injector-loaded", t: performance.now() });
  }
  if (!alreadyResident()) install();
})();
