// Active Online Assessment session — the "an attempt is currently running"
// state, plus timer helpers. Phase B of the OA feature.
//
// Persistence lives in TWO places:
//
//   1. chrome.storage.local.activeOaSession — the local timer state.
//      Survives tab close, does NOT survive extension reinstall or a
//      different device. Read by dashboard.js on every 1-second tick.
//
//      Shape: { weekNum, attemptIndex (0-based), startedAt, deadlineMs }
//      deadlineMs is absolute wall-clock time — if a student closes the
//      tab and reopens later, remaining = deadlineMs - Date.now().
//
//   2. students/{netID}/weekProgress/{weekNum} — the source of truth.
//      Survives everything. Read by grade-sync, TA dashboard, other
//      devices. Written on start-attempt and end-attempt.
//
//      Shape (per third-card.js): { type: "onlineAssessment", weekNum,
//        currentAttempt: 1|2|3, attempts: [{startedAt, finishedAt?}, ...],
//        finalStatus: "in_progress"|"passed"|"failed" }
//
// Pass/fail determination is intentionally NOT handled here — that's
// Phase C (solve attribution). Phase B just tracks that an attempt
// started and ended.
import { patchDoc, fetchStudent, deleteDoc } from "../platform/firestore.js";

export const OA_SESSION_KEY = "activeOaSession";

// ---- Storage read/write -------------------------------------------------

export async function getActive() {
  const { [OA_SESSION_KEY]: s } = await chrome.storage.local.get(OA_SESSION_KEY);
  return s ?? null;
}

async function setActive(session) {
  await chrome.storage.local.set({ [OA_SESSION_KEY]: session });
}

async function clearActive() {
  await chrome.storage.local.remove(OA_SESSION_KEY);
}

// ---- Public API ---------------------------------------------------------

// Start attempt N (0-indexed) of the OA on the given week. Writes both
// the local session state and the Firestore progress doc. Returns the
// created session object.
export async function startAttempt({
  netID,
  weekNum,
  attemptIndex,
  timeLimitMin,
  existingProgress,
}) {
  const existing = await getActive();
  if (existing) {
    throw new Error(
      `An OA attempt is already active for Week ${existing.weekNum}. ` +
        "End it before starting a new one."
    );
  }

  const now = Date.now();
  const deadlineMs = timeLimitMin != null ? now + timeLimitMin * 60 * 1000 : null;
  const session = { weekNum, attemptIndex, startedAt: now, deadlineMs };

  // Rebuild the attempts array: keep completed prior attempts, add the
  // fresh one at [attemptIndex].
  const priorAttempts = Array.isArray(existingProgress?.attempts)
    ? existingProgress.attempts.slice(0, attemptIndex)
    : [];
  const attempts = [...priorAttempts, { startedAt: now }];

  await setActive(session);

  try {
    await patchDoc(`students/${netID}/weekProgress/${weekNum}`, {
      type: "onlineAssessment",
      weekNum,
      currentAttempt: attemptIndex + 1,
      attempts,
      finalStatus: "in_progress",
    });
  } catch (error) {
    console.error("[CS 393 Buddy] startAttempt Firestore write failed:", error);
    // Timer still runs locally — Firestore write can be retried later.
  }

  return session;
}

// Given an attempt spec and a slug→timestamp solves map, returns the
// slugs from the attempt's problem list that were solved within
// [startedAt, finishedAt]. Uses the LATEST solve timestamp per slug,
// which matches the OA writeup's "reset and re-solve if you've
// already done it" rule — a re-solve during the attempt updates the
// timestamp into the window.
export function solvedInWindow(attemptSpec, solves, startedAt, finishedAt) {
  const slugs = (attemptSpec?.problems ?? []).map((p) => p.slug);
  return slugs.filter((slug) => {
    const ts = solves?.[slug];
    return ts != null && ts >= startedAt && ts <= finishedAt;
  });
}

export function attemptPassed(attemptSpec, solvedSlugsCount) {
  const required =
    attemptSpec?.requiredSolves ?? attemptSpec?.problems?.length ?? 0;
  return required > 0 && solvedSlugsCount >= required;
}

// End the active attempt (from the timer expiring OR the student
// clicking End/Submit). Fetches fresh solves from Firestore, evaluates
// pass/fail against the attempt spec, updates Firestore + local cache,
// and clears the local session.
export async function endActiveAttempt({
  netID,
  existingProgress,
  attemptSpec,
  totalAttempts,
  solves,
  reason,
}) {
  const session = await getActive();
  if (!session) return null;

  const finishedAt = Date.now();

  // Merge caller-provided solves with a fresh Firestore read, keeping
  // the LATEST timestamp per slug. Two sources because each can be
  // ahead of the other:
  //   - Caller's `solves` = local cache. Updated instantly by
  //     leetcode-tracker.js, so freshest during auto-pass right after
  //     an Accepted verdict.
  //   - Firestore student doc. Behind by one round-trip in the auto-pass
  //     case, but ahead in cross-device scenarios (student solved on
  //     another machine).
  // Overwriting one with the other would corrupt whichever was fresher.
  const freshSolves = { ...(solves ?? {}) };
  try {
    const student = await fetchStudent(netID);
    const remote = student?.solvedProblems;
    if (remote && typeof remote === "object") {
      for (const [slug, ts] of Object.entries(remote)) {
        const remoteTs = typeof ts === "number" ? ts : Number(ts);
        if (!Number.isFinite(remoteTs)) continue;
        if (!(slug in freshSolves) || remoteTs > freshSolves[slug]) {
          freshSolves[slug] = remoteTs;
        }
      }
    }
  } catch (error) {
    console.warn("[CS 393 Buddy] end-of-attempt fresh-solves fetch failed:", error);
  }

  const solvedSlugs = solvedInWindow(
    attemptSpec,
    freshSolves,
    session.startedAt,
    finishedAt
  );
  const passed = attemptPassed(attemptSpec, solvedSlugs.length);

  const attempts = Array.isArray(existingProgress?.attempts)
    ? [...existingProgress.attempts]
    : [];
  attempts[session.attemptIndex] = {
    ...(attempts[session.attemptIndex] ?? {}),
    finishedAt,
    endReason: reason ?? "unknown", // "timer" | "manual" | "submit"
    solvedSlugs,
    passed,
  };

  // Next state:
  //   Passed → stay on this attempt, finalStatus = "passed"
  //   Not passed + last attempt → bump forward, finalStatus = "failed"
  //   Not passed + more attempts → bump forward, finalStatus = "in_progress"
  const attemptNum = session.attemptIndex + 1; // 1-indexed
  const isLast = totalAttempts > 0 && attemptNum >= totalAttempts;
  const newCurrentAttempt = passed ? attemptNum : attemptNum + 1;
  const finalStatus = passed ? "passed" : isLast ? "failed" : "in_progress";

  const newProgress = {
    type: "onlineAssessment",
    weekNum: session.weekNum,
    currentAttempt: newCurrentAttempt,
    attempts,
    finalStatus,
  };

  // Firestore first (source of truth), then local cache, then clear
  // the session. Clearing fires storage.onChanged; by then the local
  // cache is already correct, so no flash on re-render.
  try {
    await patchDoc(
      `students/${netID}/weekProgress/${session.weekNum}`,
      newProgress
    );
  } catch (error) {
    console.error("[CS 393 Buddy] endActiveAttempt Firestore write failed:", error);
  }

  const cached = await chrome.storage.local.get("weekProgressBundle");
  const bundle = cached.weekProgressBundle ?? { progress: {} };
  bundle.progress = { ...bundle.progress, [session.weekNum]: newProgress };
  bundle.syncedAt = Date.now();
  await chrome.storage.local.set({ weekProgressBundle: bundle });

  await clearActive();

  return { session, passed, solvedSlugs };
}

// Wipe all OA state for a given week: clears any active session, deletes
// the Firestore progress doc, and updates the local cache. Useful for
// testing and for the user-visible "Reset attempts" button.
export async function resetOa({ netID, weekNum }) {
  await clearActive();

  try {
    await deleteDoc(`students/${netID}/weekProgress/${weekNum}`);
  } catch (error) {
    console.error("[CS 393 Buddy] resetOa Firestore delete failed:", error);
  }

  const cached = await chrome.storage.local.get("weekProgressBundle");
  const bundle = cached.weekProgressBundle ?? { progress: {} };
  const next = { ...(bundle.progress ?? {}) };
  delete next[weekNum];
  bundle.progress = next;
  bundle.syncedAt = Date.now();
  await chrome.storage.local.set({ weekProgressBundle: bundle });
}

// ---- Timer math ---------------------------------------------------------

// Milliseconds left on the session's timer. Null means no time limit
// (e.g., attempt 3). Zero or negative means time's up.
export function getRemainingMs(session, now = Date.now()) {
  if (!session || session.deadlineMs == null) return null;
  return Math.max(0, session.deadlineMs - now);
}

// Format ms as "H:MM:SS" or "MM:SS". Returns "—" if ms is null.
export function formatRemaining(ms) {
  if (ms == null) return "—";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
