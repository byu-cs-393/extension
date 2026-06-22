// verifyStudent — Canvas-backed identity verification.
//
// Plain HTTPS function (onRequest, not onCall). Reasoning: this
// project is in an org-less Google Cloud setup where the
// `iam.managed.allowedPolicyMembers` default constraint blocks
// `allUsers` from being granted Cloud Run Invoker, and there's no
// organization to override the constraint at. So callable functions
// can't be invoked by a public extension. For now we use onRequest
// and gate access at Cloud Run IAM (the caller must hold a Google
// identity with Invoker on this service). Production-access strategy
// (domain-restricted IAM, separate deployment, etc.) is a follow-up.
//
// Expected request shape (POST, application/json):
//   { "netID": "jdoe7", "ltiUserId": "<40-char hex>" }
//
// Successful response:
//   { "token": "<Firebase custom token>" }
//
// Errors return HTTP 4xx with { "error": "...", "code": "..." }.

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");

initializeApp();

// Instructor (or admin) Canvas API token. Set once with:
//   firebase functions:secrets:set CANVAS_API_TOKEN
// Token must have permission to look up student profiles via
// /api/v1/users/sis_login_id:<netID>/profile.
const canvasToken = defineSecret("CANVAS_API_TOKEN");

const CANVAS_BASE = "https://byu.instructure.com";

// netID: starts with a lowercase letter, then up to 15 letters/digits.
const NETID_REGEX = /^[a-z][a-z0-9]{1,15}$/;
// lti_user_id is a 40-char hex (SHA-1) hash.
const LTI_USER_ID_REGEX = /^[a-f0-9]{40}$/;

// Two-step Canvas lookup: resolve the netID to a Canvas internal user
// ID, then fetch that user's full profile (which includes lti_user_id
// when the calling token has sufficient permission).
async function fetchCanvasProfile(netID, token) {
  const auth = { Authorization: `Bearer ${token}`, Accept: "application/json" };

  const lookupResp = await fetch(`${CANVAS_BASE}/api/v1/users/sis_login_id:${netID}`, {
    headers: auth,
  });
  if (lookupResp.status === 404) return null;
  if (!lookupResp.ok) {
    const body = await lookupResp.text();
    throw new Error(`Canvas user lookup ${lookupResp.status}: ${body}`);
  }
  const user = await lookupResp.json();
  if (!user?.id) return null;

  const profileResp = await fetch(`${CANVAS_BASE}/api/v1/users/${user.id}/profile`, {
    headers: auth,
  });
  if (!profileResp.ok) {
    const body = await profileResp.text();
    throw new Error(`Canvas profile fetch ${profileResp.status}: ${body}`);
  }
  return profileResp.json();
}

exports.verifyStudent = onRequest(
  { secrets: [canvasToken], region: "us-central1" },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Use POST.", code: "method-not-allowed" });
      return;
    }

    const { netID, ltiUserId } = req.body ?? {};

    if (typeof netID !== "string" || !NETID_REGEX.test(netID)) {
      res.status(400).json({ error: "Invalid netID.", code: "invalid-argument" });
      return;
    }
    if (typeof ltiUserId !== "string" || !LTI_USER_ID_REGEX.test(ltiUserId)) {
      res.status(400).json({ error: "Invalid lti_user_id.", code: "invalid-argument" });
      return;
    }

    let profile;
    try {
      profile = await fetchCanvasProfile(netID, canvasToken.value());
    } catch (err) {
      console.error("Canvas lookup failed:", err);
      res.status(500).json({ error: "Canvas lookup failed.", code: "internal" });
      return;
    }
    if (!profile) {
      res.status(404).json({ error: "netID not found in Canvas.", code: "not-found" });
      return;
    }

    if (typeof profile.lti_user_id !== "string" || profile.lti_user_id !== ltiUserId) {
      res.status(403).json({
        error: "Canvas lti_user_id does not match the netID.",
        code: "permission-denied",
      });
      return;
    }

    const customToken = await getAuth().createCustomToken(netID);
    res.status(200).json({ token: customToken });
  }
);
