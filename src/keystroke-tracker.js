// Content script — captures Monaco editor deltas + paste/copy/visibility
// events on LeetCode problem pages, batches them, and writes to Firestore.
//
// Architecture:
//   - keystroke-injector.js runs in the page's JS world (via <script src>)
//     and reaches window.monaco. It postMessages deltas back to us.
//   - This script (isolated world) listens for those messages, buffers
//     them, and flushes to Firestore in chunks.
//   - Paste/copy/visibility events are captured directly here — document
//     events fire in both worlds.
//
// Data model:
//   students/{netID}/keystrokeSessions/{sessionId}
//     { sessionId, netID, problemSlug, problemTitle, startedAt,
//       lastActivityAt, deltaCount, chunkCount, endReason? }
//   students/{netID}/keystrokeSessions/{sessionId}/chunks/{chunkIndex}
//     { chunkIndex, events: [{ t, kind, ... }] }
//
// A "session" = one continuous visit to one problem in one tab.
// Navigating to a different problem starts a new session. Sessions
// never span page loads.
//
// MV3 content scripts can't use module imports, so firebase config and
// helpers are inlined (same pattern as leetcode-tracker.js).

const firebaseConfig = {
  apiKey: "AIzaSyC2RxnVrQii0rT-Tm3JZmURmHzico-VqDg",
  projectId: "cs393-496021",
};

const FIRESTORE_BASE =
  `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}` +
  `/databases/(default)/documents`;

// Flush cadence. 5s means at most 5s of typing is at risk if the tab
// is closed uncleanly. Also flushed on visibilitychange → hidden.
const FLUSH_INTERVAL_MS = 5_000;
// Session ends after this much idle time. Next event starts a new one.
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const INJECTOR_MESSAGE_SOURCE = "cs393-keystroke";

// ---- Firestore helpers -------------------------------------------------

function encodeFirestoreValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "number") return { doubleValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
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
    if (value === undefined) continue;
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
  const mask = Object.keys(fields)
    .map((f) => `updateMask.fieldPaths=${encodeURIComponent(f)}`)
    .join("&");
  const url = `${FIRESTORE_BASE}/${path}?${mask}&key=${firebaseConfig.apiKey}`;
  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${idToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields: encodeFirestoreFields(fields) }),
  });
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Firestore PATCH ${path} ${response.status}: ${errorBody}`);
  }
  return response.json();
}

// ---- URL / title helpers (mirrors leetcode-tracker.js) -----------------

function parseProblemSlug(url) {
  const match = url.match(/^https:\/\/leetcode\.com\/problems\/([^/?#]+)/);
  return match ? match[1] : null;
}

function slugToTitle(slug) {
  return slug
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

// Slugified form of a display title, for checking that document.title
// actually belongs to the problem we think we're on.
function titleToSlug(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// LeetCode is a single-page app: history.pushState fires (and we start a
// new session) BEFORE document.title catches up, so a naive read here
// returns the PREVIOUS problem's title. Navigating two-sum →
// add-two-numbers used to label the second session "Two Sum".
//
// So the DOM title is only trusted when it slugifies back to the slug in
// the URL — which is derived from location.href and can't be stale. When
// it doesn't match (mid-navigation, or an odd title like "Pow(x, n)" that
// doesn't round-trip), fall back to the slug. A slightly less pretty
// title beats confidently naming the wrong problem.
function getProblemTitle(slug) {
  const stripped = document.title.replace(/\s*[-–]\s*LeetCode\s*$/i, "").trim();
  if (stripped && titleToSlug(stripped) === slug) return stripped;
  return slugToTitle(slug);
}

// ---- Session state -----------------------------------------------------

let netID = null;
let session = null; // { sessionId, slug, startedAt, chunkIndex, deltaCount, buffer, metadataWritten }

function makeSessionId(slug, startedAt) {
  // Include a short random suffix so two tabs on the same problem opened
  // in the same ms don't collide.
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
    problemTitle: getProblemTitle(slug),
    titleVerified: document.title !== "" && titleToSlug(
      document.title.replace(/\s*[-–]\s*LeetCode\s*$/i, "").trim(),
    ) === slug,
    startedAt,
    chunkIndex: 0,
    deltaCount: 0,
    buffer: [],
    metadataWritten: false,
    lastActivityAt: startedAt,
  };
  console.log(`[CS 393 Buddy] keystroke session started: ${sessionId}`);
  return session;
}

// Metadata is written on the first flush, up to FLUSH_INTERVAL_MS after
// the session began — by which point a title that was mid-navigation at
// session start has usually settled. Only re-read if we didn't already
// get a verified one, so navigating AWAY (document.title is the next
// problem, session.slug is this one) can't downgrade a good title.
function resolveSessionTitle() {
  if (session.titleVerified) return session.problemTitle;
  const retried = getProblemTitle(session.slug);
  session.problemTitle = retried;
  session.titleVerified = titleToSlug(retried) === session.slug;
  return retried;
}

async function ensureSessionMetadata() {
  if (!session || session.metadataWritten) return;
  const path = `students/${netID}/keystrokeSessions/${session.sessionId}`;
  try {
    await patchFirestoreDoc(path, {
      sessionId: session.sessionId,
      netID,
      problemSlug: session.slug,
      problemTitle: resolveSessionTitle(),
      startedAt: session.startedAt,
      lastActivityAt: session.lastActivityAt,
      deltaCount: 0,
      chunkCount: 0,
      userAgent: navigator.userAgent,
    });
    session.metadataWritten = true;
  } catch (error) {
    console.error("[CS 393 Buddy] keystroke session metadata write failed:", error);
  }
}

async function flushBuffer(endReason) {
  if (!session) return;
  if (session.buffer.length === 0 && !endReason) return;

  await ensureSessionMetadata();

  // Snapshot + clear buffer BEFORE the write so events during the
  // write end up in the next chunk.
  const events = session.buffer;
  session.buffer = [];

  if (events.length > 0) {
    const chunkPath =
      `students/${netID}/keystrokeSessions/${session.sessionId}` +
      `/chunks/${String(session.chunkIndex).padStart(6, "0")}`;
    try {
      await patchFirestoreDoc(chunkPath, {
        chunkIndex: session.chunkIndex,
        writtenAt: Date.now(),
        events,
      });
      session.chunkIndex += 1;
      session.deltaCount += events.length;
    } catch (error) {
      console.error("[CS 393 Buddy] keystroke chunk write failed:", error);
      // Put the events back on the front of the buffer so we retry
      // on the next flush.
      session.buffer = events.concat(session.buffer);
      return;
    }
  }

  // Metadata rollup. Best-effort — a failure here just means the
  // session doc's lastActivityAt / counters get stale, but the chunks
  // are still there and authoritative.
  const sessionPath =
    `students/${netID}/keystrokeSessions/${session.sessionId}`;
  try {
    const patch = {
      lastActivityAt: session.lastActivityAt,
      deltaCount: session.deltaCount,
      chunkCount: session.chunkIndex,
    };
    if (endReason) patch.endReason = endReason;
    if (endReason) patch.endedAt = Date.now();
    await patchFirestoreDoc(sessionPath, patch);
  } catch (error) {
    console.error("[CS 393 Buddy] keystroke session rollup failed:", error);
  }
}

function pushEvent(event) {
  if (!session) {
    const slug = parseProblemSlug(location.href);
    if (!slug) return;
    newSession(slug);
  }
  // Idle timeout: end the current session and start a fresh one if
  // we've been quiet for too long.
  if (Date.now() - session.lastActivityAt > IDLE_TIMEOUT_MS) {
    flushBuffer("idle");
    const slug = parseProblemSlug(location.href);
    if (slug) newSession(slug);
    else return;
  }
  session.lastActivityAt = Date.now();
  session.buffer.push(event);
}

// ---- Injector bridge ---------------------------------------------------

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
      offset: data.offset,
      length: data.length,
      text: data.text,
    });
  } else if (data.type === "snapshot") {
    pushEvent({
      kind: "snapshot",
      t: data.t,
      wallMs: Date.now(),
      text: data.text,
      language: data.language,
    });
  } else if (data.type === "editor-hooked" || data.type === "injector-loaded") {
    console.log(`[CS 393 Buddy] injector: ${data.type}`);
  }
});

// ---- Paste / copy / visibility listeners -------------------------------

// Paste + copy DOM events give us the clipboard data directly, which
// the Monaco delta stream doesn't (a paste shows up as a delta with a
// text field, but there's no source hint).
document.addEventListener(
  "paste",
  (event) => {
    const text = event.clipboardData?.getData("text") ?? "";
    pushEvent({
      kind: "paste",
      t: performance.now(),
      wallMs: Date.now(),
      length: text.length,
      preview: text.slice(0, 200),
    });
  },
  true,
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
      preview: selection.slice(0, 200),
    });
  },
  true,
);

document.addEventListener("visibilitychange", () => {
  pushEvent({
    kind: document.visibilityState === "hidden" ? "tab_blur" : "tab_focus",
    t: performance.now(),
    wallMs: Date.now(),
  });
  // Aggressive flush when the tab loses focus — that's the most common
  // moment right before an unclean close.
  if (document.visibilityState === "hidden") {
    flushBuffer();
  }
});

// beforeunload is unreliable in MV3 (service worker may not survive
// long enough to complete the fetch), but we still try — the periodic
// flush already means we lose at most FLUSH_INTERVAL_MS of typing.
window.addEventListener("beforeunload", () => {
  flushBuffer("unload");
});

// ---- SPA navigation (problem → problem) --------------------------------
//
// leetcode-tracker.js already patches history.pushState to dispatch a
// "locationchange" event. If that content script loaded first (it's
// listed first in manifest.json), we can piggyback. If not, patch it
// ourselves — the double-patch is safe because we call the original.
const origPushState = history.pushState;
history.pushState = function (...args) {
  origPushState.apply(this, args);
  window.dispatchEvent(new Event("locationchange"));
};

function onLocationChange() {
  const slug = parseProblemSlug(location.href);
  // If we drifted off a problem page entirely, end the session.
  if (!slug) {
    if (session) {
      flushBuffer("navigate");
      session = null;
    }
    return;
  }
  // Same problem → nothing to do.
  if (session && session.slug === slug) return;
  // Different problem → flush + close current, start fresh.
  if (session) {
    flushBuffer("navigate");
    session = null;
  }
  newSession(slug);
  // Re-inject the page script for the new problem — Monaco may have
  // been torn down and rebuilt.
  injectPageScript();
}

window.addEventListener("popstate", onLocationChange);
window.addEventListener("locationchange", onLocationChange);

// ---- Recording badge ---------------------------------------------------

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
    "user-select: none",
  ].join("; ");
  badge.textContent = "● CS 393 recording";
  document.body.appendChild(badge);
}

// ---- Bootstrap ---------------------------------------------------------

(async () => {
  const { netID: stored } = await chrome.storage.sync.get("netID");
  if (!stored) {
    console.log(
      "[CS 393 Buddy] no netID set — skipping keystroke recording. Run onboarding first.",
    );
    return;
  }
  netID = stored;

  console.log("[CS 393 Buddy] keystroke tracker active");

  injectPageScript();
  mountBadge();
  // Kick off the first session if we're already on a problem page.
  const slug = parseProblemSlug(location.href);
  if (slug) newSession(slug);

  setInterval(() => flushBuffer(), FLUSH_INTERVAL_MS);
})();
