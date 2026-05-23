import { fetchStudent, updateStudent } from "./firestore.js";

// Onboarding form: collect a netID (saved to chrome.storage.sync) plus
// optional display name and status note (saved to the student doc in
// Firestore). Other parts of the extension read the netID to identify
// the active student.

const form = document.getElementById("onboard-form");
const netidInput = document.getElementById("input-netid");
const nameInput = document.getElementById("input-name");
const noteInput = document.getElementById("input-note");
const status = document.getElementById("onboard-status");

// netID format: 1–8 lowercase letters followed by optional digits.
// (BYU netIDs are usually surname-initials + a number.)
const NETID_REGEX = /^[a-z][a-z0-9]{1,15}$/;

(async () => {
  const { netID } = await chrome.storage.sync.get("netID");
  if (!netID) return;
  netidInput.value = netID;
  status.textContent = `Already set up as ${netID}. You can update your info below.`;
  try {
    const student = await fetchStudent(netID);
    if (student) {
      nameInput.value = student.name ?? "";
      noteInput.value = student.note ?? "";
    }
  } catch (error) {
    console.error("Failed to fetch existing student:", error);
  }
})();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const netID = netidInput.value.trim().toLowerCase();
  const name = nameInput.value.trim();
  const note = noteInput.value.trim();

  if (!NETID_REGEX.test(netID)) {
    status.textContent = "That doesn't look like a valid netID.";
    status.className = "onboard-status error";
    return;
  }

  status.textContent = "Saving…";
  status.className = "onboard-status";
  try {
    await chrome.storage.sync.set({ netID });

    const fields = {};
    if (name) fields.name = name;
    if (note) fields.note = note;
    if (Object.keys(fields).length > 0) {
      await updateStudent(netID, fields);
    }

    status.textContent = "Saved. Opening dashboard…";
    status.className = "onboard-status success";
    setTimeout(() => {
      window.location.href = chrome.runtime.getURL("dashboard.html");
    }, 500);
  } catch (error) {
    console.error(error);
    status.textContent = `Failed: ${error.message}`;
    status.className = "onboard-status error";
  }
});
