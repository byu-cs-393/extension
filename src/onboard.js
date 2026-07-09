import { fetchStudent, updateStudent } from "./firestore.js";
import { signIn, VerifyStudentError } from "./auth.js";

// Three-step wizard:
//   Step 0 — Welcome: what the extension does and what data it uses.
//            Shown once; skipped for anyone who's already got a netID
//            on file. A "Get started" click advances to Step 1.
//   Step 1 — Canvas identity: requires an active BYU Canvas session.
//            netID + lti_user_id come from Canvas; the student fills in
//            display name + optional status note. verifyStudent
//            server-side re-verifies the (netID, lti_user_id) pair
//            against Canvas using the instructor's Canvas API token.
//   Step 2 — LeetCode link: detect via leetcode-auth content script,
//            confirm identity, save linked username.

// ---- Step references ---------------------------------------------------

const step0Panel = document.querySelector('.step-panel[data-step="0"]');
const welcomeContinueBtn = document.getElementById("welcome-continue-btn");

const step1Panel = document.querySelector('.step-panel[data-step="1"]');
const canvasSignedOutBlock = document.getElementById("canvas-signed-out");
const canvasSignedInBlock = document.getElementById("canvas-signed-in");
const openCanvasBtn = document.getElementById("open-canvas-btn");
const canvasRecheckBtn = document.getElementById("canvas-recheck-btn");
const canvasSwitchBtn = document.getElementById("canvas-switch-btn");
const canvasCardNetid = document.getElementById("canvas-card-netid");
const canvasCardName = document.getElementById("canvas-card-name");
const step1Form = document.getElementById("step1-form");
const step1SubmitBtn = document.getElementById("step1-submit-btn");
const nameInput = document.getElementById("input-name");
const noteInput = document.getElementById("input-note");
const step1Status = document.getElementById("step1-status");

const step2Panel = document.querySelector('.step-panel[data-step="2"]');
const signedOutBlock = document.getElementById("leetcode-signed-out");
const signedInBlock = document.getElementById("leetcode-signed-in");
const openLeetcodeBtn = document.getElementById("open-leetcode-btn");
const leetcodeSignupBtn = document.getElementById("leetcode-signup-btn");
const recheckBtn = document.getElementById("recheck-btn");
const confirmBtn = document.getElementById("confirm-leetcode-btn");
const switchAccountBtn = document.getElementById("switch-account-btn");
const backBtn = document.getElementById("back-to-step1");
const step2Status = document.getElementById("step2-status");
const usernameLabel = document.getElementById("leetcode-username");
const realnameLabel = document.getElementById("leetcode-realname");

const stepPills = document.querySelectorAll(".step-indicator .step");

const helpToggle = document.getElementById("help-toggle");
const helpDrawer = document.getElementById("help-drawer");
const helpClose = document.getElementById("help-close");

// ---- Validation --------------------------------------------------------

// netID format: starts with a lowercase letter, then up to 15 letters/digits.
const NETID_REGEX = /^[a-z][a-z0-9]{1,15}$/;

// ---- Step navigation ---------------------------------------------------

function showStep(n) {
  step0Panel.hidden = n !== 0;
  step1Panel.hidden = n !== 1;
  step2Panel.hidden = n !== 2;
  stepPills.forEach((pill) => {
    const step = Number(pill.dataset.step);
    pill.classList.toggle("active", step === n);
    pill.classList.toggle("complete", step < n);
  });
}

// ---- Step 1: Canvas state rendering ------------------------------------

// Module-scoped Canvas state — the form needs to read this when submitting.
let currentCanvasAuth = null;

function renderCanvasState(auth) {
  currentCanvasAuth = auth;
  const signedIn =
    !!auth?.signedIn &&
    typeof auth.netID === "string" &&
    NETID_REGEX.test(auth.netID) &&
    !!auth.ltiUserId;

  canvasSignedOutBlock.hidden = signedIn;
  canvasSignedInBlock.hidden = !signedIn;
  if (signedIn) {
    canvasCardNetid.textContent = auth.netID;
    canvasCardName.textContent = auth.name || "";
  }
}

// Pre-fill display name + status note from any existing student doc, but
// only when we know the netID (i.e., once Canvas detection has landed).
let lastPrefilledForNetID = null;
async function maybePrefillProfile(netID) {
  if (!netID || netID === lastPrefilledForNetID) return;
  lastPrefilledForNetID = netID;
  try {
    const student = await fetchStudent(netID);
    if (student) {
      if (!nameInput.value.trim() && typeof student.name === "string") {
        nameInput.value = student.name;
      } else if (!nameInput.value.trim() && currentCanvasAuth?.name) {
        nameInput.value = currentCanvasAuth.name;
      }
      if (!noteInput.value.trim() && typeof student.note === "string") {
        noteInput.value = student.note;
      }
    } else if (currentCanvasAuth?.name && !nameInput.value.trim()) {
      nameInput.value = currentCanvasAuth.name;
    }
  } catch (error) {
    console.error("Failed to fetch existing student:", error);
  }
}

// ---- Step 2: LeetCode auth state rendering -----------------------------

function renderLeetcodeState(auth) {
  const signedIn = !!auth?.signedIn && auth?.username;
  signedInBlock.hidden = !signedIn;
  signedOutBlock.hidden = signedIn;
  if (signedIn) {
    usernameLabel.textContent = `@${auth.username}`;
    realnameLabel.textContent = auth.realName || "";
  }
}

// ---- Status message helpers --------------------------------------------

// Shows a "working…" status with a spinner. Used during Canvas
// verification, save, and LeetCode link.
function setStatusWorking(el, message) {
  el.className = "onboard-status working";
  el.innerHTML = `<span class="spinner" aria-hidden="true"></span> ${message}`;
}

function setStatusError(el, message) {
  el.className = "onboard-status error";
  el.textContent = message;
}

function setStatusSuccess(el, message) {
  el.className = "onboard-status success";
  el.textContent = message;
}

function clearStatus(el) {
  el.className = "onboard-status";
  el.textContent = "";
}

// Maps a VerifyStudentError.code (or a bare fallback code) to friendly
// student-facing copy. Kept in one place so it's easy to keep the
// wording consistent and to translate later if needed.
function friendlyVerifyError(error) {
  const code = error?.code ?? null;
  switch (code) {
    case "not-found":
      return (
        "You don't appear to be enrolled in CS 393 in Canvas. " +
        "If you just enrolled, wait a few hours for Canvas to sync. " +
        "Otherwise, contact your instructor."
      );
    case "permission-denied":
      return (
        "The BYU Canvas account you're signed in with doesn't match this session. " +
        "Sign out of Canvas and sign in with your own BYU account, then try again."
      );
    case "invalid-argument":
      return (
        "We didn't get valid info from your Canvas session. Try reloading " +
        "Canvas in another tab, then click Re-check session."
      );
    case "network-error":
      return (
        "We couldn't reach the verification server. Check your internet " +
        "connection and try again."
      );
    case "method-not-allowed":
    case "internal":
    default:
      return (
        "Something went wrong on our side while verifying with Canvas. " +
        "This is usually temporary — wait a minute and try again. If it " +
        "keeps failing, contact your instructor."
      );
  }
}

// ---- Initial load ------------------------------------------------------

(async () => {
  const { netID, leetcodeUsername } = await chrome.storage.sync.get([
    "netID",
    "leetcodeUsername",
  ]);

  // Landing rules:
  //   - Never onboarded (no netID)                 → Step 0 welcome
  //   - Onboarded but haven't linked LeetCode      → Step 1
  //   - Fully onboarded                            → Step 2 (re-confirm)
  if (netID && leetcodeUsername) {
    showStep(2);
  } else if (netID) {
    showStep(1);
    step1Status.textContent = `Previously linked to ${netID}.`;
  } else {
    showStep(0);
  }

  if (netID) {
    await maybePrefillProfile(netID);
  }
})();

// Hydrate Canvas + LeetCode state from local storage, then keep both
// live via onChanged.
(async () => {
  const { leetcodeAuth, canvasAuth } = await chrome.storage.local.get([
    "leetcodeAuth",
    "canvasAuth",
  ]);
  renderLeetcodeState(leetcodeAuth);
  renderCanvasState(canvasAuth);
  if (canvasAuth?.signedIn && canvasAuth.netID) {
    await maybePrefillProfile(canvasAuth.netID);
  }
})();

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes.leetcodeAuth) {
    renderLeetcodeState(changes.leetcodeAuth.newValue);
  }
  if (changes.canvasAuth) {
    const next = changes.canvasAuth.newValue;
    renderCanvasState(next);
    if (next?.signedIn && next.netID) {
      maybePrefillProfile(next.netID);
    }
  }
});

// ---- Step 0: Welcome ---------------------------------------------------

welcomeContinueBtn.addEventListener("click", () => {
  showStep(1);
});

// ---- Step 1: Canvas-state buttons --------------------------------------

openCanvasBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: "https://byu.instructure.com/", active: true });
});

// Re-check: focus the existing Canvas tab (if any) instead of reloading
// it — reloading destroys any in-progress work the student might have
// on that page. The content script already writes to storage on each
// page load, so as long as the student navigates or reloads Canvas
// themselves after signing in, storage.onChanged will fire and update
// the UI here.
canvasRecheckBtn.addEventListener("click", async () => {
  const tabs = await chrome.tabs.query({ url: "https://byu.instructure.com/*" });
  if (tabs.length === 0) {
    chrome.tabs.create({ url: "https://byu.instructure.com/", active: true });
    return;
  }
  const tab = tabs[0];
  await chrome.tabs.update(tab.id, { active: true });
  if (typeof tab.windowId === "number") {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
  setStatusWorking(step1Status, "Re-checking Canvas…");
  // The content script won't re-fire without a page event; give the
  // student a moment to reload/navigate, then clear the status so it
  // doesn't look stuck if nothing lands.
  setTimeout(() => {
    if (step1Status.classList.contains("working")) clearStatus(step1Status);
  }, 5000);
});

canvasSwitchBtn.addEventListener("click", () => {
  // Open Canvas — student signs out and back in there. Our content
  // script picks up the new session and the card updates automatically.
  chrome.tabs.create({ url: "https://byu.instructure.com/logout", active: true });
});

// ---- Step 1 submit -----------------------------------------------------

step1Form.addEventListener("submit", async (event) => {
  event.preventDefault();

  // Gate on Canvas state — UI hides the form when not signed in, but
  // defend against race conditions where the form is visible briefly.
  if (
    !currentCanvasAuth?.signedIn ||
    !NETID_REGEX.test(currentCanvasAuth.netID ?? "") ||
    !currentCanvasAuth.ltiUserId
  ) {
    setStatusError(
      step1Status,
      "Canvas session not detected. Sign in to Canvas first, then try again."
    );
    return;
  }

  const netID = currentCanvasAuth.netID;
  const ltiUserId = currentCanvasAuth.ltiUserId;
  const canvasUserId = currentCanvasAuth.canvasUserId ?? null;
  const name = nameInput.value.trim();
  const note = noteInput.value.trim();

  step1SubmitBtn.disabled = true;
  setStatusWorking(step1Status, "Verifying with BYU…");
  try {
    // signIn() runs verifyStudent → signInWithCustomToken → caches
    // the Firebase ID token. Errors from verifyStudent come back as
    // VerifyStudentError with a `.code` we can map to friendly copy.
    await signIn(netID, ltiUserId);

    setStatusWorking(step1Status, "Saving…");
    await chrome.storage.sync.set({ netID, ltiUserId, canvasUserId });

    const fields = {};
    if (name) fields.name = name;
    if (note) fields.note = note;
    if (Object.keys(fields).length > 0) {
      await updateStudent(netID, fields);
    }
    clearStatus(step1Status);
    showStep(2);
  } catch (error) {
    console.error(error);
    if (error instanceof VerifyStudentError) {
      setStatusError(step1Status, friendlyVerifyError(error));
    } else {
      setStatusError(
        step1Status,
        "Something went wrong while saving your profile. Try again in a moment."
      );
    }
  } finally {
    step1SubmitBtn.disabled = false;
  }
});

// ---- Step 2 handlers ---------------------------------------------------

openLeetcodeBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: "https://leetcode.com/", active: true });
});

leetcodeSignupBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: "https://leetcode.com/accounts/signup/", active: true });
});

recheckBtn.addEventListener("click", async () => {
  const tabs = await chrome.tabs.query({ url: "https://leetcode.com/*" });
  if (tabs.length === 0) {
    chrome.tabs.create({ url: "https://leetcode.com/", active: true });
    return;
  }
  const tab = tabs[0];
  await chrome.tabs.update(tab.id, { active: true });
  if (typeof tab.windowId === "number") {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
  setStatusWorking(step2Status, "Re-checking…");
  setTimeout(() => {
    if (step2Status.classList.contains("working")) clearStatus(step2Status);
  }, 5000);
});

switchAccountBtn.addEventListener("click", () => {
  chrome.tabs.create({
    url: "https://leetcode.com/accounts/logout/",
    active: true,
  });
});

confirmBtn.addEventListener("click", async () => {
  const { leetcodeAuth } = await chrome.storage.local.get("leetcodeAuth");
  const { netID } = await chrome.storage.sync.get("netID");
  if (!leetcodeAuth?.signedIn || !leetcodeAuth.username || !netID) {
    setStatusError(step2Status, "Couldn't confirm — try Re-check session.");
    return;
  }

  setStatusWorking(step2Status, "Linking…");
  try {
    await chrome.storage.sync.set({ leetcodeUsername: leetcodeAuth.username });
    await updateStudent(netID, { leetcodeUsername: leetcodeAuth.username });
    setStatusSuccess(step2Status, "Done. Opening dashboard…");
    setTimeout(() => {
      window.location.href = chrome.runtime.getURL("dashboard.html");
    }, 500);
  } catch (error) {
    console.error(error);
    setStatusError(
      step2Status,
      "Couldn't link your LeetCode account. Try again in a moment."
    );
  }
});

backBtn.addEventListener("click", () => {
  clearStatus(step2Status);
  showStep(1);
});

// ---- Help drawer -------------------------------------------------------

function openHelp() {
  helpDrawer.hidden = false;
  helpToggle.setAttribute("aria-expanded", "true");
}

function closeHelp() {
  helpDrawer.hidden = true;
  helpToggle.setAttribute("aria-expanded", "false");
}

helpToggle.addEventListener("click", () => {
  if (helpDrawer.hidden) openHelp();
  else closeHelp();
});
helpClose.addEventListener("click", closeHelp);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !helpDrawer.hidden) closeHelp();
});
