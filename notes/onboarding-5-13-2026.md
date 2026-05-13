# Onboarding / auth flow — 2026-05-13

How a CS 393 student gets from "extension installed" to "ready to use." Pairs with the auth sequence diagram in [architecture.md](architecture.md#2-first-time-connection-auth-flow), which covers the backend side; this doc covers the student-facing UX.

**Status:** Two variants captured. The **Canvas OAuth path is preferred** — pending confirmation in the 2026-05-13 instructor meeting that a BYU Canvas Developer Key is available. If not, the fall-back uses typed netID + Canvas roster check (functionally equivalent, slightly worse UX, no real identity verification).

---

## Where it lives

**Full-page tab, not the toolbar popup.** On install, the extension auto-opens an onboarding tab (`chrome-extension://.../onboard.html`) via the `chrome.runtime.onInstalled` event. The popup is too cramped for forms + privacy text, and onboarding is a one-time "leave once" event that deserves real screen space.

---

## Preferred flow — Canvas OAuth

### 1. Welcome

```
╔════════════════════════════════════════════════════════════╗
║  CS 393 Buddy                                              ║
╠════════════════════════════════════════════════════════════╣
║                                                            ║
║   Welcome to CS 393 Buddy                                  ║
║                                                            ║
║   This extension helps you:                                ║
║    • Track your weekly LeetCode work                       ║
║    • Pass off topic exams with a TA                        ║
║    • Auto-sync grades to Canvas                            ║
║                                                            ║
║   Setup takes about a minute. We'll connect your           ║
║   LeetCode account and verify you through Canvas.          ║
║                                                            ║
║                               [ Get started → ]            ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
```

### 2. Connect LeetCode

```
╔════════════════════════════════════════════════════════════╗
║  CS 393 Buddy · Setup                                      ║
║  ●━━━○━━━○━━━○   LeetCode | Canvas | Privacy | Done        ║
╠════════════════════════════════════════════════════════════╣
║                                                            ║
║   Step 1 — Connect LeetCode                                ║
║                                                            ║
║   ⚠ You're not signed in to leetcode.com                   ║
║                                                            ║
║   Click below to sign in. We'll detect you and             ║
║   automatically continue.                                  ║
║                                                            ║
║   [ Open leetcode.com → ]                                  ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
```

Once signed in, the same screen flips:

```
║   Step 1 — Connect LeetCode  ✓                             ║
║   Connected as @maria_codes                                ║
║   Is this you?                                             ║
║   [ Yes, continue → ]   [ Sign in to a different account ] ║
```

### 3. Sign in with Canvas (OAuth)

```
║   Step 2 — Verify with Canvas                              ║
║                                                            ║
║   We use Canvas to confirm you're enrolled in CS 393       ║
║   and to know who you are without you typing anything.     ║
║                                                            ║
║   Click below to sign in with your BYU account.            ║
║                                                            ║
║   [ Sign in with Canvas → ]                                ║
║                                                            ║
║   (You'll be redirected to BYU's sign-in page if you're    ║
║    not already logged in.)                                 ║
```

OAuth flow under the hood: `chrome.identity.launchWebAuthFlow()` opens the Canvas OAuth URL → BYU CAS login (if not already authenticated) → callback with short-lived Canvas token → Cloud Function calls `GET /api/v1/users/self` → returns netID, full name, student ID, enrollments → we discard the student's Canvas token (we don't need it again; grade-posting uses the instructor's token).

After successful OAuth:

```
║   Step 2 — Verify with Canvas  ✓                           ║
║                                                            ║
║   We see you in CS 393 as Maria Collins (netID mcollins7). ║
║                                                            ║
║   [ Continue → ]                                           ║
```

### 4. Privacy disclosure

```
║   Step 3 — What we'll store                                ║
║                                                            ║
║   ✓ Problems you open and solve                            ║
║      Used to track your weekly progress                    ║
║                                                            ║
║   ✓ How you typed each solution                            ║
║      Recorded so you can replay your own sessions          ║
║                                                            ║
║   ✓ Paste events and tab switches                          ║
║      Used to detect copy-paste; visible to TAs             ║
║                                                            ║
║   You can see everything stored about you any time         ║
║   under [My data] in the dashboard.                        ║
║                                                            ║
║   Full privacy statement: [ Open in new tab ]              ║
║                                                            ║
║   [ ☑ I agree — finish setup ]                             ║
```

### 5. Done

```
║   You're set, Maria.                                       ║
║   Your Week 6 is ready.                                    ║
║                                                            ║
║   [ Open my dashboard → ]                                  ║
```

---

## Fall-back: typed netID (if Canvas OAuth isn't available)

If the BYU Canvas Developer Key can't be obtained in time, step 2 changes from OAuth to a typed form:

```
║   Step 2 — Your BYU info                                   ║
║                                                            ║
║   netID                                                    ║
║   ┌──────────────────────────────────┐                     ║
║   │ mcollins7                        │                     ║
║   └──────────────────────────────────┘                     ║
║                                                            ║
║   Student ID                                               ║
║   ┌──────────────────────────────────┐                     ║
║   │ 12-345-6789                      │                     ║
║   └──────────────────────────────────┘                     ║
║                                                            ║
║   [ Continue → ]                                           ║
```

Backend still verifies enrollment via the instructor's TA-level Canvas API token (see [addendum-5-11-2026.md](addendum-5-11-2026.md)), so we still know whether the netID is on the roster. What changes:

- **Identity** is "someone typed a valid netID that's on the roster" rather than "someone authenticated as that netID."
- **Student ID** field is a soft anti-impersonation check — something only the real student should know.

The other steps (welcome, LeetCode, privacy, done) are unchanged.

---

## Error states

### Not enrolled in CS 393

```
║   ⚠ Couldn't find you in CS 393                            ║
║                                                            ║
║   Canvas tells us you're not currently enrolled in this    ║
║   course. If you just registered, give it a day — Canvas   ║
║   syncs enrollments overnight.                             ║
║                                                            ║
║   Still stuck? Email your instructor.                      ║
║                                                            ║
║   [ Try again ]                                            ║
```

### LeetCode account already linked to another netID

```
║   ⚠ LeetCode account already linked                        ║
║                                                            ║
║   The LeetCode account "@maria_codes" is already linked    ║
║   to a different netID. If this is a mistake, contact      ║
║   your instructor to reset it.                             ║
```

### Already connected on another Chrome (good case, not an error)

`chrome.storage.sync` brings the connection key across the user's Chrome installs automatically. The extension detects an existing key and skips onboarding:

```
║   Welcome back, Maria.                                     ║
║   Your account synced from another Chrome.                 ║
║                                                            ║
║   [ Open my dashboard → ]                                  ║
```

Cross-browser (e.g., Chrome on Mac, Edge on Windows) doesn't sync — the student would re-run onboarding on the second browser; the backend matches netID and adds the device.

---

## Decisions baked in

| Decision | Why |
|---|---|
| Auto-opens a full tab on install | Onboarding deserves screen space; popup is too cramped for forms + privacy text. |
| Detect LeetCode cookie *locally* before transmitting | Privacy: nothing leaves the device until the user clicks through to step 3. |
| 4-step linear wizard with progress indicator | Familiar pattern; users see how much is left. |
| Canvas OAuth as preferred path | Real identity verification + auto-filled netID/name; no student-ID typing required. |
| Discard the student's Canvas token after `GET /users/self` | We don't need it long-term; grade posting uses the instructor's TA token. Less sensitive data to store. |
| LeetCode confirmation ("Is this you?") | Catches the case where the student is logged into the wrong LeetCode account. |
| Privacy disclosure as step 3, not buried in a link | BYU mandate + good practice. Full statement opens in a new tab. |
| `chrome.storage.sync` for the connection key | Auto-replicates across user's Chrome installs. Free multi-device support. |

---

## Open questions

- **Canvas Developer Key availability.** Pending 2026-05-13 instructor meeting. Determines whether OAuth or typed-netID is the actual ship.
- **No-LeetCode-account case.** If a student doesn't have a LeetCode account yet, do we explicitly detect that and prompt them to create one, or just let them figure it out from the "open leetcode.com" button?
- **Re-validating identity over time.** Should the extension periodically reverify the LeetCode cookie (e.g., on Chrome restart) in case the student logs out, or trust the initial verification indefinitely?
- **Connection-key recovery.** If the key is lost (browser data cleared, etc.), the student re-runs onboarding and the backend re-issues the key after matching netID. Worth confirming this with the instructor for audit purposes.
- **Privacy granularity.** Master opt-in (shown above) vs per-feature toggles. Pending instructor input — covered in [meeting-prep-5-13-2026.md](meeting-prep-5-13-2026.md).
- **OAuth scopes.** Which Canvas scopes do we request? `url:GET|/api/v1/users/self` is the minimum; might want enrollment info too. Pin down during implementation.
