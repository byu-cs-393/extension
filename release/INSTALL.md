# Installing CS 393 Buddy

Ten minutes, once. You'll need Chrome (or Edge/Brave — anything
Chromium-based) and your BYU Canvas login.

## 1. Unzip it somewhere permanent

Download `cs393-buddy-0.0.1.zip` and unzip it.

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

1. **Sign in to Canvas** at byu.instructure.com in another tab if you
   aren't already — the extension reads your identity from there, so this
   has to happen first
2. Back in the onboarding tab, confirm your netID
3. **Sign in to LeetCode** at leetcode.com. Your solved problems sync
   automatically once you have

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

**Dashboard says "No weeks in view yet."** The semester hasn't started.
Correct before Sep 3.

**Chrome nags about developer-mode extensions on startup.** Expected while
we're piloting; dismissing it is fine. Don't click "Disable".

## Updates

No auto-updates while we're piloting. If a TA sends a new zip:

1. Unzip it over the old folder (replace everything)
2. `chrome://extensions` → the reload icon ↻ on CS 393 Buddy
3. **Reload any open LeetCode tabs** — this step gets missed, and until
   you do it that tab isn't recording

Your data lives in the cloud, not in the folder. Updating loses nothing.

## Removing it

`chrome://extensions` → **Remove**. That stops all recording immediately.
Data already collected stays with the course; ask the instructor if you
want it deleted.

## Questions

Jack Leonard — jack684@byu.edu
