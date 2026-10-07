/**
 * When an email goes out. Used by the server (to run automation) and by the screens (to show an example of what a rule will do).
 *  - now:    right away
 *  - delay:  a number of minutes from now
 *  - at:     one chosen moment
 *  - window: the next time the clock in a time zone reads a given time, optionally skipping Saturdays and Sundays
 */
export type SendSchedule =
  | { mode: 'now' }
  | { mode: 'delay'; minutes: number }
  | { mode: 'at'; at: string }
  | { mode: 'window'; time: string; timeZone: string; businessDaysOnly: boolean };

/** Nothing is scheduled further out than this. */
export const MAX_SCHEDULE_DAYS = 60;
export const MAX_DELAY_MINUTES = MAX_SCHEDULE_DAYS * 24 * 60;

export function isValidTimeZone(timeZone: string) {
  try { new Intl.DateTimeFormat('en-US', { timeZone }).format(); return true; } catch { return false; }
}

function localParts(utcMs: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

/** How far ahead of UTC the clock in `timeZone` is, in minutes, at that instant. */
function offsetMinutes(utcMs: number, timeZone: string) {
  const local = localParts(utcMs, timeZone);
  return (Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second) - Math.floor(utcMs / 1000) * 1000) / 60000;
}

/** The instant when the clock in `timeZone` reads this date and time. */
export function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let result = guess - offsetMinutes(guess, timeZone) * 60000;
  const corrected = guess - offsetMinutes(result, timeZone) * 60000;
  if (corrected !== result) result = corrected;
  return result;
}

export function resolveSendAt(schedule: SendSchedule, now = new Date()): Date {
  const limit = now.getTime() + MAX_SCHEDULE_DAYS * 86400000;
  switch (schedule.mode) {
    case 'now': return new Date(now);
    case 'delay': return new Date(Math.min(limit, now.getTime() + Math.max(0, Math.floor(schedule.minutes)) * 60000));
    case 'at': {
      const at = Date.parse(schedule.at);
      return new Date(Number.isFinite(at) ? Math.min(limit, Math.max(at, now.getTime())) : now.getTime());
    }
    case 'window': {
      const [hour, minute] = schedule.time.split(':').map(Number) as [number, number];
      const today = localParts(now.getTime(), schedule.timeZone);
      let day = Date.UTC(today.year, today.month - 1, today.day);
      let at = zonedToUtc(today.year, today.month, today.day, hour, minute, schedule.timeZone);
      if (at < now.getTime() + 60000) day += 86400000;
      if (schedule.businessDaysOnly) while ([0, 6].includes(new Date(day).getUTCDay())) day += 86400000;
      const target = new Date(day);
      at = zonedToUtc(target.getUTCFullYear(), target.getUTCMonth() + 1, target.getUTCDate(), hour, minute, schedule.timeZone);
      return new Date(Math.min(limit, at));
    }
  }
}

/** A short reading of a moment for people: "Thu, Oct 8, 9:00 AM". */
export function describeMoment(moment: Date, timeZone?: string) {
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...(timeZone ? { timeZone } : {}) }).format(moment);
}

const clock = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Checks a schedule that came from outside; null if it is not usable. */
export function parseSendSchedule(value: unknown): SendSchedule | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  if (input.mode === 'now') return { mode: 'now' };
  if (input.mode === 'delay') {
    const minutes = Number(input.minutes);
    return Number.isInteger(minutes) && minutes >= 0 && minutes <= MAX_DELAY_MINUTES ? { mode: 'delay', minutes } : null;
  }
  if (input.mode === 'window') {
    if (typeof input.time !== 'string' || !clock.test(input.time) || typeof input.timeZone !== 'string' || !isValidTimeZone(input.timeZone)) return null;
    return { mode: 'window', time: input.time, timeZone: input.timeZone, businessDaysOnly: input.businessDaysOnly === true };
  }
  return null;
}
