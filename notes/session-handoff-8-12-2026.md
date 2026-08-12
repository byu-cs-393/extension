# Session handoff — 2026-08-12

Supersedes `session-handoff-8-5-2026.md`, which is now wrong in most
details (it predates the keystroke work, the build step, and 248 of the
tests). If this file drifts from reality, trust `git log`,
`data/course.json`, and `npm run ci` over anything written here.

## TL;DR

**CS 393 Buddy** — Chrome MV3 extension for BYU CS 393. Tracks a
student's LeetCode work, auto-submits assignments to Canvas on their
behalf, records their editing sessions, and gives TAs a signoff queue
plus a session replay. Fall 2026: **starts Sep 3, ends Dec 17**.

**Status:** a full dress rehearsal passed on Aug 11–12 — onboarding,
solving, recording, replay, and a real Canvas submission end to end.
336 tests. The remaining pilot risk is that the rehearsal ran as a TA
with a Test Student proxy, not as a genuinely enrolled student.

## READ THIS FIRST: there is now a build step

`src/keystroke-tracker.js`, `src/keystroke-injector.js`,
`src/leetcode-tracker.js`, `src/leetcode-auth.js` and
`src/canvas-auth.js` are **generated files**. Editing them directly is
wasted work — the next build overwrites it.

The real source is `src/content/`, which imports from `src/lib/`.

```
npm run build         # src/content/ -> src/  (after every edit)
npm run build:watch   # rebuild on save
npm run ci            # build:check + all tests, same as GitHub Actions
```

Bundled in place rather than into `dist/` so the extension still loads
straight from `src/` with no build step, and a stale build can't leave
you debugging code that isn't running. The generated files are committed;
`npm run build:check` fails if they've drifted, and CI runs it.

**Why this exists:** MV3 content scripts run as classic scripts with no
`import`, so each carried its own copy of the Firestore helpers, the
firebase config and the URL parsing — and none could be imported by a
test. Six capture bugs shipped in five days in those files. Since
bundling, that logic is shared and covered.

## Read-me-first (in this order)

1. **`../course/CLAUDE.md`** — the professor's integration guide.
2. **`../course/data/course.json`** — his single source of truth,
   vendored into `src/course.json` via `scripts/vendor-course.js`.
3. **`../course/weekly/README.md`** — the Weekly Study rubric (13
   pts/week). `src/lib/study-points.js` implements it.
4. **`src/course-data.js`** — the read layer over course.json.
5. **`src/keystroke-analysis.js`** — its header explains the capture
   data model and, importantly, why the suspicion signals are
   deliberately observations rather than verdicts.
6. **`functions/index.js`** — `submitCanvasAssignment` (masquerade POST)
   and `verifyStudent`.

## Where things are (as of 2026-08-12)

### Working end-to-end
- **Student flow** — onboard via Canvas → LeetCode → dashboard shows
  past + current weeks; full-course page shows all 15.
- **Auto-submit to Canvas** for OA, performance, live interview, peer /
  professional mock, Weekly Study, Connect with Class, and the
  Instructor Interview. **Resubmitting is allowed** — Canvas keeps every
  attempt and grades the newest, so "Submit again" replaces rather than
  duplicates. Answers prefill from last time; computed parts (solved
  problems, tracked time, points) recalculate.
- **Weekly Study submission** lists solved problems with their
  **accepted-submission URLs** (the rubric is explicit that a problem URL
  is not proof), separates unsolved with a count, prints the extension's
  measured active time, and ends with a suggested points breakdown
  labelled as computed from self-reported hours.
- **Keystroke capture + replay** — see below.
- **TA flow** — signoff queue, struggling list, per-student detail with
  a LeetCode sessions panel and a replay player.

### Keystroke capture — how it fits together
```
keystroke-injector.js   page world; hooks Monaco, posts deltas/snapshots
      ↓ postMessage
keystroke-tracker.js    isolated world; buffers, flushes to Firestore
      ↓
students/{netID}/keystrokeSessions/{id}          metadata + activeMs
students/{netID}/keystrokeSessions/{id}/chunks/  the events
      ↓
keystroke-analysis.js   active time, typing shape, signals  (pure)
keystroke-replay.js     document reconstruction              (pure)
ta-keystroke-view.js    the TA panel + player                (DOM)
```

Two Monaco editors exist on a LeetCode page (solution + testcase pane),
so every delta carries an `editorId`. Sessions recorded before that
can't be replayed at all and say so — mixed offsets produce a replay that
looks convincing and is wrong.

### Tests + CI
- **336 tests, 12 files** (`npm run ci`). Two use jsdom
  (`ta-keystroke-view`, `resubmission`), declared per-file so the rest
  stay in plain Node.
- **GitHub Actions** runs `build:check` then the suite on push to main
  and on PRs.
- **Branch protection is still off** — nothing gates a merge yet.

### Key files added since Aug 5
```
src/lib/                 shared modules (content scripts + pages)
  firestore-rest.js      REST encoding, token read, PATCH, headers
  problem-url.js         slug parsing + the title-verification rule
  extension-lifecycle.js orphaned-context detection
  canvas-error.js        readable Canvas errors (no more [object Object])
  study-points.js        the 13-point weekly rubric
src/keystroke-analysis.js  active time, typing shape, signals
src/keystroke-replay.js    replay reconstruction
src/ta-keystroke-view.js   TA sessions panel + player
scripts/build-content-scripts.js
scripts/shift-schedule-for-testing.js
```

## Gotchas

- **Don't edit `src/keystroke-tracker.js` et al.** — generated. See above.
- **`src/course.json` is vendored AND gets shifted for testing.**
  `scripts/shift-schedule-for-testing.js` moves every date so a chosen
  week contains today, because before Sep 3 every week reads as "future"
  and the dashboard is empty. It leaves the file modified-but-uncommitted
  by design. **It has been committed by accident twice** via `git add -A`
  — check `git status` before staging. Revert with
  `node scripts/vendor-course.js`.
- **`students/{netID}.canvasUserId` for a TA must point at Test Student
  (169685), not their real Canvas id.** Canvas rejects a masqueraded
  submission from a teacher with "user not authorized to perform that
  action". Wiping and re-onboarding overwrites this — it cost an hour
  during the rehearsal.
- **`activeMs` only exists on sessions recorded after 2026-08-11.**
  Older ones contribute 0 to the Weekly Study tracked-time line. The TA
  panel computes from events instead, so the two disagree on old data;
  that's expected, not a bug.
- **Content scripts share one isolated-world global scope**, and it
  survives an extension reload. That's why they're bundled as IIFEs; a
  top-level `const` collides with a re-injected copy of itself.
- **Reloading the extension orphans open tabs.** Recording stops and the
  badge turns grey ("⏸ recording stopped — reload page"). Reload the
  LeetCode tab too, not just the extension.
- **Chrome extensions don't hot-reload.** `chrome://extensions` → reload.
- **The Canvas API token needs `become_user`.** Rotate with
  `firebase functions:secrets:set CANVAS_API_TOKEN`.

## What's NOT done

- **Extra-credit renderers — 0 of 7.** Templates, schemas and Canvas ids
  all exist; there's no card. EC assignments aren't in `schedule[]`, so
  they need a new surface (an Extra Credit section on the full-course
  page), and three types are repeatable (5 interview reports, 3 offer
  reports, 3 amazing projects) which needs slot-allocation logic.
- **`ec-feature-fix` can't be submitted at all** — no template, no
  schema, no Canvas id in the deploy map. Needs the professor.
- **Suspicion thresholds are uncalibrated.** 0.5 rhythm variation, 2%
  deletion ratio, 40-char paste — educated guesses, never checked
  against real sessions. Do this before any TA acts on a signal.
- **The recording disclosure hasn't been reviewed by the professor.**
  It's in `src/onboard.html`; he asked for replay, so it's likely a
  formality, but it's the text students will point at.
- **Cloud Functions and `assignment-progress.js` have no tests.**
- **Grade-push functions** (`pushCanvasGrades`, `nightlyGradeSync`,
  `pushMyRecentGrade`) are still deployed and superseded. Decommission
  once every card type auto-submits.
- **Branch protection.**

## What a next session might do

1. **Rehearse as a real enrolled student** (Andrew). The Aug 11 run was
   a TA with a Test Student proxy, so `verifyStudent`'s roster check and
   a real student's `canvasUserId` are still unexercised.
2. **Extra-credit renderers** — the original task, still outstanding.
3. **Calibrate the thresholds** against honest sessions.
4. **Revert the schedule shift before Sep 3** (`node scripts/vendor-course.js`).

## Commands

```
npm run ci            # what CI runs: build:check + 336 tests
npm run build         # after editing src/content/ or src/lib/
npm run test          # watch mode
node scripts/shift-schedule-for-testing.js --week 3   # testing only
node scripts/vendor-course.js                          # revert / re-vendor
firebase deploy --only firestore:rules
firebase deploy --only functions
```

## Contact + external artifacts

- Course repo: `github.com/byu-cs-393/course` (professor's; vendored)
- Extension repo: `github.com/byu-cs-393/extension`
- Firebase project: `cs393-496021`
- Canvas course: `35464` on `byu.instructure.com`
- Instructor: Michael Reynolds (mtr26@byu.edu)
- TAs: Jack Leonard + Andrew Cambridge

If any of this contradicts the code, trust the code and update this file.
