// "Suggest a problem" — one pick at a time, at a difficulty the student chooses.
//
// This started as a list of four problems always visible on the week card.
// A list makes you choose twice: which of these, and then whether to do it.
// One problem is a recommendation; four are a menu. So the card now asks
// what level you want and answers with a single problem, plus a way to ask
// again.
//
// The card owns only what's on screen — the current pick, whether a request
// is in flight, whether that difficulty is exhausted. Where picks come from,
// and remembering the chosen level between visits, belong to the caller.

const DIFFICULTIES = ["Any", "Easy", "Medium", "Hard"];

// requestPick(difficulty) -> a pick, or null when there's nothing left.
export function createSuggestionsCard({
  open = false,
  difficulty = "Any",
  onToggle,
  onDifficulty,
  requestPick,
} = {}) {
  let current = difficulty;
  let inFlight = false;

  const article = document.createElement("article");
  article.className = "card";

  const details = document.createElement("details");
  details.className = "problem-details suggestions-details";
  details.open = open;

  const summary = document.createElement("summary");
  summary.className = "problem-details-summary suggestions-summary";
  const heading = document.createElement("span");
  heading.className = "card-title";
  heading.textContent = "Suggest a problem";
  const chevron = document.createElement("span");
  chevron.className = "chevron";
  chevron.setAttribute("aria-hidden", "true");
  chevron.textContent = "▾";
  summary.append(heading, chevron);
  details.appendChild(summary);

  // ---- difficulty chooser ----
  const chooser = document.createElement("div");
  chooser.className = "difficulty-chooser";
  chooser.setAttribute("role", "group");
  chooser.setAttribute("aria-label", "Difficulty");

  const buttons = new Map();
  for (const level of DIFFICULTIES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "difficulty-choice";
    btn.textContent = level;
    btn.setAttribute("aria-pressed", String(level === current));
    btn.addEventListener("click", () => {
      if (level === current || inFlight) return;
      current = level;
      for (const [name, b] of buttons) b.setAttribute("aria-pressed", String(name === current));
      onDifficulty?.(current);
      load();
    });
    buttons.set(level, btn);
    chooser.appendChild(btn);
  }
  details.appendChild(chooser);

  // ---- the pick ----
  const slot = document.createElement("div");
  slot.className = "suggestion-slot";
  // aria-live so the new problem is announced when it swaps in, rather than
  // silently replacing what a screen-reader user was just reading.
  slot.setAttribute("aria-live", "polite");
  details.appendChild(slot);

  const another = document.createElement("button");
  another.type = "button";
  another.className = "btn-secondary suggestion-another";
  another.textContent = "Show another";
  another.addEventListener("click", () => load());
  details.appendChild(another);

  details.addEventListener("toggle", () => {
    onToggle?.(details.open);
    // Nothing is fetched until it's opened — a collapsed card shouldn't
    // spend a lookup on a problem nobody is going to read.
    if (details.open && !slot.firstChild) load();
  });

  article.appendChild(details);
  if (details.open) load();
  return article;

  async function load() {
    if (inFlight) return;
    inFlight = true;
    another.disabled = true;
    slot.replaceChildren(message("Finding one…"));
    let pick = null;
    try {
      pick = await requestPick?.(current);
    } catch (error) {
      console.error("[CS 393 Buddy] couldn't get a suggestion:", error);
    } finally {
      inFlight = false;
      another.disabled = false;
    }
    slot.replaceChildren(pick ? problemRow(pick) : exhaustedMessage(current));
  }
}

function problemRow(pick) {
  const wrap = document.createElement("div");
  wrap.className = "suggestion-pick";

  const top = document.createElement("div");
  top.className = "suggestion-pick-head";

  const link = document.createElement("a");
  link.className = "problem-link suggestion-title";
  link.href = `https://leetcode.com/problems/${pick.slug}/`;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = pick.title;

  const tag = document.createElement("span");
  tag.className = `problem-diff diff-${String(pick.difficulty).toLowerCase()}`;
  tag.textContent = pick.difficulty;

  top.append(link, tag);
  wrap.appendChild(top);

  // Why this one. Stands in for the sentence a model will write here once
  // the course has an API key; until then, naming what it exercises still
  // beats an unexplained problem.
  const why = pick.matchedTopics?.slice(0, 3).join(" · ");
  if (why) {
    const reason = document.createElement("div");
    reason.className = "suggestion-why";
    reason.textContent = why;
    wrap.appendChild(reason);
  }
  return wrap;
}

function exhaustedMessage(difficulty) {
  // Real, not hypothetical: easy dynamic-programming problems run out after
  // seven. Say which way out there is rather than just "none found".
  return message(
    difficulty === "Any"
      ? "You've seen everything suggested for this topic. Nice."
      : `Nothing ${difficulty.toLowerCase()} left for this topic — try another level.`,
  );
}

function message(text) {
  const div = document.createElement("div");
  div.className = "card-detail suggestion-message";
  div.textContent = text;
  return div;
}
