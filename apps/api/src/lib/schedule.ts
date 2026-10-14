/**
 * Timezone-aware reminder scheduling (pure functions, no I/O).
 *
 * Invoice due dates are calendar dates ("YYYY-MM-DD"). A step with
 * `delayDays = +7` fires on due date + 7 days at the tenant's configured send
 * hour, in the tenant's timezone — so a customer in Sydney gets their reminder
 * at 9:00 their time, not at 00:00 UTC. Optionally weekends are skipped:
 * pre-due reminders move back to Friday (so they still arrive before the due
 * date), post-due reminders move forward to Monday.
 */

export type ScheduleOptions = {
  timezone: string;
  sendHour: number;
  skipWeekends: boolean;
};

const DEFAULT_OPTIONS: ScheduleOptions = { timezone: "UTC", sendHour: 9, skipWeekends: false };

const tzCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = tzCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    tzCache.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    formatter(tz).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function safeZone(tz: string | null | undefined): string {
  return tz && isValidTimeZone(tz) ? tz : "UTC";
}

/** Wall-clock parts of an instant in a timezone. */
function zonedParts(instantMs: number, timeZone: string) {
  const parts = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(new Date(instantMs))
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, Number(p.value)]),
  ) as Record<"year" | "month" | "day" | "hour" | "minute" | "second", number>;
  return parts;
}

/** Offset (ms) of `timeZone` from UTC at a given instant. */
function tzOffsetMs(instantMs: number, timeZone: string): number {
  const p = zonedParts(instantMs, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/** The UTC instant at which the wall clock in `timeZone` reads `ymd hour:00`. DST-safe. */
export function zonedTimeToUtc(ymd: string, hour: number, timeZone: string): Date {
  const [y, m, d] = parseYmd(ymd);
  const guess = Date.UTC(y, m - 1, d, hour, 0, 0);
  const first = guess - tzOffsetMs(guess, timeZone);
  // Re-evaluate at the candidate instant so a DST change between guess and
  // result is accounted for.
  const second = guess - tzOffsetMs(first, timeZone);
  return new Date(second);
}

export function parseYmd(ymd: string): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  if (!m) throw new Error(`Invalid calendar date: ${ymd}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function formatYmd(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function addCalendarDays(ymd: string, days: number): string {
  const [y, m, d] = parseYmd(ymd);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return formatYmd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** 0 = Sunday … 6 = Saturday */
export function weekday(ymd: string): number {
  const [y, m, d] = parseYmd(ymd);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Today's calendar date in a timezone. */
export function todayInZone(now: Date, timeZone: string): string {
  const p = zonedParts(now.getTime(), safeZone(timeZone));
  return formatYmd(p.year, p.month, p.day);
}

/** Days from `today` to `ymd` (negative = in the past). */
export function daysBetween(fromYmd: string, toYmd: string): number {
  const [a, b, c] = parseYmd(fromYmd);
  const [x, y, z] = parseYmd(toYmd);
  return Math.round((Date.UTC(x, y - 1, z) - Date.UTC(a, b - 1, c)) / 86_400_000);
}

/**
 * When should a step fire?
 * @param dueDate invoice due date ("YYYY-MM-DD"); invoices without one are anchored to today
 */
export function scheduledSendTime(
  dueDate: string | null,
  delayDays: number,
  options: Partial<ScheduleOptions> = {},
  now: Date = new Date(),
): Date {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const tz = safeZone(opts.timezone);
  const hour = Number.isInteger(opts.sendHour) && opts.sendHour >= 0 && opts.sendHour <= 23 ? opts.sendHour : 9;
  const anchor = dueDate ?? todayInZone(now, tz);
  let target = addCalendarDays(anchor, delayDays);
  if (opts.skipWeekends) {
    const wd = weekday(target);
    if (wd === 6) target = addCalendarDays(target, delayDays < 0 ? -1 : 2); // Sat -> Fri / Mon
    else if (wd === 0) target = addCalendarDays(target, delayDays < 0 ? -2 : 1); // Sun -> Fri / Mon
  }
  return zonedTimeToUtc(target, hour, tz);
}

/**
 * Catch-up: the index of the step that should be sent now. When an invoice is
 * imported late (or the engine was down), several steps may already be due —
 * only the MOST RECENT one is sent; earlier ones are skipped instead of being
 * fired in rapid succession. Returns -1 when nothing is due yet.
 */
export function stepToSend(
  steps: { delayDays: number }[],
  fromIndex: number,
  dueDate: string | null,
  options: Partial<ScheduleOptions>,
  now: Date,
): number {
  let found = -1;
  for (let i = fromIndex; i < steps.length; i++) {
    if (scheduledSendTime(dueDate, steps[i].delayDays, options, now).getTime() <= now.getTime()) found = i;
    else break;
  }
  return found;
}
