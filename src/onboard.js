// Onboarding form: collect a netID and save it to chrome.storage.sync so
// it follows the student across their Chrome installs. Other parts of
// the extension read this key to identify the active student.

const form = document.getElementById("onboard-form");
const input = document.getElementById("input-netid");
const status = document.getElementById("onboard-status");

// netID format: 1–8 lowercase letters followed by optional digits.
// (BYU netIDs are usually surname-initials + a number.)
const NETID_REGEX = /^[a-z][a-z0-9]{1,15}$/;

(async () => {
  const { netID } = await chrome.storage.sync.get("netID");
  if (netID) {
    input.value = netID;
    status.textContent = `Already set up as ${netID}. You can update it below.`;
  }
})();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const value = input.value.trim().toLowerCase();

  if (!NETID_REGEX.test(value)) {
    status.textContent = "That doesn't look like a valid netID.";
    status.className = "onboard-status error";
    return;
  }

  status.textContent = "Saving…";
  status.className = "onboard-status";
  try {
    await chrome.storage.sync.set({ netID: value });
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
