// MARK: heartbeat scheduler
//
// Pure time math: given a schedule string and the task's lastFiredAt,
// return the next fire time (or undefined if the schedule is malformed).
//
// Times are always in the LOCAL timezone of the process. This matches the
// behaviour described in the spec and keeps "7am" meaning what the user
// expects on a desktop.

import type { HeartbeatTaskDef } from "./types.js";

const WEEKDAYS: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const DAILY_RE = /^daily\s+(\d{1,2}):(\d{2})$/i;
const WEEKLY_RE = /^weekly\s+(mon|tue|wed|thu|fri|sat|sun)\s+(\d{1,2}):(\d{2})$/i;
const EVERY_RE = /^every\s+(\d+)\s+(minutes?|hours?)$/i;

export type ScheduleKind = "daily" | "weekly" | "every";

export interface ParsedSchedule {
  kind: ScheduleKind;
}

export function nextFireAfter(
  schedule: string,
  lastFiredAt: Date | undefined,
  now: Date,
): Date | undefined {
  const daily = schedule.match(DAILY_RE);
  if (daily) {
    const hour = Number(daily[1]);
    const minute = Number(daily[2]);
    if (!isValidHM(hour, minute)) return undefined;
    return nextDailyFire(hour, minute, lastFiredAt, now);
  }

  const weekly = schedule.match(WEEKLY_RE);
  if (weekly) {
    const weekday = WEEKDAYS[weekly[1]!.toLowerCase()]!;
    const hour = Number(weekly[2]);
    const minute = Number(weekly[3]);
    if (!isValidHM(hour, minute)) return undefined;
    return nextWeeklyFire(weekday, hour, minute, lastFiredAt, now);
  }

  const every = schedule.match(EVERY_RE);
  if (every) {
    const n = Number(every[1]);
    const unit = every[2]!.toLowerCase();
    if (!Number.isFinite(n) || n <= 0) return undefined;
    const intervalMs = unit.startsWith("hour") ? n * 3_600_000 : n * 60_000;
    if (!lastFiredAt) {
      // Never fired — fire at the next tick.
      return now;
    }
    return new Date(lastFiredAt.getTime() + intervalMs);
  }

  return undefined;
}

function isValidHM(h: number, m: number): boolean {
  return Number.isFinite(h) && Number.isFinite(m) && h >= 0 && h < 24 && m >= 0 && m < 60;
}

function nextDailyFire(
  hour: number,
  minute: number,
  lastFiredAt: Date | undefined,
  now: Date,
): Date {
  const candidate = setTime(now, hour, minute);
  // If today's slot already passed (or we've already fired it today), roll forward.
  if (candidate.getTime() <= now.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
  }
  // Never return a time at or before the last fire — push forward one day at a time.
  while (lastFiredAt && candidate.getTime() <= lastFiredAt.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate;
}

function nextWeeklyFire(
  weekday: number,
  hour: number,
  minute: number,
  lastFiredAt: Date | undefined,
  now: Date,
): Date {
  const candidate = setTime(now, hour, minute);
  const daysUntil = (weekday - candidate.getDay() + 7) % 7;
  candidate.setDate(candidate.getDate() + daysUntil);
  if (candidate.getTime() <= now.getTime()) {
    candidate.setDate(candidate.getDate() + 7);
  }
  while (lastFiredAt && candidate.getTime() <= lastFiredAt.getTime()) {
    candidate.setDate(candidate.getDate() + 7);
  }
  return candidate;
}

function setTime(ref: Date, hour: number, minute: number): Date {
  const d = new Date(ref);
  d.setHours(hour, minute, 0, 0);
  return d;
}

/**
 * Most recent scheduled fire time at or before `now`. Returns undefined for
 * `every N` schedules (which don't have wall-clock slots) or malformed input.
 */
function latestPastSlot(schedule: string, now: Date): Date | undefined {
  const daily = schedule.match(DAILY_RE);
  if (daily) {
    const hour = Number(daily[1]);
    const minute = Number(daily[2]);
    if (!isValidHM(hour, minute)) return undefined;
    const candidate = setTime(now, hour, minute);
    if (candidate.getTime() > now.getTime()) {
      candidate.setDate(candidate.getDate() - 1);
    }
    return candidate;
  }
  const weekly = schedule.match(WEEKLY_RE);
  if (weekly) {
    const weekday = WEEKDAYS[weekly[1]!.toLowerCase()]!;
    const hour = Number(weekly[2]);
    const minute = Number(weekly[3]);
    if (!isValidHM(hour, minute)) return undefined;
    const candidate = setTime(now, hour, minute);
    const dayOffset = (weekday - candidate.getDay() + 7) % 7;
    candidate.setDate(candidate.getDate() + dayOffset);
    if (candidate.getTime() > now.getTime()) {
      candidate.setDate(candidate.getDate() - 7);
    }
    return candidate;
  }
  return undefined;
}

/**
 * Decide whether a task is due right now.
 *
 * Rules:
 * - Disabled tasks are never due.
 * - `every N` schedules: due when `now >= lastFiredAt + interval`, or
 *   immediately if never fired (eager first tick).
 * - `daily` / `weekly` schedules: due when the most recent scheduled slot has
 *   passed AND `lastFiredAt` is either missing or older than that slot.
 *   A task added mid-day with a past slot fires at the next tick — missed
 *   slots are not "caught up" further than once.
 *
 * `nextFireAt` in the return value is always the next strictly-future slot,
 * useful for status UIs.
 */
export function isDue(
  task: HeartbeatTaskDef,
  lastFiredAt: Date | undefined,
  now: Date,
): { due: boolean; nextFireAt?: Date } {
  if (task.enabled === false) return { due: false };
  const next = nextFireAfter(task.schedule, lastFiredAt, now);

  const every = task.schedule.match(EVERY_RE);
  if (every) {
    const n = Number(every[1]);
    const unit = every[2]!.toLowerCase();
    if (!Number.isFinite(n) || n <= 0) return { due: false };
    const intervalMs = unit.startsWith("hour") ? n * 3_600_000 : n * 60_000;
    if (!lastFiredAt) return { due: true, nextFireAt: next };
    return {
      due: now.getTime() >= lastFiredAt.getTime() + intervalMs,
      nextFireAt: next,
    };
  }

  const past = latestPastSlot(task.schedule, now);
  if (!past) return { due: false, nextFireAt: next };
  const due = !lastFiredAt || lastFiredAt.getTime() < past.getTime();
  return { due, nextFireAt: next };
}
