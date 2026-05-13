# Data model — 2026-05-13

Sketch of the Firestore + Cloud Storage data model that backs the rest of the design (student dashboard, TA dashboard, alerts, keystroke replay). Follow-up to [ux-locked-5-12-2026.md](ux-locked-5-12-2026.md), [alerts-5-12-2026.md](alerts-5-12-2026.md), and [ta-view-5-13-2026.md](ta-view-5-13-2026.md).

**Status:** Sketch captured. Implementation will surface more questions; this is a starting point, not the final word.

---

## Top-level structure

Firestore is document-oriented — collections of documents, where documents can contain subcollections. The schema uses hierarchy for clear ownership and flat top-level collections for entities that need to be queried across parents.

```
classes/{classId}
  ├── weeks/{weekNum}                    # per-week assignment definitions
  └── onlineAssessments/{assessmentId}   # assessment definitions

students/{netID}
  ├── progress/{weekNum}                 # per-week summary (solved problems, exam state)
  ├── flags/{weekNum}                    # per-week alert state + streaks
  ├── recordings/{recordingId}           # keystroke metadata (raw data in Cloud Storage)
  └── assessmentAttempts/{attemptId}     # online assessment attempts (1–3 per assessment)

tas/{netID}                              # TA identity + which classes they work

signoffs/{signoffId}                     # top-level for cross-TA/student queries
mockInterviewSessions/{sessionId}        # paired sessions
mockInterviewRequests/{requestId}        # waiting-to-be-matched queue
bookings/{bookingId}                     # scheduled slots (mirror of Cal.com / Calendly)
activity/{eventId}                       # append-only milestone event stream
alertEmails/{emailId}                    # audit log of sent alert emails
```

**Plus Cloud Storage** for keystroke recordings — too big for Firestore (1 MB document cap). Each recording lives as a single JSON file at `gs://<bucket>/recordings/{netID}/{sessionId}.json`, with metadata pointing to it from `students/{netID}/recordings/{recordingId}`.

---

## Decisions baked in

1. **Pre-computed weekly summaries.** `students/{netID}/progress/{weekNum}` is updated as events happen (problem solved → counter incremented). The dashboard reads *one* doc to render a week, not thousands of activity events. Firestore charges per document read; this matters.

2. **Keystroke recordings in Cloud Storage, not Firestore.** Firestore caps documents at 1 MB. A long session would blow through that. Recordings go to a bucket; Firestore stores only metadata + the path.

3. **Multi-class from day one.** Every student has an `enrolledClass` field; every class-scoped doc carries a `classId`. Costs nothing now; saves a migration if the tool ever serves another course.

4. **Signoffs as a top-level collection.** Belongs to both a student AND a TA — making it a subcollection of one would orphan the other. Top-level + `studentNetID` + `taNetID` fields make queries like "all signoffs by Jack this week" and "all signoffs for Maria this semester" both fast.

5. **Bookings mirror, don't own.** The scheduler (Cal.com / Calendly / Google Calendar) is the source of truth for slots. Firestore mirrors enough metadata to correlate "this booking → this signoff session" and survive scheduler downtime.

6. **Activity log is milestone-only.** Captures open_problem, start_problem, submit, pass, paste, tab_switch, session_end — not every keystroke. The raw keystroke stream is one Cloud Storage file per session, opened only on replay.

---

## Subcollections vs top-level — when to choose which

| | Subcollection | Top-level collection |
|---|---|---|
| Use when | Clear single owner; queried in parent context | Multiple parents OR cross-parent queries needed |
| Example | `students/jdoe/progress/6` — week-6 progress only makes sense for Jane Doe | `signoffs/{id}` — has both a student and a TA; queried across both |
| Trade-off | Cleaner ownership; can't query across parents without `collectionGroup` indexes | Cross-querying easy; relationship traversal needs explicit fields |

In Firestore, *everything* relates to other things — whether via subcollection containment or stored ID fields. Where a piece of data lives in the tree is a layout choice, not a connectedness choice.

---

## The metadata pattern

A pattern that shows up multiple times in this schema: a small Firestore doc describes a larger thing stored elsewhere.

| Metadata doc (Firestore) | The actual thing |
|---|---|
| `students/.../recordings/{id}` | Keystroke JSON in Cloud Storage |
| `bookings/{id}` | Calendar event owned by Cal.com / Calendly |
| `students/.../assessmentAttempts/{id}` | The session it summarizes |
| `activity/{eventId}` | A milestone — raw keystroke detail is in Cloud Storage |

**Rule of thumb:** if a piece of data is small, frequently queried, used to filter/find/list, or describes a heavier thing → store in Firestore. If it's large, infrequently accessed, or only useful in full → store elsewhere and point at it from Firestore.

---

## Trade-offs and leans

- **Activity event granularity:** milestone-level only. Reason: queries are about milestones, not individual keystrokes; storing per-keystroke would multiply the document count by ~100x for no read-side benefit.
- **Week identifier:** `classId` + integer `weekNum`. Date ranges are derivable from the class start date.
- **Student root doc:** keep tiny (identity, connection key, devices, privacy opt-ins). Everything time-varying lives in subcollections to isolate writes and avoid the 1 MB cap.
- **Soft vs hard delete** for students who drop the class — needs BYU privacy guidance before locking in.

---

## Open questions

- **Exact set of milestone events** in `activity`. Initial list above; are there others worth tracking (gave_up, switched_problem_mid_session, etc.)?
- **Who writes activity events** — direct from the extension or through a Cloud Function for validation/rate-limiting?
- **Composite indexes.** Firestore needs explicit indexes for any multi-field query. We'll discover the full set during implementation.
- **Security rules.** Students should read only their own data; TAs read enrolled students' data; admin / Cloud Functions bypass. Rules to be drafted alongside implementation.
- **Class config ownership.** Who writes `classes/{classId}/weeks/{weekNum}` — the instructor via a config UI, a JSON file checked into the repo, or both?
