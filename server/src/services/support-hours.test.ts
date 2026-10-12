import { describe, expect, it } from "vitest";
import {
  addWorkingMinutes,
  supportClock,
  workingMinutesBetween,
} from "./support-hours.js";

// October 2026 is BST (UTC+1); the clocks go back on Sun 25 Oct 2026.
const iso = (at: Date) => at.toISOString();

describe("support working-hours clock", () => {
  it("P1 inside working hours is due 4 working hours later the same day", () => {
    const clock = supportClock("P1", new Date("2026-10-07T09:00:00Z")); // Wed 10:00 BST
    expect(iso(clock.dueAt)).toBe("2026-10-07T13:00:00.000Z"); // 14:00 BST
    expect(iso(clock.warnAt)).toBe("2026-10-07T12:00:00.000Z"); // 13:00 BST
  });

  it("P1 late in the day rolls over to the next working morning", () => {
    const clock = supportClock("P1", new Date("2026-10-07T15:30:00Z")); // Wed 16:30 BST
    // 60 min on Wed, 180 min on Thu from 09:00 -> Thu 12:00 BST
    expect(iso(clock.dueAt)).toBe("2026-10-08T11:00:00.000Z");
  });

  it("a Friday evening ticket starts its clock on Monday 09:00", () => {
    const clock = supportClock("P2", new Date("2026-10-09T18:00:00Z")); // Fri 19:00 BST
    // one working day from Mon 09:00 -> Mon 17:30 BST
    expect(iso(clock.dueAt)).toBe("2026-10-12T16:30:00.000Z");
  });

  it("P3 is two working days and skips the weekend", () => {
    const clock = supportClock("P3", new Date("2026-10-08T12:00:00Z")); // Thu 13:00 BST
    // Thu 270 + Fri 510 = 780; 240 left on Mon -> Mon 13:00 BST
    expect(iso(clock.dueAt)).toBe("2026-10-12T12:00:00.000Z");
  });

  it("crosses the BST to GMT change on 25 Oct 2026", () => {
    const due = addWorkingMinutes(new Date("2026-10-23T15:30:00Z"), 120); // Fri 16:30 BST
    // 60 min Fri, 60 min Mon from 09:00 GMT -> Mon 10:00 GMT
    expect(iso(due)).toBe("2026-10-26T10:00:00.000Z");
  });

  it("skips listed bank holidays", () => {
    const due = addWorkingMinutes(new Date("2026-12-24T16:00:00Z"), 60, ["2026-12-25", "2026-12-28"]);
    // Thu 24 Dec 16:00 GMT -> 60 min left -> due 17:00 the same day
    expect(iso(due)).toBe("2026-12-24T17:00:00.000Z");
    const later = addWorkingMinutes(new Date("2026-12-24T17:00:00Z"), 60, ["2026-12-25", "2026-12-28"]);
    // 30 min Thu, then Fri 25 and Mon 28 are holidays -> Tue 29 Dec 09:30 GMT
    expect(iso(later)).toBe("2026-12-29T09:30:00.000Z");
  });

  it("counts only working minutes between two times", () => {
    expect(workingMinutesBetween(new Date("2026-10-09T15:30:00Z"), new Date("2026-10-12T09:00:00Z"))).toBe(60 + 60); // Fri 16:30 to Mon 10:00 BST
    expect(workingMinutesBetween(new Date("2026-10-10T10:00:00Z"), new Date("2026-10-11T10:00:00Z"))).toBe(0);
  });
});
