import { fetchStudent, updateStudent } from "./firestore.js";
import { signIn } from "./auth.js";

// Two-step wizard:
//   Step 1 — Canvas identity: requires an active BYU Canvas session.
//            netID + lti_user_id come from Canvas; the student fills in
//            display name + optional status note. No typed BYU ID — the
//            Canvas session itself is the identity proof, verified by
//            phase 2's Cloud Function via the instructor's Canvas API
//            token.
//   Step 2 — LeetCode link: detect via leetcode-auth content script,
//            confirm identity, save linked username.

// ---- Step 1 references -------------------------------------------------

const step1Panel = document.querySelector('.step-panel[data-step="1"]');
const canvasSignedOutBlock = document.getElementById("canvas-signed-out");
const canvasSignedInBlock = document.getElementById("canvas-signed-in");
const openCanvasBtn = document.getElementById("open-canvas-btn");
const canvasRecheckBtn = document.getElementById("canvas-recheck-btn");
const canvasSwitchBtn = document.getElementById("canvas-switch-btn");
const canvasCardNetid = document.getElementById("canvas-card-netid");
const canvasCardName = document.getElementById("canvas-card-name");
const step1Form = document.getElementById("step1-form");
const nameInput = document.getElementById("input-name");
const noteInput = document.getElementById("input-note");
const step1Status = document.getElementById("step1-status");

// ---- Step 2 references -------------------------------------------------

const step2Panel = document.querySelector('.step-panel[data-step="2"]');
const signedOutBlock = document.getElementById("leetcode-signed-out");
const signedInBlock = document.getElementById("leetcode-signed-in");
const openLeetcodeBtn = document.getElementById("open-leetcode-btn");
const recheckBtn = document.getElementById("recheck-btn");
const confirmBtn = document.getElementById("confirm-leetcode-btn");
const switchAccountBtn = document.getElementById("switch-account-btn");
const backBtn = document.getElementById("back-to-step1");
const step2Status = document.getElementById("step2-status");
const usernameLabel = document.getElementById("leetcode-username");
const realnameLabel = document.getElementById("leetcode-realname");

const stepPills = document.querySelectorAll(".step-indicator .step");

// ---- Validation --------------------------------------------------------

// netID format: 1–8 lowercase letters followed by optional digits.
const NETID_REGEX = /^[a-z][a-z0-9]{1,15}$/;

// ---- Step navigation ---------------------------------------------------

function showStep(n) {
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

// ---- Initial load ------------------------------------------------------

(async () => {
  const { netID, leetcodeUsername } = await chrome.storage.sync.get([
    "netID",
    "leetcodeUsername",
  ]);

  // If the student already finished step 2 previously, land them there
  // so they can re-confirm or change accounts.
  if (netID && leetcodeUsername) {
    showStep(2);
  } else {
    showStep(1);
    if (netID) {
      step1Status.textContent = `Previously linked to ${netID}.`;
    }
  }

  // Pre-fill name/note if we already have a netID on file.
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

// ---- Step 1: Canvas-state buttons --------------------------------------

openCanvasBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: "https://byu.instructure.com/", active: true });
});

canvasRecheckBtn.addEventListener("click", async () => {
  const tabs = await chrome.tabs.query({ url: "https://byu.instructure.com/*" });
  if (tabs.length === 0) {
    chrome.tabs.create({ url: "https://byu.instructure.com/", active: true });
    return;
  }
  await chrome.tabs.reload(tabs[0].id);
  step1Status.textContent = "Re-checking Canvas…";
  step1Status.className = "onboard-status";
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
    step1Status.textContent =
      "Canvas session not detected. Sign in to Canvas first, then try again.";
    step1Status.className = "onboard-status error";
    return;
  }

  const netID = currentCanvasAuth.netID;
  const ltiUserId = currentCanvasAuth.ltiUserId;
  const canvasUserId = currentCanvasAuth.canvasUserId ?? null;
  const name = nameInput.value.trim();
  const note = noteInput.value.trim();

  step1Status.textContent = "Verifying with BYU…";
  step1Status.className = "onboard-status";
  try {
    // Run the Firebase signin chain BEFORE writing to Firestore:
    //   Google OIDC (@byu.edu) → verifyStudent → Firebase custom token
    //   → signInWithCustomToken → cached Firebase ID token.
    // Subsequent Firestore writes (and later, per-user rules) rely on
    // that token being available.
    await signIn(netID, ltiUserId);

    step1Status.textContent = "Saving…";
    await chrome.storage.sync.set({ netID, ltiUserId, canvasUserId });

    const fields = {};
    if (name) fields.name = name;
    if (note) fields.note = note;
    if (Object.keys(fields).length > 0) {
      await updateStudent(netID, fields);
    }
    step1Status.textContent = "";
    showStep(2);
  } catch (error) {
    console.error(error);
    step1Status.textContent = `Failed: ${error.message}`;
    step1Status.className = "onboard-status error";
  }
});

// ---- Step 2 handlers ---------------------------------------------------

openLeetcodeBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: "https://leetcode.com/", active: true });
});

recheckBtn.addEventListener("click", async () => {
  const tabs = await chrome.tabs.query({ url: "https://leetcode.com/*" });
  if (tabs.length === 0) {
    chrome.tabs.create({ url: "https://leetcode.com/", active: true });
    return;
  }
  await chrome.tabs.reload(tabs[0].id);
  step2Status.textContent = "Re-checking…";
  step2Status.className = "onboard-status";
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
    step2Status.textContent = "Couldn't confirm — try Re-check session.";
    step2Status.className = "onboard-status error";
    return;
  }

  step2Status.textContent = "Linking…";
  step2Status.className = "onboard-status";
  try {
    await chrome.storage.sync.set({ leetcodeUsername: leetcodeAuth.username });
    await updateStudent(netID, { leetcodeUsername: leetcodeAuth.username });
    step2Status.textContent = "Done. Opening dashboard…";
    step2Status.className = "onboard-status success";
    setTimeout(() => {
      window.location.href = chrome.runtime.getURL("dashboard.html");
    }, 500);
  } catch (error) {
    console.error(error);
    step2Status.textContent = `Failed: ${error.message}`;
    step2Status.className = "onboard-status error";
  }
});

backBtn.addEventListener("click", () => {
  step2Status.textContent = "";
  showStep(1);
});
