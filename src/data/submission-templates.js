// Fill-in templates for Canvas submission bodies.
//
// Mirrors the templates defined in the professor's build/canvas_content.py
// (`_template_md` function). Each assignment type has a corresponding
// `fill*Template({...}) → string` here. The returned string goes into
// `submission[body]` on a Canvas `online_text_entry` POST.
//
// Output is HTML. Canvas renders online_text_entry as HTML and collapses
// whitespace/newlines, so plain-text templates render as one wall of
// text. We emit <p>, <ul>, and <a> to give the submission real structure
// and clickable links.
//
// Design notes:
//   - Pure functions. No fetch, no chrome.*, no DOM. Testable in Vitest.
//   - Missing fields become empty values, not errors. The professor's
//     original template has empty lines by design (student fills them);
//     doing the same lets us auto-submit even when we only know some
//     fields (edge case for retries / partial info).
//   - HTML escapes user-visible strings so a stray "<" or "&" in a
//     problem title doesn't break the page. URLs go through
//     escapeAttr because they land in href attributes.

// ---- HTML helpers ------------------------------------------------------

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(str) {
  // Same as escapeHtml plus quotes, since this lands in href="...".
  return escapeHtml(str).replace(/"/g, "&quot;");
}

// ---- Shared building blocks -------------------------------------------

// Emit "<p><strong>Label:</strong> value</p>". Value gets HTML-escaped.
import { studyPointsBreakdown } from "../lib/study-points.js";
function pLabelValue(label, value) {
  return `<p><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value ?? "")}</p>`;
}

// Emit a linked URL inside a paragraph. If value is empty, emits an
// empty value slot so the reviewer can see the field is unfilled.
function pLabelUrl(label, url) {
  if (!url) return pLabelValue(label, "");
  return (
    `<p><strong>${escapeHtml(label)}:</strong> ` +
    `<a href="${escapeAttr(url)}">${escapeHtml(url)}</a></p>`
  );
}

// ---- Type-specific fillers --------------------------------------------

// Online Assessment.
// Ref: `_template_md(a)` in canvas_content.py, `typ == "oa"`.
export function fillOaTemplate({ attemptNum, acceptedUrls }) {
  const attempt = attemptNum != null ? escapeHtml(String(attemptNum)) : "";
  const urls = Array.isArray(acceptedUrls) ? acceptedUrls : [];
  // Always emit at least three items so the shape matches the
  // professor's template even for shorter OAs.
  const items = Math.max(3, urls.length);
  const listItems = Array.from({ length: items }, (_, i) => {
    const url = urls[i];
    if (!url) return "<li></li>";
    return `<li><a href="${escapeAttr(url)}">${escapeHtml(url)}</a></li>`;
  }).join("");
  return (
    `<p><strong>Attempt you passed (1 / 2 / 3):</strong> ${attempt}</p>` +
    `<p><strong>Accepted-solution URLs for every problem in that attempt:</strong></p>` +
    `<ul>${listItems}</ul>`
  );
}

// Performance Exam. The professor's original template includes a
// "book a time with a TA" banner at the top — omitted here since the
// filled submission is posted AFTER the exam, not before.
// Ref: `_template_md`, `typ == "performance"`.
// No solution link: a TA watches this one happen, and their word plus
// the recorded editor session is better evidence than a URL the student
// pastes in afterwards.
export function fillPerformanceTemplate({
  date,
  workedWith,
  howLong,
  attemptNum,
}) {
  return (
    pLabelValue("Date you did it", date) +
    pLabelValue("Who you worked with (TA / instructor)", workedWith) +
    pLabelValue("How long it took", howLong) +
    pLabelValue("Attempt you passed on", attemptNum)
  );
}

// Live Interview. Same treatment as Performance — no booking banner.
// Ref: `_template_md`, `typ == "live-interview"`.
export function fillLiveInterviewTemplate({
  date,
  howItWent,
  selfRating,
  acceptedUrl,
}) {
  return (
    pLabelValue("Date you did it", date) +
    pLabelValue("How did it go?", howItWent) +
    pLabelValue("Self-rating (1-3)", selfRating) +
    pLabelUrl("Link to your solution", acceptedUrl)
  );
}

// Peer Mock Interview.
// Ref: `_template_md`, `typ in ("peer-mock", "professional-mock")`.
export function fillPeerMockTemplate({ interviewedWith, when, howItWent }) {
  return (
    pLabelValue("Who you interviewed with", interviewedWith) +
    pLabelValue("When", when) +
    pLabelValue("How did it go?", howItWent)
  );
}

// Professional Mock Interview — same shape as peer mock.
export function fillProfessionalMockTemplate({
  interviewedWith,
  when,
  howItWent,
}) {
  return fillPeerMockTemplate({ interviewedWith, when, howItWent });
}

// Instructor Pass/Fail Interview.
// Ref: `_template_md`, `typ == "instructor-interview"`.
export function fillInstructorInterviewTemplate({
  date,
  acceptedUrl,
  howItWent,
}) {
  return (
    pLabelValue("Date you did it", date) +
    pLabelUrl("Link to your passing solution", acceptedUrl) +
    pLabelValue("How did it go?", howItWent)
  );
}

// Connect with Class — 7-item checklist. Each field is a string like
// "Did it!" or a free-form explanation of why not.
// Ref: `_template_md`, `typ == "connect-with-class"`.
export function fillConnectWithClassTemplate({
  joinedTeams,
  updatedPhoto,
  postedIntro,
  reactedToThree,
  dmedClassmate,
  leetcodeProfileUrl,
  networkPlan,
}) {
  const check = (label, value) =>
    pLabelValue(label + " (Did it! / Not yet — why?)", value);
  return (
    check("Joined Teams", joinedTeams) +
    check("Updated my photo", updatedPhoto) +
    check("Posted my intro", postedIntro) +
    check("Reacted to 3 intros", reactedToThree) +
    check("DM'd a classmate for a mock", dmedClassmate) +
    pLabelUrl("My LeetCode profile URL", leetcodeProfileUrl) +
    pLabelValue(
      "How I plan to connect with others and network this semester",
      networkPlan,
    )
  );
}

// Weekly Study.
//
// The professor's rubric (../course/weekly/README.md) is explicit that
// each problem link must be the student's ACCEPTED SUBMISSION, not the
// problem page — a problem URL proves nothing about whether they solved
// it. So solved and unsolved problems are listed separately, and a
// solved problem with no captured submission URL says so rather than
// quietly falling back to the problem page.
//
// `problems`: [{ title, problemUrl, acceptedUrl, tag, solved }]
//   tag is "required" | "in class"; acceptedUrl may be null even when
//   solved (the tracker only captures the last ~20 submissions).
//
// `trackedMs` is the extension's own measure of active time on LeetCode
// during the week, printed next to the self-reported hours so a grader
// can compare the two.
export function fillStudyTemplate({
  problems,
  collabHours,
  collabWithWhom,
  personalHours,
  growthActions,
  taReviewUrl,
  trackedMs,
}) {
  const probs = Array.isArray(problems) ? problems : [];
  const solved = probs.filter((p) => p?.solved);
  const unsolved = probs.filter((p) => !p?.solved);

  const solvedItems = solved.length
    ? solved.map(problemListItem).join("")
    : "<li>(none solved yet)</li>";

  const unsolvedSection = unsolved.length
    ? `<p><strong>Not solved this week (${unsolved.length} of ${probs.length}):</strong></p>` +
      `<ul>${unsolved.map(problemListItem).join("")}</ul>`
    : "";

  const collab =
    collabHours != null || collabWithWhom
      ? `${escapeHtml(String(collabHours ?? ""))} hrs${
          collabWithWhom ? ` (with ${escapeHtml(collabWithWhom)})` : ""
        }`
      : "";

  const breakdown = studyPointsBreakdown({
    collabHours,
    personalHours,
    solvedCount: solved.length,
    totalCount: probs.length,
  });

  return (
    `<p><strong>Solved this week (${solved.length} of ${probs.length}) — accepted-submission URLs:</strong></p>` +
    `<ul>${solvedItems}</ul>` +
    unsolvedSection +
    pLabelValue("Collaborative study", collab) +
    pLabelValue("Personal study", personalHours != null ? `${personalHours} hrs` : "") +
    trackedTimeLine(trackedMs) +
    pLabelValue(
      "For growth I did (mark any: re-timed / re-did without lookups / studied others' solutions / just finished / other)",
      growthActions,
    ) +
    pLabelUrl("TA review request (paste the submission link)", taReviewUrl) +
    pointsSummary(breakdown)
  );
}

function problemListItem(p) {
  const tag = p?.tag ? ` <em>(${escapeHtml(p.tag)})</em>` : "";
  const title = escapeHtml(p?.title ?? "");
  const accepted = p?.acceptedUrl;
  if (accepted) {
    return (
      `<li>${title}${tag} — ` +
      `<a href="${escapeAttr(accepted)}">${escapeHtml(accepted)}</a></li>`
    );
  }
  // Deliberately NOT falling back to the problem URL as if it were a
  // submission. Saying the link is missing is more useful to a grader
  // than a link that looks like proof and isn't.
  const problemUrl = p?.problemUrl;
  const link = problemUrl
    ? ` — <a href="${escapeAttr(problemUrl)}">${escapeHtml(problemUrl)}</a>`
    : "";
  const note = p?.solved
    ? " <em>(solved — no submission link captured; paste it here)</em>"
    : "";
  return `<li>${title}${tag}${link}${note}</li>`;
}

function trackedTimeLine(trackedMs) {
  if (!Number.isFinite(trackedMs) || trackedMs <= 0) return "";
  return pLabelValue(
    "Time on LeetCode measured by the extension this week",
    `${formatTrackedDuration(trackedMs)} of active editing`,
  );
}

function formatTrackedDuration(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// A grader-facing summary so the points can be read off rather than
// recomputed. Explicitly labelled as computed from self-reported hours —
// the extension can count solves and measure editing time, but it can't
// verify that four reported hours of collaborative study happened.
function pointsSummary(breakdown) {
  const rows = breakdown.lines
    .map(
      (line) =>
        `<li>${escapeHtml(line.label)}: <strong>${line.points} / ${line.max}</strong>` +
        ` <em>(${escapeHtml(line.detail)})</em></li>`,
    )
    .join("");
  return (
    `<hr />` +
    `<p><strong>Suggested points: ${breakdown.total} / ${breakdown.max}</strong></p>` +
    `<ul>${rows}</ul>` +
    `<p><em>Computed by CS 393 Buddy from the problems solved and the hours ` +
    `reported above. Hours are self-reported — please adjust if the work ` +
    `behind them doesn't hold up.</em></p>`
  );
}

export function fillEcInterviewReadyTemplate({
  allGreen,
  totalProblemsSolved,
  learned,
}) {
  return (
    pLabelValue("All categories green? (Yes / No)", allGreen) +
    pLabelValue("Total problems solved", totalProblemsSolved) +
    pLabelValue("Anything you learned using the extension", learned)
  );
}

// Real Interview Report N (1..5) — same template for each numbered slot.
export function fillEcRealInterviewReportTemplate({
  where,
  questionTypes,
  experience,
}) {
  return (
    pLabelValue("Where did you interview?", where) +
    pLabelValue("What types of questions were you asked?", questionTypes) +
    pLabelValue(
      "How was your experience? Would you recommend them?",
      experience,
    )
  );
}

// Real Offer Report N (1..3).
export function fillEcRealOfferReportTemplate({
  preparation,
  network,
  tips,
  overFiftyK,
  jobType,
  expectations,
}) {
  return (
    pLabelValue("What did you do to prepare?", preparation) +
    pLabelValue(
      "Who did you network with to get the interview/job?",
      network,
    ) +
    pLabelValue("Tips for others", tips) +
    pLabelValue("Was the offer over 50k/yr?", overFiftyK) +
    pLabelValue("Full-time / Internship / Other", jobType) +
    pLabelValue(
      "Did it meet your expectations? (1 = no … 10 = perfectly)",
      expectations,
    )
  );
}

// Get a Friend an Interview.
export function fillEcFriendInterviewTemplate({
  friendName,
  whereInterviewed,
  howHelped,
}) {
  return (
    pLabelValue("Friend's full name", friendName) +
    pLabelValue("Where they interviewed", whereInterviewed) +
    pLabelValue("How you helped them get the interview", howHelped)
  );
}

// Get a Friend an Offer.
export function fillEcFriendOfferTemplate({
  friendName,
  whereGotOffer,
  howHelped,
}) {
  return (
    pLabelValue("Friend's full name", friendName) +
    pLabelValue("Where they got the offer", whereGotOffer) +
    pLabelValue("How you helped them get the offer", howHelped)
  );
}

// ---- Dispatcher --------------------------------------------------------

// Route by assignment type OR stable id. `type` handles the schedule
// item types (oa, performance, live-interview, peer-mock,
// professional-mock, instructor-interview, connect-with-class, study).
// `assignmentId` handles the standalone assignments (EC items) whose
// template varies by id, not by type. Pass whichever the caller has —
// assignmentId wins when both are present so EC ids route to their
// specific fillers.
//
// Unknown types/ids throw explicitly so missing wiring is loud rather
// than silently submitting an empty body.
export function fillSubmissionTemplate({ type, assignmentId, data }) {
  // Route EC ids first — they share the "extra-credit" category but
  // each has its own template shape.
  if (assignmentId === "ec-interview-ready")
    return fillEcInterviewReadyTemplate(data ?? {});
  if (typeof assignmentId === "string" &&
      assignmentId.startsWith("ec-real-interview-report"))
    return fillEcRealInterviewReportTemplate(data ?? {});
  if (typeof assignmentId === "string" &&
      assignmentId.startsWith("ec-real-offer-report"))
    return fillEcRealOfferReportTemplate(data ?? {});
  if (assignmentId === "ec-friend-interview")
    return fillEcFriendInterviewTemplate(data ?? {});
  if (assignmentId === "ec-friend-offer")
    return fillEcFriendOfferTemplate(data ?? {});
  // Amazing Project items are online_url — no text template to fill.
  // Caller should send `submissionType: "online_url"` with a URL, not
  // hit this function.

  switch (type) {
    case "oa":
      return fillOaTemplate(data ?? {});
    case "performance":
      return fillPerformanceTemplate(data ?? {});
    case "live-interview":
      return fillLiveInterviewTemplate(data ?? {});
    case "peer-mock":
      return fillPeerMockTemplate(data ?? {});
    case "professional-mock":
      return fillProfessionalMockTemplate(data ?? {});
    case "instructor-interview":
      return fillInstructorInterviewTemplate(data ?? {});
    case "connect-with-class":
      return fillConnectWithClassTemplate(data ?? {});
    case "study":
      return fillStudyTemplate(data ?? {});
    default:
      throw new Error(
        `No submission template for type=${type} assignmentId=${assignmentId}`,
      );
  }
}
