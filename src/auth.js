// Firebase Auth wiring for the extension.
//
// Phase 2 auth chain:
//   1. Extension POSTs (netID, ltiUserId) — captured from the student's
//      own Canvas session — to our verifyStudent endpoint via Firebase
//      Hosting (publicly callable; Hosting authenticates to Cloud Run
//      on our behalf via its service account, sidestepping the org
//      policy that blocks public Cloud Run invocations).
//   2. The Cloud Function independently verifies the (netID, ltiUserId)
//      against Canvas using the instructor's API token. On match it
//      mints a Firebase custom token whose uid is the netID.
//   3. Exchange the custom token for a Firebase ID token via Firebase
//      Auth REST (signInWithCustomToken).
//   4. Cache the Firebase ID token + refresh token in
//      chrome.storage.local. Subsequent Firestore REST calls send the
//      ID token in Authorization: Bearer, and Firestore rules can
//      enforce request.auth.uid == netID.
//   5. Tokens are JWTs valid for ~1 hour. getIdToken() transparently
//      refreshes (~5 min before expiry) using the refresh token.
//
// Note: the security here comes from the lti_user_id check — only the
// real student's Canvas session can see their own lti_user_id. We
// don't need user-side OAuth because the verification happens
// server-side via the instructor token. (BYU students use Microsoft
// for email, not Google, which made a Google-OAuth gate unworkable
// anyway.)

import { firebaseConfig } from "./firebase-config.js";

// Public callable via Firebase Hosting → Cloud Run rewrite.
const VERIFY_STUDENT_URL = "https://cs393-496021.web.app/api/verifyStudent";

const SIGN_IN_URL =
  `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${firebaseConfig.apiKey}`;

const REFRESH_URL = `https://securetoken.googleapis.com/v1/token?key=${firebaseConfig.apiKey}`;

// Refresh the Firebase ID token this many ms before expiry to avoid
// racing the 1-hour TTL on calls that happen right at the boundary.
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

// ---- verifyStudent call ------------------------------------------------

// Thrown by callVerifyStudent when verifyStudent returns a non-2xx.
// The UI switches on `.code` to pick friendly copy; keeping this a
// distinct class avoids fragile string-matching against `.message`.
export class VerifyStudentError extends Error {
  constructor({ code, status, serverMessage }) {
    super(serverMessage || code || `verifyStudent HTTP ${status}`);
    this.name = "VerifyStudentError";
    this.code = code || null; // "not-found" | "permission-denied" | "internal" | "invalid-argument" | "method-not-allowed" | null
    this.status = status; // HTTP status number
  }
}

async function callVerifyStudent(netID, ltiUserId) {
  let response;
  try {
    response = await fetch(VERIFY_STUDENT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ netID, ltiUserId }),
    });
  } catch (networkError) {
    // fetch() throws for network-level failures (offline, DNS, etc.).
    // Give the UI a stable code to distinguish "we couldn't even reach
    // the server" from a server response with a code.
    throw new VerifyStudentError({
      code: "network-error",
      status: 0,
      serverMessage: networkError.message,
    });
  }
  if (!response.ok) {
    let code = null;
    let serverMessage = null;
    // verifyStudent returns { error, code } on 4xx/5xx (see
    // functions/index.js). Some 5xx paths (e.g. Cloud Run 502) return
    // HTML, so guard the JSON parse.
    try {
      const body = await response.json();
      if (body && typeof body === "object") {
        code = body.code ?? null;
        serverMessage = body.error ?? null;
      }
    } catch {
      /* non-JSON body — leave code null and let the UI default to "internal" */
    }
    throw new VerifyStudentError({
      code,
      status: response.status,
      serverMessage,
    });
  }
  const data = await response.json();
  if (!data?.token) {
    throw new VerifyStudentError({
      code: "internal",
      status: response.status,
      serverMessage: "verifyStudent returned no token.",
    });
  }
  return data.token;
}

// ---- Exchange custom token for Firebase ID token -----------------------

async function signInWithCustomToken(customToken) {
  const response = await fetch(SIGN_IN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`signInWithCustomToken ${response.status}: ${body}`);
  }
  const data = await response.json();
  return {
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    expiresIn: Number(data.expiresIn),
  };
}

// ---- Token refresh -----------------------------------------------------

async function refreshTokens(refreshToken) {
  const response = await fetch(REFRESH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`token refresh ${response.status}: ${body}`);
  }
  const data = await response.json();
  return {
    idToken: data.id_token,
    refreshToken: data.refresh_token,
    expiresIn: Number(data.expires_in),
  };
}

// ---- Persistence -------------------------------------------------------

async function storeTokens({ idToken, refreshToken, expiresIn }) {
  const expiresAt = Date.now() + expiresIn * 1000;
  await chrome.storage.local.set({
    firebaseAuth: { idToken, refreshToken, expiresAt },
  });
}

// ---- Public API --------------------------------------------------------

// Run the full sign-in chain. Called by onboarding once we know netID +
// ltiUserId from Canvas.
export async function signIn(netID, ltiUserId) {
  const customToken = await callVerifyStudent(netID, ltiUserId);
  const bundle = await signInWithCustomToken(customToken);
  await storeTokens(bundle);
  return bundle.idToken;
}

// Returns a fresh Firebase ID token, refreshing if near expiry. Returns
// null if the user has never signed in.
export async function getIdToken() {
  const { firebaseAuth } = await chrome.storage.local.get("firebaseAuth");
  if (!firebaseAuth?.idToken) return null;
  if (Date.now() < firebaseAuth.expiresAt - REFRESH_BUFFER_MS) {
    return firebaseAuth.idToken;
  }
  try {
    const refreshed = await refreshTokens(firebaseAuth.refreshToken);
    await storeTokens(refreshed);
    return refreshed.idToken;
  } catch (error) {
    console.error("[CS 393 Buddy] Firebase token refresh failed:", error);
    return null;
  }
}

export async function signOut() {
  await chrome.storage.local.remove("firebaseAuth");
}

// Reads a claim out of the current Firebase ID token without
// re-verifying its signature — we trust the token because it was
// minted by our verifyStudent Cloud Function and Firebase Auth on our
// project. Returns null if no valid token is cached.
//
// The token is a JWT with 3 base64url-encoded segments separated by
// dots: header.payload.signature. We decode the payload only.
function decodeIdTokenPayload(idToken) {
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  try {
    // base64url → base64: swap chars and pad.
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "===".slice((b64.length + 3) % 4);
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

// Returns "ta" if the current signed-in user has the TA role claim
// (added by verifyStudent when Canvas reports them as a TA/instructor
// in course 35464). Returns null otherwise.
export async function getRole() {
  const { firebaseAuth } = await chrome.storage.local.get("firebaseAuth");
  if (!firebaseAuth?.idToken) return null;
  const payload = decodeIdTokenPayload(firebaseAuth.idToken);
  return payload?.role ?? null;
}

// Unconditionally swap the cached ID token for a fresh one. Used by
// the background service worker's periodic refresh — it can't rely on
// the buffer-based check in getIdToken because the alarm may fire
// while the token is still "fresh enough" by that test.
export async function forceRefresh() {
  const { firebaseAuth } = await chrome.storage.local.get("firebaseAuth");
  if (!firebaseAuth?.refreshToken) return null;
  try {
    const refreshed = await refreshTokens(firebaseAuth.refreshToken);
    await storeTokens(refreshed);
    return refreshed.idToken;
  } catch (error) {
    console.error("[CS 393 Buddy] forced refresh failed:", error);
    return null;
  }
}
