// scripts/seed-firestore.js
//
// Seeds the entire semester's week catalog into Firestore in one shot.
// Paste the ENTIRE contents of this file into the dashboard DevTools
// console (chrome-extension://<extension-id>/dashboard.html → F12).
//
// Idempotent: re-running overwrites each week doc with the same data.
// Any pre-existing `canvasAssignmentId` on a week gets PRESERVED
// because we use patchDoc (updateMask) and don't send that field.
//
// Before running: set SEMESTER_START_MONDAY_ISO to the Monday of Week 1.
//
// Data extracted from course-content/*.md (committed 2026-07-13):
//   - 14 weekly problem lists
//   - 4 online assessments (Weeks 2, 5, 9, 12)
//   - Live topic exams (Weeks 3, 6, 10, 13) — inferred per professor's rule
//   - Mock interviews (Weeks 1, 4, 7, 8, 11, 14) — inferred per professor's rule
//
// TO DO after pasting: verify the third cards match what the professor
// intends. If the mock-interview inference is wrong for any week,
// re-seed just that week manually.

(async () => {
  const { patchDoc } = await import(chrome.runtime.getURL("firestore.js"));

  // ===============================================================
  //  CONFIG — edit before running
  // ===============================================================

  // Monday of Week 1 of the semester, in "YYYY-MM-DD" format.
  // BYU Spring 2026 default; adjust for the actual term.
  const SEMESTER_START_MONDAY_ISO = "2026-04-27";

  // ===============================================================
  //  HELPERS
  // ===============================================================

  const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const week1Monday = new Date(SEMESTER_START_MONDAY_ISO + "T00:00:00").getTime();

  const slugToTitle = (slug) =>
    slug
      .split("-")
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join(" ");

  // p(slug) → { slug, title } — for problems without a known difficulty.
  // p(slug, "Easy") → adds difficulty for the pill in the dashboard.
  const p = (slug, difficulty) => ({
    slug,
    title: slugToTitle(slug),
    ...(difficulty ? { difficulty } : {}),
  });

  const weekDates = (weekNum) => {
    const startDate = week1Monday + (weekNum - 1) * ONE_WEEK_MS;
    return { startDate, endDate: startDate + ONE_WEEK_MS };
  };

  // ===============================================================
  //  THIRD-CARD STUBS
  // ===============================================================

  // Live topic exam: 30-min live signoff with a TA.
  const liveTopicExam = (topic) => ({
    type: "topicExam",
    topic,
    durationMin: 30,
    examType: "articulation",
  });

  // Mock interview: 30-min paired session with a classmate.
  const mockInterview = () => ({
    type: "mockInterview",
    durationMin: 30,
  });

  // ===============================================================
  //  ONLINE ASSESSMENTS
  // ===============================================================

  // Attempt shape: { timeLimitMin, requiredSolves, helpAllowed, problems }
  //   timeLimitMin: null = no time limit
  //   requiredSolves: null = must solve all problems in the list

  const oaDataStructures = {
    type: "onlineAssessment",
    topic: "Data Structures",
    attempts: [
      {
        timeLimitMin: 90,
        requiredSolves: null,
        helpAllowed: false,
        problems: [
          { slug: "check-if-the-sentence-is-pangram", title: "Check If the Sentence Is a Pangram" },
          { slug: "rings-and-rods", title: "Rings and Rods" },
          { slug: "merge-nodes-in-between-zeros", title: "Merge Nodes in Between Zeros" },
          { slug: "spiral-matrix", title: "Spiral Matrix" },
        ],
      },
      {
        timeLimitMin: null,
        requiredSolves: 3,
        helpAllowed: false,
        problems: [
          { slug: "string-compression", title: "String Compression" },
          { slug: "find-the-minimum-and-maximum-number-of-nodes-between-critical-points", title: "Find the Minimum and Maximum Number of Nodes Between Critical Points" },
          { slug: "watering-plants", title: "Watering Plants" },
          { slug: "set-matrix-zeroes", title: "Set Matrix Zeroes" },
          { slug: "reverse-linked-list", title: "Reverse Linked List", note: "O(1) space only" },
          { slug: "reverse-linked-list-ii", title: "Reverse Linked List II", note: "O(1) space only" },
          { slug: "brick-wall", title: "Brick Wall" },
        ],
      },
      {
        timeLimitMin: null,
        requiredSolves: null,
        helpAllowed: true,
        problems: [
          { slug: "concatenation-of-array", title: "Concatenation of Array" },
          { slug: "number-of-arithmetic-triplets", title: "Number of Arithmetic Triplets", note: "Must be O(n) time" },
          { slug: "spiral-matrix-iv", title: "Spiral Matrix IV" },
          { slug: "zigzag-conversion", title: "Zigzag Conversion" },
        ],
      },
    ],
  };

  const oaGraphs = {
    type: "onlineAssessment",
    topic: "Graphs",
    attempts: [
      {
        timeLimitMin: 90,
        requiredSolves: null,
        helpAllowed: false,
        problems: [
          { slug: "minimum-depth-of-binary-tree", title: "Minimum Depth of Binary Tree" },
          { slug: "count-good-nodes-in-binary-tree", title: "Count Good Nodes in Binary Tree" },
          { slug: "shortest-bridge", title: "Shortest Bridge" },
        ],
      },
      {
        timeLimitMin: null,
        requiredSolves: 3,
        helpAllowed: false,
        problems: [
          { slug: "pacific-atlantic-water-flow", title: "Pacific Atlantic Water Flow" },
          { slug: "shortest-path-in-binary-matrix", title: "Shortest Path in Binary Matrix" },
          { slug: "reachable-nodes-with-restrictions", title: "Reachable Nodes with Restrictions" },
          { slug: "number-of-operations-to-make-network-connected", title: "Number of Operations to Make Network Connected" },
          { slug: "clone-graph", title: "Clone Graph" },
          { slug: "path-sum-ii", title: "Path Sum II" },
          { slug: "sum-root-to-leaf-numbers", title: "Sum Root to Leaf Numbers" },
          { slug: "course-schedule-ii", title: "Course Schedule II" },
          { slug: "lowest-common-ancestor-of-a-binary-tree", title: "Lowest Common Ancestor of a Binary Tree" },
          { slug: "serialize-and-deserialize-binary-tree", title: "Serialize and Deserialize Binary Tree", note: "Hard" },
          { slug: "minesweeper", title: "Minesweeper" },
          { slug: "number-of-enclaves", title: "Number of Enclaves" },
          { slug: "minimum-time-to-collect-all-apples-in-a-tree", title: "Minimum Time to Collect All Apples in a Tree" },
          { slug: "maximum-binary-tree", title: "Maximum Binary Tree" },
          { slug: "delete-nodes-and-return-forest", title: "Delete Nodes and Return Forest" },
          { slug: "count-nodes-with-the-highest-score", title: "Count Nodes with the Highest Score" },
          { slug: "most-frequent-subtree-sum", title: "Most Frequent Subtree Sum" },
          { slug: "path-sum-iii", title: "Path Sum III" },
          { slug: "word-ladder", title: "Word Ladder", note: "Hard" },
          { slug: "coloring-a-border", title: "Coloring a Border" },
          { slug: "maximum-product-of-splitted-binary-tree", title: "Maximum Product of Splitted Binary Tree" },
        ],
      },
      {
        timeLimitMin: null,
        requiredSolves: null,
        helpAllowed: true,
        problems: [
          { slug: "path-sum", title: "Path Sum" },
          { slug: "path-sum-ii", title: "Path Sum II" },
          { slug: "sum-root-to-leaf-numbers", title: "Sum Root to Leaf Numbers" },
        ],
      },
    ],
  };

  const oaDynamicProgramming = {
    type: "onlineAssessment",
    topic: "Dynamic Programming",
    attempts: [
      {
        timeLimitMin: 180,
        requiredSolves: null,
        helpAllowed: false,
        problems: [
          { slug: "fibonacci-number", title: "Fibonacci Number" },
          { slug: "n-th-tribonacci-number", title: "N-th Tribonacci Number" },
          { slug: "range-sum-query-immutable", title: "Range Sum Query - Immutable", note: "sumRange O(1)" },
          { slug: "word-break", title: "Word Break" },
          { slug: "find-the-substring-with-maximum-cost", title: "Find the Substring with Maximum Cost", note: "O(n)" },
        ],
      },
      {
        timeLimitMin: 120,
        requiredSolves: 2,
        helpAllowed: false,
        problems: [
          { slug: "divisor-game", title: "Divisor Game" },
          { slug: "edit-distance", title: "Edit Distance" },
          { slug: "house-robber", title: "House Robber" },
          { slug: "range-sum-query-2d-immutable", title: "Range Sum Query 2D - Immutable" },
        ],
      },
      {
        timeLimitMin: null,
        requiredSolves: 3,
        helpAllowed: true,
        problems: [
          { slug: "min-cost-climbing-stairs", title: "Min Cost Climbing Stairs" },
          { slug: "vowels-of-all-substrings", title: "Vowels of All Substrings" },
          { slug: "number-of-ways-to-select-buildings", title: "Number of Ways to Select Buildings" },
          { slug: "coin-change", title: "Coin Change" },
          { slug: "number-of-dice-rolls-with-target-sum", title: "Number of Dice Rolls With Target Sum" },
        ],
      },
    ],
  };

  const oaSortingTwoPointer = {
    type: "onlineAssessment",
    topic: "Sorting / Two-Pointer",
    attempts: [
      {
        timeLimitMin: 120,
        requiredSolves: null,
        helpAllowed: false,
        problems: [
          { slug: "how-many-numbers-are-smaller-than-the-current-number", title: "How Many Numbers Are Smaller Than the Current Number" },
          { slug: "merge-sorted-array", title: "Merge Sorted Array" },
          { slug: "container-with-most-water", title: "Container With Most Water" },
          { slug: "merge-intervals", title: "Merge Intervals" },
        ],
      },
      {
        timeLimitMin: null,
        requiredSolves: 3,
        helpAllowed: false,
        problems: [
          { slug: "maximum-length-of-pair-chain", title: "Maximum Length of Pair Chain" },
          { slug: "count-complete-tree-nodes", title: "Count Complete Tree Nodes", note: "Less than O(N)" },
          { slug: "minimum-number-of-arrows-to-burst-balloons", title: "Minimum Number of Arrows to Burst Balloons" },
          { slug: "sort-colors", title: "Sort Colors", note: "O(N) time, O(1) space" },
          { slug: "sort-list", title: "Sort List" },
          { slug: "largest-divisible-subset", title: "Largest Divisible Subset" },
          { slug: "task-scheduler", title: "Task Scheduler" },
          { slug: "number-of-atoms", title: "Number of Atoms" },
          { slug: "minimum-area-rectangle", title: "Minimum Area Rectangle" },
          { slug: "search-a-2d-matrix", title: "Search a 2D Matrix", note: "O(log(m*n)) or better, O(1) space" },
          { slug: "minimum-score-by-changing-two-elements", title: "Minimum Score by Changing Two Elements" },
          { slug: "maximize-greatness-of-an-array", title: "Maximize Greatness of an Array" },
          { slug: "design-a-number-container-system", title: "Design a Number Container System" },
          { slug: "sort-an-array", title: "Sort an Array" },
          { slug: "furthest-building-you-can-reach", title: "Furthest Building You Can Reach" },
        ],
      },
      {
        timeLimitMin: null,
        requiredSolves: null,
        helpAllowed: true,
        problems: [
          { slug: "sort-list", title: "Sort List" },
          { slug: "sort-an-array", title: "Sort an Array" },
          { slug: "furthest-building-you-can-reach", title: "Furthest Building You Can Reach" },
        ],
      },
    ],
  };

  // ===============================================================
  //  WEEKS
  // ===============================================================

  const WEEKS = [
    // ── Week 1 ────────────────────────────────────────────────
    {
      weekNum: 1,
      problems: [
        p("find-first-palindromic-string-in-the-array", "Easy"),
        p("valid-palindrome", "Easy"),
        p("reverse-linked-list", "Easy"),
        p("delete-nodes-from-linked-list-present-in-array", "Medium"),
      ],
      thirdCard: mockInterview(),
    },

    // ── Week 2 ────────────────────────────────────────────────
    {
      weekNum: 2,
      problems: [
        p("lru-cache", "Medium"),
        p("valid-sudoku", "Medium"),
        p("pascals-triangle", "Easy"),
      ],
      thirdCard: oaDataStructures,
    },

    // ── Week 3 ────────────────────────────────────────────────
    {
      weekNum: 3,
      problems: [p("all-oone-data-structure", "Hard")],
      thirdCard: liveTopicExam("Data Structures"),
    },

    // ── Week 4 ────────────────────────────────────────────────
    {
      weekNum: 4,
      problems: [
        p("binary-tree-inorder-traversal", "Easy"),
        p("binary-tree-preorder-traversal", "Easy"),
        p("binary-tree-postorder-traversal", "Easy"),
        p("maximum-depth-of-binary-tree", "Easy"),
        p("count-complete-tree-nodes", "Easy"),
        p("search-in-a-binary-search-tree", "Easy"),
        p("second-minimum-node-in-a-binary-tree", "Easy"),
        p("flood-fill", "Easy"),
        p("number-of-islands", "Medium"),
        p("course-schedule", "Medium"),
      ],
      thirdCard: mockInterview(),
    },

    // ── Week 5 ────────────────────────────────────────────────
    {
      weekNum: 5,
      problems: [
        p("rotting-oranges", "Medium"),
        p("as-far-from-land-as-possible", "Medium"),
        p("surrounded-regions", "Medium"),
        p("keys-and-rooms", "Medium"),
        p("snakes-and-ladders", "Medium"),
        p("shortest-path-with-alternating-colors", "Medium"),
      ],
      thirdCard: oaGraphs,
    },

    // ── Week 6 ────────────────────────────────────────────────
    {
      weekNum: 6,
      problems: [
        p("shortest-path-in-a-grid-with-obstacles-elimination", "Hard"),
        p("shortest-bridge", "Medium"),
        p("minimum-depth-of-binary-tree", "Easy"),
        p("count-good-nodes-in-binary-tree", "Medium"),
      ],
      thirdCard: liveTopicExam("Graphs"),
    },

    // ── Week 7 ────────────────────────────────────────────────
    {
      weekNum: 7,
      problems: [
        p("fibonacci-number", "Easy"),
        p("word-break", "Medium"),
        p("knight-dialer", "Medium"),
        p("number-of-dice-rolls-with-target-sum", "Medium"),
        p("number-of-distinct-roll-sequences", "Hard"),
        p("dice-roll-simulation", "Hard"),
      ],
      thirdCard: mockInterview(),
    },

    // ── Week 8 ────────────────────────────────────────────────
    {
      weekNum: 8,
      problems: [
        p("number-of-ways-to-select-buildings", "Medium"),
        p("number-of-boomerangs", "Medium"),
        p("maximum-subarray", "Medium"),
        p("range-sum-query-immutable", "Easy"),
        p("range-sum-query-2d-immutable", "Medium"),
        p("sum-of-distances", "Hard"),
        p("min-cost-climbing-stairs", "Easy"),
        p("climbing-stairs", "Easy"),
        p("coin-change", "Medium"),
        p("coin-change-ii", "Medium"),
      ],
      thirdCard: mockInterview(),
    },

    // ── Week 9 ────────────────────────────────────────────────
    {
      weekNum: 9,
      problems: [
        p("intersection-of-two-linked-lists", "Easy"),
        p("number-of-increasing-paths-in-a-grid", "Hard"),
        p("vowels-of-all-substrings", "Medium"),
      ],
      thirdCard: oaDynamicProgramming,
    },

    // ── Week 10 ───────────────────────────────────────────────
    // Review week — solve at least 10 of these (all from OA #3).
    {
      weekNum: 10,
      problems: [
        p("fibonacci-number", "Easy"),
        p("n-th-tribonacci-number", "Easy"),
        p("range-sum-query-immutable", "Easy"),
        p("word-break", "Medium"),
        p("find-the-substring-with-maximum-cost", "Medium"),
        p("divisor-game", "Easy"),
        p("edit-distance", "Medium"),
        p("house-robber", "Medium"),
        p("range-sum-query-2d-immutable", "Medium"),
        p("min-cost-climbing-stairs", "Easy"),
        p("vowels-of-all-substrings", "Medium"),
        p("number-of-ways-to-select-buildings", "Medium"),
        p("coin-change", "Medium"),
        p("number-of-dice-rolls-with-target-sum", "Medium"),
      ],
      thirdCard: liveTopicExam("Dynamic Programming"),
    },

    // ── Week 11 ───────────────────────────────────────────────
    {
      weekNum: 11,
      problems: [
        p("koko-eating-bananas", "Medium"),
        p("furthest-building-you-can-reach", "Medium"),
        p("meeting-rooms-iii", "Hard"),
        p("binary-search", "Easy"),
        p("longest-duplicate-substring", "Hard"),
        p("video-stitching", "Medium"),
      ],
      thirdCard: mockInterview(),
    },

    // ── Week 12 ───────────────────────────────────────────────
    {
      weekNum: 12,
      problems: [
        p("trapping-rain-water", "Hard"),
        p("sort-colors", "Medium"),
        p("sort-an-array", "Medium"),
      ],
      thirdCard: oaSortingTwoPointer,
    },

    // ── Week 13 ───────────────────────────────────────────────
    {
      weekNum: 13,
      problems: [
        p("count-elements-with-strictly-smaller-and-greater-elements", "Easy"),
        p("minimum-area-rectangle", "Medium"),
        p("removing-minimum-and-maximum-from-array", "Medium"),
        p("distant-barcodes", "Medium"),
      ],
      thirdCard: liveTopicExam("Sorting / Two-Pointer"),
    },

    // ── Week 14 ───────────────────────────────────────────────
    {
      weekNum: 14,
      problems: [
        p("hand-of-straights", "Medium"),
        p("word-subsets", "Medium"),
        p("check-if-there-is-a-valid-partition-for-the-array", "Medium"),
        p("design-front-middle-back-queue", "Medium"),
        p("super-ugly-number", "Medium"),
        p("remove-zero-sum-consecutive-nodes-from-linked-list", "Medium"),
      ],
      thirdCard: mockInterview(),
    },
  ];

  // ===============================================================
  //  WRITE TO FIRESTORE
  // ===============================================================

  console.log(`Seeding ${WEEKS.length} weeks starting ${SEMESTER_START_MONDAY_ISO}...`);

  const fmt = (ms) => new Date(ms).toISOString().slice(0, 10);
  let ok = 0;
  let failed = 0;

  for (const w of WEEKS) {
    const { startDate, endDate } = weekDates(w.weekNum);
    try {
      await patchDoc(`classes/cs393/weeks/${w.weekNum}`, {
        weekNum: w.weekNum,
        startDate,
        endDate,
        problems: w.problems,
        thirdCard: w.thirdCard,
      });
      const cardLabel =
        w.thirdCard.type === "onlineAssessment"
          ? `OA · ${w.thirdCard.topic}`
          : w.thirdCard.type === "topicExam"
          ? `Live topic exam · ${w.thirdCard.topic}`
          : "Mock interview";
      console.log(
        `✓ Week ${String(w.weekNum).padStart(2, " ")}  ${fmt(startDate)} → ${fmt(endDate)}  ${w.problems.length} problems  ·  ${cardLabel}`
      );
      ok++;
    } catch (err) {
      console.error(`✗ Week ${w.weekNum} failed:`, err);
      failed++;
    }
  }

  console.log(`Done. ${ok} succeeded, ${failed} failed.`);
})();
