// Read-only accessor layer over the bundled course.json (the professor's
// data/course.json vendored via scripts/vendor-course.js). Every extension
// page that needs to know the STRUCTURE of the course goes through here.
//
// Per-student progress + solves still live in Firestore. This module is
// only about the course syllabus/schedule/assignment catalog.
//
// Design notes:
//   - loadCourse() lazy-fetches once and caches the promise.
//   - Every accessor is async; first call triggers the fetch, subsequent
//     calls return the cached resolved value.
//   - Callers that want the raw JSON can call loadCourse() directly.
//   - getCardsForWeek(n) is the "normalized view" the dashboard/course
//     pages iterate over. Everything else is a thin wrapper for
//     one-off lookups (getTopic, getOA, etc.).

const COURSE_JSON_URL = chrome.runtime.getURL("course.json");

let coursePromise = null;

export async function loadCourse() {
  if (!coursePromise) {
    coursePromise = fetch(COURSE_JSON_URL).then((response) => {
      if (!response.ok) {
        throw new Error(`course.json fetch failed: ${response.status}`);
      }
      return response.json();
    });
  }
  return coursePromise;
}

// ---- Top-level metadata ------------------------------------------------

export async function getCourseMeta() {
  const c = await loadCourse();
  return c.course;
}

export async function getGrading() {
  const c = await loadCourse();
  return c.grading;
}

export async function getPoints() {
  const c = await loadCourse();
  return c.points;
}

export async function getCanvasConfig() {
  const c = await loadCourse();
  return c.canvas;
}

// ---- Topics ------------------------------------------------------------

export async function getTopics() {
  const c = await loadCourse();
  return c.topics;
}

export async function getTopic(id) {
  const topics = await getTopics();
  return topics.find((t) => t.id === id) ?? null;
}

// ---- Schedule ----------------------------------------------------------

export async function getSchedule() {
  const c = await loadCourse();
  return c.schedule;
}

// Returns the schedule entry for a numeric week, or null. The `finals`
// sentinel entry (which has an `id` but no `week` number) is excluded
// from numeric lookups; use getScheduleById for that.
export async function getScheduleForWeek(n) {
  const schedule = await getSchedule();
  return schedule.find((s) => s.week === n) ?? null;
}

export async function getScheduleById(id) {
  const schedule = await getSchedule();
  return schedule.find((s) => s.id === id) ?? null;
}

// ---- Weeks (problem lists + objectives) --------------------------------

export async function getAllWeeks() {
  const c = await loadCourse();
  return c.weeks;
}

export async function getWeek(n) {
  const weeks = await getAllWeeks();
  return weeks.find((w) => w.week === n) ?? null;
}

// ---- Assessments -------------------------------------------------------

export async function getOAs() {
  const c = await loadCourse();
  return c.oas;
}

export async function getOA(topic) {
  const oas = await getOAs();
  return oas.find((oa) => oa.topic === topic) ?? null;
}

export async function getPerformanceExams() {
  const c = await loadCourse();
  return c.performance;
}

export async function getPerformanceExam(topic) {
  const perfs = await getPerformanceExams();
  return perfs.find((p) => p.topic === topic) ?? null;
}

export async function getPeerMockConfig() {
  const c = await loadCourse();
  return c.peerMock;
}

export async function getLiveInterviewConfig() {
  const c = await loadCourse();
  return c.liveInterview;
}

export async function getProfessionalMockConfig() {
  const c = await loadCourse();
  return c.professionalMock;
}

export async function getFinalConfig() {
  const c = await loadCourse();
  return c.final;
}

// ---- Standalone assignments (connect-with-class, instructor-interview,
//      final, EC items) --------------------------------------------------

export async function getAssignments() {
  const c = await loadCourse();
  return c.assignments;
}

export async function getAssignmentById(id) {
  const assignments = await getAssignments();
  return assignments.find((a) => a.id === id) ?? null;
}

// ---- ID derivation for schedule items ----------------------------------
//
// Each `schedule[N].performance[]` entry has a `type` but not always an
// `id`. Callers that want the stable ID (to map to Canvas via
// deploy.fall-2026.json, or to look up per-student progress) go through
// this. Returns null for schedule items that don't map to a gradeable
// assignment (e.g. reminders).

export function deriveScheduleItemId(item, weekNum) {
  if (!item || typeof item !== "object") return null;
  // Refs point at a standalone assignment by id directly.
  if (item.ref) return item.ref;
  switch (item.type) {
    case "peer-mock":
      return `peer-mock-w${weekNum}`;
    case "oa":
      return item.topic ? `oa-${item.topic}` : null;
    case "performance":
      return item.topic ? `perf-${item.topic}` : null;
    case "live-interview":
      return item.index ? `live-${item.index}` : null;
    case "professional-mock":
      return "professional-mock";
    case "final":
      return "final";
    default:
      return null;
  }
}

// The Weekly Study assignment id follows a fixed pattern.
export function studyAssignmentIdForWeek(weekNum) {
  return `study-w${weekNum}`;
}

// ---- Date parsing ------------------------------------------------------
//
// course.json schedule dates are human strings like "Sep 7–12",
// "Nov 30–Dec 5", or "Nov 23–24". We parse to local-time epoch ms
// windows (startMs inclusive, endMs exclusive) so the dashboard can
// classify past/current/future and filter solves by week window.
//
// Year comes from course.term ("Fall 2026"). We hardcode the parse to
// 2026 to keep this synchronous; if the term ever changes, update
// SEMESTER_YEAR here.

const SEMESTER_YEAR = 2026;

const MONTHS = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

export function parseScheduleDates(str) {
  if (typeof str !== "string") return null;
  // "MMM D–MMM D" (spans a month boundary; check FIRST so it doesn't
  // fall through to the simpler single-month pattern).
  let m = str.match(/^(\w{3})\s+(\d{1,2})\s*[–-]\s*(\w{3})\s+(\d{1,2})/);
  if (m) {
    const sm = MONTHS[m[1]];
    const em = MONTHS[m[3]];
    if (sm == null || em == null) return null;
    return {
      startMs: new Date(SEMESTER_YEAR, sm, +m[2], 0, 0, 0).getTime(),
      endMs: new Date(SEMESTER_YEAR, em, +m[4] + 1, 0, 0, 0).getTime(),
    };
  }
  // "MMM D–D" (single month).
  m = str.match(/^(\w{3})\s+(\d{1,2})\s*[–-]\s*(\d{1,2})/);
  if (m) {
    const mo = MONTHS[m[1]];
    if (mo == null) return null;
    return {
      startMs: new Date(SEMESTER_YEAR, mo, +m[2], 0, 0, 0).getTime(),
      endMs: new Date(SEMESTER_YEAR, mo, +m[3] + 1, 0, 0, 0).getTime(),
    };
  }
  // Finals entry: "Thu Dec 17, 7–10 am" (single date).
  m = str.match(/(\w{3})\s+(\d{1,2}),/);
  if (m) {
    const mo = MONTHS[m[1]];
    if (mo == null) return null;
    return {
      startMs: new Date(SEMESTER_YEAR, mo, +m[2], 0, 0, 0).getTime(),
      endMs: new Date(SEMESTER_YEAR, mo, +m[2] + 1, 0, 0, 0).getTime(),
    };
  }
  return null;
}

// "past" | "current" | "future" relative to now. Cards blob must include
// startMs / endMs (getCardsForWeek fills these).
export function classifyWeek(cards, now = Date.now()) {
  if (!cards || cards.startMs == null || cards.endMs == null) return "future";
  if (cards.endMs <= now) return "past";
  if (cards.startMs > now) return "future";
  return "current";
}

// Set of LeetCode slugs solved inside this week's window.
export function solvedSlugsInWeek(cards, solvesBundle) {
  const solves = solvesBundle?.solves ?? {};
  if (!cards || cards.startMs == null || cards.endMs == null) return new Set();
  return new Set(
    Object.entries(solves)
      .filter(([, ts]) => ts >= cards.startMs && ts < cards.endMs)
      .map(([slug]) => slug),
  );
}

// All numeric-week cards blobs where the week has started (past + current),
// newest first. Skips future weeks and the special `finals` entry.
export async function getVisibleWeeks(now = Date.now()) {
  const schedule = await getSchedule();
  const numericWeeks = schedule.filter((s) => typeof s.week === "number");
  const all = await Promise.all(numericWeeks.map((s) => getCardsForWeek(s.week)));
  return all
    .filter((c) => c && c.startMs != null && c.startMs <= now)
    .sort((a, b) => b.week - a.week);
}

// All numeric-week cards blobs regardless of when they start. Used by the
// full-course page which shows past + current + future. Skips the special
// `finals` sentinel entry (which has an `id` but no numeric week).
export async function getAllScheduleCards() {
  const schedule = await getSchedule();
  const numericWeeks = schedule.filter((s) => typeof s.week === "number");
  const all = await Promise.all(numericWeeks.map((s) => getCardsForWeek(s.week)));
  return all.filter(Boolean);
}

// Cards blob for whichever week is currently in progress, or null if
// no numeric week contains `now`. Used by the popup for its
// "current week" one-line summary.
export async function getCurrentWeekCards(now = Date.now()) {
  const schedule = await getSchedule();
  for (const s of schedule) {
    if (typeof s.week !== "number") continue;
    const dr = parseScheduleDates(s.dates);
    if (dr && dr.startMs <= now && now < dr.endMs) {
      return getCardsForWeek(s.week);
    }
  }
  return null;
}

// First trackable placement problem for the given week that this student
// has NOT yet solved during the week window. Null if everything is done
// (or there's nothing trackable). Used by the popup to suggest a
// "next problem" to open on LeetCode.
export function firstUnsolvedProblem(cards, solvesBundle) {
  if (!cards) return null;
  const problems = flattenPlacementsToProblems(cards.placements);
  const solved = solvedSlugsInWeek(cards, solvesBundle);
  return problems.find((p) => !solved.has(p.slug)) ?? null;
}

// ---- OA translation for the runtime renderer --------------------------
//
// course.json OA shape ({n, desc, problems:[{name,url,notes?}]}) differs
// from the shape the OA runtime in third-card.js + oa-session.js expects
// ({timeLimitMin, requiredSolves, helpAllowed, problems:[{slug,title,note?}]}).
// This translator bridges the two so the existing OA card + timer +
// auto-pass logic keeps working without modification.
//
// timeLimitMin / requiredSolves / helpAllowed are currently ABSENT from
// course.json — defaulted to null / null / false, which the renderer
// interprets as "no time limit; solve all problems; solo." Enriching
// these is a later pass.

const LEETCODE_SLUG_RE = /^https:\/\/leetcode\.com\/problems\/([^/?#]+)/;

function extractLeetcodeSlug(url) {
  if (typeof url !== "string") return null;
  const m = url.match(LEETCODE_SLUG_RE);
  return m ? m[1] : null;
}

export function translateOaToRuntimeShape(oa) {
  if (!oa) return null;
  return {
    type: "onlineAssessment",
    topic: oa.topic,
    attempts: (oa.attempts ?? []).map((a) => ({
      timeLimitMin: null,
      requiredSolves: null,
      helpAllowed: false,
      desc: a.desc,
      problems: (a.problems ?? [])
        .map((p) => ({
          slug: extractLeetcodeSlug(p.url),
          title: p.name,
          note: p.notes,
        }))
        .filter((p) => p.slug),
    })),
  };
}

// Convenience: given a topic id, returns the runtime-shape OA for that
// topic, or null.
export async function getOaRuntimeShape(topic) {
  const oa = await getOA(topic);
  return translateOaToRuntimeShape(oa);
}

// Flattens weekly placements into a single list of "trackable problems"
// (those with a parseable LeetCode slug). Used by the dashboard's
// Recommended-problems card to compute solved/total against the
// student's solvedProblems map. Non-LeetCode entries (readings, free-
// form notes) are dropped — they aren't auto-trackable.
export function flattenPlacementsToProblems(placements) {
  const out = [];
  const seen = new Set();
  for (const bucket of Object.values(placements ?? {})) {
    if (!Array.isArray(bucket)) continue;
    for (const item of bucket) {
      const slug = extractLeetcodeSlug(item?.url);
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      out.push({
        slug,
        title: item.name ?? slug,
        tag: item.tag ?? null,
        notes: item.notes ?? null,
      });
    }
  }
  return out;
}

// ---- The money function: getCardsForWeek(n) ---------------------------
//
// Returns a normalized view of everything the dashboard needs to render
// for week N. Consolidates the split between `schedule[N]` (what
// assessments happen when) and `weeks[N]` (the problem-list / objectives
// content) into a single blob the UI can iterate over without knowing
// the shape of course.json.
//
// Shape:
//   {
//     week: number,
//     dates: string,             // e.g. "Sep 7–12"
//     topic: {id,label,short}|null,
//     isHalfWeek, isThanksgiving, isReview: boolean,
//     hasStudy: boolean,         // whether a Weekly Study assignment exists
//     studyAssignmentId: string|null,   // e.g. "study-w2"
//     title: string,             // human title from weeks[N] (may be undefined)
//     objectives: string[],
//     placements: {...},         // pass-through from weeks[N]
//     performanceItems: [        // resolved cards for the Performance column
//       { type, assignmentId, title, points, category, raw }
//     ],
//     otherItems: [...]          // pass-through from schedule[N].other
//   }
//
// Returns null if no schedule entry exists for that week.

export async function getCardsForWeek(n) {
  const [sched, wk, topics, points, assignments] = await Promise.all([
    getScheduleForWeek(n),
    getWeek(n),
    getTopics(),
    getPoints(),
    getAssignments(),
  ]);
  if (!sched) return null;

  const topic = sched.topic ? topics.find((t) => t.id === sched.topic) ?? null : null;
  const dateRange = parseScheduleDates(sched.dates);

  const performanceItems = (sched.performance ?? []).map((item) =>
    resolvePerformanceItem(item, n, topics, points, assignments),
  );

  return {
    week: n,
    dates: sched.dates ?? null,
    startMs: dateRange?.startMs ?? null,
    endMs: dateRange?.endMs ?? null,
    topic,
    isHalfWeek: !!sched.half,
    isThanksgiving: !!sched.thanksgiving,
    isReview: !!sched.review,
    hasStudy: !!sched.study,
    studyAssignmentId: sched.study ? studyAssignmentIdForWeek(n) : null,
    title: wk?.title ?? null,
    objectives: wk?.objectives ?? [],
    placements: wk?.placements ?? {},
    performanceItems,
    otherItems: sched.other ?? [],
  };
}

function resolvePerformanceItem(item, weekNum, topics, points, assignments) {
  const assignmentId = deriveScheduleItemId(item, weekNum);
  const standalone = assignmentId
    ? assignments.find((a) => a.id === assignmentId) ?? null
    : null;

  const title = titleForItem(item, topics, standalone);
  const pts = pointsForItem(item, points, standalone);

  return {
    type: item.type,
    assignmentId,
    title,
    points: pts,
    category: standalone?.category ?? "performance",
    topic: item.topic ?? null,
    index: item.index ?? null,
    phase: item.phase ?? null,
    // Original entry, for callers that want to inspect anything we didn't
    // surface explicitly.
    raw: item,
  };
}

function titleForItem(item, topics, standalone) {
  if (standalone?.title) return standalone.title;
  const topicLabel = item.topic
    ? topics.find((t) => t.id === item.topic)?.label ?? item.topic
    : null;
  switch (item.type) {
    case "oa":
      return topicLabel ? `${topicLabel} — Online Assessment` : "Online Assessment";
    case "performance":
      return topicLabel ? `${topicLabel} — Performance Exam` : "Performance Exam";
    case "peer-mock":
      return "Peer Mock Interview";
    case "live-interview":
      return item.index ? `Live Interview ${item.index}` : "Live Interview";
    case "professional-mock":
      return "Professional Mock Interview";
    case "final":
      return item.phase ? `Final Exam (${item.phase})` : "Final Exam";
    default:
      return item.type;
  }
}

function pointsForItem(item, points, standalone) {
  if (typeof standalone?.points === "number") return standalone.points;
  switch (item.type) {
    case "oa":
      return points.oa ?? null;
    case "performance":
      return points.performanceExam ?? null;
    case "peer-mock":
      return points.peerMock ?? null;
    case "live-interview":
      return points.liveInterview ?? null;
    case "professional-mock":
      return points.professionalMock ?? null;
    default:
      return null;
  }
}
