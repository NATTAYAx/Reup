import { Task, CountdownResult, isCompletedThisCycle } from "../types";
import { toZonedTime } from "date-fns-tz";
import { t } from "./i18n";

const TIMEZONE = "Asia/Bangkok";

export function getNextReset(task: Task): Date | null {
  const now = new Date();
  const nowBangkok = toZonedTime(now, TIMEZONE);

  switch (task.reset_type) {
    case "daily":
      return getNextDaily(nowBangkok, task.reset_time!);

    case "weekly":
      return getNextWeekly(nowBangkok, task.reset_day!, task.reset_time!);

    case "biweekly":
      return getNextCycle(nowBangkok, task.anchor_date!, 14, task.reset_time!);

    case "custom_days":
      return getNextCycle(nowBangkok, task.anchor_date!, task.reset_interval_days!, task.reset_time!);

    case "one_time": {
      // one_time is kept for backward-compat with old DB rows only.
      // New tasks from AI chat use specific_date instead.
      if (!task.event_end) return null;
      // Normalize: space→T so WebKit parses correctly
      let normalized = task.event_end.includes('T')
        ? task.event_end
        : task.event_end.replace(' ', 'T');
      // If no timezone info (no Z, no +HH:MM), it was stored as Bangkok local — append +07:00
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(normalized)) {
        normalized += '+07:00';
      }
      const d = new Date(normalized);
      if (isNaN(d.getTime())) return null;
      return d;
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
        const [y, m, d] = raw.split("-").map(Number);
        return new Date(Date.UTC(y, m - 1, d, 16, 59, 59));
      }
      // Case 3: datetime with T but no Z/offset — treat as Bangkok local, append +07:00
      const ev = raw.includes('T') ? raw : raw.replace(' ', 'T');
      const normalized = /[Z+\-]\d{2}:\d{2}$/.test(ev) || ev.endsWith('Z') ? ev : ev + '+07:00';
      const d = new Date(normalized);
      if (isNaN(d.getTime())) {
        console.warn("[countdown] event_window Invalid Date for task", task.id, task.event_end);
        return null;
      }
      return d;
    }

    case "specific_date": {
      if (!task.specific_date) return null;
      const [y, m, d] = task.specific_date.split("-").map(Number);
      // End of that day in Bangkok time (UTC+7) — task stays visible until user marks done
      // Using Date.UTC + offset so it correctly represents 23:59:59 Bangkok time
      const bkkEndOfDay = new Date(Date.UTC(y, m - 1, d, 16, 59, 59)); // 23:59:59 BKK = 16:59:59 UTC
      return bkkEndOfDay;
    }

    default:
      return null;
  }
}

function getNextDaily(now: Date, resetTime: string): Date {
  const [hours, minutes] = resetTime.split(":").map(Number);
  const next = new Date(now);
  next.setHours(hours, minutes, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next;
}

function getNextWeekly(now: Date, resetDay: number, resetTime: string): Date {
  const [hours, minutes] = resetTime.split(":").map(Number);
  const next = new Date(now);
  next.setHours(hours, minutes, 0, 0);
  const currentDay = now.getDay();
  let daysUntil = resetDay - currentDay;
  if (daysUntil < 0 || (daysUntil === 0 && next <= now)) {
    daysUntil += 7;
  }
  next.setDate(next.getDate() + daysUntil);
  return next;
}

function getNextCycle(now: Date, anchorDate: string, intervalDays: number, resetTime: string): Date {
  const [hours, minutes] = resetTime.split(":").map(Number);
  const anchor = new Date(anchorDate);
  anchor.setHours(hours, minutes, 0, 0);
  const msPerCycle = intervalDays * 24 * 60 * 60 * 1000;
  const elapsed = now.getTime() - anchor.getTime();
  const cyclesPassed = Math.floor(elapsed / msPerCycle);
  const next = new Date(anchor.getTime() + (cyclesPassed + 1) * msPerCycle);
  return next;
}

export function calculateCountdown(task: Task): CountdownResult | null {
  try {
    const nextReset = getNextReset(task);
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
      next_reset: nextReset ?? new Date(),
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