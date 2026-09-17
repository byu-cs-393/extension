// The "Suggested for you" card: extra practice beyond the week's assigned
// problems, rendered from the shortlist week-suggestions.js builds.
//
// Pure DOM and no state of its own — the caller owns whether it's open and
// what to do when that changes — so it can be rendered and clicked in a
// test without pulling in the dashboard's bootstrap.

// Practice beyond the assigned problems.
//
// This fills the `outside` slot in course.json, which in most weeks just
// says "do 4 other problems" and names none. Every pick is something the
// student hasn't solved and the course doesn't assign in ANY week — the
// later online assessments are all in course.json, and suggesting one
// would hand out an assessment early.
export function createSuggestionsCard(picks, { open = false, onToggle } = {}) {
  const article = document.createElement("article");
  article.className = "card";

  // Collapsed by default, and the header is the control — this is optional
  // practice sitting under the week's actual assigned work, so it shouldn't
  // take up four rows until someone asks for it. Same disclosure pattern as
  // the recommended-problems list.
  const details = document.createElement("details");
  details.className = "problem-details suggestions-details";
  details.open = open;

  const summary = document.createElement("summary");
  summary.className = "problem-details-summary suggestions-summary";

  const heading = document.createElement("span");
  heading.className = "card-title";
  heading.textContent = `Suggested for you · ${picks.length}`;

  const chevron = document.createElement("span");
  chevron.className = "chevron";
  chevron.setAttribute("aria-hidden", "true");
  chevron.textContent = "▾";

  summary.append(heading, chevron);
  details.appendChild(summary);

  const blurb = document.createElement("div");
  blurb.className = "card-detail";
  blurb.textContent =
    "Extra practice on this week's topic, picked from problems you haven't solved.";
  details.appendChild(blurb);

  const list = document.createElement("ul");
  list.className = "card-list problem-list";
  for (const pick of picks) list.appendChild(createSuggestionItem(pick));
  details.appendChild(list);

  details.addEventListener("toggle", () => onToggle?.(details.open));

  article.appendChild(details);
  return article;
}

function createSuggestionItem(pick) {
  const li = document.createElement("li");
  li.className = "problem pending suggestion";

  const link = document.createElement("a");
  link.className = "problem-link";
  link.href = `https://leetcode.com/problems/${pick.slug}/`;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = pick.title;

  const difficulty = document.createElement("span");
  difficulty.className = `problem-diff diff-${pick.difficulty.toLowerCase()}`;
  difficulty.textContent = pick.difficulty;

  li.append(link, difficulty);

  // What the problem exercises, in the course's own vocabulary. Stands in
  // for the one-line reason a model will write here once the course has an
  // API key — until then, saying WHY it was picked still beats a bare list.
  const why = pick.matchedTopics?.slice(0, 3).join(" · ");
  if (why) {
    const reason = document.createElement("div");
    reason.className = "suggestion-why";
    reason.textContent = why;
    li.appendChild(reason);
  }
  return li;
}
