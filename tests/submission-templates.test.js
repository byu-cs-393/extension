// Unit tests for src/submission-templates.js. Pure functions — no
// mocks, no fetch, no chrome.*. Runs under Vitest.
import { describe, it, expect } from "vitest";
import {
  fillOaTemplate,
  fillPerformanceTemplate,
  fillLiveInterviewTemplate,
  fillPeerMockTemplate,
  fillProfessionalMockTemplate,
  fillInstructorInterviewTemplate,
  fillConnectWithClassTemplate,
  fillStudyTemplate,
  fillEcInterviewReadyTemplate,
  fillEcRealInterviewReportTemplate,
  fillEcRealOfferReportTemplate,
  fillEcFriendInterviewTemplate,
  fillEcFriendOfferTemplate,
  fillSubmissionTemplate,
} from "../src/data/submission-templates.js";

describe("fillOaTemplate", () => {
  it("fills in attempt number + accepted URLs as HTML", () => {
    const body = fillOaTemplate({
      attemptNum: 2,
      acceptedUrls: [
        "https://leetcode.com/problems/two-sum/submissions/1000/",
        "https://leetcode.com/problems/valid-parentheses/submissions/2000/",
        "https://leetcode.com/problems/3sum/submissions/3000/",
      ],
    });
    expect(body).toContain("<strong>Attempt you passed (1 / 2 / 3):</strong> 2");
    expect(body).toContain(
      '<a href="https://leetcode.com/problems/two-sum/submissions/1000/">https://leetcode.com/problems/two-sum/submissions/1000/</a>',
    );
    expect(body).toContain(
      '<a href="https://leetcode.com/problems/valid-parentheses/submissions/2000/">',
    );
    expect(body).toContain(
      '<a href="https://leetcode.com/problems/3sum/submissions/3000/">',
    );
    expect(body.startsWith("<p>")).toBe(true);
    expect(body).toContain("<ul>");
    expect(body).toContain("</ul>");
  });

  it("always emits at least three <li> items even for shorter OAs", () => {
    const body = fillOaTemplate({ attemptNum: 1, acceptedUrls: ["https://x/"] });
    // Count <li> occurrences: 1 with a link, 2 empty.
    const liCount = (body.match(/<li>/g) ?? []).length;
    expect(liCount).toBe(3);
    expect(body).toContain('<li><a href="https://x/">https://x/</a></li>');
    // Two empty items follow the filled one.
    const emptyLiCount = (body.match(/<li><\/li>/g) ?? []).length;
    expect(emptyLiCount).toBe(2);
  });

  it("expands item count when there are more URLs than 3", () => {
    const urls = Array.from({ length: 5 }, (_, i) => `https://u${i + 1}/`);
    const body = fillOaTemplate({ attemptNum: 3, acceptedUrls: urls });
    const liCount = (body.match(/<li>/g) ?? []).length;
    expect(liCount).toBe(5);
    expect(body).toContain('<a href="https://u5/">');
  });

  it("emits blank attempt when attemptNum is missing (partial fill)", () => {
    const body = fillOaTemplate({ acceptedUrls: ["https://x/"] });
    expect(body).toContain("<strong>Attempt you passed (1 / 2 / 3):</strong> </p>");
    expect(body).not.toContain("undefined");
  });

  it("handles missing acceptedUrls array", () => {
    const body = fillOaTemplate({ attemptNum: 1 });
    const emptyLiCount = (body.match(/<li><\/li>/g) ?? []).length;
    expect(emptyLiCount).toBe(3);
  });

  it("HTML-escapes dangerous characters in URLs (defense against injection)", () => {
    // A URL containing a quote or angle bracket shouldn't break the href
    // attribute or bleed HTML into the surrounding markup.
    const body = fillOaTemplate({
      attemptNum: 1,
      acceptedUrls: ['https://x/?q="&<script>'],
    });
    expect(body).not.toContain('<script>');
    expect(body).toContain('&quot;');
    expect(body).toContain('&amp;');
    expect(body).toContain('&lt;');
  });
});

describe("fillPerformanceTemplate", () => {
  it("emits all five labeled fields with a linked URL", () => {
    const body = fillPerformanceTemplate({
      date: "2026-09-15",
      workedWith: "Jack",
      howLong: "12 min",
      attemptNum: 1,
      acceptedUrl: "https://leetcode.com/problems/lru-cache/",
    });
    expect(body).toContain("<strong>Date you did it:</strong> 2026-09-15");
    expect(body).toContain("<strong>Who you worked with (TA / instructor):</strong> Jack");
    expect(body).toContain("<strong>How long it took:</strong> 12 min");
    expect(body).toContain("<strong>Attempt you passed on:</strong> 1");
    expect(body).toContain('<a href="https://leetcode.com/problems/lru-cache/">');
  });

  it("leaves values blank when fields are missing (partial fill)", () => {
    const body = fillPerformanceTemplate({ date: "2026-09-15" });
    expect(body).toContain("<strong>Who you worked with (TA / instructor):</strong> </p>");
    expect(body).not.toContain("undefined");
  });
});

describe("fillLiveInterviewTemplate", () => {
  it("emits all four labeled fields", () => {
    const body = fillLiveInterviewTemplate({
      date: "2026-09-24",
      howItWent: "Nailed it",
      selfRating: 3,
      acceptedUrl: "https://leetcode.com/problems/x/",
    });
    expect(body).toContain("<strong>How did it go?:</strong> Nailed it");
    expect(body).toContain("<strong>Self-rating (1-3):</strong> 3");
    expect(body).toContain('<a href="https://leetcode.com/problems/x/">');
  });
});

describe("fillPeerMockTemplate / fillProfessionalMockTemplate", () => {
  it("produce identical output for the same input (share a template)", () => {
    const data = {
      interviewedWith: "Alex",
      when: "2026-10-05 4pm",
      howItWent: "Solid",
    };
    expect(fillPeerMockTemplate(data)).toBe(fillProfessionalMockTemplate(data));
  });

  it("emits all three labeled fields", () => {
    const body = fillPeerMockTemplate({
      interviewedWith: "Alex",
      when: "Wed 4pm",
      howItWent: "Solid",
    });
    expect(body).toContain("<strong>Who you interviewed with:</strong> Alex");
    expect(body).toContain("<strong>When:</strong> Wed 4pm");
    expect(body).toContain("<strong>How did it go?:</strong> Solid");
  });
});

describe("fillInstructorInterviewTemplate", () => {
  it("emits all three fields with linked URL", () => {
    const body = fillInstructorInterviewTemplate({
      date: "2026-12-01",
      acceptedUrl: "https://leetcode.com/problems/x/",
      howItWent: "Passed on the second try",
    });
    expect(body).toContain("<strong>Date you did it:</strong> 2026-12-01");
    expect(body).toContain('<a href="https://leetcode.com/problems/x/">');
    expect(body).toContain("<strong>How did it go?:</strong> Passed on the second try");
  });
});

describe("fillConnectWithClassTemplate", () => {
  it("emits all seven checklist items + LeetCode URL + network plan", () => {
    const body = fillConnectWithClassTemplate({
      joinedTeams: "Did it!",
      updatedPhoto: "Did it!",
      postedIntro: "Did it!",
      reactedToThree: "Did it!",
      dmedClassmate: "Not yet — will do this weekend",
      leetcodeProfileUrl: "https://leetcode.com/jack684/",
      networkPlan: "Attending 2 meetups/mo",
    });
    expect(body).toContain("Joined Teams (Did it! / Not yet — why?):</strong> Did it!");
    expect(body).toContain("DM'd a classmate for a mock (Did it! / Not yet — why?):</strong> Not yet");
    expect(body).toContain('<a href="https://leetcode.com/jack684/">');
    expect(body).toContain("How I plan to connect");
  });
});

describe("fillStudyTemplate", () => {
  const problem = (over = {}) => ({
    title: "Two Sum",
    tag: "required",
    problemUrl: "https://leetcode.com/problems/two-sum/",
    acceptedUrl: null,
    solved: false,
    ...over,
  });

  it("links accepted submissions for solved problems", () => {
    const body = fillStudyTemplate({
      problems: [
        problem({
          solved: true,
          acceptedUrl: "https://leetcode.com/problems/two-sum/submissions/1046917577/",
        }),
      ],
      collabHours: 4,
      collabWithWhom: "Alex + Sam",
      personalHours: 5,
      growthActions: "re-timed myself",
    });
    expect(body).toContain("Solved this week (1 of 1)");
    expect(body).toContain(
      '<a href="https://leetcode.com/problems/two-sum/submissions/1046917577/">',
    );
    expect(body).toContain("(required)");
    expect(body).toContain("<strong>Collaborative study:</strong> 4 hrs (with Alex + Sam)");
    expect(body).toContain("<strong>Personal study:</strong> 5 hrs");
  });

  it("separates unsolved problems and counts them", () => {
    // The rubric grades "required and in class problems DONE", so a
    // grader needs the denominator, not just a list of links.
    const body = fillStudyTemplate({
      problems: [
        problem({ solved: true, acceptedUrl: "https://leetcode.com/problems/two-sum/submissions/1/" }),
        problem({ title: "Valid Sudoku", tag: "in class" }),
        problem({ title: "LRU Cache" }),
      ],
    });
    expect(body).toContain("Solved this week (1 of 3)");
    expect(body).toContain("Not solved this week (2 of 3)");
    expect(body).toContain("Valid Sudoku");
    expect(body).toContain("LRU Cache");
  });

  it("never passes off a problem URL as an accepted submission", () => {
    // The professor's rubric is explicit: link the accepted submission,
    // not the problem page. Silently substituting one for the other
    // would look like proof of a solve and isn't.
    const body = fillStudyTemplate({
      problems: [problem({ solved: true, acceptedUrl: null })],
    });
    expect(body).toContain("no submission link captured");
    expect(body).not.toContain("Solved this week (0 of 1)");
  });

  it("reports the extension's tracked time when there is any", () => {
    const body = fillStudyTemplate({
      problems: [problem()],
      trackedMs: 3 * 60 * 60 * 1000 + 12 * 60 * 1000,
    });
    expect(body).toContain("Time on LeetCode measured by the extension this week");
    expect(body).toContain("3h 12m of active editing");
  });

  it("omits the tracked-time line when nothing was recorded", () => {
    const body = fillStudyTemplate({ problems: [problem()], trackedMs: 0 });
    expect(body).not.toContain("measured by the extension");
  });

  it("prints a points summary a grader can read off", () => {
    const body = fillStudyTemplate({
      problems: [
        problem({ solved: true, acceptedUrl: "https://leetcode.com/problems/two-sum/submissions/1/" }),
        problem({ title: "Valid Sudoku" }),
      ],
      collabHours: 4,
      personalHours: 5,
    });
    // 4 collaborative + 2 of 4 problems + 5 personal
    expect(body).toContain("Suggested points: 11 / 13");
    expect(body).toContain("Collaborative study: <strong>4 / 4</strong>");
    expect(body).toContain("Required + in-class problems: <strong>2 / 4</strong>");
    expect(body).toContain("Personal study: <strong>5 / 5</strong>");
  });

  it("says the points are computed from self-reported hours", () => {
    // The extension can count solves and measure editing time; it can't
    // verify four hours of collaborative study happened.
    const body = fillStudyTemplate({ problems: [problem()], collabHours: 4 });
    expect(body).toMatch(/self-reported/i);
    expect(body).toMatch(/adjust/i);
  });

  it("handles a week with no assigned problems", () => {
    const body = fillStudyTemplate({});
    expect(body).toContain("(none solved yet)");
  });
});

describe("EC template fillers", () => {
  it("fillEcInterviewReadyTemplate — three labeled fields", () => {
    const body = fillEcInterviewReadyTemplate({
      allGreen: "Yes",
      totalProblemsSolved: 187,
      learned: "Priority queues clicked",
    });
    expect(body).toContain("<strong>All categories green? (Yes / No):</strong> Yes");
    expect(body).toContain("<strong>Total problems solved:</strong> 187");
  });

  it("fillEcRealInterviewReportTemplate — three labeled fields", () => {
    const body = fillEcRealInterviewReportTemplate({
      where: "Lucid",
      questionTypes: "Graphs + DP",
      experience: "Great — recommend",
    });
    expect(body).toContain("<strong>Where did you interview?:</strong> Lucid");
    expect(body).toContain("Would you recommend them?:</strong> Great — recommend");
  });

  it("fillEcRealOfferReportTemplate — six labeled fields", () => {
    const body = fillEcRealOfferReportTemplate({
      preparation: "3 months of leetcode",
      network: "BYU alum",
      tips: "Practice OOD",
      overFiftyK: "Yes",
      jobType: "Full-time",
      expectations: 9,
    });
    expect(body).toContain("What did you do to prepare?:</strong> 3 months of leetcode");
    expect(body).toContain("Full-time / Internship / Other:</strong> Full-time");
    expect(body).toContain("1 = no");
  });

  it("fillEcFriendInterviewTemplate — three labeled fields", () => {
    const body = fillEcFriendInterviewTemplate({
      friendName: "Sam",
      whereInterviewed: "Google",
      howHelped: "Referral",
    });
    expect(body).toContain("<strong>Friend's full name:</strong> Sam");
    expect(body).toContain("<strong>Where they interviewed:</strong> Google");
  });

  it("fillEcFriendOfferTemplate — three labeled fields", () => {
    const body = fillEcFriendOfferTemplate({
      friendName: "Sam",
      whereGotOffer: "Google",
      howHelped: "Referred + interview prep",
    });
    expect(body).toContain("<strong>Where they got the offer:</strong> Google");
  });
});

describe("fillSubmissionTemplate — dispatcher", () => {
  it("routes 'oa' to fillOaTemplate", () => {
    const body = fillSubmissionTemplate({
      type: "oa",
      data: { attemptNum: 1, acceptedUrls: ["https://u1/"] },
    });
    expect(body).toContain("<strong>Attempt you passed (1 / 2 / 3):</strong> 1");
    expect(body).toContain('<a href="https://u1/">');
  });

  it("routes 'performance' to fillPerformanceTemplate", () => {
    const body = fillSubmissionTemplate({
      type: "performance",
      data: { date: "2026-09-15", workedWith: "Jack" },
    });
    expect(body).toContain("<strong>Date you did it:</strong> 2026-09-15");
  });

  it("routes 'peer-mock' to fillPeerMockTemplate", () => {
    const body = fillSubmissionTemplate({
      type: "peer-mock",
      data: { interviewedWith: "Alex", when: "Wed", howItWent: "OK" },
    });
    expect(body).toContain("<strong>Who you interviewed with:</strong> Alex");
  });

  it("routes EC ids based on assignmentId (not type)", () => {
    // Every EC item shares category 'extra-credit' but each has its own
    // template shape — the dispatcher must key off assignmentId.
    const body = fillSubmissionTemplate({
      assignmentId: "ec-real-interview-report-2",
      data: { where: "Lucid", questionTypes: "Graphs", experience: "Great" },
    });
    expect(body).toContain("<strong>Where did you interview?:</strong> Lucid");
  });

  it("routes ec-friend-interview by exact id", () => {
    const body = fillSubmissionTemplate({
      assignmentId: "ec-friend-interview",
      data: { friendName: "Sam", whereInterviewed: "Google", howHelped: "Referral" },
    });
    expect(body).toContain("<strong>Friend's full name:</strong> Sam");
  });

  it("throws with a clear message for unknown types (missing wiring is loud)", () => {
    expect(() =>
      fillSubmissionTemplate({ type: "unknown-type", data: {} }),
    ).toThrow(/No submission template for type=unknown-type/);
  });
});
