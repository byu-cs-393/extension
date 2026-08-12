// Turning a failed submitCanvasAssignment response into something a
// student can read.
//
// Canvas doesn't return errors as strings. Its usual shape is an ARRAY of
// objects:
//
//     { errors: [{ message: "user not authorized to perform that action" }] }
//
// and sometimes a bare object, a nested { errors: { base: [...] } }, or
// plain text. submitCanvasAssignment passes `canvasBody.errors` through
// untouched, so dropping that into a template literal produced the
// famously unhelpful "Couldn't submit to Canvas: [object Object]".
//
// Covered by tests/canvas-error.test.js.

// Pulls readable text out of any one Canvas error node.
function messageFrom(node) {
  if (node == null) return null;
  if (typeof node === "string") return node.trim() || null;
  if (typeof node === "number" || typeof node === "boolean") return String(node);
  if (Array.isArray(node)) {
    const parts = node.map(messageFrom).filter(Boolean);
    return parts.length ? [...new Set(parts)].join("; ") : null;
  }
  if (typeof node === "object") {
    // Canvas uses `message`; some endpoints use `description`. `base` is
    // where it puts errors that aren't tied to a specific field.
    const recognised = "message" in node || "description" in node;
    const direct = node.message ?? node.description ?? null;
    if (typeof direct === "string" && direct.trim()) return direct.trim();
    const nested = node.errors ?? node.base ?? null;
    if (nested != null) return messageFrom(nested);
    // A shape we DO understand whose message is blank carries nothing —
    // drop it, so it doesn't crowd out the real errors beside it in the
    // joined output.
    if (recognised) return null;
    // Genuinely unrecognised — show the JSON rather than "[object
    // Object]", so at least the shape is visible when someone reports it.
    try {
      const json = JSON.stringify(node);
      return json && json !== "{}" ? json : null;
    } catch (_error) {
      return null;
    }
  }
  return null;
}

// Best readable explanation of a failed submit response, for display.
// Falls back through the function's own outcome fields so a failure that
// never reached Canvas (no deploy-map entry, missing canvasUserId) still
// says something specific.
export function describeCanvasError(result) {
  return (
    messageFrom(result?.canvasError) ??
    messageFrom(result?.reason) ??
    messageFrom(result?.error) ??
    messageFrom(result?.outcome) ??
    "unknown error"
  );
}

// Extra guidance for the failure modes that have a known cause, so the
// student isn't left with Canvas's wording alone. Returns null when
// there's nothing useful to add.
export function canvasErrorHint(result) {
  const text = describeCanvasError(result).toLowerCase();
  if (result?.outcome === "skipped-no-user") {
    return "Your Canvas user ID is missing — finish onboarding, or ask a TA to check your student record.";
  }
  if (result?.outcome === "skipped-no-assignment") {
    return "This assignment isn't mapped to Canvas yet. Tell a TA — it's a setup issue, not something you did.";
  }
  if (text.includes("not authorized")) {
    return "Canvas refused the submission on your behalf. This is usually a setup problem with the course, not your account — tell a TA.";
  }
  if (result?.canvasStatus === 404) {
    return "Canvas couldn't find that assignment. Tell a TA — the assignment mapping may be out of date.";
  }
  return null;
}
