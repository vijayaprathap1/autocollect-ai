import { describe, expect, it } from "vitest";
import { addCalendarDays, isValidTimeZone, scheduledSendTime, stepToSend, todayInZone, weekday, zonedTimeToUtc } from "./schedule.js";

describe("calendar helpers", () => {
  it("adds days across month/year boundaries", () => {
    expect(addCalendarDays("2026-12-30", 3)).toBe("2027-01-02");
    expect(addCalendarDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addCalendarDays("2028-03-01", -1)).toBe("2028-02-29"); // leap year
  });

  it("computes weekdays", () => {
    expect(weekday("2026-10-03")).toBe(6); // Saturday
    expect(weekday("2026-10-05")).toBe(1); // Monday
  });

  it("validates time zones", () => {
    expect(isValidTimeZone("Asia/Kolkata")).toBe(true);
    expect(isValidTimeZone("Mars/Base")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });

  it("finds today's date in a zone", () => {
    const now = new Date("2026-09-25T20:00:00Z");
    expect(todayInZone(now, "UTC")).toBe("2026-09-25");
    expect(todayInZone(now, "Asia/Kolkata")).toBe("2026-09-26"); // 01:30 next day
    expect(todayInZone(now, "America/Los_Angeles")).toBe("2026-09-25");
  });
});

describe("zonedTimeToUtc", () => {
  it("converts local wall time to UTC", () => {
    expect(zonedTimeToUtc("2026-09-25", 9, "Asia/Kolkata").toISOString()).toBe("2026-09-25T03:30:00.000Z");
    expect(zonedTimeToUtc("2026-09-25", 9, "UTC").toISOString()).toBe("2026-09-25T09:00:00.000Z");
  });

  it("is DST-correct on both sides of a transition", () => {
    // New York: EDT (UTC-4) before Nov 1 2026, EST (UTC-5) after.
    expect(zonedTimeToUtc("2026-10-30", 9, "America/New_York").toISOString()).toBe("2026-10-30T13:00:00.000Z");
    expect(zonedTimeToUtc("2026-11-02", 9, "America/New_York").toISOString()).toBe("2026-11-02T14:00:00.000Z");
  });
});

describe("scheduledSendTime", () => {
  const opts = { timezone: "UTC", sendHour: 9, skipWeekends: false };

  it("fires at the send hour relative to the due date", () => {
    expect(scheduledSendTime("2026-10-10", 7, opts).toISOString()).toBe("2026-10-17T09:00:00.000Z");
    expect(scheduledSendTime("2026-10-10", -2, opts).toISOString()).toBe("2026-10-08T09:00:00.000Z");
  });

  it("moves pre-due weekend reminders back to Friday and overdue ones to Monday", () => {
    const w = { ...opts, skipWeekends: true };
    // due Mon 2026-10-05: -2 => Sat 10-03 -> Fri 10-02
    expect(scheduledSendTime("2026-10-05", -2, w).toISOString()).toBe("2026-10-02T09:00:00.000Z");
    // due Thu 2026-10-01: +3 => Sun 10-04 -> Mon 10-05
    expect(scheduledSendTime("2026-10-01", 3, w).toISOString()).toBe("2026-10-05T09:00:00.000Z");
  });

  it("falls back to safe defaults for bad settings", () => {
    expect(scheduledSendTime("2026-10-10", 0, { timezone: "Not/AZone", sendHour: 99, skipWeekends: false }).toISOString()).toBe(
      "2026-10-10T09:00:00.000Z",
    );
  });
});

describe("stepToSend (catch-up)", () => {
  const steps = [{ delayDays: -2 }, { delayDays: 1 }, { delayDays: 7 }, { delayDays: 14 }];
  const opts = { timezone: "UTC", sendHour: 9, skipWeekends: false };

  it("returns -1 when nothing is due yet", () => {
    expect(stepToSend(steps, 0, "2026-10-20", opts, new Date("2026-10-01T00:00:00Z"))).toBe(-1);
  });

  it("returns the current step when exactly one is due", () => {
    expect(stepToSend(steps, 0, "2026-10-20", opts, new Date("2026-10-18T10:00:00Z"))).toBe(0);
  });

  it("skips to the most recent due step for long-overdue invoices", () => {
    expect(stepToSend(steps, 0, "2026-09-01", opts, new Date("2026-09-25T10:00:00Z"))).toBe(3);
    expect(stepToSend(steps, 1, "2026-09-01", opts, new Date("2026-09-09T10:00:00Z"))).toBe(2);
  });
});
