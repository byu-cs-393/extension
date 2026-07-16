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
const { onSchedule } = require("firebase-functions/v2/scheduler");
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

// ---- pushCanvasTestGrade -----------------------------------------------
//
// Phase 2 Stage A: minimum-viable proof that we can write to Canvas.
// Ignores Firestore entirely. Hardcoded target: pushes ONE grade to
// ONE test assignment for the course's Test Student. If this returns
// a Canvas 200 and the grade shows up in the gradebook, the plumbing
// is proven and we generalize in Stage B.
//
// Auth: same instructor allowlist as dryRunGrades. Same log
// collection so the audit trail stays chronological.
//
// Once Stage A works, this function is done — Stage B is a separate
// pushCanvasGrades function that reads Firestore.

const CANVAS_TEST_TARGET = {
  courseId: 35464,
  assignmentId: 1380333,
  userId: 169685, // Test Student in course 35464
  grade: "2", // out of 3 possible on the assignment — non-max so we can
  // confirm we're actually setting the value, not just defaulting
};

// Course ID for CS 393 in Canvas. Used by pushCanvasGrades.
// Hardcoded for now; would move to classes/cs393.canvasCourseId
// once we support multiple classes.
const CANVAS_COURSE_ID = 35464;

exports.pushCanvasTestGrade = onRequest(
  { secrets: [canvasToken], region: "us-central1" },
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
    const { courseId, assignmentId, userId, grade } = CANVAS_TEST_TARGET;
    const canvasUrl =
      `${CANVAS_BASE}/api/v1/courses/${courseId}` +
      `/assignments/${assignmentId}/submissions/${userId}`;

    // Canvas's grade-a-submission endpoint. `posted_grade` accepts a
    // string; using string form is safest (matches all Canvas
    // examples). Canvas overwrites any existing grade, so re-runs
    // are safe.
    let canvasStatus = 0;
    let canvasBody = null;
    let networkError = null;
    try {
      const canvasResp = await fetch(canvasUrl, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${canvasToken.value()}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ submission: { posted_grade: String(grade) } }),
      });
      canvasStatus = canvasResp.status;
      // Response might be non-JSON on some error paths (Cloud Run
      // rejections etc.) — guard the parse.
      try {
        canvasBody = await canvasResp.json();
      } catch {
        canvasBody = { note: "response body was not JSON" };
      }
    } catch (err) {
      networkError = err.message ?? String(err);
    }

    const finishedAt = Date.now();
    const outcome =
      networkError == null && canvasStatus >= 200 && canvasStatus < 300
        ? "ok"
        : "failed";

    // Same collection as dryRunGrades logs, distinguished by prefix
    // (`testPush-*`). Keeps chronological history in one place.
    const runId = `testPush-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19)}`;
    const db = getFirestore();
    await db.doc(`gradeSyncLog/${runId}`).set({
      startedAt,
      finishedAt,
      triggeredBy: decoded.uid,
      target: CANVAS_TEST_TARGET,
      canvasStatus,
      canvasBody,
      networkError,
      outcome,
    });

    res.status(outcome === "ok" ? 200 : 502).json({
      runId,
      logPath: `gradeSyncLog/${runId}`,
      outcome,
      canvasStatus,
      networkError,
      canvasBody,
    });
  }
);

// ---- pushCanvasGrades --------------------------------------------------
//
// Phase 2 Stage B: real grade sync driven by Firestore data.
//
// For each (student, week) pair, computes BOTH:
//   - The recommended-problem grade (count of listed problems solved
//     within the week window)
//   - The third-card grade (0 or 1 based on progress doc status)
// and pushes each to its respective Canvas assignment.
//
// Every row skips gracefully if any prerequisite is missing:
//   - week.canvasAssignmentId (recommended)
//   - week.thirdCard.canvasAssignmentId (third card)
//   - student.canvasUserId (either)
//   - week has no thirdCard (skip the third-card push for that week)
//
// Auth: same instructor allowlist as dryRunGrades. Log doc lands
// in the same gradeSyncLog collection under a "push-*" prefix so
// dry-runs and real pushes stay chronologically together.

// Third-card grade is 0 or 1 based on the type-specific "passed" state.
// Returns { earned, total } — matches the shape dryRunGrades uses.
function computeThirdCardGrade(thirdCard, progress) {
  const total = 1;
  let earned = 0;
  if (progress && thirdCard?.type) {
    if (thirdCard.type === "topicExam" && progress.status === "passed") earned = 1;
    else if (thirdCard.type === "onlineAssessment" && progress.finalStatus === "passed") earned = 1;
    else if (thirdCard.type === "mockInterview" && progress.status === "completed") earned = 1;
  }
  return { earned, total };
}

// Single Canvas grade PUT. Returns { canvasStatus, canvasError } for
// the caller to fold into a row outcome. Kept as its own function so
// the recommended + third-card push paths stay symmetric.
async function pushGradeToCanvas({ courseId, assignmentId, userId, grade, token }) {
  const url =
    `${CANVAS_BASE}/api/v1/courses/${courseId}` +
    `/assignments/${assignmentId}/submissions/${userId}`;
  try {
    const resp = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ submission: { posted_grade: String(grade) } }),
    });
    const canvasStatus = resp.status;
    let canvasError = null;
    if (!(canvasStatus >= 200 && canvasStatus < 300)) {
      canvasError = await resp
        .json()
        .catch(() => ({ note: "response body was not JSON" }));
    }
    return { canvasStatus, canvasError };
  } catch (err) {
    return { canvasStatus: 0, canvasError: { message: err.message ?? String(err) } };
  }
}

// Shared implementation used by both the HTTP endpoint and the
// scheduled function. Reads Firestore, computes grades, pushes to
// Canvas, writes a summary to gradeSyncLog. Returns the summary so
// callers can log/return it however they need.
//
// `triggeredBy` — netID for HTTP calls, "system" for scheduled runs.
// `trigger`      — "manual" | "scheduled". Recorded in the log doc
//                   so we can distinguish real-time vs nightly rows.
async function runPushCanvasGrades({ triggeredBy, trigger, token }) {
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

  // ---- Per-row push loop ----
  const results = {};
  const flatRows = [];
  const warnings = [];
  const totals = {
    recommended: { ok: 0, skippedNoAssignment: 0, skippedNoUser: 0, failed: 0 },
    thirdCard: { ok: 0, skippedNoAssignment: 0, skippedNoUser: 0, skippedNoCard: 0, failed: 0 },
  };

  for (const studentDoc of studentsSnap.docs) {
    const netID = studentDoc.id;
    const student = studentDoc.data();
    const solves =
      student?.solvedProblems && typeof student.solvedProblems === "object"
        ? student.solvedProblems
        : {};
    const canvasUserId = student?.canvasUserId ?? null;
    const progressByWeek = progressByStudent[netID] ?? {};
    results[netID] = {};

    for (const week of weeks) {
      const weekNum = week.weekNum;
      const problems = Array.isArray(week.problems) ? week.problems : [];
      const cell = { recommended: null, thirdCard: null };

      // -- Recommended --
      const recSolved = problems.filter((p) => {
        const ts = solves[p?.slug];
        return typeof ts === "number" && ts >= week.startDate && ts < week.endDate;
      }).length;
      const recTotal = problems.length;
      const recAssignmentId = week.canvasAssignmentId ?? null;

      if (recAssignmentId == null) {
        const row = {
          netID, weekNum, category: "recommended",
          points: recSolved, maxPoints: recTotal,
          canvasAssignmentId: null, canvasUserId,
          outcome: "skipped-no-assignment",
        };
        cell.recommended = row;
        flatRows.push(row);
        totals.recommended.skippedNoAssignment++;
      } else if (canvasUserId == null) {
        const row = {
          netID, weekNum, category: "recommended",
          points: recSolved, maxPoints: recTotal,
          canvasAssignmentId: recAssignmentId, canvasUserId: null,
          outcome: "skipped-no-user",
        };
        cell.recommended = row;
        flatRows.push(row);
        totals.recommended.skippedNoUser++;
      } else {
        const { canvasStatus, canvasError } = await pushGradeToCanvas({
          courseId: CANVAS_COURSE_ID,
          assignmentId: recAssignmentId,
          userId: canvasUserId,
          grade: recSolved,
          token,
        });
        const outcome = canvasError == null ? "ok" : "failed";
        if (outcome === "ok") totals.recommended.ok++;
        else totals.recommended.failed++;
        const row = {
          netID, weekNum, category: "recommended",
          points: recSolved, maxPoints: recTotal,
          canvasAssignmentId: recAssignmentId, canvasUserId,
          canvasStatus, outcome,
          ...(canvasError ? { canvasError } : {}),
        };
        cell.recommended = row;
        flatRows.push(row);
      }

      // -- Third card --
      if (!week.thirdCard?.type) {
        totals.thirdCard.skippedNoCard++;
      } else {
        const tcAssignmentId = week.thirdCard.canvasAssignmentId ?? null;
        const { earned, total } = computeThirdCardGrade(
          week.thirdCard,
          progressByWeek[weekNum]
        );

        if (tcAssignmentId == null) {
          const row = {
            netID, weekNum, category: "thirdCard",
            subtype: week.thirdCard.type,
            points: earned, maxPoints: total,
            canvasAssignmentId: null, canvasUserId,
            outcome: "skipped-no-assignment",
          };
          cell.thirdCard = row;
          flatRows.push(row);
          totals.thirdCard.skippedNoAssignment++;
        } else if (canvasUserId == null) {
          const row = {
            netID, weekNum, category: "thirdCard",
            subtype: week.thirdCard.type,
            points: earned, maxPoints: total,
            canvasAssignmentId: tcAssignmentId, canvasUserId: null,
            outcome: "skipped-no-user",
          };
          cell.thirdCard = row;
          flatRows.push(row);
          totals.thirdCard.skippedNoUser++;
        } else {
          const { canvasStatus, canvasError } = await pushGradeToCanvas({
            courseId: CANVAS_COURSE_ID,
            assignmentId: tcAssignmentId,
            userId: canvasUserId,
            grade: earned,
            token,
          });
          const outcome = canvasError == null ? "ok" : "failed";
          if (outcome === "ok") totals.thirdCard.ok++;
          else totals.thirdCard.failed++;
          const row = {
            netID, weekNum, category: "thirdCard",
            subtype: week.thirdCard.type,
            points: earned, maxPoints: total,
            canvasAssignmentId: tcAssignmentId, canvasUserId,
            canvasStatus, outcome,
            ...(canvasError ? { canvasError } : {}),
          };
          cell.thirdCard = row;
          flatRows.push(row);
        }
      }

      results[netID][weekNum] = cell;
    }
  }

  // ---- Write log ----
  const runId = `push-${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .slice(0, 19)}`;
  const finishedAt = Date.now();
  await db.doc(`gradeSyncLog/${runId}`).set({
    startedAt,
    finishedAt,
    triggeredBy,
    trigger,
    classId: CLASS_ID,
    canvasCourseId: CANVAS_COURSE_ID,
    studentsProcessed: studentsSnap.size,
    weeksProcessed: weeks.length,
    totals,
    results,
    flatRows,
    warnings,
  });

  return {
    runId,
    logPath: `gradeSyncLog/${runId}`,
    studentsProcessed: studentsSnap.size,
    weeksProcessed: weeks.length,
    totals,
  };
}

exports.pushCanvasGrades = onRequest(
  { secrets: [canvasToken], region: "us-central1" },
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

    const summary = await runPushCanvasGrades({
      triggeredBy: decoded.uid,
      trigger: "manual",
      token: canvasToken.value(),
    });
    res.status(200).json(summary);
  }
);

// ---- nightlyGradeSync --------------------------------------------------
//
// Cloud Scheduler-driven nightly reconciliation. Fires every night at
// midnight America/Denver (BYU's timezone). Runs the exact same code
// as pushCanvasGrades, but triggered by the scheduler service account
// instead of a human-authenticated HTTP call — so there's no auth
// header to check, and `triggeredBy` is recorded as "system".
//
// Purpose: safety net for the real-time hybrid. If pushMyRecentGrade
// misses a solve (browser closed, network hiccup, function fault),
// this catches up within 24h. Also picks up third-card grade changes
// that don't go through the real-time path at all.
//
// First-time deploy note: the Cloud Scheduler API must be enabled in
// the GCP project. Firebase's CLI usually prompts to enable it
// automatically on first deploy of a scheduled function.

exports.nightlyGradeSync = onSchedule(
  {
    schedule: "0 0 * * *", // midnight daily
    timeZone: "America/Denver",
    secrets: [canvasToken],
    region: "us-central1",
  },
  async (_event) => {
    console.log("[nightlyGradeSync] starting");
    const summary = await runPushCanvasGrades({
      triggeredBy: "system",
      trigger: "scheduled",
      token: canvasToken.value(),
    });
    console.log("[nightlyGradeSync] done", summary);
  }
);

// ---- pushMyRecentGrade -------------------------------------------------
//
// Real-time counterpart to pushCanvasGrades. Called by
// leetcode-tracker.js right after a solve is persisted to Firestore.
// Scope: only the caller's own recommended grade for the week
// containing the just-solved problem.
//
// The nightly pushCanvasGrades still runs and reconciles everything,
// so if this call misses (student closed browser mid-flight, network
// hiccup, etc.), the batch catches up within 24h. That's why this
// function only writes a log doc on FAILURE — successes are silent
// and don't clutter gradeSyncLog with hundreds of docs per day.
//
// Auth: any authenticated student. netID is DERIVED FROM auth.uid,
// not read from the body — a student can only ever trigger a push
// for themselves regardless of what payload they send.

exports.pushMyRecentGrade = onRequest(
  {
    secrets: [canvasToken],
    region: "us-central1",
    // `cors: true` on the function is defense-in-depth — the manual
    // headers below are what actually make browsers happy when the
    // request goes through the Firebase Hosting rewrite, because
    // Hosting can intercept OPTIONS preflights before the function's
    // own cors middleware runs.
    cors: true,
  },
  async (req, res) => {
    // ---- Manual CORS (belt-and-suspenders for Hosting-rewrite path) ----
    // Called from leetcode-tracker.js content script on leetcode.com,
    // which in MV3 doesn't get the extension's CORS-bypass privilege.
    // Auth is still required inside the function, so opening CORS
    // doesn't meaningfully reduce security — attackers can't forge a
    // Firebase ID token cross-origin anyway.
    const origin = req.get("origin") ?? "*";
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.set("Access-Control-Max-Age", "3600");

    // Preflight — no body needed, no auth check needed. Just 204.
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({ error: "Use POST.", code: "method-not-allowed" });
      return;
    }

    // ---- Auth ----
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
    const netID = decoded.uid; // trust the token, ignore any netID in body

    // ---- Body ----
    const { slug } = req.body ?? {};
    if (typeof slug !== "string" || !slug) {
      res.status(400).json({ error: "Missing slug in body.", code: "invalid-argument" });
      return;
    }

    const db = getFirestore();
    const now = Date.now();

    // ---- Find the currently-active week containing this slug ----
    const weeksSnap = await db.collection(`classes/${CLASS_ID}/weeks`).get();
    const matchingWeek = weeksSnap.docs
      .map((d) => d.data())
      .find(
        (w) =>
          Number.isFinite(w?.startDate) &&
          Number.isFinite(w?.endDate) &&
          w.startDate <= now &&
          now < w.endDate &&
          Array.isArray(w.problems) &&
          w.problems.some((p) => p?.slug === slug)
      );

    if (!matchingWeek) {
      // Solve wasn't for a current-week's recommended problem. Common
      // case (personal practice on a random LeetCode problem).
      res.status(200).json({ outcome: "no-op", reason: "slug not in any current week's recommended list" });
      return;
    }

    // ---- Fetch student ----
    const studentSnap = await db.doc(`students/${netID}`).get();
    if (!studentSnap.exists) {
      res.status(200).json({ outcome: "no-op", reason: "no student doc" });
      return;
    }
    const student = studentSnap.data();
    const canvasUserId = student?.canvasUserId ?? null;
    const solves =
      student?.solvedProblems && typeof student.solvedProblems === "object"
        ? student.solvedProblems
        : {};

    // ---- Skip checks ----
    const canvasAssignmentId = matchingWeek.canvasAssignmentId ?? null;
    if (canvasAssignmentId == null) {
      res.status(200).json({
        outcome: "skipped-no-assignment",
        weekNum: matchingWeek.weekNum,
      });
      return;
    }
    if (canvasUserId == null) {
      res.status(200).json({
        outcome: "skipped-no-user",
        weekNum: matchingWeek.weekNum,
      });
      return;
    }

    // ---- Compute recommended grade for this week ----
    const recSolved = matchingWeek.problems.filter((p) => {
      const ts = solves[p?.slug];
      return typeof ts === "number" && ts >= matchingWeek.startDate && ts < matchingWeek.endDate;
    }).length;

    // ---- Push ----
    const { canvasStatus, canvasError } = await pushGradeToCanvas({
      courseId: CANVAS_COURSE_ID,
      assignmentId: canvasAssignmentId,
      userId: canvasUserId,
      grade: recSolved,
      token: canvasToken.value(),
    });
    const outcome = canvasError == null ? "ok" : "failed";

    // ---- Log only on failure ----
    if (outcome === "failed") {
      const runId = `myPush-${new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .slice(0, 19)}-${netID}`;
      try {
        await db.doc(`gradeSyncLog/${runId}`).set({
          startedAt: now,
          finishedAt: Date.now(),
          triggeredBy: netID,
          trigger: "real-time",
          weekNum: matchingWeek.weekNum,
          slug,
          recSolved,
          canvasAssignmentId,
          canvasUserId,
          canvasStatus,
          canvasError,
          outcome,
        });
      } catch (logErr) {
        console.error("Failed to write failure log:", logErr);
      }
    }

    res.status(outcome === "ok" ? 200 : 502).json({
      outcome,
      weekNum: matchingWeek.weekNum,
      grade: recSolved,
      canvasStatus,
      ...(canvasError ? { canvasError } : {}),
    });
  }
);
