// scripts/seed-test-week.js
//
// Mini seed for Phase 2 Stage B testing. Sets up just enough
// Firestore state to prove that pushCanvasGrades can compute and
// push a real recommended-problem grade to Canvas.
//
// Paste the ENTIRE file into the dashboard DevTools console
// (chrome-extension://<extension-id>/dashboard.html → F12).
//
// What it does:
//   1. Creates a "Week 99" doc anchored to THIS calendar week,
//      with 3 easy LeetCode problems and canvasAssignmentId
//      pointing at the test assignment (1380333).
//      weekNum 99 is deliberately outside the real semester
//      range so it doesn't collide with anything.
//   2. Adds canvasUserId to your own student doc, pointing at
//      Test Student (169685). Grades computed for you will
//      land on Test Student's row in the gradebook — that's the
//      testing trick so we don't need you to be enrolled as a
//      student in Canvas.
//
// Prerequisites:
//   - firestore.rules must permit `canvasUserId` on student docs
//     and `canvasAssignmentId` on week docs. If either write 403s,
//     redeploy rules first (firebase deploy --only firestore:rules).

(async () => {
  const { patchDoc } = await import(chrome.runtime.getURL("firestore.js"));

  const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const TEST_WEEK_NUM = 99;
  const TEST_CANVAS_ASSIGNMENT_ID = 1380333;
  const TEST_STUDENT_CANVAS_USER_ID = 169685;

  // This week's Monday, 00:00 local.
  const now = new Date();
  const daysFromMonday = (now.getDay() + 6) % 7;
  const monday = new Date(now);
  monday.setDate(now.getDate() - daysFromMonday);
  monday.setHours(0, 0, 0, 0);
  const startDate = monday.getTime();
  const endDate = startDate + ONE_WEEK_MS;

  // === Seed the test week ===
  await patchDoc(`classes/cs393/weeks/${TEST_WEEK_NUM}`, {
    weekNum: TEST_WEEK_NUM,
    startDate,
    endDate,
    problems: [
      { slug: "two-sum", title: "Two Sum", difficulty: "Easy" },
      { slug: "valid-parentheses", title: "Valid Parentheses", difficulty: "Easy" },
      { slug: "climbing-stairs", title: "Climbing Stairs", difficulty: "Easy" },
    ],
    canvasAssignmentId: TEST_CANVAS_ASSIGNMENT_ID,
    thirdCard: null,
  });
  console.log(
    `✓ Week ${TEST_WEEK_NUM} seeded — ${new Date(startDate).toDateString()} → ${new Date(endDate).toDateString()}`
  );
  console.log(`  3 problems, canvasAssignmentId ${TEST_CANVAS_ASSIGNMENT_ID}`);

  // === Set canvasUserId on your student doc ===
  const { netID } = await chrome.storage.sync.get("netID");
  if (!netID) {
    console.warn("No netID in chrome.storage.sync — skipping canvasUserId set");
    return;
  }
  await patchDoc(`students/${netID}`, {
    canvasUserId: TEST_STUDENT_CANVAS_USER_ID,
  });
  console.log(
    `✓ Student ${netID}.canvasUserId → ${TEST_STUDENT_CANVAS_USER_ID} (Test Student)`
  );
  console.log("");
  console.log("Now solve any subset of Two Sum / Valid Parentheses / Climbing Stairs");
  console.log("on LeetCode. Then fire pushCanvasGrades — the grade should land in");
  console.log("Test Student's row on assignment 1380333.");
})();
