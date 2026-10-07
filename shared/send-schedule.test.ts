import { describe, expect, it } from 'vitest';
import { MAX_SCHEDULE_DAYS, resolveSendAt, zonedToUtc } from './send-schedule.js';

const now = new Date('2026-10-07T20:30:00.000Z'); // a Wednesday

describe('resolving when an email goes out', () => {
  it('sends right away, or after a delay', () => {
    expect(resolveSendAt({ mode: 'now' }, now).toISOString()).toBe(now.toISOString());
    expect(resolveSendAt({ mode: 'delay', minutes: 90 }, now).toISOString()).toBe('2026-10-07T22:00:00.000Z');
  });

  it('never goes into the past or further out than the limit', () => {
    expect(resolveSendAt({ mode: 'at', at: '2026-01-01T00:00:00.000Z' }, now).toISOString()).toBe(now.toISOString());
    expect(resolveSendAt({ mode: 'at', at: 'not a date' }, now).toISOString()).toBe(now.toISOString());
    const far = resolveSendAt({ mode: 'at', at: '2030-01-01T00:00:00.000Z' }, now);
    expect(far.getTime() - now.getTime()).toBe(MAX_SCHEDULE_DAYS * 86400000);
    expect(resolveSendAt({ mode: 'delay', minutes: 10_000_000 }, now).getTime() - now.getTime()).toBe(MAX_SCHEDULE_DAYS * 86400000);
  });

  it('picks the next time the clock in a time zone reads the chosen time', () => {
    // 20:30 UTC is 02:00 on Thursday in India, so 09:00 there is later the same day.
    expect(resolveSendAt({ mode: 'window', time: '09:00', timeZone: 'Asia/Kolkata', businessDaysOnly: false }, now).toISOString()).toBe('2026-10-08T03:30:00.000Z');
    // 13:30 on Wednesday in Los Angeles: 09:00 has passed, so it is Thursday.
    expect(resolveSendAt({ mode: 'window', time: '09:00', timeZone: 'America/Los_Angeles', businessDaysOnly: false }, now).toISOString()).toBe('2026-10-08T16:00:00.000Z');
    // 15:00 has not passed yet in Los Angeles.
    expect(resolveSendAt({ mode: 'window', time: '15:00', timeZone: 'America/Los_Angeles', businessDaysOnly: false }, now).toISOString()).toBe('2026-10-07T22:00:00.000Z');
  });

  it('skips the weekend when asked to', () => {
    const friday = new Date('2026-10-09T18:00:00.000Z'); // 11:00 Friday in Los Angeles
    expect(resolveSendAt({ mode: 'window', time: '09:00', timeZone: 'America/Los_Angeles', businessDaysOnly: true }, friday).toISOString()).toBe('2026-10-12T16:00:00.000Z');
    expect(resolveSendAt({ mode: 'window', time: '09:00', timeZone: 'America/Los_Angeles', businessDaysOnly: false }, friday).toISOString()).toBe('2026-10-10T16:00:00.000Z');
  });

  it('follows daylight saving time', () => {
    // The clocks in Los Angeles go back on 1 November 2026: 09:00 is UTC-7 before and UTC-8 after.
    expect(new Date(zonedToUtc(2026, 10, 31, 9, 0, 'America/Los_Angeles')).toISOString()).toBe('2026-10-31T16:00:00.000Z');
    expect(new Date(zonedToUtc(2026, 11, 2, 9, 0, 'America/Los_Angeles')).toISOString()).toBe('2026-11-02T17:00:00.000Z');
    const saturday = new Date('2026-10-31T20:00:00.000Z');
    expect(resolveSendAt({ mode: 'window', time: '09:00', timeZone: 'America/Los_Angeles', businessDaysOnly: true }, saturday).toISOString()).toBe('2026-11-02T17:00:00.000Z');
  });
});
