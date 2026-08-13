#!/usr/bin/env node
//
// Bundles the content scripts.
//
// MV3 content scripts declared in the manifest run as CLASSIC scripts —
// no `import`. That single limitation is why keystroke-tracker.js,
// leetcode-tracker.js and leetcode-auth.js each carried their own inlined
// copy of the Firestore REST helpers, the firebase config, and the
// slug/title parsing, and why none of them could be imported by a test.
// Every capture bug we hit in August lived in exactly those files.
//
// So the real source now lives in src/content/*.js as ordinary ES
// modules, importing shared code from src/lib/. esbuild flattens each
// entry point into one self-contained classic script written back to
// src/, which is where manifest.json already points.
//
// Bundling IN PLACE rather than into dist/ is deliberate: the extension
// stays loadable straight from src/ with no build step, so a stale build
// can't leave you debugging code that isn't running. The generated files
// are committed, and `npm run build:check` fails if they've drifted from
// their sources — CI runs it.
//
// Usage:
//   node scripts/build-content-scripts.js           # build
//   node scripts/build-content-scripts.js --watch   # rebuild on change
//   node scripts/build-content-scripts.js --check    # verify committed
//                                                    # output is current

import { build, context } from "esbuild";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const CONTENT = join(SRC, "content");
const OUT = join(SRC, "generated");

// entry (in src/content/) -> output (in src/generated/, where the manifest points)
export const CONTENT_SCRIPTS = [
  "keystroke-tracker",
  "keystroke-injector",
  "leetcode-tracker",
  "leetcode-auth",
  "canvas-auth",
];

const BANNER = `// GENERATED FILE — DO NOT EDIT.
// Built from src/content/ by scripts/build-content-scripts.js.
// Edit the source there and run: npm run build
`;

function optionsFor(name) {
  return {
    entryPoints: [join(CONTENT, `${name}.js`)],
    outfile: join(OUT, `${name}.js`),
    bundle: true,
    // IIFE keeps every binding out of the shared isolated-world scope.
    // Content scripts from one extension share ONE global scope on a
    // page, so two files declaring `const firebaseConfig` at top level
    // used to kill whichever loaded second.
    format: "iife",
    platform: "browser",
    // Chrome ships current V8; no downlevelling, and the output stays
    // close enough to the source to read in devtools.
    target: "chrome120",
    // Readable output matters more than bytes here — these get debugged
    // in a browser console against a live LeetCode page.
    minify: false,
    banner: { js: BANNER },
    legalComments: "inline",
    logLevel: "warning",
  };
}

async function buildAll() {
  await Promise.all(CONTENT_SCRIPTS.map((name) => build(optionsFor(name))));
}

async function watchAll() {
  const contexts = await Promise.all(
    CONTENT_SCRIPTS.map((name) => context(optionsFor(name))),
  );
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log("Watching src/content/ — rebuilding into src/ on change.");
}

// Rebuild into memory and compare against what's committed, so a
// forgotten `npm run build` fails CI instead of shipping a stale bundle.
async function checkAll() {
  let stale = false;
  for (const name of CONTENT_SCRIPTS) {
    const outfile = join(OUT, `${name}.js`);
    if (!existsSync(outfile)) {
      console.error(`  MISSING  ${name}.js — run npm run build`);
      stale = true;
      continue;
    }
    const result = await build({
      ...optionsFor(name),
      outfile: undefined,
      write: false,
    });
    const fresh = result.outputFiles[0].text;
    const committed = readFileSync(outfile, "utf8");
    if (fresh !== committed) {
      console.error(`  STALE    ${name}.js — run npm run build`);
      stale = true;
    } else {
      console.log(`  ok       ${name}.js`);
    }
  }
  if (stale) {
    console.error(
      "\nCommitted content scripts don't match src/content/. " +
        "Run `npm run build` and commit the result.",
    );
    process.exit(1);
  }
  console.log("\nAll content scripts are up to date.");
}

const args = process.argv.slice(2);
if (args.includes("--watch")) {
  await watchAll();
} else if (args.includes("--check")) {
  await checkAll();
} else {
  await buildAll();
  console.log(`Built ${CONTENT_SCRIPTS.length} content scripts into src/generated/.`);
}
