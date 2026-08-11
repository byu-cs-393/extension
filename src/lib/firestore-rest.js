// Firestore REST encoding + writes for CONTENT SCRIPTS.
//
// src/firestore.js does the same job for extension pages, but it reaches
// auth.js for token refresh, which content scripts can't do — they read
// whatever token the extension last cached. Keeping the two separate is
// deliberate; merging them would drag page-only auth machinery into every
// LeetCode tab.
//
// Before bundling, each content script carried its own copy of all of
// this. keystroke-tracker.js, leetcode-tracker.js and leetcode-auth.js
// had three near-identical encoders that were free to drift apart.
import { firebaseConfig } from "../firebase-config.js";

export const FIRESTORE_BASE =
  `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}` +
  `/databases/(default)/documents`;

export { firebaseConfig };

// Firestore's REST API wants every value type-tagged.
export function encodeFirestoreValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "number") return { doubleValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(encodeFirestoreValue) } };
  }
  if (typeof value === "object") {
    return { mapValue: { fields: encodeFirestoreFields(value) } };
  }
  throw new Error(`Unsupported field value type: ${typeof value}`);
}

// `undefined` fields are dropped rather than encoded as null, so a
// partially-filled object doesn't blank out existing document fields.
export function encodeFirestoreFields(obj) {
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    result[key] = encodeFirestoreValue(value);
  }
  return result;
}

export async function getStoredFirebaseIdToken() {
  const { firebaseAuth } = await chrome.storage.local.get("firebaseAuth");
  return firebaseAuth?.idToken ?? null;
}

// Authorization header for a direct fetch, when the caller builds its
// own request (activity POSTs, GraphQL-adjacent calls). Returns the extra
// headers unchanged if no token is cached, so callers fail on the
// response rather than here.
export async function authedHeaders(extra = {}) {
  const idToken = await getStoredFirebaseIdToken();
  const headers = { ...extra };
  if (idToken) headers.Authorization = `Bearer ${idToken}`;
  return headers;
}

// PATCH with an updateMask, so only the named fields are touched and the
// document is created if it doesn't exist.
export async function patchFirestoreDoc(path, fields) {
  const idToken = await getStoredFirebaseIdToken();
  if (!idToken) throw new Error("no Firebase ID token cached");
  const mask = Object.keys(fields)
    .map((f) => `updateMask.fieldPaths=${encodeURIComponent(f)}`)
    .join("&");
  const url = `${FIRESTORE_BASE}/${path}?${mask}&key=${firebaseConfig.apiKey}`;
  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${idToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields: encodeFirestoreFields(fields) }),
  });
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Firestore PATCH ${path} ${response.status}: ${errorBody}`);
  }
  return response.json();
}
