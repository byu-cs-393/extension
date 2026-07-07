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
const { getFirestore } = require("firebase-admin/firestore");

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

// ---- dryRunGrades ------------------------------------------------------
//
// Phase 1 of Canvas grade sync: computes what every enrolled student's
// grade WOULD be, based on Firestore data, and writes the result to
// `gradeSyncLog/{runId}`. Does NOT talk to Canvas. Use this to sanity-
// check the rubric against manually-computed grades before we wire up
// real Canvas writes.
//
// Auth: caller must present a Firebase ID token whose uid is in
// INSTRUCTOR_ALLOWLIST below. Same allowlist must be duplicated in
// firestore.rules for `gradeSyncLog` read access — if you edit one,
// edit the other.
//
// Input: POST with empty body (nothing to configure yet).
//
// Success response:
//   { runId, studentsProcessed, weeksProcessed, warningsCount,
//     warnings: [...first 20], logPath }
//
// Grade computation per (student, week):
//   - recommended: count solves of any week.problems slug whose
//     timestamp falls in [startDate, endDate)
//   - thirdCard (if present): 0 or 1 based on progress doc:
//        topicExam        → progress.status === "passed"
//        onlineAssessment → progress.finalStatus === "passed"
//        mockInterview    → progress.status === "completed"

const CLASS_ID = "cs393";
const INSTRUCTOR_ALLOWLIST = ["jack684"]; // keep in sync with firestore.rules

exports.dryRunGrades = onRequest(
  { region: "us-central1" },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Use POST.", code: "method-not-allowed" });
      return;
    }

    // ---- Auth check ----
    const authHeader = req.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "Missing Bearer token.", code: "unauthenticated" });
      return;
    }
    let decoded;
    try {
      decoded = await getAuth().verifyIdToken(authHeader.slice(7));
    } catch (err) {
      res.status(401).json({ error: "Invalid ID token.", code: "unauthenticated" });
      return;
    }
    if (!INSTRUCTOR_ALLOWLIST.includes(decoded.uid)) {
      res.status(403).json({
        error: `${decoded.uid} is not on the instructor allowlist.`,
        code: "permission-denied",
      });
      return;
    }

    const startedAt = Date.now();
    const db = getFirestore();

    // ---- Fetch weeks + students in parallel ----
    const [weeksSnap, studentsSnap] = await Promise.all([
      db.collection(`classes/${CLASS_ID}/weeks`).get(),
      db.collection("students").get(),
    ]);

    const now = Date.now();
    const weeks = weeksSnap.docs
      .map((d) => d.data())
      .filter((w) => Number.isFinite(w?.startDate) && w.startDate <= now)
      .sort((a, b) => a.weekNum - b.weekNum);

    // ---- Fetch each student's weekProgress in parallel ----
    const progressByStudent = {};
    await Promise.all(
      studentsSnap.docs.map(async (doc) => {
        const netID = doc.id;
        const snap = await db.collection(`students/${netID}/weekProgress`).get();
        const byWeek = {};
        for (const p of snap.docs) {
          const data = p.data();
          if (Number.isFinite(data?.weekNum)) {
            byWeek[data.weekNum] = data;
          }
        }
        progressByStudent[netID] = byWeek;
      })
    );

    // ---- Compute grades ----
    const warnings = [];
    const results = {}; // netID -> weekNum -> row
    const flatRows = [];

    for (const studentDoc of studentsSnap.docs) {
      const netID = studentDoc.id;
      const student = studentDoc.data();
      const solves =
        student?.solvedProblems && typeof student.solvedProblems === "object"
          ? student.solvedProblems
          : {};
      const progressByWeek = progressByStudent[netID] ?? {};
      results[netID] = {};

      for (const week of weeks) {
        const weekNum = week.weekNum;
        const problems = Array.isArray(week.problems) ? week.problems : [];
        if (problems.length === 0) {
          warnings.push(`Week ${weekNum} has no problems array`);
        }

        // Recommended: count solves of listed problems whose timestamp
        // falls in [startDate, endDate). endDate is exclusive per the
        // week-doc contract.
        const recSolved = problems.filter((p) => {
          const ts = solves[p?.slug];
          return (
            typeof ts === "number" &&
            ts >= week.startDate &&
            ts < week.endDate
          );
        }).length;
        const recTotal = problems.length;

        // Third card (optional)
        let thirdCard = null;
        if (week.thirdCard && week.thirdCard.type) {
          const type = week.thirdCard.type;
          const progress = progressByWeek[weekNum];
          let earned = 0;
          if (progress) {
            if (type === "topicExam" && progress.status === "passed") earned = 1;
            else if (type === "onlineAssessment" && progress.finalStatus === "passed") earned = 1;
            else if (type === "mockInterview" && progress.status === "completed") earned = 1;
            else if (
              type !== "topicExam" &&
              type !== "onlineAssessment" &&
              type !== "mockInterview"
            ) {
              warnings.push(`Unknown thirdCard type "${type}" on week ${weekNum}`);
            }
          }
          thirdCard = { type, earned, total: 1 };
        }

        const row = {
          recSolved,
          recTotal,
          thirdCard,
        };
        results[netID][weekNum] = row;

        // Flat rows: one per Canvas gradebook column. Recommended
        // always emits a row; thirdCard emits a row only if the week
        // has one. Each carries the intent shape Phase 2 will use.
        flatRows.push({
          netID,
          weekNum,
          category: "recommended",
          points: recSolved,
          maxPoints: recTotal,
          wouldPush: {
            canvasAssignmentId: week.canvasAssignmentId ?? null,
            points: recSolved,
            maxPoints: recTotal,
          },
        });
        if (thirdCard) {
          flatRows.push({
            netID,
            weekNum,
            category: "thirdCard",
            subtype: thirdCard.type,
            points: thirdCard.earned,
            maxPoints: thirdCard.total,
            wouldPush: {
              canvasAssignmentId: week.thirdCard.canvasAssignmentId ?? null,
              points: thirdCard.earned,
              maxPoints: thirdCard.total,
            },
          });
        }
      }
    }

    // ---- Write the log doc ----
    // Doc ID keeps the ISO timestamp so runs sort naturally in the
    // Firestore console. Colons → dashes because URLs and paths.
    const runId = `dryRun-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
    const finishedAt = Date.now();
    await db.doc(`gradeSyncLog/${runId}`).set({
      startedAt,
      finishedAt,
      triggeredBy: decoded.uid,
      classId: CLASS_ID,
      studentsProcessed: studentsSnap.size,
      weeksProcessed: weeks.length,
      results,
      flatRows,
      warnings,
    });

    res.status(200).json({
      runId,
      logPath: `gradeSyncLog/${runId}`,
      studentsProcessed: studentsSnap.size,
      weeksProcessed: weeks.length,
      warningsCount: warnings.length,
      warnings: warnings.slice(0, 20),
    });
  }
);
