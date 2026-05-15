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

function renderStudent(student) {
  const nameEl = document.getElementById("student-name");
  nameEl.textContent = student?.name || "friend";
}

async function loadAndRender() {
  try {
    const student = await fetchStudent(STUDENT_NETID);
    console.log("Loaded student from Firestore:", student);
    renderStudent(student);
  } catch (error) {
    console.error("Failed to load student:", error);
    document.getElementById("student-name").textContent = "friend";
  }
}

loadAndRender();
