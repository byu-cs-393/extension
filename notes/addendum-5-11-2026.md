# Addendum — 2026-05-11

Recorded after the main meeting. Walkthrough of how Jack will get a Canvas API token and how the extension will use it.

## Adding Jack to the Canvas course

- Canvas user search returned two similar handles — `jackjohn684` (Jack's actual account) and a near-duplicate (something like "jack@safelearning"). They look almost identical; pick carefully when adding people.
- Jack has been added to the course on Canvas.

## Generating a Canvas API access token

1. Click your **profile picture** (top-left of Canvas).
2. Click **Settings**.
3. Scroll to **Approved Integrations** (a.k.a. the Integrations section).
4. Click **New Access Token**.
5. Copy the token immediately — Canvas only shows it once.

## What the token actually grants

A Canvas access token is **full impersonation** of the user who minted it. Whatever the user can do in Canvas, the token can do:

- Edit grades on any course where the user is a TA or instructor.
- Post/edit submissions on their behalf.
- Read course rosters, assignments, submissions.

For the extension: the **instructor's** token is what lets the backend auto-write topic-exam pass-offs to Canvas grades. Jack's TA-level token can also be used to test the flow during development.

## Why this changes the architecture (re-emphasis)

This is exactly why the architecture from [architecture.md](architecture.md) keeps the token in **GCP Secret Manager**, not in the extension:

- The extension never sees the token.
- The Cloud Function reads it from Secret Manager at request time.
- The extension just calls `POST /signoff` and the function does the Canvas call.

```mermaid
flowchart LR
    EXT["Extension<br/>(no secrets)"] -->|POST /signoff| FN["Cloud Function"]
    FN -->|reads at request time| SM[("Secret Manager<br/>🔐 Canvas token")]
    FN -->|impersonates instructor| CV["Canvas API"]
```

## Security rules for the token

- Treat the token like a password. If it leaks, anyone can change any grade in any of the instructor's courses.
- **Only** store in Google Secret Manager. Never commit it to the repo. Never put it in `chrome.storage.*`. Never log it (not even truncated).
- For local dev, Jack can use his own TA-level token in his own local `.env` (gitignored) — never the instructor's.
- Rotate (regenerate) at least once a semester, or immediately if compromise is suspected. Old tokens can be revoked from the same Integrations page.

## Action items added today

- [ ] Instructor: generate the production Canvas token, store it in Secret Manager under e.g. `projects/cs393-496021/secrets/canvas-api-token`.
- [ ] Jack: generate his own TA-level token for local dev, store in a gitignored `.env`.
- [ ] Backend code: read the secret via the Google Cloud client library, never from environment variables in deployed Functions.
