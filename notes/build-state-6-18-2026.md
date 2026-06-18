# Build state — 2026-06-18

Snapshot of where the extension is after roughly a month of work since [build-state-5-22-2026.md](build-state-5-22-2026.md). A lot changed — most of the dashboard moved from mock to real data, the auth model evolved, and Firestore picked up a security-rules layer (still schema-only, not per-user).

For project background, see [notes-5-11-2026.md](notes-5-11-2026.md) and [summary-5-11-2026.md](summary-5-11-2026.md). For the data-model intent, see [data-model-5-13-2026.md](data-model-5-13-2026.md). For the original onboarding design, [onboarding-5-13-2026.md](onboarding-5-13-2026.md).

---

## What works now (end-to-end)

1. **Onboarding requires an active BYU Canvas session.** `src/onboard.html` step 1 has two sub-states:
   - **Canvas signed out** → "Open BYU Canvas →" prompt. Form is hidden.
   - **Canvas signed in** → green identity card ("Signed in to Canvas as `<netID>`") with display-name and status-note inputs revealed.

   The Canvas content script (`src/canvas-auth.js`) runs on `https://byu.instructure.com/*`, hits `/api/v1/users/self/profile`, and writes `{ signedIn, netID, name, canvasUserId, ltiUserId }` to `chrome.storage.local.canvasAuth`. The onboarding panel auto-flips between the two sub-states the moment the storage value lands.

   No more typed BYU ID — Canvas session is the identity gate.

2. **Step 2 is the LeetCode link** (unchanged). Cookie detection via `src/leetcode-auth.js`, "Yes, that's me" confirmation, saves `leetcodeUsername`.

3. **Dashboard** at `src/dashboard.html` is now fully data-driven:
   - Greeting from `student.name`
   - Profile dropdown with Sign out (clears `chrome.storage.sync.netID`, redirects to onboarding)
   - **Weeks render dynamically** from the Firestore subcollection, no more hardcoded HTML week sections
   - Per-week recommended-problems card with three visual states: **current** (blue), **past-complete** (green check), **past-incomplete** (gray, "Week ended — no more credit")
   - Each week's solves filter by that week's own `startDate`/`endDate` window
   - "Synced X ago" meta for the current week
   - Live re-renders via `chrome.storage.onChanged`

4. **Popup** at `src/popup.html` mirrors the current week's recommended card — "Currently on: `<next unsolved>`" + a button that opens that problem on LeetCode. Falls back to "No active week" if between weeks.

5. **LeetCode tracker** (`src/leetcode-tracker.js`) writes three event types into `activity/{auto}`: `open_problem`, `submit_pass`, `submit_fail`. The verdict detector is now substantially more robust — requires the candidate "Accepted" element to live inside an ancestor whose text contains `Runtime`/`Memory`/`testcases passed`/`submitted at`, filtering false positives from status badges and filter UI.

6. **LeetCode backstop** (also in `src/leetcode-auth.js`) runs on every leetcode.com page load (throttled to 1×/min). Calls `recentAcSubmissionList`, reconciles with cache + Firestore, preserves tracker-recorded timestamps over LeetCode-reported ones (the tracker fires in real time; LeetCode reports server time). Pushes cache-only entries to Firestore on the way through.

7. **Recommended catalog is Firestore-driven**. Per-week docs live at `classes/cs393/weeks/{weekNum}` with `weekNum`, `startDate`, `endDate`, `problems: [{slug, title, difficulty}]`. On first run, `src/recommended.js` auto-seeds three test weeks (4, 5, 6) with dates computed from today. When the real semester starts, the professor wipes and re-seeds with real dates.

8. **Schema-only Firestore security rules** live at `firestore.rules` (and in the Firebase Console). Enumerate allowed paths, validate document shape and enum values, make activity append-only, default-deny everything else. Documented at the top of the file: they're a "doorman who checks paperwork, not faces" — no per-user authorization yet.

## What's NOT built yet

- **Phase 2 of auth: Cloud Function + Firebase Auth + per-user rules.** `lti_user_id` is captured but unused. Until this lands, anyone with the API key + a netID can still write to that student's doc as long as the schema fits. Next on the docket.
- **Topic exam cards** (data + UI). The original instructor priority from [summary-5-11-2026.md](summary-5-11-2026.md) — still entirely unimplemented.
- **Other card types per week:** Choice problems, Mock Interview, Online Assessment.
- **TA dashboard.** The TA-facing surface for signoffs, alerts, viewing student progress.
- **Activity → progress aggregation via Cloud Functions.** Activity log fills up but nothing reads it server-side.
- **Falling-behind alerts.** The "student hasn't solved anything in N days" outreach signal.
- **Mock interview matching, keystroke recording / replay, Canvas grade posting** — all the original-scope items still pending.
- **Multi-class support.** `CLASS_ID` is hardcoded to `"cs393"` in `recommended.js`.

## Architecture

### Storage shape

**`chrome.storage.sync`** (identity, follows the user across Chromes):
- `netID` — from Canvas
- `ltiUserId` — Canvas-issued hash, will be Phase 2's verification token
- `canvasUserId` — Canvas internal ID
- `leetcodeUsername` — confirmed in step 2

**`chrome.storage.local`** (cache, per-device):
- `canvasAuth` — `{ signedIn, netID, name, canvasUserId, ltiUserId, checkedAt }`
- `leetcodeAuth` — `{ signedIn, username, realName, avatar, checkedAt }`
- `solvedProblems` — `{ solves: { slug: timestampMs }, syncedAt }`
- `weeksCatalog` — `{ weeks: [...], syncedAt }`
- `backstopLastRunAt` — throttle timestamp

### Firestore

- `students/{netID}` — `{ name?, note?, leetcodeUsername?, solvedProblems: map<slug, ms> }`. Solves are a Firestore `mapValue` with `doubleValue` timestamps.
- `activity/{autoId}` — append-only `{ studentNetID, eventType, source, timestamp, problemSlug?, problemTitle?, verdict? }`. Three valid `eventType`s: `open_problem`, `submit_pass`, `submit_fail`.
- `classes/{classId}` — class doc. Has a legacy `recommendedProblems` field from before multi-week; new code ignores it.
- `classes/{classId}/weeks/{weekNum}` — `{ weekNum, startDate (ms), endDate (ms), problems: [{slug, title, difficulty}] }`. Auto-seeded on first run.

### Tech conventions

- **Chrome MV3 + Firestore REST API.** No SDK, no bundler, no TypeScript.
- **ES modules** for extension pages (dashboard, onboard, popup). **Classic scripts** for content scripts (can't use `import`).
- **`firestore.js`** exposes generic `fetchDoc` / `patchDoc` / `fetchCollection` helpers + recursive `parseFirestoreFields` / `encodeFirestoreFields` (handle arrays and nested maps).
- **`recommended.js`** holds the per-week catalog fetcher + week-window helpers; both dashboard and popup import from it.
- **Cache pattern:** every cross-component update flows through `chrome.storage.local` and `chrome.storage.onChanged` — popup, dashboard, and onboarding all subscribe to the keys they care about and re-render automatically.
- **Each content script wrapped in an IIFE** to keep top-level `const`s scope-local. Without this, scripts injected on the same page collide on shared identifier names (`firebaseConfig` etc.) and the second-loaded script silently fails to inject.

## File layout

```
src/
  manifest.json          # MV3 manifest
  background.js          # Service worker — opens onboarding on install
  firebase-config.js     # Public Firebase config (api key, project id)
  firestore.js           # Generic Firestore REST helpers (module)
  recommended.js         # Per-week catalog fetcher + week helpers (module)
  onboard.html/css/js    # 2-step wizard: Canvas → LeetCode
  popup.html/css/js      # Toolbar popup — current week's progress
  dashboard.html/css/js  # Full dashboard — all weeks
  canvas-auth.js         # Content script: BYU Canvas session detection
  leetcode-auth.js       # Content script: LeetCode session + backstop sync
  leetcode-tracker.js    # Content script: verdict detection + activity log
firestore.rules          # Schema-only security rules (in version control)
notes/
  *.md                   # Design docs, snapshots, meeting notes
```

## Open questions / next decisions

- **Phase 2 design.** How is the roster seeded (Firestore admin collection? Cloud Function syncing from Canvas?). Where does the instructor's Canvas API token live (Cloud Function env var? Firebase config?). How does token refresh work in the extension?
- **Topic exam state model.** Open question from [data-model-5-13-2026.md](data-model-5-13-2026.md). What states does a signoff move through, who can transition each, what blocks week-completion?
- **Multi-class.** When and how to generalize beyond CS 393. `CLASS_ID` is hardcoded; a real class roster would need to be tied to enrolled students.
- **Between-semester behavior.** The "current week" is whichever week's window contains today. What happens when no week's window contains today (winter break, etc.)? Popup falls back to "No active week"; dashboard shows past weeks only.
- **Deprecated `classes/{classId}.recommendedProblems` field.** Should be deleted once we're confident no client paths read it.
- **Canvas API stability.** `/api/v1/users/self/profile` returns `login_id` and `lti_user_id` for BYU students, but BYU IT could change permissions. Worth periodic verification.

## Last commits on `main` (newest first)

- `2c2c158` — Require active Canvas session for onboarding; drop BYU ID input
- `54d9276` — Auto-fill onboarding from BYU Canvas cookie; collect Student ID *(superseded)*
- `7518815` — Add schema-only Firestore security rules
- `04ffed0` — Drive dashboard from per-week Firestore subcollection
- `82849cc` — Move recommended-problem catalog from code to Firestore
- `8b2c94e` — Drive popup card from real solvedProblems cache
- `0454539` — Stop two regressions: tracker silent-fail, resolves not registering
- `e30c309` — Add recent-AC backstop sync; only count solves from the current week
- `8c5191a` — Fix verdict detector against LeetCode's run-on result-panel text
- `552aa4c` — Move recommended-problem truth from LeetCode to Firestore
- `7b6147b` — Stop counting status badges as fresh LeetCode verdicts
- `f8a3245` — Make recommended-progress sync responsive to recent submissions
- `cf634e7` — Collapse recommended-problems list behind a details/summary toggle
- `c4f700a` — Drive Week 6 recommended-problems card from real LeetCode status
- `fb7b5a2` — Add LeetCode cookie-detection step to onboarding wizard
- `35eaf4b` — Add 2026-05-22 build state snapshot
