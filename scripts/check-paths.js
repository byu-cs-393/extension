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

// ---- ES module imports --------------------------------------------------
//
// Tests catch broken imports in anything they import, but nothing imports
// the page entry points (dashboard.js et al.) — those are only loaded by
// a browser. Walking their relative imports covers that gap.

for (const file of walkJs(SRC)) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(/(?:from|import)\s+["'](\.[^"']+)["']/g)) {
    const target = resolve(dirname(file), match[1]);
    if (!existsSync(target)) {
      problems.push(
        `${relative(ROOT, file)} imports "${match[1]}", which doesn't exist`,
      );
    }
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
