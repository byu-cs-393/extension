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
export function fillPerformanceTemplate({
  date,
  workedWith,
  howLong,
  attemptNum,
  acceptedUrl,
}) {
  return (
    pLabelValue("Date you did it", date) +
    pLabelValue("Who you worked with (TA / instructor)", workedWith) +
    pLabelValue("How long it took", howLong) +
    pLabelValue("Attempt you passed on", attemptNum) +
    pLabelUrl("Link to your passing solution", acceptedUrl)
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

// Weekly Study. Per-week — the professor's build injects
// `_weekly = (required, inclass)` at render time, so we take those as
// params here. `problems` param: array of {url, tag} where tag is
// "required" | "in class". The tag pattern matches the professor's
// output of "  - {url} (required): " lines.
// Ref: `_template_md`, `typ == "study"`.
export function fillStudyTemplate({
  problems,
  collabHours,
  collabWithWhom,
  personalHours,
  growthActions,
  taReviewUrl,
}) {
  const probs = Array.isArray(problems) ? problems : [];
  const problemItems = probs.length
    ? probs
        .map((p) => {
          const tag = p?.tag ? ` (${escapeHtml(p.tag)})` : "";
          const url = p?.url;
          if (!url) return `<li>${escapeHtml(p?.title ?? "")}${tag}</li>`;
          return (
            `<li><a href="${escapeAttr(url)}">${escapeHtml(url)}</a>${tag}</li>`
          );
        })
        .join("")
    : "<li>(none assigned this week)</li>";
  const collab =
    collabHours != null || collabWithWhom
      ? `${escapeHtml(String(collabHours ?? ""))} hrs${
          collabWithWhom ? ` (with ${escapeHtml(collabWithWhom)})` : ""
        }`
      : "";
  return (
    `<p><strong>Problems (accepted-submission URLs):</strong></p>` +
    `<ul>${problemItems}</ul>` +
    pLabelValue("Collaborative study", collab) +
    pLabelValue("Personal study", personalHours != null ? `${personalHours} hrs` : "") +
    pLabelValue(
      "For growth I did (mark any: re-timed / re-did without lookups / studied others' solutions / just finished / other)",
      growthActions,
    ) +
    pLabelUrl("TA review request (paste the submission link)", taReviewUrl)
  );
}

// ---- Extra credit fillers ---------------------------------------------
//
// Professor's original templates include "post this in the Teams channel"
// notes on some EC items — omitted here since those directives are for
// the empty template, not the submission.

// Interview Ready Chrome Extension.
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
