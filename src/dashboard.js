import { firebaseConfig } from "./firebase-config.js";

// Fetch a student document from Firestore via the REST API.
// Skipping the Firebase JS SDK for now — no bundler set up yet.
async function fetchStudent(netID) {
  const url =
    `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}` +
    `/databases/(default)/documents/students/${netID}` +
    `?key=${firebaseConfig.apiKey}`;

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

(async () => {
  try {
    const student = await fetchStudent("test123");
    console.log("Loaded student from Firestore:", student);
  } catch (error) {
    console.error("Failed to load student:", error);
  }
})();
