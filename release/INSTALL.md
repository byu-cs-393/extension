# Installing CS 393 Buddy

**Version 1.0.1**

Ten minutes, once. You'll need Chrome (or Edge/Brave — anything
Chromium-based) and your BYU Canvas login.

## 1. Download and unzip it somewhere permanent

Go to **https://github.com/byu-cs-393/extension/releases/latest** and
download `cs393-buddy-<version>.zip` from the Assets list at the bottom.
Then unzip it.

Download the **zip from the release**, not the repository's green "Code"
button — that gives you the whole project, and Chrome won't know which
folder to load.

**Put the folder somewhere you won't move or delete it** — Documents is
fine, Downloads is not. Chrome loads the extension from that exact folder
every time it starts. Move it and the extension stops working.

You should end up with a folder containing `manifest.json` and a few
others alongside it.

## 2. Turn on Developer Mode

1. Open `chrome://extensions` (paste it into the address bar)
2. Top right — switch on **Developer mode**

## 3. Load it

1. Click **Load unpacked** (top left, appears once Developer mode is on)
2. Select the folder you unzipped — the one **containing** `manifest.json`,
   not `manifest.json` itself
3. "CS 393 Buddy" should appear in the list

An onboarding tab opens automatically. If it doesn't, click the extension
icon in the toolbar.

## 4. Onboard

The extension needs to know which Canvas account is yours. It can't just
take your word for it, and it deliberately can't read your Canvas
session — so you prove it once, by hand:

1. Onboarding shows a **connection code**, something like `7F3K-92QR`
2. Click **Open the assignment in Canvas**, paste the code as your
   submission, and submit it. It's worth 0 points and is never graded —
   it exists only to carry the code. (If the button doesn't work, the
   assignment is **Connect Your Account (Optional — CS 393 Buddy)**,
   under Milestones:
   <https://byu.instructure.com/courses/35464/assignments/1498932>)
3. Come back to the onboarding tab, type your **netID**, and click
   **Verify**
4. **Sign in to LeetCode** at leetcode.com. Your solved problems sync
   automatically once you have

Because you submitted the code while signed in to Canvas as yourself,
nobody else can claim to be you — they'd have to submit under your
account, which they can't. Don't share your code, and don't submit
somebody else's.

If Verify says it can't find your submission, check that you actually
clicked Submit in Canvas, then try again. You can resubmit at any time,
and a new submission replaces the old one.

That's it. Open a problem on LeetCode and you should see a red
**● CS 393 recording** badge in the bottom-right corner.

## What it does, plainly

While you're on `leetcode.com/problems/...`, the extension records:

- **What you type in the code editor**, as a sequence of edits — enough
  for a TA to replay how a solution came together
- **Pastes and copies**, including the pasted text
- **When the tab is focused or in the background**
- Which problems you open and whether submissions pass

It does **not** record anything outside LeetCode problem pages. Not other
sites, not other tabs, not your clipboard when you're elsewhere.

**It runs no code on Canvas at all.** Chrome will not ask you to grant it
access to byu.instructure.com, because it doesn't have any — everything
it does with Canvas happens on the course's server, using the course's
own credentials. That's why onboarding asks you to paste a code instead
of just reading who you're signed in as.

Your instructor and TAs can see this. It's how weekly study time gets
verified and how a TA can look at your work with you.

Full detail, including how long it's kept and how to have it deleted:
https://cs393-496021.web.app/privacy.html

The badge tells you the current state:

| Badge | Meaning |
|---|---|
| 🔴 CS 393 recording | working normally |
| ⚠️ keystrokes not recording | something's wrong — tell a TA |
| ⏸ recording stopped — reload page | reload the page to resume |

## Everyday use

- Click the toolbar icon for this week's summary
- The dashboard shows your weeks, problems, and the Submit-to-Canvas
  buttons
- Submissions go to Canvas under your name. You can submit again to
  replace an earlier one — Canvas grades the most recent

## Troubleshooting

**No recording badge on a problem page.** Reload the page. If it's still
missing, check `chrome://extensions` shows CS 393 Buddy enabled.

**Badge says "recording stopped — reload page".** Normal after the
extension updates. Reload the LeetCode tab.

**"Couldn't submit to Canvas."** Read the second line — it usually says
what to do. Anything mentioning *not authorized* is a course setup
problem, not you. Tell a TA.

**Dashboard says "No weeks in view yet."** The semester hasn't started,
or it's over.

**Verify says your netID isn't on the roster.** Check the spelling — it's
the name you sign in to Canvas with, like `jack684`, not your student ID.
If you enrolled very recently, Canvas can take a few hours to sync.

**Chrome nags about developer-mode extensions on startup.** Expected while
we're piloting; dismissing it is fine. Don't click "Disable".

## Updates

No auto-updates while we're piloting. When a new version is announced:

1. Download the new zip from
   **https://github.com/byu-cs-393/extension/releases/latest**
2. Unzip it over the old folder, replacing everything
3. `chrome://extensions` → the reload icon ↻ on CS 393 Buddy
4. **Reload any open LeetCode tabs** — this step gets missed, and until
   you do it that tab isn't recording

Your data lives in the cloud, not in the folder, so updating loses
nothing. The version you have is shown on the extension's card at
`chrome://extensions`.

## Removing it

`chrome://extensions` → **Remove**. That stops all recording immediately.
Data already collected stays with the course; ask the instructor if you
want it deleted.

## Questions

Jack Leonard — jack684@byu.edu
