// Third-card module — the "one of {Topic Exam, Online Assessment, Mock
// Interview}" slot that sits below the Recommended card on each week.
//
// Two halves:
//
//   1. CATALOG (shared, lives on the week doc):
//      week.thirdCard = null | {
//        type: "topicExam",        topic, durationMin, examType?
//      } | {
//        type: "onlineAssessment", topic, attempts: [Attempt, ...]
//      } | {
//        type: "mockInterview",    durationMin
//      }
//
//      Attempt = {
//        timeLimitMin: number | null,     // null = no time limit
//        requiredSolves: number | null,   // null = must solve all
//        helpAllowed: boolean,
//        problems: [{ slug, title, note? }, ...]
//      }
//
//   2. PROGRESS (per-student, lives at
//      `students/{netID}/weekProgress/{weekNum}`):
//
//      topicExam:        { type, weekNum, status: "requested"|"scheduled"
//                                              |"passed"|"failed",
//                          requestedAt?, scheduledAt?, signoffAt?,
//                          signoffNote?, taNetID? }
//      onlineAssessment: { type, weekNum, currentAttempt: 1|2|3,
//                          attempts: [{startedAt, finishedAt?, passed?}],
//                          finalStatus: "in_progress"|"passed"|"failed" }
//      mockInterview:    { type, weekNum, status: "looking"|"paired"
//                                              |"completed",
//                          partnerNetID?, partnerDisplayName?, pairedAt?,
//                          completedAt?, durationMin? }
//
//   When no progress doc exists, the card renders in its default
//   "unattempted" state for that type.
import { fetchCollection, fetchDoc, patchDoc } from "./firestore.js";
import {
  startAttempt,
  endActiveAttempt,
  getRemainingMs,
  formatRemaining,
  solvedInWindow,
  resetOa,
} from "./oa-session.js";
import { requestSignoff, submitSelfRating } from "./assignment-progress.js";

const PROGRESS_CACHE_KEY = "weekProgressBundle";

// ---- Progress: fetch + cache --------------------------------------------

// Cached progress, keyed by weekNum. Empty object if nothing cached yet.
export async function getCachedProgress() {
  const { [PROGRESS_CACHE_KEY]: bundle } = await chrome.storage.local.get(
    PROGRESS_CACHE_KEY
  );
  return bundle?.progress ?? {};
}

// Pull all of this student's week-progress docs from Firestore and
// cache them. Storage change fires re-render on the dashboard.
export async function refreshProgress(netID) {
  try {
    const docs = await fetchCollection(`students/${netID}/weekProgress`);
    const progress = {};
    for (const d of docs) {
      if (Number.isFinite(d?.weekNum)) {
        progress[d.weekNum] = d;
      }
    }
    await chrome.storage.local.set({
      [PROGRESS_CACHE_KEY]: { progress, syncedAt: Date.now() },
    });
  } catch (error) {
    console.error("[CS 393 Buddy] failed to refresh week progress:", error);
  }
}

// ---- Rendering: dispatcher ----------------------------------------------

// Returns an HTMLElement for a third card, or null if unrenderable.
// Handles BOTH the new course.json item shape (types: "oa", "performance",
// "peer-mock", "live-interview", "professional-mock", "final") AND the
// legacy Firestore third-card shape (types: "topicExam",
// "onlineAssessment", "mockInterview"), for back-compat during migration.
//
// `progress` is the per-student progress doc for this week (or null).
// `weekStatus` is "current" | "past" | "future".
// `ctx` bundles per-render context: { weekNum, netID, activeSession,
//    solves, oaShapes: {topic → runtime OA} }. oaShapes is preloaded
//    by dashboard.js so the OA renderer stays synchronous.
export function createThirdCardSection(item, progress, weekStatus, ctx = {}) {
  if (!item || !item.type) return null;
  switch (item.type) {
    // ---- course.json types (new) ----
    case "oa":
      return renderOaFromCourseItem(item, progress, weekStatus, ctx);
    case "performance":
      return renderCoursePerformanceExam(item, progress, weekStatus, ctx);
    case "peer-mock":
      return renderCoursePeerMock(item, progress, weekStatus, ctx);
    case "live-interview":
      return renderCourseLiveInterview(item, progress, weekStatus, ctx);
    case "professional-mock":
      return renderCourseProfessionalMock(item, progress, weekStatus, ctx);
    case "final":
      return renderCourseFinal(item, progress, weekStatus, ctx);
    // ---- legacy Firestore-model types ----
    case "topicExam":
      return renderTopicExam(item, progress, weekStatus, ctx);
    case "onlineAssessment":
      return renderOnlineAssessment(item, progress, weekStatus, ctx);
    case "mockInterview":
      return renderMockInterview(item, progress, weekStatus);
    default:
      console.warn("[CS 393 Buddy] unknown card type:", item.type);
      return null;
  }
}

// Bridge: takes a course.json performance item of type "oa" and delegates
// to the existing OA renderer using the pre-translated runtime shape
// (loaded by the dashboard into ctx.oaShapes at bootstrap).
function renderOaFromCourseItem(item, progress, weekStatus, ctx) {
  const runtime = ctx?.oaShapes?.[item.topic];
  if (!runtime) {
    const article = makeCard();
    addTitle(article, item.title ?? "Online Assessment");
    addStatusLine(article, "Loading…");
    return article;
  }
  return renderOnlineAssessment(runtime, progress, weekStatus, ctx);
}

// ---- Placeholder renderers for new course.json types -------------------
//
// These are display-only for now. Step 5 will add full progress tracking
// (per-assignment progress docs, TA signoff flows for perf/live, partner
// pairing for peer-mock, etc). Kept minimal on purpose so we can see the
// dashboard layout at multi-card granularity before we commit to signoff
// data shapes.

function renderCoursePerformanceExam(item, _progress, weekStatus, ctx) {
  const article = makeCard();
  addTitle(article, item.title ?? "Performance Exam");
  addDetail(article, "Practice ahead of time, then perform live in 15 min for a TA.");

  const ap = ctx?.assignmentProgress?.[item.assignmentId] ?? null;
  const status = ap?.status ?? "available";

  if (status === "passed") {
    addStatusLine(article, "✓ Passed", "complete");
    // Rare — but if the student wants to retake, allow it (matches the
    // "you can always retry to improve" spirit of the topic exams).
    appendRequestButton(article, item, ap, ctx, "Request re-signoff");
    return article;
  }
  if (status === "requested") {
    addStatusLine(article, "⏳ Signoff requested");
    return article;
  }
  if (weekStatus === "past" && status === "available") {
    addStatusLine(article, "Not attempted");
    return article;
  }
  const label = status === "failed" ? "Request re-signoff" : "Request signoff";
  if (status === "failed") addStatusLine(article, "✗ Failed", "incomplete");
  appendRequestButton(article, item, ap, ctx, label);
  return article;
}

// Shared helper: renders the "Request signoff" button. Wired to
// assignment-progress.js's requestSignoff. Records weekNum so the TA's
// signoff queue can surface it under the right week header.
function appendRequestButton(article, item, existingProgress, ctx, label) {
  addPrimaryButton(article, label, async () => {
    if (!ctx?.netID || !item?.assignmentId) {
      stubAction("Signoff");
      return;
    }
    try {
      await requestSignoff({
        netID: ctx.netID,
        assignmentId: item.assignmentId,
        type: item.type,
        weekNum: ctx.weekNum,
      });
    } catch (err) {
      console.error("[CS 393 Buddy] Failed to request signoff:", err);
      alert("Couldn't submit your signoff request. Try again in a moment.");
    }
  });
}

function renderCoursePeerMock(item, _progress, _weekStatus) {
  const article = makeCard();
  addTitle(article, item.title ?? "Peer Mock Interview");
  addDetail(article, "Pair with a classmate this week.");
  addStatusLine(article, "Pairing flow coming soon");
  return article;
}

function renderCourseLiveInterview(item, _progress, weekStatus, ctx) {
  const article = makeCard();
  const titleLabel = item.index ? `Live Interview ${item.index}` : "Live Interview";
  addTitle(article, titleLabel);
  addDetail(article, "Schedule with a TA or the instructor. Self-rate 1/2/3 after.");

  const ap = ctx?.assignmentProgress?.[item.assignmentId] ?? null;
  const status = ap?.status ?? "available";

  if (status === "passed") {
    // TA's grader rating shows first (if set), student self-rating below.
    if (Number.isInteger(ap?.graderRating)) {
      addStatusLine(article, `✓ Passed · TA rating ${ap.graderRating}/3`, "complete");
    } else {
      addStatusLine(article, "✓ Passed", "complete");
    }
    if (Number.isInteger(ap?.selfRating)) {
      addDetail(article, `Your self-rating: ${ap.selfRating}/3`);
    } else {
      // Prompt the student to self-rate — required to fully complete
      // the live interview per the professor's rubric.
      appendSelfRatingRow(article, item, ctx);
    }
    // Live interviews are always retakeable — the professor explicitly
    // wants students to try before they feel ready.
    appendRequestButton(article, item, ap, ctx, "Request another");
    return article;
  }
  if (status === "requested") {
    addStatusLine(article, "⏳ Signoff requested");
    return article;
  }
  if (weekStatus === "past" && status === "available") {
    addStatusLine(article, "Not attempted");
    return article;
  }
  const label = status === "failed" ? "Request re-signoff" : "Request signoff";
  if (status === "failed") addStatusLine(article, "✗ Failed", "incomplete");
  appendRequestButton(article, item, ap, ctx, label);
  return article;
}

// Inline 1 / 2 / 3 button row for the student's self-rating on a
// passed live interview. Writes to assignmentProgress via
// submitSelfRating; the storage listener fires re-render immediately.
function appendSelfRatingRow(article, item, ctx) {
  const wrapper = document.createElement("div");
  wrapper.className = "card-actions self-rating-row";

  const label = document.createElement("span");
  label.className = "card-detail self-rating-label";
  label.textContent = "Self-rate:";
  wrapper.appendChild(label);

  for (const n of [1, 2, 3]) {
    const btn = document.createElement("button");
    btn.className = "btn-primary self-rating-btn";
    btn.textContent = String(n);
    btn.addEventListener("click", async () => {
      if (!ctx?.netID || !item?.assignmentId) return;
      try {
        await submitSelfRating({
          netID: ctx.netID,
          assignmentId: item.assignmentId,
          selfRating: n,
        });
      } catch (err) {
        console.error("[CS 393 Buddy] self-rate failed:", err);
        alert("Couldn't save your self-rating. Try again in a moment.");
      }
    });
    wrapper.appendChild(btn);
  }
  article.appendChild(wrapper);
}

function renderCourseProfessionalMock(item, _progress, _weekStatus) {
  const article = makeCard();
  addTitle(article, item.title ?? "Professional Mock Interview");
  addDetail(article, "One-on-one with someone working in industry (takes ~a month to line up).");
  addStatusLine(article, "Submission flow coming soon");
  return article;
}

function renderCourseFinal(item, _progress, _weekStatus) {
  const article = makeCard();
  const label = item.phase === "concludes" ? "Final Exam (concludes)" : "Final Exam";
  addTitle(article, label);
  addDetail(article, "5.5 hrs across three sittings. Must pass to pass the course.");
  return article;
}

function stubAction(label) {
  alert(
    `${label} workflow coming soon.\n\n` +
      "The TA-side and partner-pairing flows are being designed. " +
      "For now, your action has been noted visually but not saved."
  );
}

function makeCard() {
  const article = document.createElement("article");
  article.className = "card";
  return article;
}

function addTitle(article, text) {
  const el = document.createElement("div");
  el.className = "card-title";
  el.textContent = text;
  article.appendChild(el);
}

function addDetail(article, text) {
  const el = document.createElement("div");
  el.className = "card-detail";
  el.textContent = text;
  article.appendChild(el);
}

function addStatusLine(article, text, kind = "") {
  const el = document.createElement("div");
  el.className = kind ? `card-status ${kind}` : "card-status";
  el.textContent = text;
  article.appendChild(el);
}

function addPrimaryButton(article, label, onClick) {
  const actions = document.createElement("div");
  actions.className = "card-actions";
  const button = document.createElement("button");
  button.className = "btn-primary";
  button.textContent = label;
  button.addEventListener("click", onClick);
  actions.appendChild(button);
  article.appendChild(actions);
}

// ---- Topic Exam ---------------------------------------------------------

function renderTopicExam(card, progress, weekStatus, ctx) {
  const article = makeCard();
  addTitle(article, `Topic Exam · ${card.topic}`);

  if (Number.isFinite(card.durationMin)) {
    addDetail(article, `Solve a problem with a TA · ${card.durationMin} min`);
  }

  const status = progress?.status ?? "available";

  if (status === "passed") {
    addStatusLine(article, "✓ Passed", "complete");
    return article;
  }
  if (status === "requested") {
    addStatusLine(article, "⏳ Signoff requested");
    return article;
  }
  if (status === "scheduled") {
    addStatusLine(article, "📅 Signoff scheduled");
    return article;
  }
  // "available" or "failed". Past weeks with no attempt show neutral text.
  if (weekStatus === "past" && status === "available") {
    addStatusLine(article, "Not attempted");
    return article;
  }
  const label = status === "failed" ? "Request re-signoff" : "Request signoff";
  addPrimaryButton(article, label, async () => {
    if (!ctx?.netID || !Number.isFinite(ctx?.weekNum)) {
      stubAction("Signoff");
      return;
    }
    try {
      await requestTopicExamSignoff({
        netID: ctx.netID,
        weekNum: ctx.weekNum,
        existingProgress: progress,
      });
    } catch (err) {
      console.error("[CS 393 Buddy] Failed to request signoff:", err);
      alert("Couldn't submit your signoff request. Try again in a moment.");
    }
  });
  return article;
}

// Records a signoff request against the topic exam by writing/patching
// the student's weekProgress doc. Storage listener on the dashboard
// re-renders the card into the "⏳ Signoff requested" state.
async function requestTopicExamSignoff({ netID, weekNum, existingProgress }) {
  const now = Date.now();
  // Preserve any fields already on the doc (e.g., a prior signoffAt
  // from a "failed" attempt so we can see the retry chain later).
  const existing = existingProgress
    ? existingProgress
    : (await fetchDoc(`students/${netID}/weekProgress/${weekNum}`)) ?? {};
  const newProgress = {
    ...existing,
    type: "topicExam",
    weekNum,
    status: "requested",
    requestedAt: now,
  };
  await patchDoc(`students/${netID}/weekProgress/${weekNum}`, newProgress);

  // Update the local cache so the storage listener re-renders
  // immediately — same pattern as endActiveAttempt in oa-session.js.
  const cached = await chrome.storage.local.get(PROGRESS_CACHE_KEY);
  const bundle = cached[PROGRESS_CACHE_KEY] ?? { progress: {} };
  bundle.progress = { ...(bundle.progress ?? {}), [weekNum]: newProgress };
  bundle.syncedAt = Date.now();
  await chrome.storage.local.set({ [PROGRESS_CACHE_KEY]: bundle });
}

// ---- Online Assessment --------------------------------------------------

function renderOnlineAssessment(card, progress, _weekStatus, ctx) {
  const article = makeCard();

  const totalAttempts = card.attempts?.length ?? 0;
  const finalStatus = progress?.finalStatus ?? "not_started";
  const activeForThisWeek =
    ctx?.activeSession && ctx.activeSession.weekNum === ctx.weekNum;
  const hasTimer =
    activeForThisWeek && ctx.activeSession.deadlineMs != null;

  // Title row — the timer, if any, sits in the top-right pill.
  const timerContent = hasTimer
    ? "⏱ " + formatRemaining(getRemainingMs(ctx.activeSession))
    : null;
  addOaTitleRow(article, card.topic, timerContent, ctx?.weekNum);

  if (finalStatus === "passed") {
    const which = progress?.currentAttempt ?? "?";
    addStatusLine(article, `✓ Passed (attempt ${which} of ${totalAttempts})`, "complete");
    appendResetIfProgress(article, ctx, progress, activeForThisWeek);
    return article;
  }

  if (finalStatus === "failed") {
    addStatusLine(article, `✗ Failed all ${totalAttempts} attempts`, "incomplete");
    appendResetIfProgress(article, ctx, progress, activeForThisWeek);
    return article;
  }

  // If they've cycled through every attempt without an active session,
  // there's no "next attempt to start." Show a terminal placeholder.
  const rawNextAttempt = progress?.currentAttempt ?? 1;
  if (!activeForThisWeek && rawNextAttempt > totalAttempts) {
    addStatusLine(
      article,
      `All ${totalAttempts} attempts used`,
      "incomplete"
    );
    appendResetIfProgress(article, ctx, progress, activeForThisWeek);
    return article;
  }

  const attemptIdx = activeForThisWeek
    ? ctx.activeSession.attemptIndex
    : clampAttempt(rawNextAttempt, totalAttempts) - 1;
  const attempt = card.attempts?.[attemptIdx];
  if (!attempt) {
    addStatusLine(article, "No attempt data");
    appendResetIfProgress(article, ctx, progress, activeForThisWeek);
    return article;
  }

  // Headline: "Attempt 1 of 3 · 90 min · solo".
  const parts = [`Attempt ${attemptIdx + 1} of ${totalAttempts}`];
  parts.push(attempt.timeLimitMin == null ? "no time limit" : `${attempt.timeLimitMin} min`);
  parts.push(attempt.helpAllowed ? "help allowed" : "solo");
  addDetail(article, parts.join(" · "));

  if (attempt.helpAllowed) {
    addDetail(article, "Get help from a TA or classmate (no internet solutions).");
  }

  // Pass rule — period-terminated so it reads naturally with or
  // without the problem list below it.
  const problemCount = attempt.problems?.length ?? 0;
  const requiredCount =
    attempt.requiredSolves ?? attempt.problems?.length ?? 0;
  const passRule = attempt.requiredSolves
    ? `Solve any ${attempt.requiredSolves} of ${problemCount} problems`
    : `Solve all ${problemCount} problem${problemCount === 1 ? "" : "s"}`;
  addDetail(article, passRule + ".");

  if (activeForThisWeek) {
    // Reveal the progress bar and problem list ONLY once the attempt
    // is running. Pre-start we intentionally keep the problems hidden
    // — students shouldn't be able to browse the exam before starting.
    const solvedSet = new Set(
      solvedInWindow(
        attempt,
        ctx.solves ?? {},
        ctx.activeSession.startedAt,
        Date.now()
      )
    );
    const solvedCount = solvedSet.size;

    if (requiredCount > 0) {
      article.appendChild(
        makeProgressBar(solvedCount, requiredCount, solvedCount >= requiredCount)
      );
    }

    if (problemCount > 0) {
      const list = document.createElement("ul");
      list.className = "card-list problem-list";
      attempt.problems.forEach((p) =>
        list.appendChild(makeOaProblemRow(p, solvedSet.has(p.slug)))
      );
      article.appendChild(list);
    }

    if (hasTimer) {
      addPrimaryButton(article, "End attempt early", async () => {
        if (!confirm("End this attempt now?")) return;
        await endActiveAttempt({
          netID: ctx.netID,
          existingProgress: progress,
          attemptSpec: attempt,
          totalAttempts,
          solves: ctx.solves ?? {},
          reason: "manual",
        });
      });
    } else {
      // Open-window model (attempts 2 and 3): status + Submit.
      addStatusLine(article, "● Attempt in progress");
      addDetail(
        article,
        "Close this tab and come back anytime — the attempt stays open until you submit."
      );

      addPrimaryButton(article, "Submit attempt", async () => {
        if (!confirm("Submit this attempt for evaluation?")) return;
        await endActiveAttempt({
          netID: ctx.netID,
          existingProgress: progress,
          attemptSpec: attempt,
          totalAttempts,
          solves: ctx.solves ?? {},
          reason: "submit",
        });
      });
    }
    appendResetIfProgress(article, ctx, progress, activeForThisWeek);
    return article;
  }

  // Not active: no problem list, no progress bar — just the Start
  // button. The problems only reveal after the student commits.
  const label =
    attemptIdx === 0 ? "Start attempt 1" :
    attemptIdx === totalAttempts - 1 && attempt.helpAllowed ? "Try again with help" :
    "Try again";
  addPrimaryButton(article, label, async () => {
    if (!ctx?.netID) {
      stubAction("Online assessment");
      return;
    }
    try {
      await startAttempt({
        netID: ctx.netID,
        weekNum: ctx.weekNum,
        attemptIndex: attemptIdx,
        timeLimitMin: attempt.timeLimitMin,
        existingProgress: progress,
      });
    } catch (error) {
      alert(error.message);
    }
  });
  appendResetIfProgress(article, ctx, progress, activeForThisWeek);
  return article;
}

// Renders the OA card's title row. Includes an optional timer pill on
// the right side (top-right corner). The pill carries a `data-oa-timer`
// attribute so the dashboard's 1-second tick can surgically update just
// the countdown text without touching the rest of the card.
function addOaTitleRow(article, topic, timerContent, weekNum) {
  const row = document.createElement("div");
  row.className = "card-title-row";

  const titleEl = document.createElement("span");
  titleEl.className = "card-title";
  titleEl.textContent = `Online Assessment · ${topic}`;
  row.appendChild(titleEl);

  if (timerContent != null) {
    const timerEl = document.createElement("span");
    timerEl.className = "oa-timer";
    timerEl.dataset.oaTimer = String(weekNum);
    timerEl.textContent = timerContent;
    row.appendChild(timerEl);
  }

  article.appendChild(row);
}

// Adds a subtle "Reset attempts" link at the bottom of the OA card
// whenever there's OA state to reset — either an active session for
// this week, or an existing progress doc. Confirms before wiping.
function appendResetIfProgress(article, ctx, progress, activeForThisWeek) {
  if (!ctx?.netID) return;
  if (!progress && !activeForThisWeek) return;
  const btn = document.createElement("button");
  btn.className = "oa-reset-link";
  btn.type = "button";
  btn.textContent = "Reset attempts";
  btn.addEventListener("click", async () => {
    const ok = confirm(
      "Reset all OA progress for this week?\n\n" +
        "This clears any active attempt and all past attempt history."
    );
    if (!ok) return;
    await resetOa({ netID: ctx.netID, weekNum: ctx.weekNum });
  });
  article.appendChild(btn);
}

// Builds a Recommended-card-style progress bar. Extracted so the OA
// renderer can reuse the exact same DOM shape and CSS classes.
function makeProgressBar(current, total, isComplete) {
  const progress = document.createElement("div");
  progress.className = "progress";

  const bar = document.createElement("div");
  bar.className = "progress-bar";
  bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", String(total));
  bar.setAttribute("aria-valuenow", String(current));

  const pct = total === 0 ? 0 : Math.min(100, Math.round((current / total) * 100));
  const fill = document.createElement("div");
  fill.style.width = `${pct}%`;
  fill.className = isComplete ? "progress-fill complete" : "progress-fill";
  bar.appendChild(fill);

  const text = document.createElement("div");
  text.className = "progress-text";
  text.textContent = `${current} / ${total}`;
  if (isComplete) {
    const check = document.createElement("span");
    check.className = "status-check";
    check.setAttribute("aria-hidden", "true");
    check.textContent = " ✓";
    text.appendChild(check);
  }

  progress.append(bar, text);
  return progress;
}

// Same DOM shape as createProblemItem in dashboard.js so styling
// stays consistent. OA problems don't have a difficulty, but they
// can have an optional constraint note ("O(1) space only") which
// takes the slot the difficulty pill occupies on Recommended rows.
function makeOaProblemRow(p, isSolved) {
  const li = document.createElement("li");
  li.className = `problem ${isSolved ? "complete" : "pending"}`;

  const mark = document.createElement("span");
  mark.className = "problem-mark";
  mark.textContent = isSolved ? "✓" : "○";

  const link = document.createElement("a");
  link.className = "problem-link";
  link.href = `https://leetcode.com/problems/${p.slug}/`;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = p.title;

  li.append(mark, link);

  if (p.note) {
    const note = document.createElement("span");
    note.className = "problem-note";
    note.textContent = p.note;
    li.appendChild(note);
  }
  return li;
}

function clampAttempt(n, max) {
  if (!Number.isFinite(n) || n < 1) return 1;
  if (max > 0 && n > max) return max;
  return n;
}

// ---- Mock Interview -----------------------------------------------------

function renderMockInterview(card, progress, _weekStatus) {
  const article = makeCard();
  addTitle(article, "Mock Interview");

  const status = progress?.status ?? "looking";

  if (status === "completed") {
    const partner = progress?.partnerDisplayName ?? "your partner";
    const duration = Number.isFinite(progress?.durationMin)
      ? ` · ${progress.durationMin} min`
      : "";
    addDetail(article, `Paired with ${partner}${duration}`);
    addStatusLine(article, "✓ Completed", "complete");
    return article;
  }

  if (status === "paired") {
    const partner = progress?.partnerDisplayName ?? "a classmate";
    addDetail(article, `Paired with ${partner}`);
    addPrimaryButton(article, "Mark as completed", () =>
      stubAction("Mock interview signoff")
    );
    return article;
  }

  // "looking" / no progress doc — show the find-partner CTA.
  const detail = Number.isFinite(card.durationMin)
    ? `Pair with a classmate · ${card.durationMin} min`
    : "Pair with a classmate";
  addDetail(article, detail);
  addPrimaryButton(article, "Find a partner", () => stubAction("Mock interview pairing"));
  return article;
}
