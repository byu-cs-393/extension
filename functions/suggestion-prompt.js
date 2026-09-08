// Prompt construction and response validation for problem suggestions.
//
// Split out of index.js so it can be tested without deploying anything
// or spending a token: both functions here are pure, and the parts that
// matter for correctness — that the model can only pick problems it was
// offered, and that a malformed reply degrades instead of throwing — are
// exactly the parts a live call is worst at exercising.
//
// The division of labour with src/data/problem-suggestions.js: that
// module decides WHICH problems are eligible, deterministically. This
// one asks a model to order a handful of them and say why. The model
// never widens the set — see pickFromCandidates below.

// Hard ceiling on what a caller may submit for ranking. The shortlist
// arrives from the extension, so it's client-controlled: without a cap a
// modified client could post a thousand problems and bill the course for
// the tokens.
const MAX_CANDIDATES = 40;

// Refuse anything that isn't the shape the prompt assumes. Being strict
// here keeps the prompt free of defensive phrasing about missing fields.
function sanitizeCandidates(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const clean = [];
  for (const c of raw) {
    if (clean.length >= MAX_CANDIDATES) break;
    const slug = typeof c?.slug === "string" ? c.slug.trim() : "";
    if (!slug || seen.has(slug)) continue;
    if (!/^[a-z0-9-]{1,120}$/.test(slug)) continue;
    seen.add(slug);
    clean.push({
      slug,
      title: String(c.title ?? slug).slice(0, 200),
      difficulty: ["Easy", "Medium", "Hard"].includes(c.difficulty)
        ? c.difficulty
        : "Medium",
      topics: Array.isArray(c.matchedTopics ?? c.topics)
        ? (c.matchedTopics ?? c.topics).slice(0, 6).map((t) => String(t).slice(0, 40))
        : [],
      acceptance: Number.isFinite(c.acceptance) ? Math.round(c.acceptance) : null,
    });
  }
  return clean;
}

// A short, factual description of how this student is doing. Everything
// here is derived from what the extension already records; nothing is
// inferred about the person.
//
// Deliberately narrow. The keystroke data could support a much richer
// picture, but this prompt's job is choosing practice problems, and
// handing a model detailed behavioural readings invites it to write
// about the student rather than about the problems.
function describeStudent(signals = {}) {
  const lines = [];
  if (Number.isFinite(signals.solvedThisWeek) && Number.isFinite(signals.assignedThisWeek)) {
    lines.push(
      `- Finished ${signals.solvedThisWeek} of ${signals.assignedThisWeek} assigned problems this week.`,
    );
  }
  if (Number.isFinite(signals.solvedAllTime)) {
    lines.push(`- ${signals.solvedAllTime} problems solved in the course so far.`);
  }
  if (Number.isFinite(signals.medianMinutesPerProblem)) {
    lines.push(
      `- Typically spends about ${signals.medianMinutesPerProblem} minutes of active work per problem.`,
    );
  }
  if (Array.isArray(signals.struggledWith) && signals.struggledWith.length > 0) {
    lines.push(
      `- Took noticeably longer than usual on: ${signals.struggledWith.slice(0, 5).join(", ")}.`,
    );
  }
  if (Array.isArray(signals.weakTopics) && signals.weakTopics.length > 0) {
    lines.push(`- Least practised topics so far: ${signals.weakTopics.slice(0, 5).join(", ")}.`);
  }
  if (signals.lastOaResult === "failed") {
    lines.push("- Did not pass their most recent online assessment attempt.");
  }
  return lines.length > 0 ? lines.join("\n") : "- No practice history recorded yet.";
}

// The tool the model must call. Forcing a tool call is what makes the
// reply parseable — asking for JSON in prose and hoping gets you a
// markdown fence around it about one time in twenty.
function pickTool(limit) {
  return {
    name: "recommend",
    description: "Return the recommended practice problems, best first.",
    input_schema: {
      type: "object",
      properties: {
        picks: {
          type: "array",
          minItems: 1,
          maxItems: limit,
          items: {
            type: "object",
            properties: {
              slug: {
                type: "string",
                description: "Must be one of the slugs from the candidate list.",
              },
              reason: {
                type: "string",
                description:
                  "One sentence, max 20 words, addressed to the student, saying what this problem will give them practice at. No praise, no filler.",
              },
            },
            required: ["slug", "reason"],
          },
        },
      },
      required: ["picks"],
    },
  };
}

function buildRequest({ week, candidates, signals, limit = 4, model }) {
  const list = sanitizeCandidates(candidates);
  const wanted = Math.min(limit, list.length);

  const system = [
    "You help a university student choose extra LeetCode practice for an interview-prep course.",
    "",
    "You are given a pre-filtered shortlist. Every problem on it is already",
    "known to fit the week's topic, to be free, and to be one the student has",
    "not solved and the course has not assigned. Your job is ordering and",
    "explanation, not search.",
    "",
    "Rules:",
    `- Choose exactly ${wanted} problems, best first.`,
    "- Only use slugs from the candidate list. Never invent one.",
    "- Prefer a spread of skills over several problems that drill the same thing.",
    "- If the student is behind or struggling, favour the easier end.",
    "- Reasons are concrete and about the problem's content. Say what it will",
    "  exercise, not that it is 'great practice' or 'a classic'.",
    "- Address the student as 'you'. No greetings, no encouragement.",
  ].join("\n");

  const user = [
    `This week: ${week?.title ?? "current week"} (topic: ${week?.topic ?? "unknown"}).`,
    week?.objectives?.length
      ? `Week objectives:\n${week.objectives.map((o) => `- ${o}`).join("\n")}`
      : "",
    "",
    "The student:",
    describeStudent(signals),
    "",
    "Candidates:",
    ...list.map(
      (c) =>
        `- ${c.slug} — "${c.title}" · ${c.difficulty}` +
        (c.topics.length ? ` · ${c.topics.join(", ")}` : "") +
        (c.acceptance != null ? ` · ${c.acceptance}% acceptance` : ""),
    ),
  ]
    .filter(Boolean)
    .join("\n");

  return {
    body: {
      model,
      max_tokens: 1024,
      system,
      tools: [pickTool(wanted)],
      tool_choice: { type: "tool", name: "recommend" },
      messages: [{ role: "user", content: user }],
    },
    candidates: list,
  };
}

// Pull the picks out of an Anthropic response and hold them to the
// candidate list.
//
// This is the guardrail the whole feature rests on. The catalog stops
// the model inventing a problem that doesn't exist; this stops it
// returning one that exists but wasn't offered — a problem the student
// already solved, or worse, one that's on a later OA. Anything not
// offered is dropped rather than corrected, because a wrong suggestion
// is worse than a short list.
function pickFromCandidates(response, candidates) {
  const allowed = new Map(candidates.map((c) => [c.slug, c]));
  const block = (response?.content ?? []).find(
    (b) => b?.type === "tool_use" && b?.name === "recommend",
  );
  const picks = Array.isArray(block?.input?.picks) ? block.input.picks : [];

  const out = [];
  const used = new Set();
  for (const pick of picks) {
    const slug = typeof pick?.slug === "string" ? pick.slug.trim() : "";
    const candidate = allowed.get(slug);
    if (!candidate || used.has(slug)) continue;
    used.add(slug);
    out.push({
      slug,
      title: candidate.title,
      difficulty: candidate.difficulty,
      topics: candidate.topics,
      url: `https://leetcode.com/problems/${slug}/`,
      reason: typeof pick.reason === "string" ? pick.reason.trim().slice(0, 300) : "",
    });
  }
  return out;
}

// If the model is unreachable, malformed, or returns nothing usable, the
// shortlist is still a perfectly good answer — it was already ordered by
// the deterministic scorer. The student loses the explanations, not the
// suggestions.
function fallbackPicks(candidates, limit) {
  return candidates.slice(0, limit).map((c) => ({
    slug: c.slug,
    title: c.title,
    difficulty: c.difficulty,
    topics: c.topics,
    url: `https://leetcode.com/problems/${c.slug}/`,
    reason: c.topics.length ? `Practice with ${c.topics.slice(0, 2).join(" and ")}.` : "",
  }));
}

module.exports = {
  MAX_CANDIDATES,
  sanitizeCandidates,
  describeStudent,
  buildRequest,
  pickFromCandidates,
  fallbackPicks,
};
