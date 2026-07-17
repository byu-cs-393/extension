# Testing plan — 2026-07-17

Concrete ways to validate the extension is doing what it's supposed to do. Written after most features shipped, before real students onboard.

Loosely follows a "you can actually execute this today" bar. Each section says **what you do**, **what should happen**, and **what to check if it doesn't**.

Divided into four sections:

1. [Manual QA — go/no-go checklist](#1-manual-qa) — 30 minutes of clicking through every flow
2. [Failure-mode scenarios](#2-failure-modes) — things that go wrong on purpose
3. [Automated coverage worth adding](#3-automated-coverage) — what to write in Vitest / Firebase tests
4. [Pilot testing plan](#4-pilot-plan) — how to onboard real students

## 1. Manual QA

### Setup: fresh state

Before running the checklist, get to a known state. Two paths:

**Path A (full reset — best for onboarding tests):**
```
1. Uninstall the extension at chrome://extensions
2. In Firestore console, delete:
     - students/jack684
     - students/jack684/weekProgress/* (subcollection)
3. Reinstall (Load unpacked → src/)
4. Extension icon opens the popup — should see the Welcome state
```

**Path B (dashboard-console reset — fast, keeps LeetCode logged in):**
```js
// Paste in dashboard console
await chrome.storage.sync.remove(["netID", "ltiUserId", "canvasUserId", "leetcodeUsername"]);
await chrome.storage.local.remove(["firebaseAuth", "canvasAuth", "leetcodeAuth", "weeksCatalog", "solvedProblems", "weekProgressBundle", "activeOaSession"]);
```

### Flow 1: onboarding (10 min)

| Step | What you do | Expected |
|---|---|---|
| 1a | Click the extension icon after fresh install | Popup shows Welcome copy + "Continue setup →" |
| 1b | Click "Continue setup →" | onboard.html opens in a new tab, Step 0 (Welcome) is visible |
| 1c | Click "Get started →" | Step 1 (Canvas) becomes visible |
| 1d | Click "Open BYU Canvas →" | Canvas opens in a new tab |
| 1e | Sign in to Canvas if not already | canvas-auth.js content script writes leetcodeAuth to storage |
| 1f | Back in onboard tab | Canvas card appears with your netID + name; form fields visible |
| 1g | Fill display name + optional note, click Continue | Spinner appears ("Verifying with BYU…"), then Step 2 loads |
| 1h | Click "Open leetcode.com →" | LeetCode opens, sign in if needed |
| 1i | Back in onboard tab | LeetCode card appears with your username |
| 1j | Click "Yes, that's me →" | Dashboard opens, "Hi, {name}" appears at top |

If any of 1c/1g/1j alerts with a friendly error message, the wired-up error UX is working. If it alerts with a raw HTTP error, we regressed the error mapping.

### Flow 2: solving a recommended problem (5 min)

Prerequisite: current week has recommended problems and canvasAssignmentId. If not, run `scripts/seed-test-week.js` first.

| Step | What you do | Expected |
|---|---|---|
| 2a | On dashboard, click any listed problem in the Recommended card | LeetCode opens to that problem in a new tab |
| 2b | Solve the problem and hit Submit | Dashboard tab: counter increments within ~1s |
| 2c | Check console in the LeetCode tab | See `[CS 393 Buddy] persisted solved: {slug}` and `[CS 393 Buddy] real-time push: { outcome: "ok" ... }` |
| 2d | Open Canvas gradebook, find Test Student's row for the test assignment | Grade updated to N/M within ~5 seconds |
| 2e | Solve the same problem twice in 30s | Second attempt's real-time push logs "debounced" (rate-limit working) |

### Flow 3: OA attempt end-to-end (10 min)

Prerequisite: current week has an OA. If not, run `scripts/seed-test-week.js` and then modify Week 99 to include an OA:

```js
const { patchDoc } = await import(chrome.runtime.getURL("firestore.js"));
await patchDoc("classes/cs393/weeks/99", {
  thirdCard: {
    type: "onlineAssessment",
    topic: "Test",
    attempts: [
      { timeLimitMin: 5, requiredSolves: 1, helpAllowed: false,
        problems: [{ slug: "two-sum", title: "Two Sum" }] },
      { timeLimitMin: null, requiredSolves: 1, helpAllowed: false,
        problems: [{ slug: "valid-parentheses", title: "Valid Parentheses" }] },
    ],
  },
});
```

Also reset your progress: `await deleteDoc('students/{netID}/weekProgress/99')`

| Step | What you do | Expected |
|---|---|---|
| 3a | Reload dashboard | Week 99 shows the OA card with "Start attempt 1" |
| 3b | Click "Start attempt 1" | Timer starts (5:00 counting down), problem list revealed, End button visible |
| 3c | Solve two-sum on LeetCode | Counter reads "1 of 1" — auto-pass fires |
| 3d | Dashboard | Card jumps to "✓ Passed (attempt 1 of 2)" |
| 3e | Test attempt 2: reset OA (button on card), then don't solve, click Submit | Card advances to "Try again"; second attempt gets a "Submit" flow (untimed) |

### Flow 4: topic exam signoff loop (5 min)

Prerequisite: current week has a topic exam and canvasAssignmentId. Modify Week 99:

```js
const { patchDoc } = await import(chrome.runtime.getURL("firestore.js"));
await patchDoc("classes/cs393/weeks/99", {
  thirdCard: {
    type: "topicExam",
    topic: "Test",
    durationMin: 30,
  },
});
```

| Step | What you do | Expected |
|---|---|---|
| 4a | Click "Request signoff" on the topic exam card | Card flips to "⏳ Signoff requested" immediately |
| 4b | Click the 🛡 TA button in header | TA dashboard loads on Signoff queue tab |
| 4c | See your own row in the queue | Row visible with "Requested just now" |
| 4d | Click Pass | Row disappears from queue |
| 4e | Click "← Student view" | Back on dashboard |
| 4f | Week 99 topic exam card | Now shows "✓ Passed" |

### Flow 5: TA dashboard navigation (5 min)

Prerequisite: dummy students seeded via `seedDummyStudents`.

| Step | What you do | Expected |
|---|---|---|
| 5a | On TA dashboard, click Students tab | Sort dropdown visible, rows sorted by least recent activity |
| 5b | Switch sort to "Fewest solves this week" | List reorders, "Alice Solver" moves toward the bottom |
| 5c | Click Dan Dropped Off's row | URL becomes `#students/dummyd`, detail view loads |
| 5d | Confirm no visits on recent weeks (last 12 days) in the weekly breakdown | Reflects Dan's stale persona correctly |
| 5e | Click "← Back to Students" | Back to `#students`, sort still on "Fewest solves this week" |
| 5f | Browser back button | Back to `#signoffs` |
| 5g | Browser forward | `#students` |
| 5h | Paste `#students/nonexistent` in URL bar | Student-not-found state with a Back link |

### Flow 6: cross-cutting (5 min)

| Step | What you do | Expected |
|---|---|---|
| 6a | Open dashboard as a non-TA (e.g., a dummy netID) | 🛡 TA button not visible in header |
| 6b | Manually navigate to `chrome-extension://.../ta-dashboard.html` as non-TA | Redirects immediately to student dashboard |
| 6c | Try to read another student's data in Firestore console via extension REST (rules test) | 403 for non-TA, 200 for TA |
| 6d | Wait an hour without opening the dashboard, then solve a problem | Real-time push still works (background alarm has kept the token fresh) |

## 2. Failure modes

Things that will happen in production. Verify graceful handling.

### 2.1 Network failure during solve

**What you do**: solve a problem while offline (`chrome://net-internals` → Sockets → Flush; or turn off wifi mid-submit).

**Expected**:
- Solve is recorded in chrome.storage.local (dashboard counter updates)
- Firestore write fails silently to console
- Real-time Canvas push not attempted (guard on firestoreOk)
- Next time on-line, backstop sync catches up
- Nightly reconciliation covers anything the backstop missed

### 2.2 Canvas 5xx during push

**What you do**: manually break the CANVAS_API_TOKEN (set to an invalid string via `firebase functions:secrets:set CANVAS_API_TOKEN`), then fire pushCanvasGrades.

**Expected**:
- Function completes, response includes failure counts
- `gradeSyncLog/push-*` has per-row `outcome: "failed"` with `canvasError` populated
- Firestore state unchanged
- After restoring the real token, next run recovers

### 2.3 Expired auth token

**What you do**: manually delete the `firebaseAuth` entry from `chrome.storage.local` while dashboard is open.

**Expected**:
- Existing UI keeps rendering from cached data
- Any Firestore write fails with a clear error (no crash)
- Reopening dashboard triggers onboarding redirect

### 2.4 Malformed week doc

**What you do**: manually corrupt `classes/cs393/weeks/99` by removing `problems` field.

**Expected**:
- Dashboard skips the week's Recommended section (no crash)
- pushCanvasGrades records `recTotal: 0`, `recSolved: 0`
- Warning appears in the dryRun log

### 2.5 Simultaneous edits (race condition)

**What you do**: in two tabs, click Pass on the same signoff request at the same time.

**Expected**:
- Both patchDoc writes succeed (last-write-wins on Firestore's side)
- Both tabs re-render the queue; row is gone from both
- No corrupted progress doc

## 3. Automated coverage

Not everything is worth automating. Here's what would pay off vs what wouldn't.

### Worth adding

**Vitest — grade computation** (roughly 2h of work):
- The `runPushCanvasGrades` inner loop pulled apart into a testable function that takes `{ weeks, students, progress, activity }` and returns `{ results, flatRows, totals }`. Run against canned inputs, assert the totals.
- Would catch regressions in the grade math specifically. High leverage — grade math is where "silently wrong" hurts most.

**Vitest — third-card status decoding**:
- `computeThirdCardGrade` already extracted. One test each for topicExam/OA/mockInterview across passed/failed/pending states.
- Small, obvious, easy.

**Firebase Rules unit tests** (roughly 3h):
- `@firebase/rules-unit-testing` lets you test rules against a mock Firestore.
- Coverage: TAs can read all `students/*` but not write; TAs can read+write all `weekProgress/*`; non-TAs blocked from cross-student reads; students can write their own.
- High leverage because rules are the actual security boundary.

### Not worth automating

**End-to-end browser tests via Playwright** — extension E2E is possible but heavy setup (headless browser, mock Canvas, mock LeetCode, mock Firebase). Manual QA is faster to run than the E2E suite would be to maintain.

**Cloud Function integration tests** — Firebase Functions can be tested locally via emulators, but they need Firestore + Auth + Canvas API mocks. Effort > payoff for MVP.

**Dashboard rendering tests** — DOM assertions are brittle, and CSS changes constantly break them. Manual visual check catches more.

## 4. Pilot plan

Two-stage rollout when the professor conversation is done.

### Stage 1: two friendly beta users (week 1)

Ask two people who won't be angry if it breaks. Ideally: another TA + one enrolled student.

- Give them the `.crx` file and a 5-step install guide (`chrome://extensions` → Developer mode on → Load unpacked → done)
- Give them the netID + Canvas + LeetCode paths
- Don't give them anything else
- Watch: do they get through onboarding? Do their solves land in the TA dashboard's Students view within an hour?

**Success criteria**: both have a passing "this week X/Y" that matches what they actually solved. If not, we've got a real bug.

### Stage 2: broader (weeks 2–4)

Expand to 5–10 students. Use Chrome Web Store's *unlisted* publishing option if we want auto-updates, or continue sideload if we don't.

- Add real weekly grade pushes into Canvas (nightlyGradeSync running for real)
- Monitor `gradeSyncLog/push-*` for failure counts
- Monitor Canvas gradebook manually — do TA-marked signoffs actually appear?
- Keep the fallback of manual grade entry always available (nothing prevents you from touching the gradebook by hand)

**Success criteria**: end of week 4, professor is comfortable removing the Learning Suite self-report quiz from at least one category and letting the extension drive that category alone.

### Stage 3: full class

Everyone onboarded, self-report retired. Nightly runs are the source of truth.

### Rollback plan

At any stage, "turn it off" = disable nightlyGradeSync via the Cloud Scheduler console, tell students the extension is optional this week, and manually enter grades. No infrastructure to unwind.

## Order of testing operations

If you have one hour today and want to feel confident:

1. **20 min** — Flow 1 (onboarding) + Flow 2 (solve) + Flow 4 (signoff loop). Covers the critical student paths.
2. **20 min** — Flow 5 (TA dashboard) + Flow 6 (cross-cutting). Covers TA and security.
3. **20 min** — Failure mode 2.1 (offline solve) + 2.2 (Canvas 5xx). Covers "what happens when things break."

Skip everything else for now. Come back to Flow 3 (OA), failure modes 2.3–2.5, and the automated tests when you have another hour.
