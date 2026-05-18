/**
 * useCountdowns.ts
 *
 * Loads all active tasks from the DB, computes live countdowns every second,
 * and provides refreshTasks() that ALWAYS re-queries the DB (not a cached list).
 *
 * ARCHITECTURE NOTE:
 * - tasksRef holds the latest DB snapshot — updated only by loadTasks()
 * - The tick interval reads tasksRef.current every second to compute countdowns
 * - setTasks() state is INTENTIONALLY REMOVED — it caused spurious React re-renders
 *   every time refreshTasks() was called (e.g. button clicks), which raced with the
 *   per-second tick and caused AnimatePresence to remount TaskCards → frozen buttons
 * - Only setCountdowns() drives renders — it fires every second with a stable-sorted list
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { getAllTasks } from "../lib/database";
import { calculateCountdown } from "../lib/countdown";
import { checkAndNotify } from "../lib/notifier";
import { CountdownResult } from "../types";

export function useCountdowns() {
  const [countdowns, setCountdowns] = useState<CountdownResult[]>([]);
  const [loading, setLoading]   = useState(true);
  const tasksRef = useRef<any[]>([]);
  // Flag to force an immediate tick after a DB refresh (e.g. after task add/delete)
  const needsTickRef = useRef(false);

  // ── Load tasks from DB — updates tasksRef only, NO state update ───────────
  // Deliberately does NOT call setTasks() — that caused a second React render
  // cycle that raced with the tick interval and remounted TaskCards.
  const loadTasks = useCallback(async () => {
    try {
      const fresh = await getAllTasks();
      tasksRef.current = fresh;
      needsTickRef.current = true; // signal tick to run immediately on next interval
    } catch (err) {
      console.error("[useCountdowns] loadTasks error:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  // ── refreshTasks: re-query DB (called after any mutation) ─────────────────
  const refreshTasks = useCallback(async () => {
    await loadTasks();
  }, [loadTasks]);

  // ── Initial load ────────────────────────────────────────────────────────────
  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

  // ── Tick every second — recalculate countdowns from tasksRef ─────────────
  // Dependency array is EMPTY — interval is created once and never torn down.
  // tasksRef.current is always fresh because loadTasks() mutates it in place.
  useEffect(() => {
    const runTick = () => {
      const results: CountdownResult[] = [];
      for (const task of tasksRef.current) {
        const result = calculateCountdown(task);
        if (result) results.push(result);
      }

      // Sort ONLY on stable fields — NEVER on time_remaining_ms.
      // time_remaining_ms changes every second → reshuffles array → AnimatePresence
      // sees different key order → remounts TaskCards → all buttons freeze.
      // Stable sort: completed last, urgent first, priority second, then by ID.
      results.sort((a, b) => {
        if (a.is_completed_this_cycle !== b.is_completed_this_cycle)
          return a.is_completed_this_cycle ? 1 : -1;
        if (Boolean(b.task.is_urgent) !== Boolean(a.task.is_urgent))
          return Boolean(b.task.is_urgent) ? 1 : -1;
        if (Boolean(b.task.is_priority) !== Boolean(a.task.is_priority))
          return Boolean(b.task.is_priority) ? 1 : -1;
        // Stable tiebreaker by ID — order never changes between ticks
        return a.task.id - b.task.id;
      });

      setCountdowns(results);
      // Pass only valid, non-expired results with > 10 seconds remaining to notifier.
      // The 10-second floor prevents invoke() from firing at the expiry boundary,
      // which previously raced with the expired-state transition and caused a
      // second freeze vector in WebKit's microtask queue.
      checkAndNotify(results.filter(r =>
        !r.is_completed_this_cycle &&
        r.urgency !== "expired" &&
        r.time_remaining_ms > 10_000
      ));
    };

    runTick(); // immediate first tick
    const interval = setInterval(() => {
      // If a DB refresh just happened, run tick immediately to reflect new data
      runTick();
      needsTickRef.current = false;
    }, 1000);
    return () => clearInterval(interval);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps — intentionally empty, uses refs

  return { countdowns, loading, refreshTasks };
}