# Meeting prep — 2026-05-13

Quick reference for today's meeting with the instructor. Carries the open questions accumulated across the design notes:
- [ux-locked-5-12-2026.md](ux-locked-5-12-2026.md)
- [alerts-5-12-2026.md](alerts-5-12-2026.md)
- [topic-exam-5-12-2026.md](topic-exam-5-12-2026.md)
- [ta-view-5-13-2026.md](ta-view-5-13-2026.md)
- [data-model-5-13-2026.md](data-model-5-13-2026.md)

Ordered by impact.

---

## What's been decided since 5/11 (quick FYI)

- Student dashboard = Canvas-style weekly scroll, 1–3 cards per week (recommended / choice / one-of {online assessment, mock interview, topic exam})
- Falling-behind alerts: red/yellow/copy-paste, twice-weekly digest emails to Jack + instructor
- Topic exams stay live with TA present (no async)
- TA view = roster-first dashboard with notification-approve signoff (no PIN)
- Needs-attention list lives on a dedicated page for privacy
- All TA time formally scheduled; even spontaneous drop-ins book the calendar slot
- Data model = Firestore + Cloud Storage with pre-computed weekly summaries

---

## High-priority decisions needed

### 1. One topic-exam type or two this semester?

The 5/11 meeting discussed splitting into:
- **Performance exam** (pre-announced problem, 15 min, no help — proves skill)
- **Articulation exam** (novel problem, 30 min, TA actively engages — proves understanding)

Is this happening **this** semester, or do we keep a single topic-exam type for v1 and spec the split for next?

**Why it matters:** affects the dashboard mockup, scheduling (different slot lengths), and the data model. Cleaner to commit to one type for v1 and add the second later than to half-build for both.

**Jack's lean:** start with one type for v1, design the data model so a second type can slot in cleanly.

---

### 2. Canvas Developer Key for OAuth

Have you already registered a Canvas Developer Key for any of your projects (e.g., the BYU Pathway email pipeline)? If yes, we can use OAuth for student onboarding — they sign in with Canvas, identity is verified automatically, no typing netID or student ID.

If no, how long does BYU IT typically take to approve one? Worth it if quick.

**If deferred:** onboarding falls back to typed netID + Canvas roster check via your TA token. Works fine; just no identity verification (low risk in this context anyway).

---

### 3. Canvas TA token in Secret Manager before you travel?

Both the roster check at onboarding AND the future grade-posting need your TA-level Canvas API token in `projects/cs393-496021/secrets/canvas-api-token` (per [addendum-5-11-2026.md](addendum-5-11-2026.md)). Without it, Jack can't develop the roster-check flow during the async stretch.

**Action:** confirm the token will be generated and uploaded before 2026-05-18.

---

### 4. Privacy: master opt-in or per-feature toggles?

When students onboard, they consent to data collection. Two options:
- **Master**: one "I agree to everything" checkbox covering activity tracking, keystroke recording, leaderboards, alerts
- **Per-feature**: separate toggles for each piece

Master is simpler; per-feature is friendlier to BYU policy. Was there guidance from the prior BYU approval about which is required?

**Jack's lean:** master for v1; add granular toggles if BYU requires it.

---

### 5. BYU privacy statement — fresh approval needed?

Does the prior BYU approval (mentioned 5/11) cover this extension, or is fresh sign-off required? If fresh: what's the process and lead time?

Either way, Jack will draft the privacy statement during the async stretch — just need to know if it's reviewable by you alone or needs to go to BYU compliance.

---

### 6. BYU Pathway email pipeline walkthrough

You offered to walk Jack through the existing automated-email pipeline. The falling-behind/copy-paste alerts (twice-weekly digests, see [alerts-5-12-2026.md](alerts-5-12-2026.md)) will reuse this pattern.

**Action:** schedule a 30-min walkthrough before you travel, or share the relevant repo/docs link so Jack can study it asynchronously.

---

## If there's time

- **Scheduler backend.** Cal.com (free, multi-duration, open-source) vs Calendly Standard ($12/TA/month) vs direct Google Calendar API. Lean: Cal.com.
- **Mock-interview matching mechanics.** Student clicks "Find a partner" — then what? Random match from others looking right now? TA-pre-paired? Worth your initial thoughts.
- **"Pick problem" pool for choice-problem weeks.** LeetCode's full catalog with a difficulty filter, or a small curated list?
- **TA PIN distribution** vs notification-approve-only (Jack's lean: skip PINs, see [ta-view-5-13-2026.md](ta-view-5-13-2026.md)).

---

## To capture from this meeting

After today, update:
- [topic-exam-5-12-2026.md](topic-exam-5-12-2026.md) — one type vs two decision
- [ta-view-5-13-2026.md](ta-view-5-13-2026.md) — scheduler choice, multi-TA routing if relevant
- A new privacy notes file — BYU statement scope + opt-in granularity
- The onboarding flow notes (not yet committed) — Canvas OAuth yes/no
