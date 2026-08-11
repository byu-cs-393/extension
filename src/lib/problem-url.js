// Parsing LeetCode problem URLs and titles.
//
// Both LeetCode content scripts need these, and both used to carry their
// own copy. The title logic in particular is subtle enough that two
// copies is two chances to get it wrong — it was already wrong once, in
// August, when a stale document.title labelled a session with the
// previous problem's name.
//
// Covered by tests/problem-url.test.js.

export function parseProblemSlug(url) {
  const match = String(url ?? "").match(
    /^https:\/\/leetcode\.com\/problems\/([^/?#]+)/,
  );
  return match ? match[1] : null;
}

// "two-sum" -> "Two Sum". Only used when the DOM title can't be trusted.
export function slugToTitle(slug) {
  return String(slug ?? "")
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

// Slugified form of a display title, for checking that document.title
// actually belongs to the problem we think we're on.
export function titleToSlug(title) {
  return String(title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// document.title with LeetCode's suffix removed.
export function strippedDocumentTitle(documentTitle) {
  return String(documentTitle ?? "")
    .replace(/\s*[-–]\s*LeetCode\s*$/i, "")
    .trim();
}

// Whether the page title currently on screen belongs to `slug`.
//
// LeetCode is a single-page app: the URL changes before document.title
// catches up, so mid-navigation the title still names the PREVIOUS
// problem. The slug comes from location.href and can't be stale, so it's
// the arbiter.
export function titleMatchesSlug(documentTitle, slug) {
  const stripped = strippedDocumentTitle(documentTitle);
  return stripped !== "" && titleToSlug(stripped) === slug;
}

// Display title for a problem: the page's own title when it verifiably
// belongs to this problem (which preserves LeetCode's casing, e.g. the
// lowercase "of" in "Median of Two Sorted Arrays"), otherwise one built
// from the slug. A slightly plainer title beats confidently naming the
// wrong problem.
export function getProblemTitle(documentTitle, slug) {
  return titleMatchesSlug(documentTitle, slug)
    ? strippedDocumentTitle(documentTitle)
    : slugToTitle(slug);
}
