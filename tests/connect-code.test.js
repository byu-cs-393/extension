// The connection code: generated in the extension, pasted into Canvas by
// the student, read back by the Cloud Function.
//
// The server half is what the security rests on, so these lean on it
// hard — particularly the cases where a student pastes something almost
// but not quite right, and the case where they paste nothing useful at
// all.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import {
  generateConnectCode,
  formatConnectCode,
  normalizeConnectCode,
} from "../src/data/connect-code.js";

const require = createRequire(import.meta.url);
const {
  CODE_LENGTH,
  normalizeCode,
  submissionMatchesCode,
} = require("../functions/connect-code.js");

// How Canvas actually returns an online_text_entry body.
const submitted = (text) => `<p>${text}</p>`;

describe("generateConnectCode", () => {
  it("produces a code of the agreed length", () => {
    expect(generateConnectCode()).toHaveLength(CODE_LENGTH);
  });

  it("omits the characters people misread", () => {
    // I/1 and O/0 confusions produce a failure a student can't diagnose.
    const all = Array.from({ length: 200 }, generateConnectCode).join("");
    expect(all).not.toMatch(/[IO01]/);
  });

  it("doesn't repeat itself", () => {
    const codes = new Set(Array.from({ length: 500 }, generateConnectCode));
    expect(codes.size).toBe(500);
  });

  it("formats into two groups for transcription", () => {
    expect(formatConnectCode("7F3K92QR")).toBe("7F3K-92QR");
  });
});

// The client and server each normalise; they have to agree or a valid
// code fails verification.
describe("normalisation agrees across the two implementations", () => {
  const cases = ["7f3k-92qr", "  7F3K 92QR  ", "7F3K–92QR", "7f3k92qr"];
  for (const input of cases) {
    it(`agrees on ${JSON.stringify(input)}`, () => {
      expect(normalizeConnectCode(input)).toBe(normalizeCode(input));
    });
  }
});

describe("submissionMatchesCode", () => {
  const code = "7F3K92QR";

  it("accepts the code as Canvas wraps it", () => {
    expect(submissionMatchesCode(submitted("7F3K-92QR"), code)).toBe(true);
  });

  it("accepts a student who lowercased or dropped the dash", () => {
    expect(submissionMatchesCode(submitted("7f3k92qr"), code)).toBe(true);
    expect(submissionMatchesCode(submitted("7F3K 92QR"), code)).toBe(true);
  });

  // Students write sentences. "my code is X thanks!" would fail if the
  // whole body were normalised and compared, rather than searched.
  it("accepts the code embedded in a sentence", () => {
    expect(
      submissionMatchesCode(submitted("Here is my code: 7F3K-92QR. Thanks!"), code),
    ).toBe(true);
  });

  it("survives the entities Canvas's editor introduces", () => {
    expect(submissionMatchesCode("<p>7F3K-92QR&nbsp;</p>", code)).toBe(true);
    expect(submissionMatchesCode("<div><b>7F3K</b>-92QR</div>", code)).toBe(true);
  });

  it("rejects a submission with no code in it", () => {
    expect(submissionMatchesCode(submitted("done"), code)).toBe(false);
    expect(submissionMatchesCode(submitted("I connected my account"), code)).toBe(false);
    expect(submissionMatchesCode("", code)).toBe(false);
    expect(submissionMatchesCode(null, code)).toBe(false);
  });

  // The one that matters: a different student's code must not verify.
  it("rejects somebody else's code", () => {
    expect(submissionMatchesCode(submitted("QQ22WW33"), code)).toBe(false);
  });

  it("rejects a near miss rather than matching loosely", () => {
    expect(submissionMatchesCode(submitted("7F3K92Q"), code)).toBe(false);
    expect(submissionMatchesCode(submitted("7F3K92QX"), code)).toBe(false);
  });

  it("refuses to verify against a malformed expected code", () => {
    // A caller sending a short or empty code must never trivially pass.
    expect(submissionMatchesCode(submitted("anything"), "")).toBe(false);
    expect(submissionMatchesCode(submitted("ABC"), "ABC")).toBe(false);
    expect(submissionMatchesCode(submitted("7F3K92QR"), null)).toBe(false);
  });
});
