// The Extra Credit section on the full-course page.
//
// Extra credit isn't in `schedule[]`, so unlike every other card type
// these have no week to sit under — they get their own section, always
// visible, below the weeks.
//
// Firestore access is injected so this can be rendered in a test with a
// fake, the same arrangement as ta-keystroke-view.js.
//
// Covered by tests/extra-credit-view.test.js.
import { openSubmissionForm } from "./submission-form.js";
import {
  extraCreditCards,
  cardState,
  extraCreditTotals,
} from "../lib/extra-credit-catalog.js";

export function renderExtraCreditSection(container, {
  assignments,
  assignmentProgress = {},
  netID,
  openForm = openSubmissionForm,
} = {}) {
  const cards = extraCreditCards(assignments);
  if (cards.length === 0) return;

  const section = document.createElement("section");
  section.className = "ec-section";

  const heading = document.createElement("h2");
  heading.className = "ec-heading";
  heading.textContent = "Extra credit";
  section.appendChild(heading);

  const totals = extraCreditTotals(cards, assignmentProgress);
  const summary = document.createElement("p");
  summary.className = "ec-summary";
  summary.textContent =
    totals.submissions > 0
      ? `${totals.earned} of ${totals.max} possible points from ` +
        `${totals.submissions} submission${totals.submissions === 1 ? "" : "s"}.`
      : `Optional. Up to ${totals.max} points available — do as many or as ` +
        "few as you like, in any week.";
  section.appendChild(summary);

  const list = document.createElement("div");
  list.className = "ec-list";
  for (const card of cards) {
    list.appendChild(renderCard(card, { assignmentProgress, netID, openForm }));
  }
  section.appendChild(list);

  container.appendChild(section);
  return section;
}

function renderCard(card, ctx) {
  const article = document.createElement("article");
  article.className = "card ec-card";

  const titleRow = document.createElement("div");
  titleRow.className = "ec-card-head";

  const title = document.createElement("div");
  title.className = "card-title";
  title.textContent = card.title;

  const points = document.createElement("span");
  points.className = "ec-points";
  // Repeatable cards award their points per submission, so "3 pts each"
  // rather than a total a student might read as a cap.
  points.textContent =
    card.kind === "repeatable" ? `${card.points} pts each` : `${card.points} pts`;

  titleRow.append(title, points);
  article.appendChild(titleRow);

  if (card.desc) {
    const desc = document.createElement("div");
    desc.className = "card-detail";
    desc.textContent = card.desc;
    article.appendChild(desc);
  }

  if (card.kind === "unavailable") {
    const note = document.createElement("div");
    note.className = "ec-unavailable";
    note.textContent = card.reason;
    article.appendChild(note);
    return article;
  }

  const state = cardState(card, ctx.assignmentProgress);

  if (card.kind === "repeatable") {
    const status = document.createElement("div");
    status.className = "card-status";
    status.textContent = `${state.submittedCount} of ${state.totalSlots} submitted`;
    article.appendChild(status);
  } else if (state.submittedCount > 0) {
    const status = document.createElement("div");
    status.className = "card-status complete";
    status.textContent = "✓ Submitted";
    article.appendChild(status);
  }

  appendSubmitButton(article, card, state, ctx);
  return article;
}

function appendSubmitButton(article, card, state, ctx) {
  // Every slot used: there's nothing new to submit, but a student can
  // still replace their most recent one — same rule as every other card.
  const targetId = state.nextSlot ?? state.slots[state.slots.length - 1]?.assignmentId;
  if (!targetId || !ctx.netID) return;

  const full = state.nextSlot === null;
  const actions = document.createElement("div");
  actions.className = "card-actions";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = full || state.submittedCount > 0 ? "btn-secondary" : "btn-primary";
  btn.textContent = full
    ? "Replace last submission"
    : state.submittedCount > 0
      ? "Submit another"
      : "Submit to Canvas";
  if (full) {
    btn.title =
      `All ${state.totalSlots} submissions used. This replaces the most recent one.`;
  }

  const existing = ctx.assignmentProgress?.[targetId] ?? null;
  btn.addEventListener("click", () => {
    ctx.openForm({
      type: card.key,
      assignmentId: targetId,
      netID: ctx.netID,
      prefill: existing?.canvasSubmissionData ?? {},
      isResubmission: Boolean(existing?.canvasSubmittedAt),
    });
  });

  actions.appendChild(btn);
  article.appendChild(actions);
}
