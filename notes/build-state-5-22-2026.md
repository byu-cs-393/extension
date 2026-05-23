# Build state — 2026-05-22

Snapshot of where the extension is right now, written so Jack (or another instance of Claude on the phone) can be productive without re-reading the full commit history. Jack is traveling for ~3 weeks starting late May; this doc is the offline-friendly handoff.

For project background and the original scope, see [notes-5-11-2026.md](notes-5-11-2026.md) and [summary-5-11-2026.md](summary-5-11-2026.md). For the data-model sketch, see [data-model-5-13-2026.md](data-model-5-13-2026.md). For the full onboarding design, see [onboarding-5-13-2026.md](onboarding-5-13-2026.md).

---

## What works right now

End-to-end, with a real Firestore project (`cs393-496021`):

1. **Onboarding** at `src/onboard.html`. A full-tab page that auto-opens on extension install (via `chrome.runtime.onInstalled` in `background.js`). Collects netID + optional display name + optional status note. netID goes to `chrome.storage.sync`; name/note are PATCHed onto `students/{netID}` in Firestore.
2. **Dashboard** at `src/dashboard.html`. Loads the student doc, greets them by name, shows three hardcoded week cards (4, 5, 6) — **the weeks are still mock HTML**, not Firestore-driven. Profile button (👤) has a dropdown with **Sign out** which clears the netID from `chrome.storage.sync` and bounces back to onboarding.
3. **LeetCode tracker** at `src/leetcode-tracker.js`. Content script that runs on `leetcode.com/problems/*`. Logs three event types into the top-level `activity/{autoId}` collection:
   - `open_problem` — when the problem page loads or the user navigates between problems
   - `submit_pass` — Accepted verdict detected in the DOM
   - `submit_fail` — any other verdict (Wrong Answer, TLE, MLE, Runtime Error, Compile Error, etc.)

Each activity doc carries: `studentNetID`, `source: "leetcode"`, `eventType`, `problemSlug`, `problemTitle`, `timestamp`, and (for submits) `verdict`.

## What's NOT built yet

- **Dashboard week cards are mock HTML.** Doesn't read `students/{netID}/progress/{weekNum}` yet. Next obvious step.
- **No aggregation from activity → progress.** Solving on LeetCode logs an event but doesn't increment any counter. Needs a Cloud Function (or client-side aggregation if we accept the trust trade-off).
- **Onboarding is minimal.** The full design in `onboarding-5-13-2026.md` has a 4-step wizard (Canvas OAuth, LeetCode account detection, privacy disclosure). Current implementation is just a netID input.
- **No popup wiring.** `popup.html` is still pure mockup HTML from Stage 1. It doesn't read any real data.
- **No Cloud Functions yet.** Everything client-side.
- **No Firestore security rules in the repo.** Whatever is in the project is open enough for the current dashboard PATCH and content script POST to succeed. Should be tightened before any real data lives there.
- **No build/bundler.** Vanilla JS modules + content script. Means the LeetCode content script inlines its own copy of `firebaseConfig` and Firestore helpers (MV3 content scripts can't use `import`).
- **No tests.**

## Tech and conventions

- **Stack:** Chrome extension MV3 + Firestore (REST API, no Firebase SDK).
- **Why REST not SDK:** no bundler, so adding the SDK would require setting one up. REST works fine for the load we have.
- **firebase-config.js** holds the public Firebase config. Safe to commit — Firestore security rules (not the API key) gate access. The LeetCode content script inlines its own copy.
- **firestore.js** is the shared helper module (`fetchStudent`, `updateStudent`, plus `parseFirestoreFields` / `encodeFirestoreFields`). Imported by `dashboard.js` and `onboard.js`. Not importable from the content script.
- **chrome.storage.sync** holds the netID (key: `netID`). Picked sync over local so it follows the student across Chromes, per `onboarding-5-13-2026.md`.
- **Code style:** terse, minimal comments — only WHY when it's non-obvious. No defensive validation for impossible cases. No backwards-compat shims.
- **Commit style:** short imperative subjects ("Render student name from Firestore on dashboard"), optional body with the reasoning, `Co-Authored-By: Claude ...` trailer.

## File layout

```
src/
  manifest.json           # MV3 manifest: action popup, content script, background sw
  background.js           # Service worker — opens onboard.html on install
  firebase-config.js      # Public Firebase config (apiKey, projectId, etc.)
  firestore.js            # Shared fetchStudent/updateStudent helpers (module)
  onboard.html/.css/.js   # Full-tab onboarding: netID + name + note
  popup.html/.css/.js     # Toolbar popup — still mockup, opens dashboard
  dashboard.html/.css/.js # Full-tab dashboard — greeting + mock weeks + profile menu
  leetcode-tracker.js     # Content script for leetcode.com/problems/*
notes/
  *.md                    # Design docs, meeting notes, scope
```

## Firestore shape (current)

- `students/{netID}` — flat fields: `name`, `note`. (More fields will be added as features land.)
- `activity/{autoId}` — append-only event log written by the LeetCode tracker. Fields above.

The data-model doc plans for `students/{netID}/progress/{weekNum}` subcollection docs, which we'll need before the dashboard weeks can become real.

## Open questions Jack is sitting with

- Should Cloud Functions own the activity → progress aggregation, or can it be client-side?
- Canvas OAuth or typed-netID for production onboarding? Pending instructor confirmation on Canvas Developer Key.
- The LeetCode verdict detection relies on DOM text inspection (looking for spans/divs whose `textContent` exactly equals "Accepted", "Wrong Answer", etc.). Will break if LeetCode redesigns. Probably worth replacing with network interception eventually, but works for now.

## Last commits on `main` (most recent first)

- `32b5236` — Move student-info form to onboarding, add sign-out menu
- `4b3e01f` — Detect LeetCode submission verdicts, not just problem opens
- `7457aed` — Replace hardcoded netID with onboarding flow
- `0ad327c` — Log LeetCode problem visits via content script
- `af7f932` — Add Firestore write form to dashboard *(later removed)*
- `c2ade9f` — Render student name from Firestore on dashboard
- `895cd60` — First Firestore read: dashboard fetches a test student doc via REST
