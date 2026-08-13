// Third-card module — the performance-item card(s) that sit below the
// Recommended card on each week. Types come from course.json:
// "oa", "performance", "peer-mock", "live-interview",
// "professional-mock", "final".
//
// Two halves:
//
//   1. CATALOG (shared): course.json's `schedule[N].performance` items,
//      read through course-data.js. OA items are translated into the
//      runtime shape below by translateOaToRuntimeShape():
//
//        { type: "onlineAssessment", topic, attempts: [Attempt, ...] }
//
//        Attempt = {
//          timeLimitMin: number | null,     // null = no time limit
//          requiredSolves: number | null,   // null = must solve all
//          helpAllowed: boolean,
//          problems: [{ slug, title, note? }, ...]
//        }
//
//   2. PROGRESS (per-student). Two stores, mid-migration:
//
//      OA still runs off the legacy weekProgress doc at
//      `students/{netID}/weekProgress/{weekNum}`:
//        { type: "onlineAssessment", weekNum, currentAttempt: 1|2|3,
//          attempts: [{startedAt, finishedAt?, passed?}],
//          finalStatus: "in_progress"|"passed"|"failed" }
//
//      Everything else uses per-assignment docs at
//      `students/{netID}/assignmentProgress/{assignmentId}`, passed in
//      via ctx.assignmentProgress. See assignment-progress.js.
//
//   When no progress doc exists, the card renders in its default
//   "unattempted" state for that type.
import { fetchCollection, patchDoc } from "../platform/firestore.js";
import {
  startAttempt,
  endActiveAttempt,
  getRemainingMs,
  formatRemaining,
  solvedInWindow,
  resetOa,
} from "../data/oa-session.js";
import { requestSignoff, submitSelfRating } from "../data/assignment-progress.js";
import { fillOaTemplate } from "../data/submission-templates.js";
import { openSubmissionForm } from "./submission-form.js";
import { describeCanvasError, canvasErrorHint } from "../lib/canvas-error.js";

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
//
// `item` is a "performance item" — an entry from `schedule[N].performance`
// in the professor's course.json, plus the gradeable refs course-data.js
// promotes out of `schedule[N].other`. The name comes from his grading
// categories, where Performance is worth 40% of the course:
//
//     Study 40% · Performance 40% · Final 20% · Extra Credit
//
// Note the word does double duty, which is a wart inherited from the
// data: "performance" is both that CATEGORY and the `type` of one
// specific assessment inside it (the performance exam). The array is also
// slightly wider than its name — the Final lives there too, and its
// category is "final".
//
// Handled types: "oa", "performance", "peer-mock", "live-interview",
// "professional-mock", "final", "connect-with-class",
// "instructor-interview".
//
// `progress` is the per-student progress doc for this week (or null).
// `weekStatus` is "current" | "past" | "future".
// `ctx` (context) is everything a renderer might need that isn't the item
// itself, bundled into one argument so adding a dependency doesn't change
// this function's signature or every call site:
//
//    weekNum             which week is being rendered
//    netID               whose dashboard this is — writes need it
//    activeSession       the in-flight OA attempt, if any
//    solves              { slug → solvedAtMs } for progress bars
//    solutionUrls        { slug → accepted submission URL }
//    oaShapes            { topic → runtime OA }, preloaded by the caller
//                        so the OA renderer can stay synchronous
//    assignmentProgress  { assignmentId → progress doc }, the source for
//                        signoff status and canvasSubmittedAt
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
    case "connect-with-class":
      return renderConnectWithClass(item, progress, weekStatus, ctx);
    case "instructor-interview":
      return renderInstructorInterview(item, progress, weekStatus, ctx);
    default:
      console.warn("[CS 393 Buddy] unknown card type:", item.type);
      return null;
  }
}

// Bridge: takes a course.json performance item of type "oa" and delegates
// to the existing OA renderer using the pre-translated runtime shape
// (loaded by the dashboard into ctx.oaShapes at bootstrap).
function renderOaFromCourseItem(item, progress, weekStatus, ctx) {
  const oaShape = ctx?.oaShapes?.[item.topic];
  if (!oaShape) {
    // Not an error — the dashboard translates every topic's OA
    // asynchronously at bootstrap, so the first render can land before
    // they're ready. Return a placeholder card rather than null: null
    // means "no card here", which would leave a gap and then shove the
    // page down when the real one arrives.
    const article = makeCard();
    addTitle(article, item.title ?? "Online Assessment");
    addStatusLine(article, "Loading…");
    return article;
  }
  return renderOnlineAssessment(oaShape, progress, weekStatus, ctx);
}

// ---- Renderers for new course.json types -------------------------------
//
// Non-signoff types (peer-mock, professional-mock) get an always-visible
// "Submit to Canvas" button per the user's UX decision. Signoff types
// (performance, live-interview) get the button AFTER TA Pass.
// The Weekly Study card is rendered by dashboard.js (recommended
// problems section), not here.

function renderCoursePerformanceExam(item, _progress, weekStatus, ctx) {
  const article = makeCard();
  addTitle(article, item.title ?? "Performance Exam");
  addDetail(article, "Practice ahead of time, then perform live in 15 min for a TA.");

  const ap = ctx?.assignmentProgress?.[item.assignmentId] ?? null;
  const status = ap?.status ?? "available";

  if (status === "passed") {
    addStatusLine(article, "✓ Passed", "complete");
    // After Pass, the student submits to Canvas with the fields the
    // performance-exam template asks for (date, URL, duration, etc.).
    appendCanvasSubmitAffordance(article, item, ap, ctx, {
      prefill: {
        date: todayIso(),
        workedWith: ap?.signoffTaNetID ?? "",
        attemptNum: 1,
      },
    });
    // Retakeable — rare but supported.
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

function renderCoursePeerMock(item, _progress, _weekStatus, ctx) {
  const article = makeCard();
  addTitle(article, item.title ?? "Peer Mock Interview");
  addDetail(article, "Pair with a classmate this week.");
  const ap = ctx?.assignmentProgress?.[item.assignmentId] ?? null;
  appendCanvasSubmitAffordance(article, item, ap, ctx, {
    prefill: { when: todayIso() },
  });
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
    // After self-rating, offer the Canvas submit. Gate on selfRating
    // being present so the submission has the full picture.
    if (Number.isInteger(ap?.selfRating)) {
      appendCanvasSubmitAffordance(article, item, ap, ctx, {
        prefill: {
          date: todayIso(),
          selfRating: String(ap.selfRating),
        },
      });
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

function renderCourseProfessionalMock(item, _progress, _weekStatus, ctx) {
  const article = makeCard();
  addTitle(article, item.title ?? "Professional Mock Interview");
  addDetail(article, "One-on-one with someone working in industry (takes ~a month to line up).");
  const ap = ctx?.assignmentProgress?.[item.assignmentId] ?? null;
  appendCanvasSubmitAffordance(article, item, ap, ctx);
  return article;
}

function renderCourseFinal(item, _progress, _weekStatus) {
  const article = makeCard();
  const label = item.phase === "concludes" ? "Final Exam (concludes)" : "Final Exam";
  addTitle(article, label);
  addDetail(article, "5.5 hrs across three sittings. Must pass to pass the course.");
  return article;
}

// Week-1 onboarding checklist. No signoff — the student self-reports all
// seven items in the modal, so the button is always visible. The Teams
// link rides along on the assignments[] entry rather than being hardcoded
// here, since it carries the tenant/group ids.
function renderConnectWithClass(item, _progress, _weekStatus, ctx) {
  const article = makeCard();
  addTitle(article, item.title ?? "Connect with Class");
  addDetail(
    article,
    "Join the class Teams, post an intro, react to three others, and DM a classmate for a mock."
  );

  const teamsUrl = item.assignment?.teamsUrl;
  if (teamsUrl) addExternalLink(article, "Open class Teams ↗", teamsUrl);

  const ap = ctx?.assignmentProgress?.[item.assignmentId] ?? null;
  appendCanvasSubmitAffordance(article, item, ap, ctx);
  return article;
}

// Course gate — a random-topic live interview with the instructor. There's
// deliberately no TA signoff path here (a TA can't sign off the
// instructor's own interview), so this follows the professional-mock
// shape: always-visible button, student self-reports afterward.
function renderInstructorInterview(item, _progress, _weekStatus, ctx) {
  const article = makeCard();
  addTitle(article, item.title ?? "Instructor Pass/Fail Interview");
  addDetail(
    article,
    item.assignment?.desc ??
      "Schedule a live interview with the instructor. Required to pass the course."
  );

  const ap = ctx?.assignmentProgress?.[item.assignmentId] ?? null;
  if (item.assignment?.gate && !ap?.canvasSubmittedAt) {
    addStatusLine(article, "⚑ Required to pass the course");
  }
  appendCanvasSubmitAffordance(article, item, ap, ctx, {
    prefill: { date: todayIso() },
  });
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

// An out-of-extension link (Teams, docs). Opens in a new tab; noopener so
// the target can't reach back into the dashboard via window.opener.
function addExternalLink(article, label, href) {
  const el = document.createElement("a");
  el.className = "card-link";
  el.href = href;
  el.target = "_blank";
  el.rel = "noopener noreferrer";
  el.textContent = label;
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
    appendCanvasSubmitRow(article, card, progress, ctx);
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

// Adds a "Submit to Canvas" button (or a "✓ Submitted" receipt) at the
// bottom of a passed OA card. On click: fills the OA template with the
// student's attempt# + accepted problem URLs from the passing attempt,
// forwards to the background service worker's submitCanvasAssignment
// handler (which POSTs to the Cloud Function which POSTs to Canvas with
// masquerade), then patches the progress doc with canvasSubmittedAt so
// the card can show a receipt.
//
// One-click confirm per user preference (not fully auto): student
// sees the button and decides when to submit.
//
// Resubmitting is allowed, same as the other card types: Canvas keeps
// every attempt and grades the most recent, so a later submission
// supersedes the earlier one. Firestore rules allow the student to write
// additional fields on their own weekProgress doc.
function appendCanvasSubmitRow(article, card, progress, ctx) {
  if (!ctx?.netID || !card?.topic) return;
  const assignmentId = `oa-${card.topic}`;

  const submittedAt = progress?.canvasSubmittedAt ?? null;
  const submitCount = Number.isFinite(progress?.canvasSubmitCount)
    ? progress.canvasSubmitCount
    : submittedAt
      ? 1
      : 0;

  if (submittedAt) {
    const line = document.createElement("div");
    line.className = "card-detail canvas-submit-receipt";
    const times = submitCount > 1 ? ` · ${submitCount} submissions` : "";
    line.textContent =
      `✓ Submitted to Canvas · ${formatRelativeTime(submittedAt)}${times}`;
    article.appendChild(line);
  }

  const actions = document.createElement("div");
  actions.className = "card-actions";
  const btn = document.createElement("button");
  btn.className = submittedAt ? "btn-secondary" : "btn-primary";
  btn.textContent = submittedAt ? "Submit again" : "Submit to Canvas";
  if (submittedAt) {
    btn.title = "Sends a new submission to Canvas. It replaces this one for grading.";
  }
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = "Submitting…";
    try {
      const attemptIdx = (progress?.currentAttempt ?? 1) - 1;
      const attempt = progress?.attempts?.[attemptIdx];
      const solvedSlugs = attempt?.solvedSlugs ?? [];
      // Prefer per-submission URLs from the tracker/backstop when
      // available; fall back to the plain problem URL otherwise.
      const solutionUrls = ctx?.solutionUrls ?? {};
      const acceptedUrls = solvedSlugs.map(
        (slug) => solutionUrls[slug] ?? `https://leetcode.com/problems/${slug}/`,
      );
      const body = fillOaTemplate({
        attemptNum: progress?.currentAttempt ?? attemptIdx + 1,
        acceptedUrls,
      });
      const result = await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          {
            type: "submitCanvasAssignment",
            payload: {
              assignmentId,
              submissionType: "online_text_entry",
              body,
            },
          },
          (r) => resolve(r),
        );
      });
      if (result?.outcome !== "submitted") {
        console.error("[CS 393 Buddy] Canvas submit failed:", result);
        const hint = canvasErrorHint(result);
        alert(
          `Couldn't submit to Canvas.\n\n${describeCanvasError(result)}` +
            (hint ? `\n\n${hint}` : ""),
        );
        btn.disabled = false;
        btn.textContent = originalText;
        return;
      }
      // Patch the weekProgress doc + local cache so this card re-renders
      // as "✓ Submitted" without waiting for a Firestore refetch.
      // Named `now`, not `submittedAt`: the outer scope already binds
      // `submittedAt` to the PREVIOUS submission's timestamp, which the
      // button label and submit count read.
      const now = Date.now();
      const newProgress = {
        ...(progress ?? {}),
        type: "onlineAssessment",
        weekNum: ctx.weekNum,
        canvasSubmittedAt: now,
        canvasSubmitCount: submitCount + 1,
        canvasSubmissionId: result.canvasSubmissionId ?? null,
      };
      try {
        await patchDoc(`students/${ctx.netID}/weekProgress/${ctx.weekNum}`, newProgress);
        const cached = await chrome.storage.local.get(PROGRESS_CACHE_KEY);
        const bundle = cached[PROGRESS_CACHE_KEY] ?? { progress: {} };
        bundle.progress = { ...(bundle.progress ?? {}), [ctx.weekNum]: newProgress };
        bundle.syncedAt = Date.now();
        await chrome.storage.local.set({ [PROGRESS_CACHE_KEY]: bundle });
      } catch (patchErr) {
        // Non-fatal: Canvas has the submission; we just failed to record it.
        // The next refreshProgress round will observe the state via Firestore.
        console.error("[CS 393 Buddy] Failed to record canvasSubmittedAt:", patchErr);
      }
    } catch (err) {
      console.error("[CS 393 Buddy] Canvas submit threw:", err);
      alert(`Couldn't submit to Canvas: ${err.message ?? String(err)}`);
      btn.disabled = false;
      btn.textContent = originalText;
    }
  });
  actions.appendChild(btn);
  article.appendChild(actions);
}

// Small helper used by the Canvas-submit receipt line. Same intent as
// dashboard.js's formatRelativeTime but locally-scoped so third-card.js
// doesn't need to import from a UI module.
function formatRelativeTime(ts) {
  if (!Number.isFinite(ts)) return "";
  const seconds = Math.round((ts - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return `${abs}s ago`;
  if (abs < 3600) return `${Math.round(abs / 60)}m ago`;
  if (abs < 86400) return `${Math.round(abs / 3600)}h ago`;
  return `${Math.round(abs / 86400)}d ago`;
}

function todayIso() {
  // Local-time YYYY-MM-DD for prefilling <input type="date"> fields.
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

// Shared affordance for cards that write to assignmentProgress. Shows
// "✓ Submitted to Canvas · <time>" when canvasSubmittedAt is set;
// otherwise a "Submit to Canvas" button that opens the schema-driven
// modal for {item.type, item.assignmentId}. Idempotency guard is
// canvasSubmittedAt on the assignmentProgress doc.
//
// Exported so dashboard.js's recommended-problems card (Weekly Study)
// can reuse the same button/receipt pattern without duplicating.
export function appendCanvasSubmitAffordance(article, item, progress, ctx, opts = {}) {
  if (!ctx?.netID || !item?.assignmentId) return;

  const submittedAt = progress?.canvasSubmittedAt ?? null;
  const submitCount = Number.isFinite(progress?.canvasSubmitCount)
    ? progress.canvasSubmitCount
    : submittedAt
      ? 1
      : 0;

  if (submittedAt) {
    const line = document.createElement("div");
    line.className = "card-detail canvas-submit-receipt";
    const times = submitCount > 1 ? ` · ${submitCount} submissions` : "";
    line.textContent =
      `✓ Submitted to Canvas · ${formatRelativeTime(submittedAt)}${times}`;
    article.appendChild(line);
  }

  const actions = document.createElement("div");
  actions.className = "card-actions";
  const btn = document.createElement("button");
  // Resubmitting is allowed. Canvas keeps every attempt and grades the
  // most recent one, so a later submission supersedes the earlier one
  // rather than duplicating it — which is what a student correcting
  // their hours, or submitting again after solving more problems,
  // actually wants.
  btn.className = submittedAt ? "btn-secondary" : "btn-primary";
  btn.textContent = submittedAt ? "Submit again" : "Submit to Canvas";
  if (submittedAt) {
    btn.title = "Sends a new submission to Canvas. It replaces this one for grading.";
  }
  btn.addEventListener("click", () => {
    openSubmissionForm({
      type: item.type,
      assignmentId: item.assignmentId,
      weekNum: ctx.weekNum,
      netID: ctx.netID,
      // Values from the last submission win over the computed defaults,
      // so correcting one field doesn't mean retyping the rest.
      // extraSubmitData is deliberately NOT reused — solved problems and
      // tracked time are recomputed, which is the point of resubmitting.
      prefill: {
        ...(opts.prefill ?? {}),
        ...(progress?.canvasSubmissionData ?? {}),
      },
      extraSubmitData: opts.extraSubmitData ?? {},
      isResubmission: Boolean(submittedAt),
    });
  });
  actions.appendChild(btn);
  article.appendChild(actions);
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
