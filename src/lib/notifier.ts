/**
 * notifier.ts — v5
 *
 * BUG FIXED: Second (and later) notifications silently skipped.
 *
 * ROOT CAUSE:
 * buildKey() included `deadlineMin` (next_reset floored to the minute).
 * pruneOld() only ran every 30 seconds AND only saw tasks still in the
 * active list — but expired tasks are filtered OUT before checkAndNotify()
 * in useCountdowns.ts, so their keys lingered in _notified forever.
 *
 * When you delete a test task and create a NEW one, SQLite autoincrement
 * gives the new task the next available ID. But more critically, even a
 * fresh task with a brand-new ID can fail if pruneOld() hasn't cleaned up
 * yet and the Set still holds the key from a same-ID predecessor.
 *
 * Also: for recurring tasks (daily etc.), next_reset changes every cycle.
 * The old key with the old deadlineMin stays in _notified, so the task
 * fires once and then NEVER fires again across reset boundaries.
 *
 * FIX:
 * 1. pruneOld() runs every tick and removes keys for ANY taskId not in
 *    the current active list (including just-expired tasks).
 * 2. buildKey() is now just `${taskId}-${tier}` — no deadlineMin.
 *    This means each task fires once per session per tier, which is the
 *    correct dedup behaviour. When the cycle resets, pruneOld() clears
 *    the key so it can fire again next cycle.
 * 3. Deadline edits are detected and keys cleared so re-fire works.
 */

import { invoke } from "@tauri-apps/api/core";
import { recordNotify } from "./notifyLog";
import { parseQuiet, putSetting, QUIET_KEY } from "./userSettings";
import { CountdownResult } from "../types";
import { wallClock } from "./tz";

const INVOKE_TIMEOUT = 3_000;
const FINAL_WARN_MS  = 10 * 60 * 1000;
const MIN_NOTIFY_MS  = 10_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) =>
      setTimeout(() => rej(new Error(`invoke timeout ${ms}ms`)), ms)
    ),
  ]);
}

// Dedup set. Keys: "${taskId}-main" | "${taskId}-final"
// Pruned eagerly every tick so expired/deleted tasks don't block re-use of their IDs.
const _notified = new Set<string>();

// Tracks last-seen deadline per taskId to detect edits
const _lastDeadline = new Map<number, number>();

function pruneOld(activeTaskIds: number[]) {
  const ids = new Set(activeTaskIds);
  for (const key of _notified) {
    const taskId = parseInt(key.split("-")[0], 10);
    if (!ids.has(taskId)) {
      _notified.delete(key);
    }
  }
  // Also clean deadline cache for gone tasks
  for (const id of _lastDeadline.keys()) {
    if (!ids.has(id)) _lastDeadline.delete(id);
  }
}

// ─── Quiet hours ──────────────────────────────────────────────────────────────
//
// Mute used to be the only control, and it is all-or-nothing: either every
// reminder or none of them. That is the wrong shape for the actual problem,
// which is not "reminders are unwelcome" but "a chime at five in the morning
// costs a night's sleep". A window is the smaller, truer setting.
//
// TWO THINGS HERE ARE EASY TO GET WRONG.
//
// 1. A SUPPRESSED NOTIFICATION MUST NOT COUNT AS FIRED. The dedup set is what
//    stops a reminder repeating; if a quiet-hours skip wrote to it, the
//    reminder would be cancelled rather than delayed and would never arrive.
//    So the check below returns before _notified is touched, which also means
//    catch-up is free: the moment the window ends, the next tick finds the
//    reminder still unsent and still inside its window, and sends it.
//
// 2. SILENCE MUST NOT CAUSE THE MISS IT WAS MEANT TO PREVENT. If the thing is
//    actually DUE during the quiet window, staying silent is not a kindness —
//    the reminder would arrive after the deadline, which is the same as never.
//    So a task whose deadline falls inside the current window is exempt and
//    rings anyway. Quiet hours delay reminders; they do not eat deadlines.

export interface QuietHours {
  enabled: boolean;
  /** "HH:MM" in the app's timezone. */
  start: string;
  /** "HH:MM". Earlier than start means the window crosses midnight. */
  end: string;
}

const QUIET_DEFAULT: QuietHours = { enabled: false, start: "23:00", end: "08:00" };

/**
 * Reads the cache, parses with the one parser.
 *
 * The parsing moved to userSettings.ts because the phone has to reach the same
 * answer from the same string, and a second reading of it here is the second
 * implementation that would drift. What stays here is this app's own shape for
 * it, which has an `enabled` flag where the shared type has a third case.
 */
export function getQuietHours(): QuietHours {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(QUIET_KEY);
  } catch {
    return QUIET_DEFAULT;
  }
  const q = parseQuiet(raw);
  // `unknown` and `off` are the same answer to this caller: do not be quiet.
  // They are only told apart on a device that has never been told anything,
  // which is the phone before its first sync. See userSettings.ts.
  if (q.kind !== "window") return QUIET_DEFAULT;
  return { enabled: true, start: q.start, end: q.end };
}

export function setQuietHours(q: QuietHours) {
  // Through the mirror rather than straight to localStorage, so the phone stops
  // having to guess what night means here. See userSettings.ts.
  putSetting(QUIET_KEY, JSON.stringify(q));
}

const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

/**
 * Where `at` sits relative to the window, and when the window ends.
 *
 * `endsAt` is what makes the deadline exemption possible: without knowing when
 * quiet is over, there is no way to ask whether the deadline lands inside it.
 * Returns null when quiet hours are off or `at` is outside the window.
 *
 * A start equal to the end is treated as OFF, not as twenty-four hours of
 * silence. Someone who sets both to 08:00 has made a mistake, and the failure
 * that loses every reminder forever is not the one to pick.
 */
export function quietWindowEnd(at: number = Date.now()): number | null {
  const q = getQuietHours();
  if (!q.enabled) return null;

  const startMin = toMinutes(q.start);
  const endMin   = toMinutes(q.end);
  if (startMin === endMin) return null;

  const w = wallClock(at);
  const nowMin = w.h * 60 + w.mi;

  const wraps = endMin < startMin;
  const inside = wraps
    ? (nowMin >= startMin || nowMin < endMin)   // e.g. 23:00 → 08:00
    : (nowMin >= startMin && nowMin < endMin);  // e.g. 01:00 → 06:00
  if (!inside) return null;

  // Minutes from now until the window ends, allowing for the wrap.
  const untilEnd = endMin > nowMin ? endMin - nowMin : 1440 - nowMin + endMin;
  return at + untilEnd * 60_000;
}

export function isMuted(): boolean {
  return localStorage.getItem("gamesched_notifications_muted") === "true";
}
export function setMuted(v: boolean) {
  localStorage.setItem("gamesched_notifications_muted", v ? "true" : "false");
}

const _originCache = new Map<string, { deadline: number; origin: number }>();

function getDeadlineOriginMs(task: any, deadlineEpoch: number): number {
  const cacheKey = String(task.id);
  if (task.created_at) {
    try {
      const raw        = String(task.created_at);
      const normalized = raw.includes("T") ? raw : raw.replace(" ", "T") + "Z";
      const ts         = new Date(normalized).getTime();
      if (!isNaN(ts) && ts > 0) {
        _originCache.set(cacheKey, { deadline: deadlineEpoch, origin: ts });
        return ts;
      }
    } catch {}
  }
  const cached = _originCache.get(cacheKey);
  if (cached) {
    if (cached.deadline === deadlineEpoch) return cached.origin;
    const now = Date.now();
    _originCache.set(cacheKey, { deadline: deadlineEpoch, origin: now });
    return now;
  }
  const now = Date.now();
  _originCache.set(cacheKey, { deadline: deadlineEpoch, origin: now });
  return now;
}

function getNotifyWindowMs(result: CountdownResult): number {
  const { task, time_remaining_ms, next_reset } = result;
  const isUrgent   = Boolean(task.is_urgent);
  const isPriority = Boolean(task.is_priority);

  let totalMs: number;
  const isRecurring = ["daily", "weekly", "biweekly", "custom_days"].includes(task.reset_type);

  if (isRecurring) {
    switch (task.reset_type) {
      case "daily":       totalMs = 24 * 3600_000; break;
      case "weekly":      totalMs = 7  * 24 * 3600_000; break;
      case "biweekly":    totalMs = 14 * 24 * 3600_000; break;
      case "custom_days": totalMs = (task.reset_interval_days ?? 14) * 24 * 3600_000; break;
      default:            totalMs = 24 * 3600_000;
    }
  } else {
    const deadlineEpoch = next_reset.getTime();
    const originMs      = getDeadlineOriginMs(task, deadlineEpoch);
    totalMs             = deadlineEpoch - originMs;
    if (totalMs < 30_000) totalMs = time_remaining_ms;
  }

  let windowMs: number;
  if      (totalMs < 15 * 60_000)   windowMs = totalMs * 0.5;
  else if (totalMs < 2  * 3600_000) windowMs = 30 * 60_000;
  else if (totalMs < 24 * 3600_000) windowMs =  2 * 3600_000;
  else                               windowMs =  4 * 3600_000;

  if (isUrgent)   windowMs *= 1.5;
  if (isPriority) windowMs *= 1.2;

  windowMs = Math.min(windowMs, totalMs * 0.9);
  const floorMs = totalMs < 5 * 60_000 ? totalMs * 0.2 : 60_000;
  windowMs = Math.max(windowMs, floorMs);

  return windowMs;
}

// No deadlineMin in key — prevents stale-key collisions across task cycles/recreations
function buildKey(taskId: number, tier: "main" | "final"): string {
  return `${taskId}-${tier}`;
}

function fireNotification(
  taskName: string, urgencyLabel: "critical" | "warning",
  timeLeft: string, category: string,
) {
  void (async () => {
    try {
      await withTimeout(
        invoke("show_notification", { taskName, urgency: urgencyLabel, timeLeft, category }),
        INVOKE_TIMEOUT,
      );
    } catch (e) {
      console.warn("[notifier] show_notification failed or timed out:", e);
    }
  })();
}

export function checkAndNotify(results: CountdownResult[]) {
  if (isMuted()) return;

  // Computed once per tick rather than per task: it reads localStorage and the
  // answer cannot differ between two tasks in the same pass.
  const quietUntil = quietWindowEnd();

  console.log(`[notify-debug] called with ${results.length} tasks, _notified size=${_notified.size}`);
  results.forEach(r => {
    const win = getNotifyWindowMs(r);
    console.log(`  task="${r.task.name}" id=${r.task.id} remaining=${Math.round(r.time_remaining_ms/1000)}s window=${Math.round(win/1000)}s notified=${_notified.has(buildKey(r.task.id,"main"))}`);
  });

  // Prune every tick — any taskId gone from active list gets its keys cleared.
  // This handles: deleted tasks, expired tasks, completed one-shots.
  // A new task created right after gets a clean slate even if SQLite reused the ID.
  pruneOld(results.map(r => r.task.id));

  for (const result of results) {
    const { task, time_remaining_ms, urgency } = result;

    if (urgency === "expired" || time_remaining_ms <= MIN_NOTIFY_MS) continue;
    if (result.is_completed_this_cycle) continue;
    if ((task as any).is_done) continue;

    // Detect deadline edits — clear fired keys so notification re-fires
    const deadlineNow  = result.next_reset.getTime();
    const deadlinePrev = _lastDeadline.get(task.id);
    if (deadlinePrev !== undefined && deadlinePrev !== deadlineNow) {
      _notified.delete(buildKey(task.id, "main"));
      _notified.delete(buildKey(task.id, "final"));
    }
    _lastDeadline.set(task.id, deadlineNow);

    // Quiet hours. Skipped BEFORE _notified is touched, so this delays the
    // reminder rather than cancelling it — when the window ends the next tick
    // finds it unsent and fires. Exempt when the deadline itself falls inside
    // the window, because silence there would not delay the reminder, it would
    // replace it with nothing.
    if (quietUntil !== null && deadlineNow > quietUntil) continue;

    const notifyWindowMs = getNotifyWindowMs(result);
    const mainKey        = buildKey(task.id, "main");
    const finalKey       = buildKey(task.id, "final");

    // MAIN notification
    if (time_remaining_ms <= notifyWindowMs && !_notified.has(mainKey)) {
      _notified.add(mainKey);
      const timeLeft = formatTimeLeft(time_remaining_ms, task.reset_type);
      const label: "critical" | "warning" =
        Boolean(task.is_urgent) || time_remaining_ms < 3_600_000 ? "critical" : "warning";
      console.log(`[notifier] 🔔 MAIN  "${task.name}" remaining=${Math.round(time_remaining_ms/1000)}s`);
      // Written down as well as shown. The card takes itself away after eight
      // seconds and the console is gone at the next restart, so without this
      // the only record of a reminder is having been in the room for it.
      recordNotify({ name: task.name, at: Date.now(), label });
      fireNotification(task.name, label, timeLeft, task.category);
    }

    // FINAL warning at ≤ 10 min
    if (time_remaining_ms <= FINAL_WARN_MS && !_notified.has(finalKey)) {
      _notified.add(finalKey);
      if (notifyWindowMs > FINAL_WARN_MS) {
        const timeLeft = formatTimeLeft(time_remaining_ms, task.reset_type);
        console.log(`[notifier] 🔔 FINAL "${task.name}" remaining=${Math.round(time_remaining_ms/1000)}s`);
        // Marked as the ten-minute warning, because that one fires by a
        // different rule and "it rang twice" is otherwise unexplainable.
        recordNotify({ name: task.name, at: Date.now(), label: "critical", final: true });
        fireNotification(task.name, "critical", timeLeft, task.category);
      }
    }
  }
}

function formatTimeLeft(ms: number, resetType: string): string {
  const isDeadline = ["specific_date", "one_time", "event_window"].includes(resetType);
  if (isDeadline) {
    const hours = Math.floor(ms / 3_600_000);
    const mins  = Math.floor((ms % 3_600_000) / 60_000);
    if (hours === 0) return `${mins}m left`;
    return `${hours}h ${mins}m left`;
  }
  const totalMins = Math.floor(ms / 60_000);
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  if (h === 0) return `${m}m left`;
  return `${h}h ${m}m left`;
}