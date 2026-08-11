#!/usr/bin/env node
//
// DEV ONLY — shifts every date in the vendored src/course.json so that a
// chosen week contains today. Nothing here should ever be committed.
//
// Why it exists: the dashboard classifies weeks against real time, so
// before the semester starts every week reads as "future" and the whole
// student view renders empty. Testing the recommended-problems card,
// solve progress, or the Weekly Study submission needs a CURRENT week.
//
// Shifting the whole schedule (rather than editing one week) keeps the
// weeks in order, so you also get real past weeks above the current one
// and locked future weeks below — the same shape a student sees in
// October.
//
// Usage:
//   node scripts/shift-schedule-for-testing.js            # week 3 = this week
//   node scripts/shift-schedule-for-testing.js --week 6   # week 6 = this week
//
// Revert (do this before committing anything):
//   node scripts/vendor-course.js        # re-copies from ../course
//   git checkout src/course.json         # or just this, if ../course is stale
//
// NOTE: src/course.json is vendored from the professor's repo. This edits
// the VENDORED copy only — ../course/data/course.json is never touched.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COURSE_PATH = join(ROOT, "src", "course.json");

// Must match SEMESTER_YEAR in src/course-data.js, which is what actually
// parses these strings at runtime.
const SEMESTER_YEAR = 2026;

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const MONTH_INDEX = Object.fromEntries(MONTHS.map((m, i) => [m, i]));

const DAY_MS = 24 * 60 * 60 * 1000;

function parseArgs(argv) {
  const weekFlag = argv.indexOf("--week");
  const week = weekFlag === -1 ? 3 : Number(argv[weekFlag + 1]);
  if (!Number.isInteger(week) || week < 1) {
    console.error("--week must be a positive integer");
    process.exit(1);
  }
  return { week };
}

// Same three shapes course-data.js's parseScheduleDates understands:
// "Sep 7–12", "Nov 30–Dec 5", and the finals entry "Thu Dec 17, 7–10 am".
function parseDates(str) {
  let m = str.match(/^(\w{3})\s+(\d{1,2})\s*[–-]\s*(\w{3})\s+(\d{1,2})/);
  if (m && MONTH_INDEX[m[1]] != null && MONTH_INDEX[m[3]] != null) {
    return {
      kind: "range",
      start: new Date(SEMESTER_YEAR, MONTH_INDEX[m[1]], +m[2]),
      end: new Date(SEMESTER_YEAR, MONTH_INDEX[m[3]], +m[4]),
    };
  }
  m = str.match(/^(\w{3})\s+(\d{1,2})\s*[–-]\s*(\d{1,2})/);
  if (m && MONTH_INDEX[m[1]] != null) {
    return {
      kind: "range",
      start: new Date(SEMESTER_YEAR, MONTH_INDEX[m[1]], +m[2]),
      end: new Date(SEMESTER_YEAR, MONTH_INDEX[m[1]], +m[3]),
    };
  }
  m = str.match(/^(.*?)(\w{3})\s+(\d{1,2}),(.*)$/);
  if (m && MONTH_INDEX[m[2]] != null) {
    return {
      kind: "single",
      prefix: m[1],
      suffix: m[4],
      start: new Date(SEMESTER_YEAR, MONTH_INDEX[m[2]], +m[3]),
    };
  }
  return null;
}

function shiftDate(date, days) {
  return new Date(date.getTime() + days * DAY_MS);
}

function formatDates(parsed, days) {
  if (parsed.kind === "single") {
    const d = shiftDate(parsed.start, days);
    // Weekday prefixes like "Thu " would be wrong after shifting, so
    // rebuild it rather than carrying the original across.
    const weekday = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d.getDay()];
    const prefix = /^\w{3}\s/.test(parsed.prefix) ? `${weekday} ` : parsed.prefix;
    return `${prefix}${MONTHS[d.getMonth()]} ${d.getDate()},${parsed.suffix}`;
  }
  const start = shiftDate(parsed.start, days);
  const end = shiftDate(parsed.end, days);
  const startStr = `${MONTHS[start.getMonth()]} ${start.getDate()}`;
  return start.getMonth() === end.getMonth()
    ? `${startStr}–${end.getDate()}`
    : `${startStr}–${MONTHS[end.getMonth()]} ${end.getDate()}`;
}

const { week: targetWeek } = parseArgs(process.argv.slice(2));
const course = JSON.parse(readFileSync(COURSE_PATH, "utf8"));
const schedule = course.schedule ?? [];

const target = schedule.find((entry) => entry.week === targetWeek);
if (!target) {
  console.error(`No schedule entry for week ${targetWeek}.`);
  process.exit(1);
}

const targetParsed = parseDates(target.dates);
if (!targetParsed) {
  console.error(`Couldn't parse week ${targetWeek}'s dates: ${target.dates}`);
  process.exit(1);
}

// Land today on the target week's start date. Using the start (rather
// than centring) means the current week always has today inside it, for
// any week length — including the short Thanksgiving week.
const today = new Date();
today.setHours(0, 0, 0, 0);
const shiftDays = Math.round((today - targetParsed.start) / DAY_MS);

let changed = 0;
for (const entry of schedule) {
  if (typeof entry.dates !== "string") continue;
  const parsed = parseDates(entry.dates);
  if (!parsed) {
    console.warn(`  ! skipped unparseable dates: ${entry.dates}`);
    continue;
  }
  const before = entry.dates;
  entry.dates = formatDates(parsed, shiftDays);
  const label = String(entry.week ?? entry.id).padStart(6);
  const marker = entry.week === targetWeek ? "  <-- today" : "";
  console.log(`${label}: ${before.padEnd(20)} -> ${entry.dates}${marker}`);
  changed += 1;
}

writeFileSync(COURSE_PATH, `${JSON.stringify(course, null, 2)}\n`);

console.log(
  `\nShifted ${changed} entries by ${shiftDays} days so week ${targetWeek} contains today.`,
);
console.log("src/course.json is now MODIFIED — do not commit it.");
console.log("Revert with:  node scripts/vendor-course.js");
