import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { computeNextFireTime } from "./scheduling.js";

describe("computeNextFireTime", () => {
  describe("every_n_minutes", () => {
    it("advances by exactly the configured number of minutes", () => {
      const from = new Date("2026-01-01T10:00:00.000Z");
      const next = computeNextFireTime({ kind: "every_n_minutes", minutes: 15 }, "UTC", from);
      expect(next.toISOString()).toBe("2026-01-01T10:15:00.000Z");
    });
  });

  describe("every_n_hours", () => {
    // Regression for #18: adding the full interval before aligning the
    // minute skipped the valid same-cycle occurrence whenever atMinute
    // was still ahead of `from` — "every 1 hour at :30" from 10:00
    // incorrectly returned 11:30 instead of 10:30.
    it("fires at the target minute within the current hour when that hasn't passed yet", () => {
      const from = new Date("2026-01-01T10:00:00.000Z");
      const next = computeNextFireTime({ kind: "every_n_hours", hours: 1, atMinute: 30 }, "UTC", from);
      expect(next.toISOString()).toBe("2026-01-01T10:30:00.000Z");
    });

    it("advances a full interval once the target minute has already passed", () => {
      const from = new Date("2026-01-01T10:35:00.000Z");
      const next = computeNextFireTime({ kind: "every_n_hours", hours: 1, atMinute: 30 }, "UTC", from);
      expect(next.toISOString()).toBe("2026-01-01T11:30:00.000Z");
    });

    it("maintains a consistent cadence when chained from its own previous result", () => {
      const first = computeNextFireTime(
        { kind: "every_n_hours", hours: 3, atMinute: 15 },
        "UTC",
        new Date("2026-01-01T08:00:00.000Z"),
      );
      expect(first.toISOString()).toBe("2026-01-01T08:15:00.000Z");
      const second = computeNextFireTime({ kind: "every_n_hours", hours: 3, atMinute: 15 }, "UTC", first);
      expect(second.toISOString()).toBe("2026-01-01T11:15:00.000Z");
    });
  });

  describe("daily", () => {
    it("fires today if the target time hasn't passed yet", () => {
      const from = new Date("2026-01-01T08:00:00.000Z");
      const next = computeNextFireTime({ kind: "daily", atTime: "09:00" }, "UTC", from);
      expect(next.toISOString()).toBe("2026-01-01T09:00:00.000Z");
    });

    it("rolls over to tomorrow once the target time has passed", () => {
      const from = new Date("2026-01-01T09:30:00.000Z");
      const next = computeNextFireTime({ kind: "daily", atTime: "09:00" }, "UTC", from);
      expect(next.toISOString()).toBe("2026-01-02T09:00:00.000Z");
    });

    it("handles the DST spring-forward transition (America/New_York, 2026-03-08)", () => {
      // Clocks jump 02:00 -> 03:00 local; 02:30 never happens on this
      // day. Luxon rolls a nonexistent local time forward automatically
      // — assert the resulting instant is the real 03:30 EDT moment,
      // not silently 2:30 EST or some other wrong instant.
      const from = DateTime.fromObject(
        { year: 2026, month: 3, day: 8, hour: 1, minute: 0 },
        { zone: "America/New_York" },
      ).toJSDate();
      const next = computeNextFireTime({ kind: "daily", atTime: "02:30" }, "America/New_York", from);
      const nextLocal = DateTime.fromJSDate(next).setZone("America/New_York");
      expect(nextLocal.toFormat("yyyy-MM-dd HH:mm")).toBe("2026-03-08 03:30");
      expect(nextLocal.offsetNameShort).toBe("EDT");
    });

    it("handles the DST fall-back transition (America/New_York, 2026-11-01)", () => {
      // Clocks repeat 01:00-02:00 local (EDT then EST); a schedule
      // anchored just before the transition should still resolve to a
      // real, unambiguous instant on the correct side of it.
      const from = DateTime.fromObject(
        { year: 2026, month: 11, day: 1, hour: 0, minute: 0 },
        { zone: "America/New_York" },
      ).toJSDate();
      const next = computeNextFireTime({ kind: "daily", atTime: "01:30" }, "America/New_York", from);
      const nextLocal = DateTime.fromJSDate(next).setZone("America/New_York");
      expect(nextLocal.toFormat("yyyy-MM-dd HH:mm")).toBe("2026-11-01 01:30");
      // Luxon's default disambiguation for an ambiguous repeated local
      // time picks the first occurrence (still in EDT/-04:00).
      expect(nextLocal.offsetNameShort).toBe("EDT");
    });
  });

  describe("weekly", () => {
    // 2026-01-01 is a Thursday.
    it("picks the soonest of multiple selected days", () => {
      const from = new Date("2026-01-01T00:00:00.000Z"); // Thursday
      // Sunday (0) and Saturday (6) are both still ahead; Saturday
      // (2026-01-03) is soonest.
      const next = computeNextFireTime(
        { kind: "weekly", daysOfWeek: [0, 6], atTime: "10:00" },
        "UTC",
        from,
      );
      expect(next.toISOString()).toBe("2026-01-03T10:00:00.000Z");
    });

    it("rolls over to next week when the only selected day already passed this week", () => {
      const from = new Date("2026-01-01T12:00:00.000Z"); // Thursday, after 10:00
      const next = computeNextFireTime(
        { kind: "weekly", daysOfWeek: [4], atTime: "10:00" }, // Thursday
        "UTC",
        from,
      );
      expect(next.toISOString()).toBe("2026-01-08T10:00:00.000Z");
    });

    it("fires later the same day if the target day is today and the time hasn't passed", () => {
      const from = new Date("2026-01-01T08:00:00.000Z"); // Thursday, before 10:00
      const next = computeNextFireTime(
        { kind: "weekly", daysOfWeek: [4], atTime: "10:00" },
        "UTC",
        from,
      );
      expect(next.toISOString()).toBe("2026-01-01T10:00:00.000Z");
    });
  });
});
