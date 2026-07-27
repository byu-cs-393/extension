// scripts/vendor-course.js
//
// Copies the professor's course.json from the sibling `course` repo into
// src/course.json inside this extension. Run whenever the professor
// updates his source-of-truth file.
//
// Usage:
//   node scripts/vendor-course.js
//
// Assumes the course repo lives at ../course/ relative to this repo
// root. Override with COURSE_REPO env var if it's elsewhere:
//   COURSE_REPO=/some/other/path node scripts/vendor-course.js
//
// The extension reads src/course.json at runtime (fetch via
// chrome.runtime.getURL) — see src/course-data.js. This script is
// build-time only.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, "..");
const COURSE_REPO = process.env.COURSE_REPO || path.resolve(REPO_ROOT, "..", "course");
const SRC_JSON = path.join(COURSE_REPO, "data", "course.json");
const DEST_JSON = path.join(REPO_ROOT, "src", "course.json");

if (!fs.existsSync(SRC_JSON)) {
  console.error(`ERROR: source not found at ${SRC_JSON}`);
  console.error("Set COURSE_REPO if the course repo lives elsewhere.");
  process.exit(1);
}

const src = fs.readFileSync(SRC_JSON);

// Parse to validate it's well-formed JSON before we overwrite the vendored copy.
try {
  JSON.parse(src);
} catch (err) {
  console.error(`ERROR: source is not valid JSON: ${err.message}`);
  process.exit(1);
}

const prevExists = fs.existsSync(DEST_JSON);
const prev = prevExists ? fs.readFileSync(DEST_JSON) : null;
const prevHash = prev ? crypto.createHash("sha256").update(prev).digest("hex") : null;
const nextHash = crypto.createHash("sha256").update(src).digest("hex");

fs.writeFileSync(DEST_JSON, src);

console.log(`Vendored ${SRC_JSON}`);
console.log(`     -> ${DEST_JSON}`);
console.log(`     bytes: ${src.length}`);
console.log(`     sha256: ${nextHash}`);
if (prevExists && prevHash !== nextHash) {
  console.log(`     changed from previous copy (${prevHash.slice(0, 12)}…)`);
} else if (prevExists) {
  console.log(`     no change (identical to previous copy)`);
} else {
  console.log(`     (first copy — no previous file)`);
}
