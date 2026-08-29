#!/usr/bin/env node
//
// Builds the zip students install.
//
// The extension loads unpacked, straight from src/, which means WHATEVER
// IS IN THAT FOLDER IS WHAT SHIPS. During development src/course.json
// carries a testing shift that moves every date so a week contains today
// — package that by accident and every student opens the extension to a
// semester that started in July.
//
// The pre-commit hook and the CI check both guard the git path. Neither
// knows about "zipped the working tree", which is exactly how a student
// would get it. So this refuses to run unless everything is clean:
//
//   1. src/course.json matches the professor's schedule
//   2. the committed content-script bundles match src/content/
//   3. every manifest / HTML / import / getURL path resolves
//   4. the test suite passes
//
// Refusing is the point. A packaging step that warns and continues is a
// packaging step that ships the warning.
//
// Usage:
//   node scripts/package-extension.js            # verify, then build the zip
//   node scripts/package-extension.js --skip-tests   # verify paths only (faster)

import { execFileSync, execSync } from "node:child_process";
import { readFileSync, mkdirSync, rmSync, existsSync, cpSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const OUT_DIR = join(ROOT, "release");

// Everything the extension needs at runtime, and nothing else. Listed
// explicitly rather than excluded by pattern: a new folder in src/ should
// have to be deliberately added here, not silently swept into a build
// that goes to students.
const SHIP = [
  "manifest.json",
  "course.json",
  "generated",   // bundled content scripts (manifest points here)
  "pages",       // one entry point per HTML page
  "ui",
  "data",
  "platform",
  "lib",
];

// Present in src/ but deliberately NOT shipped.
const EXCLUDE_REASON = {
  content: "content-script SOURCE — the bundles in generated/ are what run",
};

const skipTests = process.argv.includes("--skip-tests");

function run(label, command, args) {
  process.stdout.write(`  ${label} … `);
  try {
    execFileSync(command, args, { cwd: ROOT, stdio: "pipe" });
    console.log("ok");
  } catch (error) {
    console.log("FAILED\n");
    const output = [error.stdout, error.stderr]
      .filter(Boolean)
      .map((b) => b.toString())
      .join("\n")
      .trim();
    if (output) console.error(output);
    console.error(`\nRefusing to package: ${label} failed.`);
    process.exit(1);
  }
}

console.log("Verifying before packaging:\n");
run("schedule matches the professor's", "node", ["scripts/check-vendored-course.js"]);
run("content-script bundles are current", "node", [
  "scripts/build-content-scripts.js",
  "--check",
]);
run("every runtime path resolves", "node", ["scripts/check-paths.js"]);
if (skipTests) {
  console.log("  tests … SKIPPED (--skip-tests)");
} else {
  run("tests pass", "npm", ["run", "test:run"]);
}

// ---- Assemble ------------------------------------------------------------

const manifest = JSON.parse(readFileSync(join(SRC, "manifest.json"), "utf8"));
const version = manifest.version ?? "0.0.0";
const stageDir = join(OUT_DIR, `cs393-buddy-${version}`);
const zipPath = `${stageDir}.zip`;

rmSync(stageDir, { recursive: true, force: true });
rmSync(zipPath, { force: true });
mkdirSync(stageDir, { recursive: true });

console.log("\nStaging:");
for (const entry of SHIP) {
  const from = join(SRC, entry);
  if (!existsSync(from)) {
    console.error(`\nRefusing to package: src/${entry} is missing.`);
    process.exit(1);
  }
  cpSync(from, join(stageDir, entry), { recursive: true });
  console.log(`  + ${entry}`);
}
// The HTML and CSS pages sit at the top of src/ alongside the folders.
for (const file of readdirSync(SRC)) {
  if (file.endsWith(".html") || file.endsWith(".css")) {
    cpSync(join(SRC, file), join(stageDir, file));
    console.log(`  + ${file}`);
  }
}
for (const [entry, reason] of Object.entries(EXCLUDE_REASON)) {
  if (existsSync(join(SRC, entry))) console.log(`  - ${entry}  (${reason})`);
}

// Re-check paths against the STAGED copy, not src/. If SHIP is missing
// something the manifest references, this is where it surfaces — before
// a student finds it.
process.stdout.write("\n  staged copy resolves all paths … ");
try {
  execSync(`node "${join(ROOT, "scripts", "check-paths.js")}"`, {
    cwd: ROOT,
    env: { ...process.env, CS393_SRC_OVERRIDE: stageDir },
    stdio: "pipe",
  });
  console.log("ok");
} catch (error) {
  console.log("FAILED\n");
  console.error([error.stdout, error.stderr].filter(Boolean).join("\n").toString());
  console.error("\nRefusing to package: the staged copy is missing a file it needs.");
  process.exit(1);
}

execFileSync("zip", ["-r", "-q", zipPath, `cs393-buddy-${version}`], { cwd: OUT_DIR });
rmSync(stageDir, { recursive: true, force: true });

const sizeKb = Math.round(readFileSync(zipPath).length / 1024);
console.log(`\nBuilt release/cs393-buddy-${version}.zip (${sizeKb} KB)`);
console.log("Install instructions: release/INSTALL.md");
console.log(
  "\nSend students BOTH files. Remind them to unzip somewhere permanent —\n" +
    "Chrome loads from that exact folder every time it starts.",
);
