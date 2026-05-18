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
  created_at: string;
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