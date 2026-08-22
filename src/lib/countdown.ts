import { Task, CountdownResult, isCompletedThisCycle } from "../types";
import { wallClock, wallToMs, addDays, atTime, dateStrToWall, getAppTimeZone, type Wall } from "./tz";
import { t } from "./i18n";

// ─── One rule for time, applied to every kind of task ─────────────────────────
//
// reset_time used to mean something only for the repeating kinds. A one-off task
// threw the time away — the parser nulled it, the form hid the field, and this
// file never read it — so "ประชุมทีม พฤหัส บ่ายสอง" quietly became a task due at
// 23:59. Ten hours late, with nothing anywhere saying so.
//
// Now reset_time is meaningful for ALL kinds, and follows the same rule every
// calendar uses:
//
//   reset_time is null  →  all day, due at 23:59:59 that day
//   reset_time is set   →  due at exactly that time
//
// Existing rows are untouched by this: repeating tasks already carry a time and
// keep behaving identically, one-off tasks carry null and still mean end of day.
// The change is only that the second case is now a choice rather than the only
// possibility.
//
// Every zone-aware conversion below goes through lib/tz. There is no "+07:00",
// no minus seven, and no 16:59:59 standing in for a Bangkok midnight anywhere in
// this file any more, and none of the arithmetic depends on what the machine's
// own clock is set to.

/** A wall-clock moment in the task's zone, as a real instant. */
function momentInZone(dateStr: string, time: string | null | undefined, zone: string): Date | null {
  const hhmm = parseHHMM(time);
  // No time means the whole day, which ends one second before the next one.
  const w = hhmm
    ? dateStrToWall(dateStr, hhmm.h, hhmm.m, 0)
    : dateStrToWall(dateStr, 23, 59, 59);
  return w ? new Date(wallToMs(w, zone)) : null;
}

interface HM { h: number; m: number }

function parseHHMM(time?: string | null): HM | null {
  if (!time) return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return { h, m };
}

/** Repeating kinds need a concrete time to aim at; with none, aim at end of day.
 *  Returns numbers rather than a string, so the helpers below do not each
 *  re-split the same "HH:MM" once per task on every tick of the render loop. */
const timeOrEndOfDay = (time?: string | null) => parseHHMM(time) ?? { h: 23, m: 59 };

/** A timestamp that carries no zone of its own is read as the app's zone, which
 *  is what the old code meant when it glued "+07:00" onto the end of one. */
function parseLooseInstant(raw: string, zone: string): Date | null {
  const s = raw.trim();
  if (!s) return null;
  if (/[Zz]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s)) {
    const d = new Date(s.includes("T") ? s : s.replace(" ", "T"));
    return isNaN(d.getTime()) ? null : d;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (m) {
    return new Date(wallToMs({
      y: +m[1], mo: +m[2], d: +m[3],
      h: +m[4], mi: +m[5], s: m[6] ? +m[6] : 0,
      dow: 0,
    }, zone));
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

export function getNextReset(task: Task): Date | null {
  const nowMs = Date.now();
  // A task pinned to a zone is read in that zone; otherwise it floats with the
  // app's. Both are cache hits after the first task of a tick.
  const zone = task.time_zone || getAppTimeZone();
  const now = wallClock(nowMs, zone);

  switch (task.reset_type) {
    case "daily":
      return getNextDaily(now, nowMs, timeOrEndOfDay(task.reset_time), zone);

    case "weekly":
      return getNextWeekly(now, nowMs, task.reset_day!, timeOrEndOfDay(task.reset_time), zone);

    case "biweekly":
      return getNextCycle(nowMs, task.anchor_date!, 14, timeOrEndOfDay(task.reset_time), zone);

    case "custom_days":
      return getNextCycle(nowMs, task.anchor_date!, task.reset_interval_days!, timeOrEndOfDay(task.reset_time), zone);

    case "one_time": {
      // one_time is kept for backward-compat with old DB rows only.
      // New tasks from AI chat use specific_date instead.
      if (!task.event_end) return null;
      // Normalize: space→T so WebKit parses correctly
      return parseLooseInstant(task.event_end, zone);
    }

    case "event_window": {
      if (!task.event_end) return null;
      const raw = task.event_end.trim();
      // Case 1: UTC "Z" string (from AI chat "อีก X นาที") — parse directly, always correct
      if (raw.includes('T') && raw.endsWith('Z')) {
        const d = new Date(raw);
        if (isNaN(d.getTime())) {
          console.warn("[countdown] event_window Invalid UTC Date for task", task.id, raw);
          return null;
        }
        return d;
      }
      // Case 2: date-only string "YYYY-MM-DD" (from manual AddTaskModal date picker)
      // Treat as end of that day in Bangkok time (23:59:59 UTC+7 = 16:59:59 UTC)
      if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        return momentInZone(raw, task.reset_time, zone);
      }
      // Case 3: a timestamp with no zone of its own, read as the app's zone.
      const d = parseLooseInstant(raw, zone);
      if (!d) {
        console.warn("[countdown] event_window Invalid Date for task", task.id, task.event_end);
        return null;
      }
      return d;
    }

    case "specific_date": {
      if (!task.specific_date) return null;
      // With a time it is an appointment, without one it is a deadline for the
      // day. Both are one-off tasks; only the precision differs.
      return momentInZone(task.specific_date, task.reset_time, zone);
    }

    default:
      return null;
  }
}

function getNextDaily(now: Wall, nowMs: number, { h, m: mi }: HM, zone: string): Date {
  let ms = wallToMs(atTime(now, h, mi), zone);
  if (ms <= nowMs) ms = wallToMs(atTime(addDays(now, 1), h, mi), zone);
  return new Date(ms);
}

function getNextWeekly(now: Wall, nowMs: number, resetDay: number, { h, m: mi }: HM, zone: string): Date {
  let daysUntil = resetDay - now.dow;
  if (daysUntil < 0) daysUntil += 7;
  let ms = wallToMs(atTime(addDays(now, daysUntil), h, mi), zone);
  // Landing on today but already past the time means it is next week.
  if (ms <= nowMs) ms = wallToMs(atTime(addDays(now, daysUntil + 7), h, mi), zone);
  return new Date(ms);
}

function getNextCycle(nowMs: number, anchorDate: string, intervalDays: number, { h, m: mi }: HM, zone: string): Date | null {
  if (!anchorDate || !intervalDays || intervalDays < 1) return null;
  const anchor = dateStrToWall(anchorDate, h, mi);
  if (!anchor) return null;

  // Whole cycles elapsed, then the boundary rebuilt as calendar days rather
  // than a fixed multiple of 86,400,000 ms — the two only agree in a zone with
  // no daylight saving.
  const cycleMs = intervalDays * 86_400_000;
  const elapsed = nowMs - wallToMs(anchor, zone);
  let n = Math.floor(elapsed / cycleMs) + 1;
  if (n < 0) n = 0; // anchor still in the future: the first one is the anchor

  let ms = wallToMs(addDays(anchor, n * intervalDays), zone);
  if (ms <= nowMs) ms = wallToMs(addDays(anchor, (n + 1) * intervalDays), zone);
  return new Date(ms);
}

/**
 * The kinds where leaving early is a thing that exists.
 *
 * A daily reset at four in the morning is not somewhere anybody travels to, and
 * shifting a recurring countdown would make every game task read as urgent an
 * hour before it is.
 */
const HAS_LEAD = new Set(["one_time", "specific_date", "event_window"]);

/** Minutes to subtract, or zero. Anything unusable is zero rather than an error. */
function leadMinutes(task: Task): number {
  if (!HAS_LEAD.has(task.reset_type)) return 0;
  const n = task.notify_before_min;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return 0;
  // A day of lead time on an appointment is somebody typing into the wrong box,
  // and the result would be a card that is already expired when it is created.
  return Math.min(n, 24 * 60);
}

export function calculateCountdown(task: Task): CountdownResult | null {
  try {
    const appointment = getNextReset(task);
    // What is counted down to is when this has to start, not when it happens.
    // Everything downstream follows from that on purpose: the colour turns red
    // an hour before leaving rather than an hour before arriving, and the
    // notifier fires against the same number, because a warning about a thing
    // you are already late to leave for is not a warning.
    const lead = leadMinutes(task);
    const nextReset = appointment && lead > 0
      ? new Date(appointment.getTime() - lead * 60_000)
      : appointment;
    // For completed one-shot tasks that are still active, show them as completed
    const completedThisCycle = isCompletedThisCycle(task);

    if (!nextReset && !completedThisCycle) return null;

    const now = new Date();
    const diffMs = nextReset ? nextReset.getTime() - now.getTime() : 0;

    // Guard: if diffMs is NaN (Invalid Date from bad event_end), skip this task safely
    if (isNaN(diffMs)) {
      console.warn("[countdown] NaN diffMs for task", task.id, task.name, "event_end=", task.event_end);
      return null;
    }

    const isRecurringType = ["daily", "weekly", "biweekly", "custom_days"].includes(task.reset_type);
    const isDeadlineType = ["one_time", "specific_date", "event_window"].includes(task.reset_type);

    // Recurring tasks: hide when expired (they'll reappear at next reset automatically)
    if (diffMs < 0 && !completedThisCycle && isRecurringType) return null;

    // Non-deadline tasks with no reset date and not done: hide
    if (!nextReset && !completedThisCycle && !isDeadlineType) return null;

    // CRITICAL FIX: Deadline tasks (specific_date, one_time, event_window) that have
    // passed must STAY visible showing "หมดเวลา". The user must manually mark/archive them.
    // Do NOT return null here — let them show with urgency = "expired".

    const totalMinutes = Math.floor(Math.max(diffMs, 0) / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    const seconds = Math.floor((Math.max(diffMs, 0) % 60000) / 1000);

    let urgency: CountdownResult["urgency"] = "safe";
    if (diffMs <= 0) urgency = "expired";
    else if (hours < 1) urgency = "critical";
    else if (hours < 6) urgency = "warning";

    return {
      task,
      // The appointment, so that anything asking when this happens still gets
      // the right answer. Only the counting moved.
      next_reset: appointment ?? new Date(),
      leave_by: lead > 0 ? nextReset : null,
      time_remaining_ms: Math.max(diffMs, 0),
      hours_remaining: hours,
      minutes_remaining: minutes,
      seconds_remaining: seconds,
      urgency,
      is_completed_this_cycle: completedThisCycle,
    };
  } catch (err) {
    console.error("[countdown] calculateCountdown error for task", task.id, task.name, err);
    return null;
  }
}

export function formatCountdown(result: CountdownResult): string {
  if (result.urgency === "expired") return t("countdown.expired");
  if (result.is_completed_this_cycle) return t("task.completedMark");
  const { hours_remaining, minutes_remaining, seconds_remaining } = result;
  if (hours_remaining >= 24) {
    const days = Math.floor(hours_remaining / 24);
    const remainingHours = hours_remaining % 24;
    return `${days}d ${remainingHours}h ${minutes_remaining}m`;
  }
  return `${String(hours_remaining).padStart(2, "0")}:${String(minutes_remaining).padStart(2, "0")}:${String(seconds_remaining).padStart(2, "0")}`;
}

export function getCategoryColor(category: string): string {
  switch (category) {
    case "game": return "from-purple-500 to-indigo-600";
    case "school": return "from-blue-500 to-cyan-600";
    case "work": return "from-orange-500 to-red-600";
    case "personal": return "from-green-500 to-teal-600";
    default: return "from-gray-500 to-gray-600";
  }
}

export function getUrgencyColor(urgency: string): string {
  switch (urgency) {
    case "safe": return "text-green-400";
    case "warning": return "text-yellow-400";
    case "critical": return "text-red-400";
    case "expired": return "text-gray-500";
    default: return "text-white";
  }
}