# Topic exam design — resolved 2026-05-13

**Status:** Resolved 2026-05-13 — **both exam types stay live.** The discussion below is kept as historical context for the trade-offs that were weighed. Follow-up to [ux-locked-5-12-2026.md](ux-locked-5-12-2026.md).

## Decision (2026-05-13)

**The performance exam will not be async.** Both performance and articulation topic exams remain live with a TA present (in person or Zoom).

The async open questions at the bottom of this doc (paste-trigger behavior, problem-pool size, student access to recordings) are moot in the live model — paste handling becomes a TA judgment call during the session, and the rest belong to dashboard-layer decisions handled in [ta-view-5-13-2026.md](ta-view-5-13-2026.md).

---

## Two exam types (already agreed 5/11)

- **Performance exam** — student solves a pre-announced problem in 15 min. Verifies "did you do the prep work."
- **Articulation exam** — student talks through a novel problem with a TA. Verifies "do you actually understand."

Together they form a complementary pair: performance catches the lazy, articulation catches the rote.

---

## Open question: should the performance exam be async?

### What "async" would mean

- Student starts the exam from the dashboard on their own time
- 15-min timer runs locally; keystroke recording captures the session
- Submission either auto-passes (no flags) or goes to a TA review queue (if flagged)
- No TA present during the exam

### What "live" means (current model)

- Student schedules a session with a TA
- TA watches in person or on Zoom, can intervene
- TA judges effort and signs off in real time

### Arguments for async

- **TA time savings** — ~3 min of replay scrubbing replaces a 15-min live session; TAs can batch-review multiple submissions in one sitting
- **Schedule flexibility** — students take it when they're ready, not when a TA is free
- **Consistency** — removes the "TA was tired and gave too much help" inconsistency the instructor flagged in the transcript (around [23:50])
- **Threat model is small** — pre-announced problems collapse most cheating vectors (see below)

### Arguments against async

- Loses the live human connection a TA-student session creates
- Determined cheaters can still cheat — off-screen help (a friend narrating) is undetectable by keystroke replay
- "Performance under pressure" is softer when alone vs. with a TA present
- Tension with the instructor's stated goal of human-touch tooling

---

## Threat model with pre-announced problems

When the student already knows the problem:

- **Memorizing and typing from memory is the desired behavior** — practicing until you can produce a working solution is literally the goal of this exam type
- **Straight-line typing is no longer a cheating signal** — it's exactly what we want from a well-prepared student
- **The remaining threats become:**
  - Pasting the solution from a notes file written during practice
  - Someone else doing the exam in the student's place
- Both detectable signals (paste, tab-switch) catch the low-effort version of paste-from-notes
- The articulation exam catches the "memorized without understanding" case as a backstop

---

## Recommended simplification (if instructor approves async)

- **Drop:** active TA review of every submission; straight-line-typing analysis
- **Keep:** time limit, keystroke recording (as audit trail, not active verification), paste detection, tab-switch detection
- **Auto-pass** on no flags; only flagged exams reach the TA queue
- TA queue shrinks dramatically — TAs mostly handle articulation exams + the occasional flagged performance exam
- Recording becomes useful **for the student too** — they can watch themselves solve from memory as self-study

The articulation exam stays live regardless. The conversation *is* the assessment; there's no async equivalent.

---

## Decisions needed from instructor

1. Async performance exam — yes, no, or hybrid (default async + optional live)?
2. If async, what should a paste event trigger — auto-fail, soft-flag for TA review, or warning to student?
3. Strictly one pre-announced problem, or a small rotating pool so students can't fully memorize one specific solution?
4. Should the recording be made available to the student afterward as a self-study aid?
5. Should async submissions be available the same week the problem is announced, or only after a "practice window" (e.g., students get the problem on Monday, can attempt starting Wednesday)?
