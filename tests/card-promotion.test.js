// Tests for getCardsForWeek's handling of gradeable `schedule[N].other`
// refs — Connect with Class and the Instructor Pass/Fail Interview, which
// live outside `schedule[N].performance` but still need cards.
//
// Unlike course-data.test.js (pure helpers only), these run against the
// REAL vendored src/course.json, with chrome.runtime.getURL + fetch
// stubbed to read it off disk. That's deliberate: the thing worth
// guarding here is the interaction between the promotion rule and the
// professor's actual data, which is what re-vendoring can change.
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";

import { getCardsForWeek, getAssignmentById } from "../src/course-data.js";

beforeAll(() => {
  const course = JSON.parse(
    readFileSync(new URL("../src/course.json", import.meta.url), "utf8"),
  );
  globalThis.chrome = { runtime: { getURL: (path) => path } };
  globalThis.fetch = async () => ({ ok: true, json: async () => course });
});

const byId = (cards, id) =>
  (cards.performanceItems ?? []).find((p) => p.assignmentId === id) ?? null;

describe("promoting gradeable refs out of schedule[N].other", () => {
  it("gives week 1 a Connect with Class card", async () => {
    const item = byId(await getCardsForWeek(1), "connect-with-class");
    expect(item).not.toBe(null);
    expect(item.type).toBe("connect-with-class");
    expect(item.title).toBe("Connect with Class");
    expect(item.points).toBe(1);
  });

  it("gives week 4 an Instructor Pass/Fail Interview card", async () => {
    const item = byId(await getCardsForWeek(4), "instructor-interview");
    expect(item).not.toBe(null);
    // The schedule entry's own type is "reminder" — the assignment id has
    // to win, or the dispatcher can't route it and the schema lookup in
    // submission-form.js misses.
    expect(item.type).toBe("instructor-interview");
    expect(item.points).toBe(2);
  });

  it("carries the assignments[] entry through for card extras", async () => {
    const connect = byId(await getCardsForWeek(1), "connect-with-class");
    expect(connect.assignment?.teamsUrl).toMatch(/^https:\/\/teams\.microsoft\.com\//);

    const interview = byId(await getCardsForWeek(4), "instructor-interview");
    expect(interview.assignment?.gate).toBe(true);
    expect(interview.assignment?.desc).toBeTruthy();
  });

  it("leaves the week 10 professional-mock reminder alone", async () => {
    // Week 10 refs "professional-mock", but that's a schedule-level type
    // with no assignments[] entry — its real card belongs to week 14.
    // Promoting it would put a duplicate card four weeks early.
    expect(byId(await getCardsForWeek(10), "professional-mock")).toBe(null);
    expect(await getAssignmentById("professional-mock")).toBe(null);

    const wk14 = byId(await getCardsForWeek(14), "professional-mock");
    expect(wk14?.type).toBe("professional-mock");
  });

  it("does not disturb items already in schedule[N].performance", async () => {
    // Week 1 has a study assignment and no performance entries; the only
    // card it gains is the promoted one.
    const cards = await getCardsForWeek(1);
    const promoted = cards.performanceItems.filter((p) => p.raw?.ref);
    expect(promoted).toHaveLength(1);
    expect(promoted[0].assignmentId).toBe("connect-with-class");
  });

  it("promotes each ref at most once", async () => {
    for (const week of [1, 4, 10, 14]) {
      const ids = (await getCardsForWeek(week)).performanceItems.map(
        (p) => p.assignmentId,
      );
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("resolves a type for every card the dispatcher will see", async () => {
    // createThirdCardSection bails on a falsy item.type, so a null here
    // would mean a silently missing card.
    for (let week = 1; week <= 15; week += 1) {
      const cards = await getCardsForWeek(week);
      if (!cards) continue;
      for (const item of cards.performanceItems) {
        expect(item.type, `week ${week} / ${item.assignmentId}`).toBeTruthy();
      }
    }
  });
});
