// Thin wrapper around Firestore's REST API. Shared by dashboard.js and
// onboard.js. The LeetCode content script can't use module imports
// (MV3 content script limitation), so it inlines its own copy of these
// helpers.
import { firebaseConfig } from "./firebase-config.js";

const FIRESTORE_BASE =
  `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}` +
  `/databases/(default)/documents`;

// Returns the parsed student doc, or null if it doesn't exist yet.
export async function fetchStudent(netID) {
  const url = `${FIRESTORE_BASE}/students/${netID}?key=${firebaseConfig.apiKey}`;
  const response = await fetch(url);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Firestore GET ${response.status}: ${response.statusText}`);
  }
  const data = await response.json();
  return parseFirestoreFields(data.fields);
}

// PATCH with updateMask only touches the listed fields, leaving the
// rest alone. Creates the document if it doesn't exist yet.
export async function updateStudent(netID, fields) {
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
//   { name: { stringValue: "Jack" } }
// → { name: "Jack" }
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
