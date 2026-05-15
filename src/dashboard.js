import { firebaseConfig } from "./firebase-config.js";

// Hardcoded until onboarding wires the real netID into extension storage.
const STUDENT_NETID = "test123";

const FIRESTORE_BASE =
  `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}` +
  `/databases/(default)/documents`;

// Skipping the Firebase JS SDK for now — no bundler set up yet.
async function fetchStudent(netID) {
  const url = `${FIRESTORE_BASE}/students/${netID}?key=${firebaseConfig.apiKey}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Firestore returned ${response.status}: ${response.statusText}`);
  }
  const data = await response.json();
  return parseFirestoreFields(data.fields);
}

// PATCH with updateMask only touches the listed fields, leaving the rest alone.
async function updateStudent(netID, fields) {
  const mask = Object.keys(fields)
    .map((f) => `updateMask.fieldPaths=${encodeURIComponent(f)}`)
    .join("&");
  const url = `${FIRESTORE_BASE}/students/${netID}?${mask}&key=${firebaseConfig.apiKey}`;
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields: encodeFirestoreFields(fields) }),
  });
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Firestore PATCH ${response.status}: ${errorBody}`);
  }
  return response.json();
}

// Firestore REST wraps each field value in a type tag, e.g.
//   { netID: { stringValue: "test123" } }
// → { netID: "test123" }
function parseFirestoreFields(fields) {
  const result = {};
  for (const [key, valueObj] of Object.entries(fields || {})) {
    const type = Object.keys(valueObj)[0];
    result[key] = valueObj[type];
  }
  return result;
}

function encodeFirestoreFields(obj) {
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string") result[key] = { stringValue: value };
    else if (typeof value === "number") result[key] = { doubleValue: value };
    else if (typeof value === "boolean") result[key] = { booleanValue: value };
    else throw new Error(`Unsupported field type for ${key}: ${typeof value}`);
  }
  return result;
}

function renderStudent(student) {
  const nameEl = document.getElementById("student-name");
  nameEl.textContent = student?.name || "friend";
}

async function loadAndRender() {
  try {
    const student = await fetchStudent(STUDENT_NETID);
    console.log("Loaded student from Firestore:", student);
    renderStudent(student);
    document.getElementById("input-name").value = student?.name ?? "";
    document.getElementById("input-note").value = student?.note ?? "";
  } catch (error) {
    console.error("Failed to load student:", error);
    document.getElementById("student-name").textContent = "friend";
  }
}

function wireForm() {
  const form = document.getElementById("student-form");
  const status = document.getElementById("form-status");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = document.getElementById("input-name").value.trim();
    const note = document.getElementById("input-note").value.trim();

    const fields = {};
    if (name) fields.name = name;
    if (note) fields.note = note;
    if (Object.keys(fields).length === 0) {
      status.textContent = "Nothing to save — fill at least one field.";
      status.className = "debug-status error";
      return;
    }

    status.textContent = "Saving…";
    status.className = "debug-status";
    try {
      await updateStudent(STUDENT_NETID, fields);
      status.textContent = "Saved.";
      status.className = "debug-status success";
      await loadAndRender();
    } catch (error) {
      console.error(error);
      status.textContent = `Failed: ${error.message}`;
      status.className = "debug-status error";
    }
  });
}

loadAndRender();
wireForm();
