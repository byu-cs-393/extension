// Turns the flat extra-credit list in course.json into the cards a
// student actually sees.
//
// The shape doesn't map one-to-one. course.json has 15 extra-credit
// assignments, but five of them are "Real Interview Report 1..5" — one
// thing a student can do up to five times, not five separate tasks. So
// numbered siblings collapse into a single REPEATABLE card that tracks
// how many slots are used and which one a new submission should go to.
//
// Extra credit also isn't in `schedule[]` at all, so unlike every other
// card type there's no week to hang these on. They get their own section
// on the full-course page.
//
// Three card kinds come out:
//   "single"      one assignment, submit once (though resubmitting to
//                 replace is allowed, same as everywhere else)
//   "repeatable"  N numbered slots, filled in order
//   "unavailable" the professor marked it `tbd` — no template, no schema,
//                 no Canvas id. Shown so students know it exists, with no
//                 submit button, because there's nothing to submit to.
//
// Covered by tests/extra-credit-catalog.test.js.

// "ec-real-interview-report-3" -> { base: "ec-real-interview-report", n: 3 }
// Returns null for ids that don't end in a number, which is most of them
// — "ec-amazing-project-community" is a distinct project, not slot
// "community" of anything.
function splitNumberedId(id) {
  const match = String(id ?? "").match(/^(.*)-(\d+)$/);
  if (!match) return null;
  return { base: match[1], n: Number(match[2]) };
}

// Strips the trailing index from a repeatable title: "Real Interview
// Report 3" -> "Real Interview Report". The card names the thing, not
// the slot.
function familyTitle(title) {
  return String(title ?? "").replace(/\s+\d+\s*$/, "");
}

// Builds the card list from course.json's assignments array.
export function extraCreditCards(assignments) {
  const ec = (assignments ?? []).filter((a) => a?.category === "extra-credit");

  // Group numbered siblings; anything else stands alone.
  const families = new Map();
  const order = [];
  for (const assignment of ec) {
    const numbered = splitNumberedId(assignment.id);
    const key = numbered ? numbered.base : assignment.id;
    if (!families.has(key)) {
      families.set(key, []);
      order.push(key);
    }
    families.get(key).push(assignment);
  }

  return order.map((key) => {
    const members = families
      .get(key)
      .slice()
      .sort((a, b) => (splitNumberedId(a.id)?.n ?? 0) - (splitNumberedId(b.id)?.n ?? 0));
    const first = members[0];

    if (first.tbd) {
      return {
        kind: "unavailable",
        key,
        title: first.title,
        points: first.points ?? 0,
        desc: first.desc ?? null,
        reason:
          "The professor hasn't finalised this one yet — it has no Canvas " +
          "assignment to submit to.",
        slots: [],
      };
    }

    const repeatable = members.length > 1;
    return {
      kind: repeatable ? "repeatable" : "single",
      key,
      title: repeatable ? familyTitle(first.title) : first.title,
      // Points are per submission, not per card. A student who writes
      // three interview reports gets 3 points three times.
      points: first.points ?? 0,
      desc: first.desc ?? null,
      submissionType: first.submit === "online_url" ? "online_url" : "online_text_entry",
      slots: members.map((m) => m.id),
    };
  });
}

// Per-card state given the student's assignmentProgress map.
//
// `nextSlot` is the id a new submission should target: the first slot
// never submitted. Null once every slot is used — the card then offers
// only to replace an existing submission.
export function cardState(card, assignmentProgress = {}) {
  const slots = (card?.slots ?? []).map((assignmentId) => {
    const progress = assignmentProgress?.[assignmentId] ?? null;
    return {
      assignmentId,
      progress,
      submitted: Boolean(progress?.canvasSubmittedAt),
      submittedAt: progress?.canvasSubmittedAt ?? null,
    };
  });
  const used = slots.filter((s) => s.submitted);
  return {
    slots,
    submittedCount: used.length,
    totalSlots: slots.length,
    nextSlot: slots.find((s) => !s.submitted)?.assignmentId ?? null,
    // What they've banked from this card so far.
    earnedPoints: used.length * (card?.points ?? 0),
    maxPoints: slots.length * (card?.points ?? 0),
  };
}

// Totals across every card, for the section header.
export function extraCreditTotals(cards, assignmentProgress = {}) {
  let earned = 0;
  let max = 0;
  let submissions = 0;
  for (const card of cards ?? []) {
    if (card.kind === "unavailable") continue;
    const state = cardState(card, assignmentProgress);
    earned += state.earnedPoints;
    max += state.maxPoints;
    submissions += state.submittedCount;
  }
  return { earned, max, submissions };
}
