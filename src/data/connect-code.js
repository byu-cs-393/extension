// Generating the connection code a student pastes into Canvas.
//
// The code is the extension's half of onboarding's identity proof. See
// functions/connect-code.js for the full picture — briefly: the student
// pastes this into a Canvas assignment from their own session, and the
// Cloud Function reads it back with the course's token. Only that
// student can create a submission under their own name, so the code
// appearing there proves they hold the account.
//
// Generated here rather than by the server for one reason: the student
// never has to remember or retype it. They copy it into Canvas, come
// back, and the extension already knows what it's looking for.

// Deliberately NOT a full UUID, and deliberately not called a password.
//
// Not a password because some fraction of students would type one they
// actually use — which would then sit in a Canvas assignment readable by
// every TA, and travel to our server. Generating it removes that
// possibility entirely.
//
// Not a UUID because a student has to copy this by hand and might read
// it off one screen while typing into another. 8 characters from this
// alphabet is 40 bits — far beyond guessing for a code that's checked
// against one specific student's submission — while staying short enough
// to transcribe without a mistake.
//
// I, O, 0 and 1 are omitted: they're the pairs people confuse, and a
// student who mistypes gets a failure they can't diagnose.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

export function generateConnectCode() {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  // Modulo bias is negligible here: 256 % 32 === 0, so every symbol is
  // equally likely.
  let raw = "";
  for (const byte of bytes) raw += ALPHABET[byte % ALPHABET.length];
  return raw;
}

// Hyphenated for display and for copying — a code broken into two
// groups is markedly easier to transcribe correctly than a run of eight.
// The dash is cosmetic; the server strips it before comparing.
export function formatConnectCode(raw) {
  const clean = normalizeConnectCode(raw);
  if (clean.length !== CODE_LENGTH) return clean;
  return `${clean.slice(0, 4)}-${clean.slice(4)}`;
}

// Must agree with normalizeCode in functions/connect-code.js. Kept as
// two small copies rather than a shared module because the extension is
// ESM and Cloud Functions are CommonJS, and a build step to bridge four
// lines would cost more than it saves.
export function normalizeConnectCode(value) {
  if (typeof value !== "string") return "";
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export { CODE_LENGTH };
