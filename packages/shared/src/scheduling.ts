import { DateTime } from "luxon";
import type { IntervalConfig } from "./schemas/schedule.js";

// Computes the next fire time for a recurring schedule, DST-safely, in
// the schedule's own IANA time zone (REQUIREMENTS.md §2.4). Shared
// between the Worker (to actually schedule runs) and the API (to preview
// "next run" in the UI) so the two never disagree.
export function computeNextFireTime(
  intervalConfig: IntervalConfig,
  timezone: string,
  from: Date = new Date(),
): Date {
  const fromDt = DateTime.fromJSDate(from, { zone: timezone });

  switch (intervalConfig.kind) {
    case "every_n_minutes":
      return fromDt.plus({ minutes: intervalConfig.minutes }).toJSDate();

    case "every_n_hours": {
      const next = fromDt.plus({ hours: intervalConfig.hours }).set({
        minute: intervalConfig.atMinute,
        second: 0,
        millisecond: 0,
      });
      return (next > fromDt ? next : next.plus({ hours: intervalConfig.hours })).toJSDate();
    }

    case "daily": {
      const [hour, minute] = parseHHmm(intervalConfig.atTime);
      let next = fromDt.set({ hour, minute, second: 0, millisecond: 0 });
      if (next <= fromDt) {
        next = next.plus({ days: 1 });
      }
      return next.toJSDate();
    }

    case "weekly": {
      const [hour, minute] = parseHHmm(intervalConfig.atTime);
      const candidates = intervalConfig.daysOfWeek
        .map((dow) => nextWeekday(fromDt, dow, hour, minute))
        .sort((a, b) => a.toMillis() - b.toMillis());
      const soonest = candidates[0];
      if (!soonest) {
        throw new Error("weekly schedule must specify at least one day of week");
      }
      return soonest.toJSDate();
    }
  }
}

function parseHHmm(value: string): [number, number] {
  const [h, m] = value.split(":").map(Number);
  return [h ?? 0, m ?? 0];
}

// Luxon weekday: 1 (Monday) .. 7 (Sunday). Our schema uses 0 (Sunday) .. 6
// (Saturday), matching JS Date.getDay() convention for UI familiarity.
function nextWeekday(from: DateTime, dowSundayBased: number, hour: number, minute: number): DateTime {
  const luxonWeekday = dowSundayBased === 0 ? 7 : dowSundayBased;
  let candidate = from.set({ hour, minute, second: 0, millisecond: 0 });
  let daysToAdd = (luxonWeekday - from.weekday + 7) % 7;
  candidate = candidate.plus({ days: daysToAdd });
  if (candidate <= from) {
    candidate = candidate.plus({ weeks: 1 });
  }
  return candidate;
}
