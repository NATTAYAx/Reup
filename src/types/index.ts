export type ResetType =
  | "daily"
  | "weekly"
  | "biweekly"
  | "custom_days"
  | "one_time"
  | "event_window"
  | "specific_date";

export type Category = "game" | "school" | "work" | "personal";

export interface Task {
  id: number;
  name: string;
  description: string;
  category: Category;
  reset_type: ResetType;
  reset_time: string | null;
  reset_day: number | null;
  reset_interval_days: number | null;
  anchor_date: string | null;
  event_start: string | null;
  event_end: string | null;
  specific_date: string | null;
  is_priority: boolean;
  is_urgent: boolean;
  is_active: boolean;
  completed_until: string | null;  // ISO datetime — task is "done" until this time
  /** Null means the time floats: it is read in whatever zone the app is set to,
   *  so "20:00" stays 20:00 wherever you are. A zone name pins it there instead,
   *  for times that belong to somewhere else and should not move when you do —
   *  a game's 04:00 server reset is 04:00 there whether or not you have flown
   *  anywhere. Every existing row is null, which is exactly today's behaviour. */
  /** The smallest version of this task that still counts. Behavioural
   *  activation's graded task assignment, in one field. */
  min_step: string | null;
  time_zone: string | null;
  /** Why this is on the list. "want" = done because you want to, "must" =
   *  because it has to be. Null on every existing row and on anything nobody
   *  bothered to answer, which is fine — it is read as unknown, never as
   *  obligation. One bit, because the behavioural activation model this comes
   *  from is about whether a week contains any positive reinforcement at all,
   *  not about grading how much. */
  intent: "want" | "must" | null;
  /** The reset boundary already accounted for by lib/cycles. Not shown. */
  cycle_checked_until: string | null;
  /** Consecutive missed cycles. Not shown, not a score; it decides one thing
   *  (whether to ask for the smallest version instead) and a single completion
   *  resets it to zero. */
  missed_streak: number;
  /**
   * Set while the task is deliberately set aside. Null means running.
   *
   * A task used to have two states, alive or deleted, and real life has a
   * third: still yours, not this month. Without it the only ways to stop a task
   * asking were to delete it — which throws away the setup and reads like
   * giving up — or to ignore it, which trains ignoring the whole list and lets
   * missed_streak climb for something never intended to be done. Neither is an
   * answer the app should force.
   *
   * An ISO datetime, or PAUSE_FOREVER for no end date. While paused the task is
   * out of the list, out of the notifier, and out of cycle bookkeeping, so
   * coming back carries no debt.
   */
  paused_until: string | null;
  /**
   * When the person deleted it. Null on rows that reached is_active = 0 some
   * other way — one-shots archive themselves after they are done, and those are
   * finished, not thrown away, so they must not appear in a bin offering to
   * bring them back.
   */
  deleted_at: string | null;
  created_at: string;
}

/** paused_until for "no end date". A real datetime rather than a magic string
 *  so that every comparison in the codebase keeps working unchanged. */
export const PAUSE_FOREVER = "9999-12-31T00:00:00.000Z";

/** Paused right now? Compared in JS on purpose: these are ISO strings with a T
 *  and a Z in them, and SQLite's datetime() is not, so a SQL string comparison
 *  between the two is wrong in ways that only show up some hours of the day. */
export function isPaused(task: { paused_until?: string | null }, now: Date = new Date()): boolean {
  if (!task.paused_until) return false;
  const until = Date.parse(task.paused_until);
  return !isNaN(until) && until > now.getTime();
}

export interface CountdownResult {
  task: Task;
  next_reset: Date;
  time_remaining_ms: number;
  hours_remaining: number;
  minutes_remaining: number;
  seconds_remaining: number;
  urgency: "safe" | "warning" | "critical" | "expired";
  is_completed_this_cycle: boolean;  // true if done for current cycle
}

/** Whether a task is currently marked as completed for this cycle */
export function isCompletedThisCycle(task: Task): boolean {
  if (!task.completed_until) return false;
  return new Date(task.completed_until) > new Date();
}

/** Is this a recurring task (auto-resets)? */
export function isRecurring(task: Task): boolean {
  return ["daily", "weekly", "biweekly", "custom_days"].includes(task.reset_type);
}

/** Is this a one-shot task (done = gone)? */
export function isOneShot(task: Task): boolean {
  return ["one_time", "event_window", "specific_date"].includes(task.reset_type);
}