// The extension's ID must not change between releases.
//
// Everything the extension remembers (the Firebase sign-in, the netID, the
// linked LeetCode account, the connection code) is kept in chrome.storage,
// and Chrome files chrome.storage under the extension's ID. Without a
// "key" in the manifest, an unpacked extension's ID is derived from the
// folder it was loaded from. Every release unzips to a new folder
// (cs393-buddy-<version>/), so every update used to arrive as a brand-new
// extension with empty storage: re-onboarding, a new connection code in
// Canvas, relinking LeetCode. And because the old copy had a different ID,
// the two could both be installed and record every keystroke twice.
//
// The "key" pins the ID to the key instead of the path. Loading a new
// version from any folder then replaces the installed one in place, as an
// update, with its storage intact.
//
// Change or remove the key and every student is signed out on their next
// update. That's what this test is for.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const manifest = JSON.parse(
  readFileSync(new URL("../src/manifest.json", import.meta.url), "utf8"),
);

// What Chrome shows on the extension's card at chrome://extensions.
// Checked by loading src/ unpacked in Chrome for Testing 152.
const EXTENSION_ID = "ienmoiphbbgagibgdeccjpnonaepjaeb";

// Chrome's derivation: SHA-256 of the public key's DER bytes, first 32 hex
// digits, each mapped 0-f -> a-p.
function extensionIdFromKey(base64Key) {
  const hex = createHash("sha256")
    .update(Buffer.from(base64Key, "base64"))
    .digest("hex")
    .slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

describe("extension ID", () => {
  it("is pinned by a key in the manifest", () => {
    expect(typeof manifest.key).toBe("string");
    expect(manifest.key.length).toBeGreaterThan(100);
  });

  it("is the same ID every release", () => {
    expect(extensionIdFromKey(manifest.key)).toBe(EXTENSION_ID);
  });
});
