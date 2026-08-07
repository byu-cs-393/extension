// Thin wrapper around Firestore's REST API. Shared by dashboard.js and
// onboard.js. The LeetCode content scripts can't use module imports
// (MV3 content script limitation), so they inline their own copies of
// these helpers.
import { firebaseConfig } from "./firebase-config.js";
import { getIdToken } from "./auth.js";

const FIRESTORE_BASE =
  `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}` +
  `/databases/(default)/documents`;

// All Firestore calls go through this so they pick up the current
// Firebase Auth ID token from auth.js (which transparently refreshes
// when near expiry). Firestore rules then enforce request.auth.uid
// for per-user access.
async function authedFetch(url, options = {}) {
  const idToken = await getIdToken();
  const headers = { ...(options.headers ?? {}) };
  if (idToken) headers.Authorization = `Bearer ${idToken}`;
  return fetch(url, { ...options, headers });
}

// Generic GET for any Firestore doc. Returns parsed fields object or
// null on 404.
export async function fetchDoc(path) {
  const url = `${FIRESTORE_BASE}/${path}?key=${firebaseConfig.apiKey}`;
  const response = await authedFetch(url);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Firestore GET ${response.status}: ${response.statusText}`);
  }
  const data = await response.json();
  return parseFirestoreFields(data.fields);
}

// Generic LIST for any Firestore collection or subcollection.
//
// Follows nextPageToken to completion. Firestore's REST listDocuments
// defaults to 20 documents per page and caps at 300, so without this a
// collection larger than 20 came back silently truncated — fine for a
// 15-doc weekProgress collection, wrong for a class roster or a
// keystroke session's chunks, where partial data reads as complete.
export async function fetchCollection(path) {
  const documents = [];
  let pageToken = null;

  do {
    const params = new URLSearchParams({
      key: firebaseConfig.apiKey,
      pageSize: "300",
    });
    if (pageToken) params.set("pageToken", pageToken);

    const response = await authedFetch(`${FIRESTORE_BASE}/${path}?${params}`);
    if (response.status === 404) return documents;
    if (!response.ok) {
      throw new Error(`Firestore GET ${response.status}: ${response.statusText}`);
    }
    const data = await response.json();
    for (const doc of data.documents ?? []) {
      documents.push(parseFirestoreFields(doc.fields));
    }
    pageToken = data.nextPageToken ?? null;
  } while (pageToken);

  return documents;
}

// Generic DELETE for any Firestore doc. Treats 404 as success (already
// gone), so callers can call this idempotently.
export async function deleteDoc(path) {
  const url = `${FIRESTORE_BASE}/${path}?key=${firebaseConfig.apiKey}`;
  const response = await authedFetch(url, { method: "DELETE" });
  if (response.status === 404) return;
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Firestore DELETE ${response.status}: ${errorBody}`);
  }
}

// Generic PATCH for any Firestore doc. Uses updateMask so only the
// named fields are touched; creates the doc if it doesn't exist yet.
export async function patchDoc(path, fields) {
  const mask = Object.keys(fields)
    .map((f) => `updateMask.fieldPaths=${encodeURIComponent(f)}`)
    .join("&");
  const url = `${FIRESTORE_BASE}/${path}?${mask}&key=${firebaseConfig.apiKey}`;
  const response = await authedFetch(url, {
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
  return fetchDoc(`students/${netID}`);
}

// PATCH the student doc with the given fields (updateMask semantics).
export async function updateStudent(netID, fields) {
  return patchDoc(`students/${netID}`, fields);
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
  // Firestore's REST returns int64 as a JSON STRING to preserve
  // precision (JS numbers can only hold integers up to 2^53).
  // For our data, all timestamps + counts fit comfortably in a JS
  // number, so convert here. Callers that need bigint should switch
  // to reading the raw value.
  if (type === "integerValue") {
    return Number(value);
  }
  // Firestore's timestampValue comes back as an RFC 3339 string like
  // "2026-07-17T15:30:00Z". Every consumer wants ms-since-epoch to
  // compare against startDate/endDate, so convert here — same
  // reasoning as integerValue above. This unifies the two paths
  // (real activity events use timestampValue, seeded events use
  // integerValue) so downstream code doesn't need to know which
  // wrote a given field.
  if (type === "timestampValue") {
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : null;
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
  if (value === null) return { nullValue: null };
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
