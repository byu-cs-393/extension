import { fetchStudent } from "./firestore.js";

async function getNetID() {
  const { netID } = await chrome.storage.sync.get("netID");
  return netID || null;
}

function renderStudent(student) {
  const nameEl = document.getElementById("student-name");
  nameEl.textContent = student?.name || "friend";
}

async function loadAndRender(netID) {
  try {
    const student = await fetchStudent(netID);
    console.log("Loaded student from Firestore:", student);
    renderStudent(student);
  } catch (error) {
    console.error("Failed to load student:", error);
    document.getElementById("student-name").textContent = "friend";
  }
}

function wireProfileMenu() {
  const button = document.getElementById("profile-button");
  const dropdown = document.getElementById("profile-dropdown");
  const signOutBtn = document.getElementById("sign-out-btn");

  function close() {
    dropdown.hidden = true;
    button.setAttribute("aria-expanded", "false");
  }

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    const wasHidden = dropdown.hidden;
    dropdown.hidden = !wasHidden;
    button.setAttribute("aria-expanded", String(wasHidden));
  });

  // Close on outside click.
  document.addEventListener("click", (event) => {
    if (!dropdown.hidden && !dropdown.contains(event.target)) close();
  });

  // Close on Escape.
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !dropdown.hidden) close();
  });

  signOutBtn.addEventListener("click", async () => {
    await chrome.storage.sync.remove("netID");
    window.location.href = chrome.runtime.getURL("onboard.html");
  });
}

(async () => {
  const netID = await getNetID();
  if (!netID) {
    window.location.href = chrome.runtime.getURL("onboard.html");
    return;
  }
  loadAndRender(netID);
  wireProfileMenu();
})();
