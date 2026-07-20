# Professor meeting prep — 2026-07-20

For the meeting where he wants to set up the Canvas course. Working
document — bring it in, work through it together.

## 30-second summary of what exists

The extension is essentially done. End-to-end:

- Students onboard via Canvas + LeetCode (no typing IDs)
- Solve problems on LeetCode → dashboard counter updates immediately → grade appears in Canvas within seconds (real-time push) → nightly reconciliation as safety net
- Students can request topic exam signoffs → TAs approve in a dashboard
- TAs (Jack right now) have a role-gated dashboard for signoff queue + struggling-student view + per-student drill-down

**The one thing missing**: Canvas assignments don't exist yet. That's what this meeting unblocks.

## Decisions needed today

Ordered so if we run out of time, we get the most important stuff.

### 1. Weekly grading rubric — required or count-based?

Looking at the syllabus docs, some weeks list specific problems ("solve these 4") and others give a count target ("solve at least 10 total problems this week"). The extension needs to know which applies per week.

**Question for each week:** are the listed problems *required* (must solve those specific ones) or *advisory* (any N problems is fine)?

Three patterns I see across the semester:
- **Type A — all listed required.** Grade = solved-listed / listed-count.
- **Type B — count target, list is guidance.** Grade = min(any-solves-this-week, target) / target.
- **Type C — hybrid.** Must solve the listed AND reach the count. (Rare.)

Extension already handles A. Adding B is a ~30-min schema change (`gradingRule: { type, target }` field). C would be a bigger addition — hoping to avoid it.

**My ask:** for each week, tell us A or B (or C if unavoidable). I can walk through the 14 weeks with you.

### 2. Canvas assignment groups + weights

Canvas uses "assignment groups" to weight categories independently. Current design assumes **4 groups**:

- Weekly Practice (all recommended assignments)
- Topic Exams (live signoff portion)
- Online Assessments (the OA portion of each topic — different weeks from the live signoff)
- Mock Interviews

**Alternative: 2 groups** — Weekly Practice + Competency (topic exams, OAs, mock interviews all lumped).

**My ask:**
- 2 groups or 4?
- Weight per group (must sum to 100% within the course; 25% of the syllabus is Extra Credit which sits outside)

### 3. Assignment naming convention

Once auto-created, renaming is annoying (students see the old name). Options:

- `Week 6 Recommended` (short, functional)
- `Week 6 · Recommended Problems` (readable, matches dashboard)
- `CS 393 Week 6 · Recommended` (course-prefixed, matches syllabus style)

Same pattern applied to third cards: `Week 6 Topic Exam · Hash Maps`, `Week 6 OA · Data Structures`, `Week 6 Mock Interview`.

**My ask:** pick a pattern.

### 4. Publish state on creation

Newly created Canvas assignments can be **published** (visible to students, grades show) or **unpublished** (invisible, grades accumulate but hidden).

- **Publish now**: grades appear as they're pushed, real-time feedback for students.
- **Publish later**: silent accumulation, release when he approves the batch.

**My ask:** which for MVP? (Can switch later per-assignment.)

### 5. Token ownership — long-term plan

The Cloud Function that pushes grades uses a Canvas API token. Currently it's using a personal token (yours or mine). Grades pushed through the system show up in Canvas's audit log as "posted by [token owner]."

**Options for the long term:**
- Keep a personal token, rotate every semester
- BYU IT creates a "service account" for the extension — cleanest, but takes weeks
- Migrate to Canvas OAuth per-user — biggest change, best for scale

**My ask:** for this semester, is yours OK? Longer term, do you want to ask IT for a service account?

## What we DON'T need to decide today

Deferred to future meetings or after pilot:

- Extra credit mechanism (25% per syllabus — how does it get computed automatically?)
- Final exam integration (currently no plan for auto-tracking)
- Mock interview partner matching (paired-student mechanic)
- Distribution: Chrome Web Store (auto-updates, review lag) vs sideload (manual updates, no review). Only matters when we go beyond a handful of students.
- "Choice problems" (student-picked, any-of-N) — related to rubric decision #1

## If he wants to auto-create Canvas assignments today

I can write a "seed Canvas assignments" script during the meeting once decisions 2 + 3 are locked. It reads every week from Firestore, creates the corresponding Canvas assignment(s), writes IDs back. Idempotent — safe to re-run if he wants to change things.

30–60 seconds to run once decisions are made. Alternative: he clicks through in Canvas manually (~30 assignments, ~30 min).

## Live demo cheat sheet (optional)

If he wants to see the system in action:

1. Open `chrome-extension://.../dashboard.html` — student view. Shows Week 99 with the test topic exam.
2. Click 🛡 TA button — TA dashboard. Show signoff queue with pending requests from dummy students.
3. Struggling students tab — show sort dropdown. Sort by "Fewest solves this week."
4. Click a struggling student row — per-week breakdown appears.
5. Back button works. Browser back works.
6. Show Firestore console: `students/`, `weekProgress/`, `gradeSyncLog/` collections.
7. Show Canvas gradebook: Test Student's row already has real grades from previous tests.

The whole demo is under 5 minutes.

## After the meeting — order of operations

Once decisions are locked:

1. **Update the seed script** (`scripts/seed-firestore.js`) with the per-week `gradingRule` values.
2. **Run the Firestore seed** → all 14 weeks land in Firestore with correct rubric.
3. **Write + run seed-canvas.js** → all Canvas assignments created, IDs written back to Firestore.
4. **Deploy nightly Cloud Scheduler** (if not already).
5. **Fire pushCanvasGrades** manually once to sanity-check with real assignments.
6. **Start pilot** — 2 friendly students onboard (per testing plan Stage 1).

Everything above except step 1 is already written. Step 1 is 15 minutes of me updating the seed once we have his answers.
