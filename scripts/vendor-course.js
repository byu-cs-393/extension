// scripts/vendor-course.js
//
// Copies the professor's course-side artifacts into this extension. Run
// whenever the professor pushes updates.
//
// Two files are vendored:
//   ../course/data/course.json          -> src/course.json
//     Course structure (weeks, topics, assessments, stable ids).
//     Consumed at runtime by src/course-data.js in the extension pages.
//   ../course/build/deploy.fall-2026.json -> functions/deploy.fall-2026.json
//     Stable-id -> Canvas-numeric-id bridge. Consumed by the Cloud
//     Function that POSTs submissions to Canvas.
//
// Usage:
//   node scripts/vendor-course.js
//
// Assumes the course repo lives at ../course/ relative to this repo
// root. Override with COURSE_REPO env var if it's elsewhere:
//   COURSE_REPO=/some/other/path node scripts/vendor-course.js

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, "..");
const COURSE_REPO = process.env.COURSE_REPO || path.resolve(REPO_ROOT, "..", "course");

// [sourceRelToCourseRepo, destRelToExtensionRepo]
const VENDOR_MAP = [
  ["data/course.json", "src/course.json"],
  ["build/deploy.fall-2026.json", "functions/deploy.fall-2026.json"],
];

let allOk = true;

for (const [srcRel, destRel] of VENDOR_MAP) {
  const srcPath = path.join(COURSE_REPO, srcRel);
  const destPath = path.join(REPO_ROOT, destRel);
  const ok = vendorOne(srcPath, destPath);
  if (!ok) allOk = false;
}

if (!allOk) process.exit(1);

function vendorOne(srcPath, destPath) {
  if (!fs.existsSync(srcPath)) {
    console.error(`SKIP: source not found at ${srcPath}`);
    return false;
  }

  const src = fs.readFileSync(srcPath);

  // Parse to validate it's well-formed JSON before we overwrite anything.
  try {
    JSON.parse(src);
  } catch (err) {
    console.error(`ERROR: ${srcPath} is not valid JSON: ${err.message}`);
    return false;
  }

  const prevExists = fs.existsSync(destPath);
  const prev = prevExists ? fs.readFileSync(destPath) : null;
  const prevHash = prev
    ? crypto.createHash("sha256").update(prev).digest("hex")
    : null;
  const nextHash = crypto.createHash("sha256").update(src).digest("hex");

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, src);

  console.log(`Vendored ${srcPath}`);
  console.log(`     -> ${destPath}`);
  console.log(`     bytes: ${src.length}, sha256: ${nextHash.slice(0, 12)}…`);
  if (prevExists && prevHash !== nextHash) {
    console.log(`     changed (was ${prevHash.slice(0, 12)}…)`);
  } else if (prevExists) {
    console.log(`     no change`);
  } else {
    console.log(`     (first copy)`);
  }
  return true;
}
