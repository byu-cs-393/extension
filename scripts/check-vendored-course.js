#!/usr/bin/env node
//
// Guards against committing a testing-shifted src/course.json.
//
// scripts/shift-schedule-for-testing.js rewrites every date so a chosen
// week contains today, because before the semester starts every week
// reads as "future" and the dashboard renders empty. It leaves the file
// modified-but-uncommitted by design.
//
// It has now been committed by accident THREE times, always via an
// over-broad `git add -A`. On main it's not a harmless dev artifact: the
// dashboard classifies weeks against real time, so a shifted copy means
// students see a semester that's already half over on day one.
//
// Two checks, because they fail in different places:
//
//   1. Against ../course/data/course.json when it's there (local dev).
//      Exact, catches any drift including a small shift.
//   2. A term sanity check that works anywhere, including CI where the
//      professor's repo isn't checked out.
//
// Deliberately NOT part of `npm run build:check`. While you're testing,
// the shift is applied on purpose and everything local should stay green;
// blocking `npm run ci` would just train you to ignore it. The job is to
// stop a shifted file reaching main, so it runs as its own CI step.
//
// Usage:  npm run check:course      (CI runs this)

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VENDORED = join(ROOT, "src", "course.json");
const UPSTREAM = join(ROOT, "..", "course", "data", "course.json");

const MONTHS = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

const course = JSON.parse(readFileSync(VENDORED, "utf8"));
const problems = [];

// ---- 1. Exact comparison against the professor's copy -------------------

if (existsSync(UPSTREAM)) {
  const upstream = JSON.parse(readFileSync(UPSTREAM, "utf8"));
  const mine = (course.schedule ?? []).map((s) => s.dates);
  const theirs = (upstream.schedule ?? []).map((s) => s.dates);

  if (mine.length !== theirs.length) {
    problems.push(
      `src/course.json has ${mine.length} schedule entries, ` +
        `../course/data/course.json has ${theirs.length} — re-vendor.`,
    );
  } else {
    const drifted = mine
      .map((dates, i) => ({ i, dates, expected: theirs[i] }))
      .filter((row) => row.dates !== row.expected);
    if (drifted.length > 0) {
      problems.push(
        `${drifted.length} schedule date(s) differ from the professor's copy, ` +
          "e.g. " +
          drifted
            .slice(0, 3)
            .map((r) => `week ${r.i + 1}: "${r.dates}" should be "${r.expected}"`)
            .join("; "),
      );
    }
  }
} else {
  console.log("(../course not checked out — skipping exact comparison)");
}

// ---- 2. Term sanity, which works without the upstream copy --------------
//
// A Fall term's first week starts in August or September. Every shift big
// enough to make a week "current" during summer testing moves it out of
// that range.

const term = String(course.course?.term ?? "");
const firstDates = course.schedule?.[0]?.dates ?? "";
const firstMonth = firstDates.match(/^(\w{3})/)?.[1];

if (/fall/i.test(term) && firstMonth != null) {
  const month = MONTHS[firstMonth];
  if (month !== MONTHS.Aug && month !== MONTHS.Sep) {
    problems.push(
      `Term is "${term}" but week 1 starts in ${firstMonth} ("${firstDates}"). ` +
        "That looks like a testing shift.",
    );
  }
}

// ---- Report -------------------------------------------------------------

if (problems.length > 0) {
  console.error("src/course.json doesn't match the professor's schedule:\n");
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  console.error(
    "\nIf you're mid-testing this is expected — just don't commit it.\n" +
      "Restore with:  node scripts/vendor-course.js",
  );
  process.exit(1);
}

console.log("src/course.json matches the professor's schedule.");
