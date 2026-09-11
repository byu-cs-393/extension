// The "Open the assignment in Canvas" button has to point at the same
// assignment the Cloud Function reads submissions from.
//
// The id lives in three places and can't be shared between them: the
// deploy map ships with the Cloud Functions, the URL is in an extension
// page, and INSTALL.md is a document. If they drift, the student is sent
// to one assignment and verified against another — and the failure looks
// like "my code doesn't work" rather than a broken link.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import deployMap from "../functions/deploy.fall-2026.json";

const root = join(import.meta.dirname, "..");
const read = (p) => readFileSync(join(root, p), "utf8");

describe("connect assignment link", () => {
  const id = deployMap.assignments?.["connect-account"];

  // Without this key, verifyStudent throws on every onboarding.
  it("is in the deploy map", () => {
    expect(typeof id).toBe("number");
    expect(id).toBeGreaterThan(0);
  });

  it("matches the URL the onboarding page opens", () => {
    const source = read("src/pages/onboard.js");
    const match = source.match(/assignments\/(\d+)/);
    expect(match, "onboard.js has no assignment URL").not.toBeNull();
    expect(Number(match[1])).toBe(id);
  });

  it("matches the fallback link in INSTALL.md", () => {
    const match = read("release/INSTALL.md").match(/assignments\/(\d+)/);
    expect(match, "INSTALL.md has no assignment link").not.toBeNull();
    expect(Number(match[1])).toBe(id);
  });

  it("points at the course the function verifies against", () => {
    expect(read("src/pages/onboard.js")).toContain(`courses/${deployMap.course}/`);
  });
});
