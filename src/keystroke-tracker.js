// GENERATED FILE — DO NOT EDIT.
// Built from src/content/ by scripts/build-content-scripts.js.
// Edit the source there and run: npm run build

(() => {
  // src/firebase-config.js
  var firebaseConfig = {
    apiKey: "AIzaSyC2RxnVrQii0rT-Tm3JZmURmHzico-VqDg",
    authDomain: "cs393-496021.firebaseapp.com",
    projectId: "cs393-496021",
    storageBucket: "cs393-496021.firebasestorage.app",
    messagingSenderId: "620970916253",
    appId: "1:620970916253:web:12819e3116d187806ad774",
    measurementId: "G-0XEPMH2MLG"
  };

  // src/lib/firestore-rest.js
  var FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents`;
  function encodeFirestoreValue(value) {
    if (value === null || value === void 0) return { nullValue: null };
    if (typeof value === "string") return { stringValue: value };
    if (typeof value === "number") return { doubleValue: value };
    if (typeof value === "boolean") return { booleanValue: value };
    if (value instanceof Date) return { timestampValue: value.toISOString() };
    if (Array.isArray(value)) {
      return { arrayValue: { values: value.map(encodeFirestoreValue) } };
    }
    if (typeof value === "object") {
      return { mapValue: { fields: encodeFirestoreFields(value) } };
    }
    throw new Error(`Unsupported field value type: ${typeof value}`);
  }
  function encodeFirestoreFields(obj) {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      if (value === void 0) continue;
      result[key] = encodeFirestoreValue(value);
    }
    return result;
  }
  async function getStoredFirebaseIdToken() {
    const { firebaseAuth } = await chrome.storage.local.get("firebaseAuth");
    return firebaseAuth?.idToken ?? null;
  }
  async function patchFirestoreDoc(path, fields) {
    const idToken = await getStoredFirebaseIdToken();
    if (!idToken) throw new Error("no Firebase ID token cached");
    const mask = Object.keys(fields).map((f) => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join("&");
    const url = `${FIRESTORE_BASE}/${path}?${mask}&key=${firebaseConfig.apiKey}`;
    const response = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${idToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ fields: encodeFirestoreFields(fields) })
    });
    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Firestore PATCH ${path} ${response.status}: ${errorBody}`);
    }
    return response.json();
  }

  // src/lib/problem-url.js
  function parseProblemSlug(url) {
    const match = String(url ?? "").match(
      /^https:\/\/leetcode\.com\/problems\/([^/?#]+)/
    );
    return match ? match[1] : null;
  }
  function slugToTitle(slug) {
    return String(slug ?? "").split("-").filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
  }
  function titleToSlug(title) {
    return String(title ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }
  function strippedDocumentTitle(documentTitle) {
    return String(documentTitle ?? "").replace(/\s*[-–]\s*LeetCode\s*$/i, "").trim();
  }
  function titleMatchesSlug(documentTitle, slug) {
    const stripped = strippedDocumentTitle(documentTitle);
    return stripped !== "" && titleToSlug(stripped) === slug;
  }
  function getProblemTitle(documentTitle, slug) {
    return titleMatchesSlug(documentTitle, slug) ? strippedDocumentTitle(documentTitle) : slugToTitle(slug);
  }

  // src/lib/extension-lifecycle.js
  function extensionContextAlive() {
    try {
      return Boolean(globalThis.chrome?.runtime?.id);
    } catch (_error) {
      return false;
    }
  }
  function isContextInvalidatedError(error) {
    return /extension context invalidated|message port closed/i.test(
      String(error?.message ?? error)
    );
  }
  function createLifecycleGuard(onInvalidated) {
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
      }
    };
  }

  // src/content/keystroke-tracker.js
  var FLUSH_INTERVAL_MS = 5e3;
  var IDLE_TIMEOUT_MS = 15 * 60 * 1e3;
  var INJECTOR_MESSAGE_SOURCE = "cs393-keystroke";
  var INJECTOR_COMMAND_SOURCE = "cs393-keystroke-cmd";
  var flushTimer = null;
  var locationTimer = null;
  var lifecycle = createLifecycleGuard(() => {
    if (flushTimer !== null) clearInterval(flushTimer);
    if (locationTimer !== null) clearInterval(locationTimer);
    session = null;
    markBadgeStopped();
    console.warn(
      "[CS 393 Buddy] the extension was reloaded or updated \u2014 recording has STOPPED for this tab. Reload the page to start recording again."
    );
  });
  var netID = null;
  var session = null;
  function makeSessionId(slug, startedAt) {
    const rand = Math.floor(Math.random() * 1e6).toString(36);
    return `${slug}-${startedAt}-${rand}`;
  }
  function newSession(slug) {
    const startedAt = Date.now();
    const sessionId = makeSessionId(slug, startedAt);
    session = {
      sessionId,
      slug,
      // Best effort now; retried at metadata-write time if the DOM title
      // hadn't caught up to this problem yet. See resolveSessionTitle.
      problemTitle: getProblemTitle(document.title, slug),
      titleVerified: titleMatchesSlug(document.title, slug),
      startedAt,
      chunkIndex: 0,
      deltaCount: 0,
      buffer: [],
      metadataWritten: false,
      lastActivityAt: startedAt
    };
    console.log(`[CS 393 Buddy] keystroke session started: ${sessionId}`);
    requestSnapshots();
    return session;
  }
  function requestSnapshots() {
    window.postMessage(
      { source: INJECTOR_COMMAND_SOURCE, type: "request-snapshot" },
      "*"
    );
  }
  function resolveSessionTitle(target) {
    if (target.titleVerified) return target.problemTitle;
    const retried = getProblemTitle(document.title, target.slug);
    target.problemTitle = retried;
    target.titleVerified = titleMatchesSlug(retried, target.slug);
    return retried;
  }
  async function ensureSessionMetadata(target) {
    if (!target || target.metadataWritten) return;
    const path = `students/${netID}/keystrokeSessions/${target.sessionId}`;
    try {
      await patchFirestoreDoc(path, {
        sessionId: target.sessionId,
        netID,
        problemSlug: target.slug,
        problemTitle: resolveSessionTitle(target),
        startedAt: target.startedAt,
        lastActivityAt: target.lastActivityAt,
        deltaCount: 0,
        chunkCount: 0,
        userAgent: navigator.userAgent
      });
      target.metadataWritten = true;
    } catch (error) {
      if (lifecycle.failed(error)) return;
      console.error("[CS 393 Buddy] keystroke session metadata write failed:", error);
    }
  }
  async function flushBuffer(endReason, target = session) {
    if (!lifecycle.alive()) return;
    if (!target) return;
    if (target.buffer.length === 0 && !endReason) return;
    await ensureSessionMetadata(target);
    const events = target.buffer;
    target.buffer = [];
    if (events.length > 0) {
      const chunkPath = `students/${netID}/keystrokeSessions/${target.sessionId}/chunks/${String(target.chunkIndex).padStart(6, "0")}`;
      try {
        await patchFirestoreDoc(chunkPath, {
          chunkIndex: target.chunkIndex,
          writtenAt: Date.now(),
          events
        });
        target.chunkIndex += 1;
        target.deltaCount += events.length;
      } catch (error) {
        if (lifecycle.failed(error)) return;
        console.error("[CS 393 Buddy] keystroke chunk write failed:", error);
        target.buffer = events.concat(target.buffer);
        return;
      }
    }
    const sessionPath = `students/${netID}/keystrokeSessions/${target.sessionId}`;
    try {
      const patch = {
        lastActivityAt: target.lastActivityAt,
        deltaCount: target.deltaCount,
        chunkCount: target.chunkIndex
      };
      if (endReason) patch.endReason = endReason;
      if (endReason) patch.endedAt = Date.now();
      await patchFirestoreDoc(sessionPath, patch);
    } catch (error) {
      if (lifecycle.failed(error)) return;
      console.error("[CS 393 Buddy] keystroke session rollup failed:", error);
    }
  }
  function pushEvent(event) {
    if (lifecycle.invalidated()) return;
    if (!session) {
      const slug = parseProblemSlug(location.href);
      if (!slug) return;
      newSession(slug);
    }
    if (Date.now() - session.lastActivityAt > IDLE_TIMEOUT_MS) {
      flushBuffer("idle", session);
      const slug = parseProblemSlug(location.href);
      if (slug) newSession(slug);
      else return;
    }
    session.lastActivityAt = Date.now();
    session.buffer.push(event);
  }
  var lastSeenHref = location.href;
  var LOCATION_POLL_MS = 1e3;
  function injectPageScript() {
    const scriptEl = document.createElement("script");
    scriptEl.src = chrome.runtime.getURL("keystroke-injector.js");
    scriptEl.onload = () => scriptEl.remove();
    (document.head || document.documentElement).appendChild(scriptEl);
  }
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== INJECTOR_MESSAGE_SOURCE) return;
    if (data.type === "delta") {
      pushEvent({
        kind: "delta",
        t: data.t,
        wallMs: Date.now(),
        // Which Monaco instance this edit belongs to. LeetCode runs more
        // than one; `offset` only means something relative to its own
        // editor's document.
        editorId: data.editorId ?? null,
        offset: data.offset,
        length: data.length,
        text: data.text
      });
    } else if (data.type === "snapshot") {
      pushEvent({
        kind: "snapshot",
        t: data.t,
        wallMs: Date.now(),
        editorId: data.editorId ?? null,
        text: data.text,
        language: data.language,
        lineCount: data.lineCount ?? null,
        // "hook" | "model-change" | "flush" | "requested". The read side
        // uses this to distinguish a baseline taken when the document
        // genuinely changed from one taken speculatively at navigation.
        reason: data.reason ?? null
      });
    } else if (data.type === "navigated") {
      if (data.href !== lastSeenHref) {
        lastSeenHref = data.href;
        onLocationChange();
      }
    } else if (data.type === "editor-hooked" || data.type === "injector-loaded" || data.type === "injector-already-loaded") {
      console.log(`[CS 393 Buddy] injector: ${data.type}`);
    }
  });
  document.addEventListener(
    "paste",
    (event) => {
      const text = event.clipboardData?.getData("text") ?? "";
      pushEvent({
        kind: "paste",
        t: performance.now(),
        wallMs: Date.now(),
        length: text.length,
        preview: text.slice(0, 200)
      });
    },
    true
  );
  document.addEventListener(
    "copy",
    (event) => {
      const selection = event.clipboardData?.getData("text") ?? String(document.getSelection() ?? "");
      pushEvent({
        kind: "copy",
        t: performance.now(),
        wallMs: Date.now(),
        length: selection.length,
        preview: selection.slice(0, 200)
      });
    },
    true
  );
  document.addEventListener("visibilitychange", () => {
    pushEvent({
      kind: document.visibilityState === "hidden" ? "tab_blur" : "tab_focus",
      t: performance.now(),
      wallMs: Date.now()
    });
    if (document.visibilityState === "hidden") {
      flushBuffer();
    }
  });
  window.addEventListener("beforeunload", () => {
    flushBuffer("unload");
  });
  var origPushState = history.pushState;
  history.pushState = function(...args) {
    origPushState.apply(this, args);
    window.dispatchEvent(new Event("locationchange"));
  };
  locationTimer = setInterval(() => {
    if (lifecycle.invalidated()) return;
    if (location.href === lastSeenHref) return;
    lastSeenHref = location.href;
    onLocationChange();
  }, LOCATION_POLL_MS);
  function onLocationChange() {
    const slug = parseProblemSlug(location.href);
    if (!slug) {
      if (session) {
        flushBuffer("navigate", session);
        session = null;
      }
      return;
    }
    if (session && session.slug === slug) return;
    if (session) {
      flushBuffer("navigate", session);
      session = null;
    }
    newSession(slug);
    injectPageScript();
  }
  window.addEventListener("popstate", onLocationChange);
  window.addEventListener("locationchange", onLocationChange);
  function mountBadge() {
    if (document.getElementById("cs393-recording-badge")) return;
    const badge = document.createElement("div");
    badge.id = "cs393-recording-badge";
    badge.setAttribute("aria-label", "CS 393 Buddy: keystroke recording active");
    badge.style.cssText = [
      "position: fixed",
      "bottom: 12px",
      "right: 12px",
      "z-index: 2147483647",
      "background: rgba(220, 38, 38, 0.92)",
      "color: white",
      "font: 500 12px/1.2 system-ui, -apple-system, sans-serif",
      "padding: 6px 10px",
      "border-radius: 6px",
      "box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25)",
      "pointer-events: none",
      "user-select: none"
    ].join("; ");
    badge.textContent = "\u25CF CS 393 recording";
    document.body.appendChild(badge);
  }
  function markBadgeStopped() {
    const badge = document.getElementById("cs393-recording-badge");
    if (!badge) return;
    badge.setAttribute(
      "aria-label",
      "CS 393 Buddy: recording stopped, reload the page"
    );
    badge.style.background = "rgba(120, 113, 108, 0.95)";
    badge.textContent = "\u23F8 CS 393 recording stopped \u2014 reload page";
  }
  (async () => {
    const { netID: stored } = await chrome.storage.sync.get("netID");
    if (!stored) {
      console.log(
        "[CS 393 Buddy] no netID set \u2014 skipping keystroke recording. Run onboarding first."
      );
      return;
    }
    netID = stored;
    console.log("[CS 393 Buddy] keystroke tracker active");
    injectPageScript();
    mountBadge();
    const slug = parseProblemSlug(location.href);
    if (slug) newSession(slug);
    flushTimer = setInterval(() => flushBuffer(), FLUSH_INTERVAL_MS);
  })();
})();
