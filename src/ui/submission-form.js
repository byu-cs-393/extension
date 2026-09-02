// Shared submission form — modal + schema-driven fields + one-click
// submit to Canvas via the background handler.
//
// Callers:
//   import { openSubmissionForm } from "./submission-form.js";
//   openSubmissionForm({
//     type: "peer-mock",              // schedule item type
//     assignmentId: "peer-mock-w5",   // stable id (from course-data.js)
//     weekNum: 5,                     // optional; recorded on the progress doc
//     netID: "jack684",
//     prefill: { when: "Today" },     // optional — pre-populate any field by name
//     onSubmitted: (result) => { ... },
//   });
//
// Behavior:
//   - Picks the schema for {type, assignmentId} and renders a modal
//     with one <input>/<select>/<textarea> per field.
//   - On Submit: validates required fields, calls fillSubmissionTemplate
//     to produce the HTML body, sends {type: "submitCanvasAssignment", ...}
//     to the background worker, awaits Cloud Function result.
//   - On success: patches students/{netID}/assignmentProgress/{assignmentId}
//     with { canvasSubmittedAt, canvasSubmissionId, type, weekNum? },
//     also patches the local cache so the dashboard re-renders as
//     "submitted" the same tick.
//   - On failure: shows an error banner in the modal, keeps it open so
//     the student can retry.

import { patchDoc } from "../platform/firestore.js";
import { fillSubmissionTemplate } from "../data/submission-templates.js";
import { ASSIGNMENT_PROGRESS_CACHE_KEY } from "../data/assignment-progress.js";
import { describeCanvasError, canvasErrorHint } from "../lib/canvas-error.js";

// ---- Field schemas per assignment ------------------------------------
//
// Field shape:
//   { name, label, type, required?, placeholder?, min?, max?, help?, options? }
//   type: "text" | "date" | "url" | "number" | "textarea" | "select"
//   options: [{value, label}]  — for type: "select"
//
// The `name` MUST match the corresponding fillTemplate arg name so the
// form data can be passed straight through as `data`.

const SCHEMAS_BY_TYPE = {
  performance: {
    title: "Submit Performance Exam to Canvas",
    fields: [
      { name: "date", label: "Date you did it", type: "date", required: true },
      { name: "workedWith", label: "Who you worked with (TA / instructor)", type: "text", required: true, placeholder: "e.g. Jack" },
      { name: "howLong", label: "How long it took", type: "text", required: true, placeholder: "e.g. 12 min" },
      { name: "attemptNum", label: "Attempt you passed on", type: "number", required: true, min: 1 },
      { name: "acceptedUrl", label: "Link to your passing solution", type: "url", required: true, placeholder: "https://leetcode.com/problems/..." },
    ],
  },
  "live-interview": {
    title: "Submit Live Interview to Canvas",
    fields: [
      { name: "date", label: "Date you did it", type: "date", required: true },
      { name: "howItWent", label: "How did it go?", type: "textarea", required: true, placeholder: "A few sentences on how the interview went…" },
      { name: "selfRating", label: "Self-rating (1–3)", type: "select", required: true, options: [
          { value: "1", label: "1 — Showed up, went poorly" },
          { value: "2", label: "2 — Got to a solution" },
          { value: "3", label: "3 — Collaborated well, want to hire" },
        ] },
      { name: "acceptedUrl", label: "Link to your solution", type: "url", required: true },
    ],
  },
  "peer-mock": {
    title: "Submit Peer Mock Interview to Canvas",
    fields: [
      { name: "interviewedWith", label: "Who you interviewed with", type: "text", required: true, placeholder: "Classmate's name or netID" },
      { name: "when", label: "When", type: "text", required: true, placeholder: "e.g. Wed 4pm" },
      { name: "howItWent", label: "How did it go?", type: "textarea", required: true },
    ],
  },
  "professional-mock": {
    title: "Submit Professional Mock Interview to Canvas",
    fields: [
      { name: "interviewedWith", label: "Who you interviewed with", type: "text", required: true, placeholder: "Name + company" },
      { name: "when", label: "When", type: "text", required: true, placeholder: "e.g. Nov 20, 2pm" },
      { name: "howItWent", label: "How did it go?", type: "textarea", required: true },
    ],
  },
  "instructor-interview": {
    title: "Submit Instructor Pass/Fail Interview to Canvas",
    fields: [
      { name: "date", label: "Date you did it", type: "date", required: true },
      { name: "acceptedUrl", label: "Link to your passing solution", type: "url", required: true },
      { name: "howItWent", label: "How did it go?", type: "textarea", required: true },
    ],
  },
  "connect-with-class": {
    title: "Submit Connect with Class to Canvas",
    fields: [
      { name: "joinedTeams", label: "Joined Teams", type: "text", required: true, placeholder: "Did it! / Not yet — why?" },
      { name: "updatedPhoto", label: "Updated my photo", type: "text", required: true, placeholder: "Did it! / Not yet — why?" },
      { name: "postedIntro", label: "Posted my intro", type: "text", required: true, placeholder: "Did it! / Not yet — why?" },
      { name: "reactedToThree", label: "Reacted to 3 intros", type: "text", required: true, placeholder: "Did it! / Not yet — why?" },
      { name: "dmedClassmate", label: "DM'd a classmate for a mock", type: "text", required: true, placeholder: "Did it! / Not yet — why?" },
      { name: "leetcodeProfileUrl", label: "My LeetCode profile URL", type: "url", required: true, placeholder: "https://leetcode.com/yourprofile/" },
      { name: "networkPlan", label: "How I plan to connect and network this semester", type: "textarea", required: true },
    ],
  },
  study: {
    title: "Submit Weekly Study to Canvas",
    fields: [
      // NOTE: problems[] is pre-filled by the caller from course.json;
      // this form only collects hours + growth. The problems list gets
      // merged into `data` at submit time.
      { name: "collabHours", label: "Collaborative study hours", type: "number", required: true, min: 0, step: 0.5 },
      { name: "collabWithWhom", label: "Studied with whom?", type: "text", placeholder: "(optional)" },
      { name: "personalHours", label: "Personal study hours", type: "number", required: true, min: 0, step: 0.5 },
      { name: "growthActions", label: "For growth I did (mark any)", type: "textarea", placeholder: "re-timed / re-did without lookups / studied others' solutions / just finished / other:" },
      { name: "taReviewUrl", label: "Want a TA to review a solution? Paste the submission link (optional)", type: "url" },
    ],
  },
};

// Schemas keyed by exact stable assignmentId (EC items whose template
// varies per-id, not per-type).
const SCHEMAS_BY_ASSIGNMENT_ID = {
  "ec-interview-ready": {
    title: "Submit Interview Ready extension to Canvas",
    fields: [
      { name: "allGreen", label: "All categories green?", type: "select", required: true, options: [
          { value: "Yes", label: "Yes" },
          { value: "No", label: "No" },
        ] },
      { name: "totalProblemsSolved", label: "Total problems solved", type: "number", required: true, min: 0 },
      { name: "learned", label: "Anything you learned using the extension", type: "textarea" },
    ],
  },
  "ec-real-interview-report": {
    title: "Submit Real Interview Report to Canvas",
    fields: [
      { name: "where", label: "Where did you interview?", type: "text", required: true },
      { name: "questionTypes", label: "What types of questions were you asked?", type: "textarea", required: true, placeholder: "Graphs, matrix, DP, etc." },
      { name: "experience", label: "How was your experience? Would you recommend them?", type: "textarea", required: true },
    ],
  },
  "ec-real-offer-report": {
    title: "Submit Real Offer Report to Canvas",
    fields: [
      { name: "preparation", label: "What did you do to prepare?", type: "textarea", required: true },
      { name: "network", label: "Who did you network with to get the interview/job?", type: "textarea", required: true },
      { name: "tips", label: "Tips for others", type: "textarea", required: true },
      { name: "overFiftyK", label: "Was the offer over $50k/yr?", type: "select", required: true, options: [
          { value: "Yes", label: "Yes" },
          { value: "No", label: "No" },
        ] },
      { name: "jobType", label: "Job type", type: "select", required: true, options: [
          { value: "Full-time", label: "Full-time" },
          { value: "Internship", label: "Internship" },
          { value: "Other", label: "Other" },
        ] },
      { name: "expectations", label: "Did it meet your expectations? (1 = no, 10 = perfectly)", type: "number", required: true, min: 1, max: 10 },
    ],
  },
  "ec-friend-interview": {
    title: "Submit 'Get a Friend an Interview' to Canvas",
    fields: [
      { name: "friendName", label: "Friend's full name", type: "text", required: true },
      { name: "whereInterviewed", label: "Where they interviewed", type: "text", required: true },
      { name: "howHelped", label: "How you helped them get the interview", type: "textarea", required: true },
    ],
  },
  "ec-friend-offer": {
    title: "Submit 'Get a Friend an Offer' to Canvas",
    fields: [
      { name: "friendName", label: "Friend's full name", type: "text", required: true },
      { name: "whereGotOffer", label: "Where they got the offer", type: "text", required: true },
      { name: "howHelped", label: "How you helped them get the offer", type: "textarea", required: true },
    ],
  },
  // Amazing Projects use online_url — schema is just a single URL field
  // and the submission goes as submissionType: "online_url".
  "ec-amazing-project-community": {
    title: "Submit Amazing Project (Community/World) to Canvas",
    submissionType: "online_url",
    fields: [
      { name: "url", label: "Public repo URL", type: "url", required: true, placeholder: "https://github.com/yourname/project" },
    ],
  },
  "ec-amazing-project-personal": {
    title: "Submit Amazing Project (Personal) to Canvas",
    submissionType: "online_url",
    fields: [
      { name: "url", label: "Public repo URL", type: "url", required: true, placeholder: "https://github.com/yourname/project" },
    ],
  },
  "ec-amazing-project-paid": {
    title: "Submit Amazing Project (Earns Money) to Canvas",
    submissionType: "online_url",
    fields: [
      { name: "url", label: "Public URL (proof of payment)", type: "url", required: true },
    ],
  },
};

// Numbered EC ids (e.g. "ec-real-interview-report-1") share the base
// schema — strip the trailing `-N` to look up.
function resolveSchema({ type, assignmentId }) {
  if (assignmentId && SCHEMAS_BY_ASSIGNMENT_ID[assignmentId]) {
    return SCHEMAS_BY_ASSIGNMENT_ID[assignmentId];
  }
  if (assignmentId) {
    const base = assignmentId.replace(/-\d+$/, ""); // "ec-real-offer-report-2" → "ec-real-offer-report"
    if (SCHEMAS_BY_ASSIGNMENT_ID[base]) return SCHEMAS_BY_ASSIGNMENT_ID[base];
  }
  if (type && SCHEMAS_BY_TYPE[type]) return SCHEMAS_BY_TYPE[type];
  return null;
}

// ---- Modal UI ---------------------------------------------------------

let mountedModal = null;

// Public API: open the modal for a specific submission.
// Returns immediately; the submit + cleanup happens asynchronously.
export function openSubmissionForm({
  type,
  assignmentId,
  weekNum,
  netID,
  prefill = {},
  extraSubmitData = {}, // fields to add to `data` at submit time that aren't in the form (e.g., study.problems[])
  isResubmission = false,
  onSubmitted,
}) {
  const schema = resolveSchema({ type, assignmentId });
  if (!schema) {
    alert(`No submission form defined for ${assignmentId ?? type}`);
    return;
  }
  if (mountedModal) closeModal();
  mountedModal = buildModal({
    schema,
    type,
    assignmentId,
    weekNum,
    netID,
    prefill,
    extraSubmitData,
    isResubmission,
    onSubmitted,
  });
  document.body.appendChild(mountedModal);
  // Focus the first field on next tick so the browser has laid the modal out.
  setTimeout(() => {
    mountedModal?.querySelector("input, textarea, select")?.focus();
  }, 0);
}

function closeModal() {
  if (!mountedModal) return;
  mountedModal.remove();
  mountedModal = null;
}

function buildModal(opts) {
  const { schema } = opts;

  const overlay = el("div", { className: "cs393-submit-overlay" });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeModal();
  });
  document.addEventListener("keydown", escToClose);

  const panel = el("div", { className: "cs393-submit-panel", role: "dialog", "aria-modal": "true" });
  overlay.appendChild(panel);

  const title = el("h2", { className: "cs393-submit-title" }, schema.title);
  // Resubmitting is allowed, but the student should know what it does:
  // Canvas keeps every attempt and grades the newest, so this replaces
  // the previous one rather than adding to it.
  const resubmitNote = opts.isResubmission
    ? el(
        "p",
        { className: "cs393-submit-resubmit-note" },
        "You've already submitted this. Sending again replaces your previous " +
          "submission for grading — your answers below are filled in from last time.",
      )
    : null;
  panel.appendChild(title);
  if (resubmitNote) panel.appendChild(resubmitNote);

  const errorBanner = el("div", { className: "cs393-submit-error", hidden: true });
  panel.appendChild(errorBanner);

  const form = el("form", { className: "cs393-submit-form" });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    handleSubmit(opts, form, errorBanner, submitBtn);
  });
  panel.appendChild(form);

  for (const field of schema.fields) {
    form.appendChild(buildFieldRow(field, opts.prefill?.[field.name]));
  }

  const actions = el("div", { className: "cs393-submit-actions" });
  const cancelBtn = el("button", { type: "button", className: "cs393-btn-secondary" }, "Cancel");
  cancelBtn.addEventListener("click", closeModal);
  const submitBtn = el(
    "button",
    { type: "submit", className: "cs393-btn-primary" },
    opts.isResubmission ? "Replace submission" : "Submit to Canvas",
  );
  actions.append(cancelBtn, submitBtn);
  form.appendChild(actions);

  // Inject styles once — the modal is self-contained so it doesn't
  // depend on dashboard.css. Cheaper than plumbing through another CSS file.
  ensureStyles();

  return overlay;
}

function buildFieldRow(field, prefillValue) {
  const row = el("div", { className: "cs393-submit-field" });
  const labelId = `cs393-f-${field.name}`;
  const label = el("label", { htmlFor: labelId, className: "cs393-submit-label" }, field.label + (field.required ? " *" : ""));
  row.appendChild(label);

  let input;
  if (field.type === "textarea") {
    input = el("textarea", { id: labelId, name: field.name, className: "cs393-submit-input", rows: 3 });
    if (field.placeholder) input.placeholder = field.placeholder;
  } else if (field.type === "select") {
    input = el("select", { id: labelId, name: field.name, className: "cs393-submit-input" });
    // Empty option so nothing is preselected — students have to actively pick.
    input.appendChild(el("option", { value: "" }, "— pick one —"));
    for (const opt of field.options ?? []) {
      input.appendChild(el("option", { value: opt.value }, opt.label));
    }
  } else {
    input = el("input", {
      id: labelId,
      name: field.name,
      type: field.type === "url" ? "url" : field.type === "date" ? "date" : field.type === "number" ? "number" : "text",
      className: "cs393-submit-input",
    });
    if (field.placeholder) input.placeholder = field.placeholder;
    if (field.min != null) input.min = String(field.min);
    if (field.max != null) input.max = String(field.max);
    if (field.step != null) input.step = String(field.step);
  }
  if (field.required) input.required = true;
  if (prefillValue != null) input.value = String(prefillValue);
  row.appendChild(input);

  if (field.help) {
    row.appendChild(el("div", { className: "cs393-submit-help" }, field.help));
  }
  return row;
}

// Sends one submission to Canvas and records it on assignmentProgress.
//
// Shared by the modal and by the automatic submissions the dashboard
// makes for TA-approved exams, so both take exactly the same path — the
// idempotency marker, the submit count and the stored field values all
// behave identically however the submission was triggered.
//
// Returns { ok, result }. Never throws for a Canvas-side failure; the
// caller decides how to surface it.
export async function sendCanvasSubmission({
  type,
  assignmentId,
  weekNum,
  netID,
  data,
  fieldValues = data,
  submissionType = "online_text_entry",
}) {
  let payload;
  if (submissionType === "online_url") {
    payload = { assignmentId, submissionType, url: data.url };
  } else {
    payload = {
      assignmentId,
      submissionType,
      body: fillSubmissionTemplate({ type, assignmentId, data }),
    };
  }

  const result = await new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: "submitCanvasAssignment", payload },
      (r) => resolve(r),
    );
  });

  if (result?.outcome !== "submitted") {
    console.error("[CS 393 Buddy] Canvas submit failed:", result);
    return { ok: false, result };
  }

  const submittedAt = Date.now();
  const progressType = progressTypeFor({ type, assignmentId });
  try {
    // Read the cached doc BEFORE writing, both to carry forward fields
    // this caller doesn't own (signoff status) and to know how many times
    // this has been submitted already.
    const cached = await chrome.storage.local.get(ASSIGNMENT_PROGRESS_CACHE_KEY);
    const bundle = cached[ASSIGNMENT_PROGRESS_CACHE_KEY] ?? { progress: {} };
    const existing = bundle.progress?.[assignmentId] ?? {};
    const priorCount = Number.isFinite(existing.canvasSubmitCount)
      ? existing.canvasSubmitCount
      : existing.canvasSubmittedAt
        ? 1
        : 0;

    const newProgress = {
      assignmentId,
      type: progressType,
      canvasSubmittedAt: submittedAt,
      canvasSubmissionId: result.canvasSubmissionId ?? null,
      canvasSubmitCount: priorCount + 1,
      // What was entered, so a resubmission can prefill from it. Not the
      // rendered body — that's Canvas's copy, and storing HTML here would
      // only go stale against the template.
      canvasSubmissionData: fieldValues,
      ...(Number.isFinite(weekNum) ? { weekNum } : {}),
    };

    await patchDoc(`students/${netID}/assignmentProgress/${assignmentId}`, newProgress);
    bundle.progress = {
      ...(bundle.progress ?? {}),
      [assignmentId]: { ...existing, ...newProgress },
    };
    bundle.syncedAt = Date.now();
    await chrome.storage.local.set({ [ASSIGNMENT_PROGRESS_CACHE_KEY]: bundle });
  } catch (patchErr) {
    // Non-fatal — Canvas has the submission. Log for visibility.
    console.error("[CS 393 Buddy] canvasSubmittedAt patch failed:", patchErr);
  }

  return { ok: true, result };
}

async function handleSubmit(opts, form, errorBanner, submitBtn) {
  const { type, assignmentId, weekNum, netID, extraSubmitData, onSubmitted } = opts;
  const schema = resolveSchema({ type, assignmentId });
  errorBanner.hidden = true;
  submitBtn.disabled = true;
  const originalLabel = submitBtn.textContent;
  submitBtn.textContent = "Submitting…";
  try {
    // Collect form values. fieldValues is what the student typed;
    // extraSubmitData is computed (solved problems, tracked time) and is
    // deliberately kept separate — only the typed values are worth
    // storing to prefill a resubmission, and the computed ones must be
    // recalculated each time.
    const fieldValues = {};
    const formData = new FormData(form);
    for (const field of schema.fields) {
      const raw = formData.get(field.name);
      // Numbers come out as strings — coerce.
      if (field.type === "number" && raw != null && raw !== "") {
        fieldValues[field.name] = Number(raw);
      } else {
        fieldValues[field.name] = raw ?? "";
      }
    }
    const data = { ...extraSubmitData, ...fieldValues };

    const outcome = await sendCanvasSubmission({
      type,
      assignmentId,
      weekNum,
      netID,
      data,
      fieldValues,
      submissionType: schema.submissionType ?? "online_text_entry",
    });

    if (!outcome.ok) {
      const hint = canvasErrorHint(outcome.result);
      showError(
        errorBanner,
        `Couldn't submit to Canvas: ${describeCanvasError(outcome.result)}` +
          (hint ? `\n\n${hint}` : ""),
      );
      submitBtn.disabled = false;
      submitBtn.textContent = originalLabel;
      return;
    }
    const result = outcome.result;

    onSubmitted?.(result);
    closeModal();
  } catch (err) {
    console.error("[CS 393 Buddy] submission form threw:", err);
    showError(errorBanner, err.message ?? String(err));
    submitBtn.disabled = false;
    submitBtn.textContent = originalLabel;
  }
}

// Maps schema key -> the assignmentProgress `type` field. EC ids all
// use `type: "extra-credit"` since the collection's type discriminator
// doesn't need to be per-id (assignmentId already carries that).
function progressTypeFor({ type, assignmentId }) {
  if (assignmentId?.startsWith("ec-")) return "extra-credit";
  return type;
}

// ---- Helpers ----------------------------------------------------------

function el(tag, attrs = {}, text = null) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "className") node.className = v;
    else if (k === "htmlFor") node.htmlFor = v;
    else if (k === "hidden") node.hidden = v;
    else if (v == null) continue;
    else if (k in node) node[k] = v;
    else node.setAttribute(k, String(v));
  }
  if (text != null) node.textContent = text;
  return node;
}

function showError(bannerEl, message) {
  bannerEl.textContent = message;
  bannerEl.hidden = false;
}

function escToClose(e) {
  if (e.key !== "Escape") return;
  if (!mountedModal) return;
  closeModal();
  document.removeEventListener("keydown", escToClose);
}

let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    .cs393-submit-overlay {
      position: fixed; inset: 0; z-index: 2147483000;
      background: rgba(15, 23, 42, 0.55);
      display: flex; align-items: center; justify-content: center;
      padding: 24px;
    }
    .cs393-submit-panel {
      background: white; color: #0f172a;
      border-radius: 10px;
      max-width: 560px; width: 100%;
      max-height: 90vh; overflow-y: auto;
      padding: 24px 28px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.35);
      font: 14px/1.4 system-ui, -apple-system, sans-serif;
    }
    .cs393-submit-resubmit-note {
      margin: 0 0 12px 0;
      padding: 8px 10px;
      background: #fffbeb;
      border-left: 3px solid #f59e0b;
      border-radius: 0 6px 6px 0;
      font-size: 13px;
      line-height: 1.5;
      color: #92400e;
    }
    .cs393-submit-title {
      margin: 0 0 16px; font-size: 18px; font-weight: 600;
    }
    .cs393-submit-error {
      background: #fee2e2; border: 1px solid #fca5a5; color: #991b1b;
      padding: 8px 12px; border-radius: 6px; margin-bottom: 12px;
    }
    .cs393-submit-form { display: flex; flex-direction: column; gap: 12px; }
    .cs393-submit-field { display: flex; flex-direction: column; gap: 4px; }
    .cs393-submit-label { font-weight: 500; font-size: 13px; }
    .cs393-submit-input {
      font: inherit; padding: 6px 8px;
      border: 1px solid #cbd5e1; border-radius: 6px;
      background: white; color: inherit;
    }
    .cs393-submit-input:focus { outline: 2px solid #3b82f6; outline-offset: -1px; }
    textarea.cs393-submit-input { resize: vertical; min-height: 60px; }
    .cs393-submit-help { font-size: 12px; color: #64748b; }
    .cs393-submit-actions {
      display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px;
    }
    .cs393-btn-primary, .cs393-btn-secondary {
      font: inherit; padding: 8px 14px; border-radius: 6px; cursor: pointer;
      border: 1px solid transparent;
    }
    .cs393-btn-primary {
      background: #2563eb; color: white; border-color: #2563eb;
    }
    .cs393-btn-primary:disabled { opacity: 0.6; cursor: wait; }
    .cs393-btn-secondary {
      background: white; color: #0f172a; border-color: #cbd5e1;
    }
    @media (prefers-color-scheme: dark) {
      .cs393-submit-panel {
        background: #1e293b; color: #f1f5f9;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.65);
      }
      .cs393-submit-input {
        background: #0f172a; border-color: #334155; color: inherit;
      }
      .cs393-submit-help { color: #94a3b8; }
      .cs393-submit-error {
        background: #7f1d1d; border-color: #991b1b; color: #fecaca;
      }
      .cs393-btn-secondary { background: #0f172a; color: #f1f5f9; border-color: #334155; }
    }
  `;
  document.head.appendChild(style);
}
