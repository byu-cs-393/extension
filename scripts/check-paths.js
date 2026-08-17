#!/usr/bin/env node
//
// Verifies every file path the extension loads at runtime actually exists.
//
// These are the paths nothing else checks. An import with a typo fails a
// test loudly; a wrong path in manifest.json or an HTML <script src>
// fails SILENTLY — Chrome just doesn't load that content script, and the
// first sign is a feature quietly not working. During a semester that
// costs student data before anyone notices.
//
// There are only about a dozen such paths, so checking them all is cheap
// and makes moving files safe.
//
// Usage:  node scripts/check-paths.js      (also runs in `npm run build:check`)

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");

const problems = [];
const checked = [];

function check(pathFromSrc, describedBy) {
  const absolute = join(SRC, pathFromSrc);
  const ok = existsSync(absolute);
  checked.push({ pathFromSrc, describedBy, ok });
  if (!ok) {
    problems.push(`${describedBy} points at src/${pathFromSrc}, which doesn't exist`);
  }
}

// ---- manifest.json ------------------------------------------------------
//
// Every path here is resolved by Chrome relative to the extension root,
// which is src/ (that's the directory loaded as unpacked).

const manifest = JSON.parse(readFileSync(join(SRC, "manifest.json"), "utf8"));

if (manifest.background?.service_worker) {
  check(manifest.background.service_worker, "manifest.background.service_worker");
}

(manifest.content_scripts ?? []).forEach((entry, i) => {
  (entry.js ?? []).forEach((file) => {
    check(file, `manifest.content_scripts[${i}].js`);
  });
  (entry.css ?? []).forEach((file) => {
    check(file, `manifest.content_scripts[${i}].css`);
  });
});

(manifest.web_accessible_resources ?? []).forEach((entry, i) => {
  (entry.resources ?? []).forEach((file) => {
    // Resources may be globs; only check literal paths.
    if (file.includes("*")) return;
    check(file, `manifest.web_accessible_resources[${i}].resources`);
  });
});

if (manifest.action?.default_popup) {
  check(manifest.action.default_popup, "manifest.action.default_popup");
}
for (const [size, path] of Object.entries(manifest.icons ?? {})) {
  check(path, `manifest.icons["${size}"]`);
}

// ---- HTML ---------------------------------------------------------------
//
// <script src> and <link href>, skipping anything absolute or external.

for (const file of readdirSync(SRC).filter((f) => f.endsWith(".html"))) {
  const html = readFileSync(join(SRC, file), "utf8");
  for (const match of html.matchAll(/<script[^>]+src="([^"]+)"/g)) {
    if (isExternal(match[1])) continue;
    check(match[1], `src/${file} <script src>`);
  }
  for (const match of html.matchAll(/<link[^>]+href="([^"]+)"/g)) {
    if (isExternal(match[1])) continue;
    check(match[1], `src/${file} <link href>`);
  }
}

function isExternal(path) {
  return (
    path.startsWith("http:") ||
    path.startsWith("https:") ||
    path.startsWith("//") ||
    path.startsWith("#") ||
    path.startsWith("mailto:") ||
    path.startsWith("data:")
  );
}

// ---- ES module + vi.mock specifiers ------------------------------------
//
// Tests catch broken imports in anything they import, but nothing imports
// the page entry points (src/pages/*) — those are only loaded by a
// browser. Test files are walked too, because a stale vi.mock() path
// fails the whole suite rather than an assertion.

for (const file of [...walkJs(SRC), ...walkJs(join(ROOT, "tests"))]) {
  const source = readFileSync(file, "utf8");
  // `from "..."`, `import "..."`, and vi.mock("...") — the last one is a
  // module path too, and a stale one takes out an entire test suite
  // without failing a single assertion.
  const specifiers = /(?:from|import)\s+["'](\.[^"']+)["']|vi\.mock\(\s*["'](\.[^"']+)["']/g;
  for (const match of source.matchAll(specifiers)) {
    match[1] = match[1] ?? match[2];
    const target = resolve(dirname(file), match[1]);
    if (!existsSync(target)) {
      problems.push(
        `${relative(ROOT, file)} imports "${match[1]}", which doesn't exist`,
      );
    }
  }
}

// ---- chrome.runtime.getURL() -------------------------------------------
//
// These take a path relative to the EXTENSION ROOT (src/), not to the
// calling file — so they look nothing like an import and survive any
// amount of moving files around without complaint. Chrome resolves a
// wrong one to a 404 at runtime: a dynamic import rejects, a <script src>
// silently never loads.
//
// Reorganising src/ broke three of these and the import checks caught
// none of them, because none of them are imports.

for (const file of walkJs(SRC)) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(
    /chrome\.runtime\.getURL\(\s*["']([^"']+)["']\s*\)/g,
  )) {
    const target = match[1];
    if (target.includes("${")) continue; // built at runtime, can't check
    check(target, `${relative(ROOT, file)} chrome.runtime.getURL()`);
  }
}

function walkJs(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJs(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

// ---- Report -------------------------------------------------------------

if (problems.length > 0) {
  console.error("Broken paths:\n");
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  console.error(
    `\n${problems.length} broken path(s). Chrome fails these silently — ` +
      "a content script simply never loads.",
  );
  process.exit(1);
}

console.log(
  `All ${checked.length} manifest/HTML paths resolve, and every relative ` +
    "import points at a real file.",
);
