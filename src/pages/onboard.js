import { fetchStudent, updateStudent } from "../platform/firestore.js";
import { signIn, VerifyStudentError } from "../platform/auth.js";
import {
  generateConnectCode,
  formatConnectCode,
  normalizeConnectCode,
} from "../data/connect-code.js";

// Three-step wizard:
//   Step 0 — Welcome: what the extension does and what data it uses.
//            Shown once; skipped for anyone who's already got a netID
//            on file. A "Get started" click advances to Step 1.
//   Step 1 — Canvas identity: the student types their netID and pastes a
//            generated code into the "Connect Your Account" assignment in
//            Canvas. verifyStudent checks the netID is on the roster and
//            that the code is in that student's own submission, read with
//            the course's Canvas token. Nothing runs on Canvas pages —
//            the extension has no content script there.
//   Step 2 — LeetCode link: detect via leetcode-auth content script,
//            confirm identity, save linked username.

// ---- Step references ---------------------------------------------------

const step0Panel = document.querySelector('.step-panel[data-step="0"]');
const welcomeContinueBtn = document.getElementById("welcome-continue-btn");

const step1Panel = document.querySelector('.step-panel[data-step="1"]');
const connectCodeEl = document.getElementById("connect-code");
const copyCodeBtn = document.getElementById("copy-code-btn");
const openAssignmentBtn = document.getElementById("open-assignment-btn");
const openStaffPageBtn = document.getElementById("open-staff-page-btn");
const studentSteps = document.getElementById("student-steps");
const staffSteps = document.getElementById("staff-steps");
const roleToggleBtn = document.getElementById("role-toggle-btn");
const newCodeBtn = document.getElementById("new-code-btn");
const netidInput = document.getElementById("input-netid");
const step1Form = document.getElementById("step1-form");
const step1SubmitBtn = document.getElementById("step1-submit-btn");
const nameInput = document.getElementById("input-name");
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

// ---- Step 1: connection code -------------------------------------------
//
// The extension no longer reads anything from Canvas. It shows a code,
// the student pastes it into a Canvas assignment from their own login,
// and the Cloud Function reads it back with the course's token. See
// functions/connect-code.js for why that's the proof and the earlier
// approaches weren't.

// Links straight at the assignment rather than the assignment list —
// students shouldn't have to hunt for it among 53 others.
//
// The id is duplicated from functions/deploy.fall-2026.json, which is the
// source of truth. It can't be imported: the deploy map ships with the
// Cloud Functions, not the extension. A test asserts the two agree, so
// this can't drift into a dead link unnoticed.
const CONNECT_ASSIGNMENT_URL =
  "https://byu.instructure.com/courses/35464/assignments/1498932";

// Where staff paste the same code: an UNPUBLISHED assignment. Staff-only
// editing stops a student forging a code onto it; unpublished stops them
// reading one off it. Both are required, and the server re-checks the
// publish state on every read. See fetchStaffAccessDescription.
const STAFF_PAGE_URL =
  "https://byu.instructure.com/courses/35464/assignments/1500010";

// Instructions only. The server picks the channel from the person's
// Canvas enrolment, so flipping this grants nothing — a student who
// toggles it is still checked against their submission.
let showingStaffSteps = false;

function renderRoleSteps() {
  studentSteps.hidden = showingStaffSteps;
  staffSteps.hidden = !showingStaffSteps;
  roleToggleBtn.textContent = showingStaffSteps
    ? "I'm a student"
    : "I'm a TA or instructor";
}

// Held in storage.local, not just memory: a student opens Canvas in
// another tab, pastes, and comes back — possibly after this page has
// been reloaded. Regenerating the code in between would strand the one
// they already submitted.
let currentCode = null;

async function loadOrCreateCode() {
  const { connectCode } = await chrome.storage.local.get("connectCode");
  if (typeof connectCode === "string" && normalizeConnectCode(connectCode).length === 8) {
    currentCode = connectCode;
  } else {
    currentCode = generateConnectCode();
    await chrome.storage.local.set({ connectCode: currentCode });
  }
  renderCode();
}

function renderCode() {
  connectCodeEl.textContent = formatConnectCode(currentCode ?? "");
}

async function regenerateCode() {
  currentCode = generateConnectCode();
  await chrome.storage.local.set({ connectCode: currentCode });
  renderCode();
  setStatusWorking(
    step1Status,
    "New code generated — submit this one to Canvas instead.",
  );
}

// Pre-fill the display name from an existing student doc, once the
// student has typed a netID that looks real.
let lastPrefilledForNetID = null;
async function maybePrefillProfile(netID) {
  if (!netID || netID === lastPrefilledForNetID) return;
  lastPrefilledForNetID = netID;
  try {
    const student = await fetchStudent(netID);
    if (student && !nameInput.value.trim() && typeof student.name === "string") {
      nameInput.value = student.name;
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
        "That netID isn't on the CS 393 roster in Canvas. Check the " +
        "spelling — it's the name you sign in to Canvas with, like " +
        "jack684. If you just enrolled, Canvas can take a few hours to " +
        "sync."
      );
    // The two states a student is most likely to land in, so both say
    // exactly what to do rather than describing what went wrong.
    case "code-not-submitted":
      return (
        "We don't see a submission yet. Open the Connect Your Account " +
        "assignment in Canvas, paste your code as the submission, and " +
        "submit it — then click Verify again."
      );
    // Staff only: Canvas doesn't let teaching roles submit to
    // assignments, so they prove it on a staff-only page instead.
    case "code-not-on-staff-page":
      return (
        "We don't see your code on the TA Access assignment. Open it in " +
        "Canvas, click Edit, add your code on its own line in the " +
        "description, and save — then click Verify again."
      );
    case "code-mismatch":
      return (
        "The code in your Canvas submission doesn't match the one above. " +
        "Submit this exact code to the assignment, then click Verify " +
        "again. Resubmitting replaces your earlier attempt."
      );
    case "permission-denied":
      return (
        "We couldn't confirm that Canvas account is yours. Make sure you " +
        "submitted the code while signed in to Canvas as yourself."
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
  const { leetcodeAuth } = await chrome.storage.local.get("leetcodeAuth");
  renderLeetcodeState(leetcodeAuth);
  await loadOrCreateCode();
})();

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes.leetcodeAuth) {
    renderLeetcodeState(changes.leetcodeAuth.newValue);
  }
});

// ---- Step 0: Welcome ---------------------------------------------------

welcomeContinueBtn.addEventListener("click", () => {
  showStep(1);
});

// ---- Step 1: connection-code buttons -----------------------------------

openAssignmentBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: CONNECT_ASSIGNMENT_URL, active: true });
});

openStaffPageBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: STAFF_PAGE_URL, active: true });
});

roleToggleBtn.addEventListener("click", () => {
  showingStaffSteps = !showingStaffSteps;
  renderRoleSteps();
  clearStatus(step1Status);
});

copyCodeBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(formatConnectCode(currentCode ?? ""));
    setStatusSuccess(step1Status, "Code copied. Paste it into the Canvas assignment.");
  } catch {
    // Clipboard access can be refused; the code is on screen regardless.
    setStatusWorking(step1Status, "Couldn't copy — select the code above and copy it.");
  }
});

newCodeBtn.addEventListener("click", regenerateCode);

// ---- Step 1 submit -----------------------------------------------------

step1Form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const netID = netidInput.value.trim().toLowerCase();
  if (!NETID_REGEX.test(netID)) {
    setStatusError(step1Status, "That doesn't look like a BYU netID. Example: jack684");
    return;
  }
  if (!currentCode) {
    setStatusError(step1Status, "No connection code yet — reload this page.");
    return;
  }
  const name = nameInput.value.trim();

  step1SubmitBtn.disabled = true;
  setStatusWorking(step1Status, "Checking your Canvas submission…");
  let canvasUserId = null;
  try {
    // signIn() runs verifyStudent → signInWithCustomToken → caches the
    // Firebase ID token. verifyStudent reads the student's Canvas
    // submission with the course token and checks the code is in it.
    ({ canvasUserId } = await signIn(netID, currentCode));

    setStatusWorking(step1Status, "Saving…");
    await chrome.storage.sync.set({ netID, canvasUserId });

    const fields = {};
    if (name) fields.name = name;
    // canvasUserId is REQUIRED for auto-submit to masquerade as this
    // student. Persist it on the Firestore doc even when the display name
    // is empty so Cloud Functions can look it up later.
    if (canvasUserId != null) fields.canvasUserId = canvasUserId;
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
