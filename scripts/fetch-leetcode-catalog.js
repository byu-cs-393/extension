#!/usr/bin/env node
//
// Vendors LeetCode's problem list into src/leetcode-catalog.json.
//
// The suggestion feature needs a pool of problems to recommend FROM.
// course.json only names the ~124 problems the course assigns, which is
// the wrong set by definition — a suggestion is something the course
// hasn't already told you to do.
//
// The alternative is asking a model to name problems from memory. It
// will, fluently, and some of them won't exist. A student clicks through
// to a 404 and stops trusting the feature. So the model never invents a
// problem: it picks from this file, and anything not in here can't be
// recommended.
//
// Vendored rather than fetched at runtime, for the same reason
// course.json is: students shouldn't need LeetCode's API to be up, or
// answering, for the extension to work. Re-run this when you want a
// fresher snapshot; the catalog changes slowly.
//
// Usage:
//   node scripts/fetch-leetcode-catalog.js
//   node scripts/fetch-leetcode-catalog.js --out /tmp/preview.json

import { writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = join(ROOT, "src", "leetcode-catalog.json");
const ENDPOINT = "https://leetcode.com/graphql";

// LeetCode caps a page at 100 and does it SILENTLY — ask for 500 and you
// get 100 with no error and no indication the number was ignored. The
// loop below therefore advances by what came back rather than by what it
// asked for, which stays correct whatever they set the cap to next.
const PAGE_SIZE = 100;
const PAUSE_MS = 400;      // between pages — we are a guest on their API
const MAX_RETRIES = 3;

const QUERY = `
query problemsetQuestionList($categorySlug: String, $limit: Int, $skip: Int, $filters: QuestionListFilterInput) {
  problemsetQuestionList: questionList(
    categorySlug: $categorySlug
    limit: $limit
    skip: $skip
    filters: $filters
  ) {
    total: totalNum
    questions: data {
      title
      titleSlug
      difficulty
      acRate
      paidOnly: isPaidOnly
      frontendQuestionId: questionFrontendId
      topicTags { slug }
    }
  }
}`;

const outArg = process.argv.indexOf("--out");
const OUT = outArg === -1 ? DEFAULT_OUT : process.argv[outArg + 1];

async function fetchPage(skip) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // LeetCode 403s requests that don't look like they came from
          // the problem set page.
          Referer: "https://leetcode.com/problemset/all/",
          "User-Agent": "Mozilla/5.0 (cs393-buddy catalog fetch)",
        },
        body: JSON.stringify({
          query: QUERY,
          variables: { categorySlug: "", skip, limit: PAGE_SIZE, filters: {} },
        }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      if (body.errors) throw new Error(JSON.stringify(body.errors).slice(0, 200));
      const page = body?.data?.problemsetQuestionList;
      if (!page?.questions) throw new Error("response had no questions array");
      return page;
    } catch (error) {
      if (attempt === MAX_RETRIES) throw error;
      console.log(`    retry ${attempt}/${MAX_RETRIES - 1}: ${error.message}`);
      await sleep(1000 * attempt);
    }
  }
}

console.log("Fetching the LeetCode problem list:\n");

const raw = [];
let total = Infinity;
let skip = 0;
while (skip < total) {
  const page = await fetchPage(skip);
  total = page.total;
  if (page.questions.length === 0) break;   // guard against a stuck cursor
  raw.push(...page.questions);
  skip += page.questions.length;            // NOT PAGE_SIZE — see above
  process.stdout.write(`\r  ${String(raw.length).padStart(4)} / ${total}`);
  if (skip < total) await sleep(PAUSE_MS);
}
console.log("");

// A short read is the failure mode that matters here: it produces a
// catalog that looks fine and is quietly missing problems, so the
// recommender just never suggests them. Refuse instead.
if (raw.length !== total) {
  console.error(
    `\nRefusing to write: got ${raw.length} problems but the API said ${total}.` +
      "\nThe catalog would be silently incomplete.",
  );
  process.exit(1);
}

// Premium problems open a paywall, so recommending one is worse than
// recommending nothing. Drop them here rather than filtering later —
// nothing downstream should have to remember this rule.
const free = raw.filter((q) => !q.paidOnly);
const paidCount = raw.length - free.length;

const problems = free
  .map((q) => ({
    slug: q.titleSlug,
    title: q.title,
    difficulty: q.difficulty,               // "Easy" | "Medium" | "Hard"
    // Percent of submissions that pass. Within a difficulty tier this is
    // the best signal available for "is this a gentle Medium or a brutal
    // one", which is most of what picking a NEXT problem depends on.
    acceptance: Math.round(q.acRate * 10) / 10,
    topics: q.topicTags.map((t) => t.slug).sort(),
    id: Number(q.frontendQuestionId),
  }))
  .sort((a, b) => a.id - b.id);

const byDifficulty = problems.reduce((acc, p) => {
  acc[p.difficulty] = (acc[p.difficulty] ?? 0) + 1;
  return acc;
}, {});

const topics = [...new Set(problems.flatMap((p) => p.topics))].sort();

writeFileSync(
  OUT,
  JSON.stringify(
    {
      // Stamped so a stale catalog is visible rather than inferred.
      fetchedAt: new Date().toISOString().slice(0, 10),
      source: "https://leetcode.com/graphql",
      note: "Free problems only. Regenerate with scripts/fetch-leetcode-catalog.js",
      counts: { problems: problems.length, ...byDifficulty },
      topics,
      problems,
    },
    null,
    0,
  ) + "\n",
);

const sizeKb = Math.round(readFileSync(OUT).length / 1024);
console.log(`\nWrote ${OUT.replace(ROOT + "/", "")} (${sizeKb} KB)`);
console.log(`  ${problems.length} free problems  (${paidCount} premium dropped)`);
console.log(`  ${byDifficulty.Easy} easy · ${byDifficulty.Medium} medium · ${byDifficulty.Hard} hard`);
console.log(`  ${topics.length} distinct topic tags`);

// ---- Cross-check against the course ------------------------------------
//
// Every problem the course assigns should be findable in the catalog. A
// miss means either the catalog is incomplete or course.json has a typo
// in a URL — both are worth knowing about now, since the recommender
// subtracts the assigned set to avoid suggesting work already assigned,
// and a slug that doesn't match subtracts nothing.
const courseText = readFileSync(join(ROOT, "src", "course.json"), "utf8");
const assigned = [
  ...new Set(
    (courseText.match(/leetcode\.com\/problems\/([a-z0-9-]+)/g) ?? []).map((m) =>
      m.split("/").pop(),
    ),
  ),
];
const known = new Set(problems.map((p) => p.slug));
const missing = assigned.filter((slug) => !known.has(slug));

console.log(`\nCourse cross-check: ${assigned.length} assigned problems`);
if (missing.length === 0) {
  console.log("  all present in the catalog");
} else {
  console.log(`  ${missing.length} NOT in the catalog:`);
  for (const slug of missing) console.log(`    - ${slug}`);
  console.log(
    "\n  Premium-only, renamed, or a typo in course.json. Worth checking:\n" +
      missing.map((s) => `    https://leetcode.com/problems/${s}/`).join("\n"),
  );
}
