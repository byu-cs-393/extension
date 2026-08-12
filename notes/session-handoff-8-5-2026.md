> **SUPERSEDED — see `session-handoff-8-12-2026.md`.**
> Kept for history. Most details below are now wrong: this predates
> the keystroke/replay work, the content-script build step, and 248
> of the 336 tests.

# Session handoff — 2026-08-05

Written so a fresh Claude Code session (or a new dev sitting down cold)
can pick up the project without hunting. If this file drifts from
reality, trust `git log`, `data/course.json`, and the running tests
over anything in here.

## TL;DR

**CS 393 Buddy** — Chrome MV3 extension for BYU CS 393 (Advanced
Algorithms). Tracks a student's LeetCode work, exposes a TA-facing
signoff dashboard, and — the current focus — **auto-submits assignments
to Canvas on the student's behalf** (masquerade via the professor's
Canvas token). Fall 2026 semester: **starts Sep 3, ends Dec 17**.
No real students onboarded yet; the pilot happens on Sep 3.

## Read-me-first (in this order)

1. **`../course/CLAUDE.md`** — the professor's integration guide,
   addressed to us. Names the contract files (`data/course.json` +
   `build/deploy.fall-2026.json`) and describes the auto-submit flow.
   Read this whenever you're unsure about intent.
2. **`../course/data/course.json`** — professor's single source of
   truth for the course. Everything the extension shows about weeks,
   topics, assessments, and stable assignment IDs comes from here
   (vendored into `src/course.json` via `scripts/vendor-course.js`).
3. **`../course/build/deploy.fall-2026.json`** — stable-id → Canvas
   numeric-id mapping. Vendored into `functions/deploy.fall-2026.json`
   for the Cloud Function's use.
4. **`src/course-data.js`** — the read layer. Any UI code that needs
   course structure (weeks, cards, IDs, date parsing) goes through here.
5. **`functions/index.js`** — Cloud Functions, especially
   `submitCanvasAssignment` (masquerade POST) and `verifyStudent`
   (identity + TA-role check).
6. **`notes/professor-meeting-prep-7-20-2026.md`** — the pre-pivot
   snapshot of decisions still owed to us. Some of these are now
   answered by the professor's CLAUDE.md; the rest are still open.

## Where things are (as of 2026-08-05)

### Working end-to-end
- **Student flow:** onboard via Canvas → LeetCode → dashboard shows all
  past+current weeks with recommended-problems + performance items
  (multi-card weeks). Full-course page shows every week including
  future (locked). Popup shows current-week summary.
- **TA flow:** signoff queue (topic exam legacy + new performance +
  live-interview pending requests), struggling-students list,
  per-student detail view.
- **Signoff flows:** performance exam + live interview both work
  end-to-end (student requests → TA queue → Pass/Fail; live
  interview prompts TA for a 1/2/3 grader rating on Pass, student
  self-rates 1/2/3 after).
- **Auto-submit to Canvas** (via masquerade, uses professor's
  `CANVAS_API_TOKEN` with `become_user` permission):
  - **OA** — fully automatic button after pass (fills attempt# +
    accepted URLs from local state).
  - **Performance / Live interview** — button appears after TA
    Pass. Modal collects the fields the professor's template asks
    for (date, worked with, URL, etc.), fills the template, POSTs.
  - **Peer / Professional mock** — always-visible button per week.
    Modal collects who / when / how it went.
  - **Weekly Study** — button on the Recommended-problems card.
    Pre-fills the required + in-class problem list from
    `course.json`; student adds hours + growth notes.
- **Per-submission URLs** — LeetCode submission IDs captured two ways:
  synchronously if `location.pathname` matches `/problems/{slug}/submissions/{id}/`;
  otherwise by the GraphQL backstop pulling the last 20 accepted
  submissions. Stored as `students/{netID}.solutionUrls` +
  `chrome.storage.local.solvedProblems.solutions`.

### Tests + CI
- **88 tests passing** (`npm run test:run`), 3 files:
  - `tests/oa-session.test.js` (21) — OA session helpers.
  - `tests/submission-templates.test.js` (26) — every template filler +
    dispatcher.
  - `tests/course-data.test.js` (41) — parseScheduleDates, classifyWeek,
    solvedSlugsInWeek, flatten/derive/study/firstUnsolved/translate.
- **GitHub Actions** — `.github/workflows/test.yml` runs the suite on
  every push to main and every PR. Should be green as of commit `29c4096`.

### Architecture at a glance
- **Source of truth = professor's course.json**, vendored. Extension
  is a *read-only consumer* of course structure; per-student state
  (solves, progress, signoffs) lives in our Firestore.
- **Firestore collections:**
  - `students/{netID}` — profile, `solvedProblems`, `solutionUrls`,
    `canvasUserId`, `leetcodeUsername`.
  - `students/{netID}/weekProgress/{weekNum}` — LEGACY, still used
    by OA runtime + old topicExam signoffs. Kept alive for back-compat.
  - `students/{netID}/assignmentProgress/{assignmentId}` — new
    per-assignment progress keyed by stable IDs. Used for
    performance/live-interview signoffs + Canvas-submit markers
    (`canvasSubmittedAt`, `canvasSubmissionId`).
  - `students/{netID}/keystrokeSessions/{sessionId}` — Monaco delta
    captures on LeetCode problem pages (built but not being used).
  - `activity/{eventId}` — top-level event log (open_problem, submit_pass, submit_fail).
  - `classes/{classId}/weeks/{weekNum}` — LEGACY, unused by client since
    course.json adoption. Kept alive because grade-push Cloud Functions
    still read it (they'll be replaced by auto-submit once every card
    type is wired).
  - `gradeSyncLog/{runId}` — Cloud Function audit log.
- **Cloud Functions** (`functions/index.js`):
  - `verifyStudent` — Canvas-backed identity check + TA role detection.
  - `submitCanvasAssignment` — the new auto-submit path. Takes
    {assignmentId, submissionType, body|url}, looks up Canvas ID +
    canvasUserId, POSTs with masquerade.
  - `pushCanvasGrades`, `pushMyRecentGrade`, `nightlyGradeSync` —
    OLD grade-push functions. Still deployed; being phased out in
    favor of auto-submit.
  - `dryRunGrades`, `pushCanvasTestGrade`, `seedDummyStudents` — dev tools.

### Key files (per-directory tour)
```
src/
  manifest.json            MV3 manifest, 3 content scripts + service worker
  course.json              vendored professor's course.json (via scripts/vendor-course.js)
  course-data.js           read layer: pure accessors + parseScheduleDates + OA translate
  submission-templates.js  fill*Template(data) → HTML body per assignment type
  submission-form.js       shared modal + schemas + submit orchestration
  assignment-progress.js   Firestore writes for per-assignment progress
  third-card.js            dispatcher + renderers for every card type
  dashboard.js             student dashboard (past + current weeks, multi-card)
  course.js                full-course page (all 15 weeks including future)
  popup.js                 current-week summary in the toolbar popup
  ta-dashboard.js          TA-only: signoff queue + struggling + student detail
  oa-session.js            OA runtime: timer, auto-pass, multi-attempt
  leetcode-tracker.js      content script: verdict detection + real-time write
  leetcode-auth.js         content script: LeetCode auth check + backstop sync
  canvas-auth.js           content script: Canvas identity detection
  onboard.js               onboarding flow
  background.js            service worker: token refresh + msg proxy
  firestore.js             thin REST wrapper (fetchDoc, patchDoc, fetchCollection)
  firebase-config.js       public config (safe to commit)
  auth.js                  Firebase Auth ID token lifecycle
  recommended.js           DELETED — replaced by course-data.js

functions/
  index.js                 all Cloud Functions in one file
  deploy.fall-2026.json    stable-id → Canvas numeric-id map (vendored)
  package.json             separate deps; engines.node 22

scripts/
  vendor-course.js         Node script: copies course.json + deploy map from ../course/
  seed-firestore.js        DevTools-console paste for seeding classes/{classId}/weeks/
  seed-test-week.js        DevTools-console paste for the single Test Student setup

tests/
  oa-session.test.js
  submission-templates.test.js
  course-data.test.js

.github/workflows/
  test.yml                 runs vitest on push/PR

firestore.rules            per-user + TA-role access
firebase.json              Hosting rewrites for /api/* → Cloud Run services
```

## Gotchas

- **Chrome extensions don't hot-reload.** Every source change requires
  `chrome://extensions` → reload icon. Service worker may take a moment
  to restart; `chrome.runtime.onMessage.hasListeners()` returning
  `false` right after reload usually just means "SW hasn't finished
  booting yet."
- **The Canvas API token can expire.** If `verifyStudent` starts
  returning 500 "Canvas lookup failed", rotate the token:
  ```
  firebase functions:secrets:set CANVAS_API_TOKEN
  firebase deploy --only functions
  ```
  Token needs `become_user` permission for auto-submit to work. Jack's
  BYU account currently has this at the account level.
- **`canvasUserId` bug (fixed 2026-07-30).** Onboarding used to cache
  `canvasUserId` to `chrome.storage.sync` but never persist it to the
  student's Firestore doc. Fixed in `src/onboard.js`. Any student who
  onboarded BEFORE that fix needs `canvasUserId` manually backfilled
  (Firestore console). New onboardings are automatic.
- **`SEMESTER_YEAR = 2026` in `course-data.js`.** Semester runs
  Sep 3 – Dec 17 2026. Before Sep 3, every week is "future" and the
  dashboard shows "No weeks in view yet." If testing UI before then,
  temporarily edit dates in `src/course.json` (revert with
  `node scripts/vendor-course.js`) or bump `SEMESTER_YEAR` to a year
  containing today.
- **`students/jack684.canvasUserId` is set to the Test Student's ID (`169685`), not Jack's own (`62323`).** Intentional: Jack is
  enrolled as a teacher/TA in the course, not a student, so Canvas
  rejects submissions with `as_user_id=62323`. Test Student is Canvas's
  built-in student proxy; keeping the ID pointed at it lets end-to-end
  auto-submit tests succeed. Real students get their real IDs at
  onboarding.
- **Backstop only fetches last 20 accepted submissions.** Older
  solves may have no per-submission URL until re-solved. Not blocking;
  submissions fall back to `/problems/{slug}/` (problem URL).
- **`src/course.json` is vendored** — if the professor pushes updates
  to `../course/data/course.json`, re-run `node scripts/vendor-course.js`
  and reload the extension.

## What's NOT wired yet

Templates + form schemas already exist for these — just no dashboard
card renders them yet:

- **Connect with Class** (`connect-with-class`) — a `ref` in
  `schedule[N].other`, never becomes a performance item.
- **Instructor Pass/Fail Interview** (`instructor-interview`) — same.
- **All extra-credit items** — Amazing Project (3), Real Interview
  Report (5), Real Offer Report (3), Get a Friend (2), Interview
  Ready extension. Not modeled on the dashboard at all.

Also missing:
- **Grade push functions** (`pushCanvasGrades` etc.) still exist but
  are superseded conceptually by auto-submit. Should be
  decommissioned once every card type is auto-submitting.
- **Assignment-progress + Cloud Function test coverage.** Only pure
  helpers are tested; nothing that touches Firestore or the network.
- **Branch protection on `main`.** Workflow runs but doesn't gate
  merges. Enable in repo Settings → Branches when we start doing PRs.

## Recent commits (context for what's fresh)

```
29c4096 CI: add GitHub Actions workflow + 41 tests for course-data.js
74535e2 Track LeetCode per-submission URLs so Canvas submissions link to specific attempts
5e94b3d Auto-submit to Canvas: templates, form, wiring for 5 assignment types
4bd2d43 Adopt professor's course.json + wire signoff flows for performance/live interviews
d09aa3c Add professor meeting prep sheet for Canvas course setup
```

## What a next session might do

Ranked by strategic value:

1. **Wire dashboard cards for the missing types** (connect-with-class,
   instructor-interview, EC items). Templates + schemas already exist;
   this is UI + card-model work. Would complete the auto-submit story.
2. **Decommission old grade-push functions.** Once #1 is done,
   `pushCanvasGrades` / `pushMyRecentGrade` / `nightlyGradeSync` +
   the `classes/{classId}/weeks/` Firestore collection can be removed.
3. **Real pilot** with 2–3 friendly students onboarding fresh (Sep 3+).
4. **Expand test coverage** to `assignment-progress.js` (mocked
   Firestore) and Cloud Functions (mocked Canvas + Firestore Admin).
5. **Enable branch protection** once PR workflow starts.

## Testing commands

```
npm run test          # watch mode
npm run test:run      # one-shot (used by CI)
```

## Deploying

```
firebase deploy --only firestore:rules                        # rules
firebase deploy --only functions:submitCanvasAssignment,hosting  # a specific function + rewrites
firebase deploy --only functions                              # all functions
firebase functions:secrets:set CANVAS_API_TOKEN               # rotate Canvas token
```

## Contact + external artifacts

- Course repo: `github.com/byu-cs-393/course` (professor's; vendored)
- Extension repo: `github.com/byu-cs-393/extension` (this one)
- Firebase project: `cs393-496021` (`.web.app`, `.firebaseapp.com`)
- Canvas course: `35464` on `byu.instructure.com`
- Instructor: Michael Reynolds (mtr26@byu.edu)
- TAs: Jack Leonard + Andrew Cambridge

If any of this contradicts what you see in the code, trust the code
and update this file.
