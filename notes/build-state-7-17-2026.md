# Build state — 2026-07-17

Follow-up to [build-state-2026-06-18](build-state-2026-06-18.md) *(if this filename is wrong, look for the last build-state snapshot in this directory)*. Written after the TA-dashboard work landed and Phase 2 grade sync went end-to-end.

## Where we are

The extension is **essentially feature-complete for MVP launch**. Every planned flow works end-to-end with real data on the test week; the pipeline from LeetCode solve → Firestore → Canvas gradebook has been validated live. What's left is mostly:

- One professor conversation (rubric + Canvas assignment groups + token strategy)
- Full-semester Firestore seed run (script exists, waiting on rubric)
- Canvas assignment creation script (waiting on naming + groups)
- Distribution decision (Chrome Web Store or sideload)
- Real students onboarding

Nothing architectural remains.

## What exists end-to-end

### Student flow (extension)

- **Onboarding**: welcome → Canvas sign-in → LeetCode sign-in → verifyStudent → Firebase custom token. Popup shows welcome pre-onboarding; hides once complete.
- **Dashboard**: shows past + current weeks. Each week has a Recommended card + optional third card (topic exam / OA / mock interview).
- **Full course page**: shows every week including future ones (faded / locked).
- **Solve tracking**: leetcode-tracker.js content script detects Accepted verdicts, writes to Firestore (source of truth) + chrome.storage.local (instant UI reactivity). Backstop sync in leetcode-auth.js catches solves the DOM detector missed via `recentAcSubmissionList` GraphQL.
- **OA runtime**: multi-attempt sessions with timer, live solve counter, auto-pass on threshold, reset button, per-tab debounce. Solves during window attribute automatically.
- **Topic exam signoff**: student clicks "Request signoff" → weekProgress doc created with status `"requested"` → card flips to "⏳ Signoff requested".
- **Live grade UX**: after each recommended solve, `pushMyRecentGrade` fires via background service worker (bypasses CORS restriction on content scripts) → grade lands in Canvas within seconds.

### TA flow (extension, role-gated)

- **Sign-in**: same verifyStudent path as students, but the function now also calls `/api/v1/courses/{cid}/enrollments?type[]=TaEnrollment&type[]=TeacherEnrollment` and adds `role: "ta"` to the minted custom token when the caller has a TA enrollment.
- **Entry point**: `🛡 TA` button in the student dashboard header, revealed only when `getRole() === "ta"`.
- **Hash-routed SPA**: three views (`#signoffs`, `#students`, `#students/{netID}`) with browser back button support.
- **Signoff queue**: shows every `weekProgress` doc across all students where `type: "topicExam"` AND `status: "requested"`. Pass/fail buttons update the doc; row body links to student detail.
- **Students list**: computes per-student engagement metrics (last active, current-week completion, overall completion, visits) and sorts by any of 6 criteria (least recent activity is the default).
- **Student detail**: name/netID/LeetCode username header, activity summary line, per-week breakdown (recommended progress · third-card status · visits/passes/fails per week).
- **Student-not-found state**: friendly error with a link back if the URL hash points at an unknown netID.

### Grade sync (Cloud Functions)

- **verifyStudent** — Canvas-backed identity check + TA role detection.
- **dryRunGrades** — read-only: computes what every grade WOULD be, writes to `gradeSyncLog/dryRun-*`. Instructor-allowlisted.
- **pushCanvasTestGrade** — Stage A. Hardcoded push to one Test Student on one test assignment. Proved the Canvas API plumbing.
- **pushCanvasGrades** — Stage B (real). Reads Firestore, computes recommended + third-card grades for every student × week, pushes each row to Canvas. Manual trigger. Instructor-allowlisted. Log at `gradeSyncLog/push-*`.
- **pushMyRecentGrade** — Real-time. Called by leetcode-tracker (via background service worker) after each solve of a recommended problem. Scoped to caller only (netID derived from auth.uid). Failure-only logging.
- **nightlyGradeSync** — Scheduled midnight-America/Denver cron. Runs the exact same code as `pushCanvasGrades` via a shared `runPushCanvasGrades` helper. Reconciles anything the real-time missed.
- **seedDummyStudents** — Dev-only. Instructor-allowlisted. Populates 8 synthetic personas with fabricated solves + activity events derived from the real week catalog.

### Firestore data model

Locked in and stable:

```
students/{netID}
  { name, note, leetcodeUsername, solvedProblems: { slug: ms }, canvasUserId? }

students/{netID}/weekProgress/{weekNum}
  { type: "topicExam" | "onlineAssessment" | "mockInterview",
    weekNum, ...type-specific fields }

activity/{eventId}
  { studentNetID, eventType: "open_problem"|"submit_pass"|"submit_fail",
    source: "leetcode", timestamp, problemSlug?, problemTitle?, verdict? }

classes/{classId}
  { canvasCourseId? (Phase 2) }

classes/{classId}/weeks/{weekNum}
  { weekNum, startDate, endDate, problems: [...],
    thirdCard: null | TopicExam | OnlineAssessment | MockInterview,
    canvasAssignmentId? }

gradeSyncLog/{runId}
  Various shapes for dryRun-*, push-*, testPush-*, myPush-* prefixes.
```

Firestore rules enforce per-user access on students + weekProgress, with a `request.auth.token.role == 'ta'` override for TA cross-student reads and signoff writes.

## What's built but validation is thin

Some things are shipped but haven't been exercised at real class scale:

- **Nightly scheduled function** — code shipped but has never actually run against real data (only manual triggers via the sibling HTTP endpoint). Needs its first live nightly cycle to prove the Cloud Scheduler wire-up.
- **TA views on real students** — currently all validation has been on dummy personas plus jack684. Real students haven't onboarded yet.
- **Long-running token freshness** — verified for hours, not days. The `chrome.alarms`-driven refresh loop is correct in principle but hasn't been observed across a multi-day pause.
- **Signoff decision writes at scale** — Pass/Fail button works; hasn't been stress-tested with many concurrent TAs.

## What's blocked on the professor conversation

Three specific decisions the code is designed around but hasn't committed to:

1. **Grading rubric per week** — the `gradingRule` field on week docs is designed (`{ type: "solveAll" }` vs `{ type: "totalCount", target: N }`) but not implemented. Blocks:
   - Full-semester Firestore seed
   - Real grade computation for weeks with "solve any 10" targets
2. **Canvas assignment groups + naming** — how many groups (2 vs 4), what to name each assignment. Blocks the seed-canvas.js script.
3. **Token strategy long-term** — whose Canvas token owns the grade-push authority. Current setup uses the token you (or the professor) set as `CANVAS_API_TOKEN`. Works today. Not a real long-term answer.

## Immediate open questions

- Does nightlyGradeSync actually fire on schedule after deploy? Needs to be verified against a live 24h cycle.
- The activity timeline view on student detail isn't built — just weekly aggregates. Worth deciding whether that's still needed.
- Real students haven't tried the extension. First user beyond jack684 will surface things we haven't anticipated.

## What's NOT in scope for MVP

Explicitly deferred:

- Mock interview partner matching
- Compete feature (head-to-head)
- Profile / history page (keystroke playback)
- Full extra-credit tracking
- Final exam integration
- Choice problems (student-picked, any-of-N-solved)
- Multi-class support (currently hardcoded to CS 393)
- Chrome Web Store listing / auto-updates

## What immediate next steps look like

Ordered by dependency:

1. **Professor conversation** — settle rubric + groups + naming + token strategy.
2. **Deploy nightlyGradeSync** — one-time `firebase deploy --only functions:nightlyGradeSync` (enables Cloud Scheduler API on first run).
3. **Seed real weeks + third cards** — run `scripts/seed-firestore.js` after gradingRule schema is implemented.
4. **Write + run seed-canvas.js** — create all real Canvas assignments, write IDs back to Firestore.
5. **Real pilot** — 2-3 real students onboard, use the extension for a week, watch the TA dashboard.
6. **Distribution decision** — Chrome Web Store (with auto-updates) vs sideload (with manual updates).

See [testing-plan-7-17-2026](testing-plan-7-17-2026.md) for concrete validation before + during + after the pilot.
