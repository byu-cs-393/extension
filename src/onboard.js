import { fetchStudent, updateStudent } from "./firestore.js";

// Two-step wizard:
//   Step 1 — BYU info: netID (required), display name + status note (optional).
//   Step 2 — LeetCode link: detect via leetcode-auth content script,
//            confirm identity, save linked username.

// ---- Step 1 references -------------------------------------------------

const step1Panel = document.querySelector('.step-panel[data-step="1"]');
const step1Form = document.getElementById("step1-form");
const netidInput = document.getElementById("input-netid");
const studentIdInput = document.getElementById("input-studentid");
const nameInput = document.getElementById("input-name");
const noteInput = document.getElementById("input-note");
const step1Status = document.getElementById("step1-status");
const canvasBanner = document.getElementById("canvas-banner");
const canvasBannerNetid = document.getElementById("canvas-banner-netid");

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

// Step indicator pills.
const stepPills = document.querySelectorAll(".step-indicator .step");

// ---- Validation --------------------------------------------------------

// netID format: 1–8 lowercase letters followed by optional digits.
// (BYU netIDs are usually surname-initials + a number.)
const NETID_REGEX = /^[a-z][a-z0-9]{1,15}$/;

// BYU Student ID: 9 digits. The student may type with dashes
// (12-345-6789) or without — we normalize to digits-only before saving.
const STUDENT_ID_DIGITS_REGEX = /^\d{9}$/;

function normalizeStudentId(raw) {
  return raw.replace(/[^0-9]/g, "");
}

function formatStudentId(digits) {
  if (digits.length !== 9) return digits;
  return `${digits.slice(0, 2)}-${digits.slice(2, 5)}-${digits.slice(5)}`;
}

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

// ---- Canvas auto-fill --------------------------------------------------

// Fill the netID / name inputs from Canvas if they're empty AND Canvas
// reports a signed-in session. Doesn't overwrite a value the student
// already typed.
function applyCanvasAuth(auth) {
  if (!auth?.signedIn || !auth.netID) {
    canvasBanner.hidden = true;
    return;
  }
  const netidCandidate = String(auth.netID).toLowerCase();
  if (NETID_REGEX.test(netidCandidate) && !netidInput.value.trim()) {
    netidInput.value = netidCandidate;
  }
  if (auth.name && !nameInput.value.trim()) {
    nameInput.value = auth.name;
  }
  canvasBannerNetid.textContent = netidCandidate;
  canvasBanner.hidden = false;
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
  const { netID, studentID, leetcodeUsername } = await chrome.storage.sync.get([
    "netID",
    "studentID",
    "leetcodeUsername",
  ]);
  if (studentID) {
    studentIdInput.value = formatStudentId(studentID);
  }
  if (!netID) {
    showStep(1);
    return;
  }

  netidInput.value = netID;
  try {
    const student = await fetchStudent(netID);
    if (student) {
      nameInput.value = student.name ?? "";
      noteInput.value = student.note ?? "";
    }
  } catch (error) {
    console.error("Failed to fetch existing student:", error);
  }

  // If the student already finished step 2 previously, drop them on
  // step 2 so they can re-confirm or change accounts.
  if (leetcodeUsername) {
    showStep(2);
  } else {
    showStep(1);
    step1Status.textContent = `Already set up as ${netID}.`;
  }
})();

// Render LeetCode + Canvas state from whatever's already in local
// storage. Then keep both live via onChanged.
(async () => {
  const { leetcodeAuth, canvasAuth } = await chrome.storage.local.get([
    "leetcodeAuth",
    "canvasAuth",
  ]);
  renderLeetcodeState(leetcodeAuth);
  applyCanvasAuth(canvasAuth);
})();

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes.leetcodeAuth) {
    renderLeetcodeState(changes.leetcodeAuth.newValue);
  }
  if (changes.canvasAuth) {
    applyCanvasAuth(changes.canvasAuth.newValue);
  }
});

// ---- Step 1 submit -----------------------------------------------------

step1Form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const netID = netidInput.value.trim().toLowerCase();
  const studentID = normalizeStudentId(studentIdInput.value);
  const name = nameInput.value.trim();
  const note = noteInput.value.trim();

  if (!NETID_REGEX.test(netID)) {
    step1Status.textContent = "That doesn't look like a valid netID.";
    step1Status.className = "onboard-status error";
    return;
  }
  if (!STUDENT_ID_DIGITS_REGEX.test(studentID)) {
    step1Status.textContent = "Student ID should be 9 digits (e.g. 12-345-6789).";
    step1Status.className = "onboard-status error";
    return;
  }

  step1Status.textContent = "Saving…";
  step1Status.className = "onboard-status";
  try {
    // netID + studentID stay local (sync storage). studentID is a "soft
    // secret" used by the eventual Cloud Function for identity
    // verification; it doesn't belong in any public student doc.
    await chrome.storage.sync.set({ netID, studentID });
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

// Force the auth content script to re-run by reloading any open leetcode
// tab. If none is open, open one — same as "Open leetcode.com".
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
  // Sign them out so they can sign in with a different account. LeetCode
  // redirects to the login page after logout.
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
