// Thin wrapper around Firestore's REST API. Shared by dashboard.js and
// onboard.js. The LeetCode content script can't use module imports
// (MV3 content script limitation), so it inlines its own copy of these
// helpers.
import { firebaseConfig } from "./firebase-config.js";

const FIRESTORE_BASE =
  `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}` +
  `/databases/(default)/documents`;

// Generic GET for any Firestore doc. Returns parsed fields object or
// null on 404.
export async function fetchDoc(path) {
  const url = `${FIRESTORE_BASE}/${path}?key=${firebaseConfig.apiKey}`;
  const response = await fetch(url);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Firestore GET ${response.status}: ${response.statusText}`);
  }
  const data = await response.json();
  return parseFirestoreFields(data.fields);
}

// Generic PATCH for any Firestore doc. Uses updateMask so only the
// named fields are touched; creates the doc if it doesn't exist yet.
export async function patchDoc(path, fields) {
  const mask = Object.keys(fields)
    .map((f) => `updateMask.fieldPaths=${encodeURIComponent(f)}`)
    .join("&");
  const url = `${FIRESTORE_BASE}/${path}?${mask}&key=${firebaseConfig.apiKey}`;
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
// Arrays are nested: arrayValue.values is itself a list of type-tagged
// values, which we unwrap recursively.
function parseFirestoreFields(fields) {
  const result = {};
  for (const [key, valueObj] of Object.entries(fields || {})) {
    result[key] = unwrapFirestoreValue(valueObj);
  }
  return result;
}

function unwrapFirestoreValue(valueObj) {
  const type = Object.keys(valueObj)[0];
  const value = valueObj[type];
  if (type === "arrayValue") {
    return (value.values ?? []).map(unwrapFirestoreValue);
  }
  if (type === "mapValue") {
    return parseFirestoreFields(value.fields);
  }
  return value;
}

function encodeFirestoreFields(obj) {
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = encodeFirestoreValue(value);
  }
  return result;
}

function encodeFirestoreValue(value) {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "number") return { doubleValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(encodeFirestoreValue) } };
  }
  if (typeof value === "object" && value !== null) {
    return { mapValue: { fields: encodeFirestoreFields(value) } };
  }
  throw new Error(`Unsupported field value type: ${typeof value}`);
}
