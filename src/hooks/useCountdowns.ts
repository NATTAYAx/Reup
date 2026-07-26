/**
 * useCountdowns.ts — v2 (battery/idle friendly)
 *
 * WHAT CHANGED AND WHY:
 * The old version ran ONE 1-second setInterval that did BOTH jobs at once:
 *   (1) recompute countdowns + setCountdowns() → forces a React re-render
 *   (2) checkAndNotify() → fire toast notifications
 * That meant React re-rendered every single second, forever, even when the
 * window was hidden in the tray and nobody was looking. During a livestream or
 * fullscreen game, that per-second render is exactly what caused the stutter.
 *
 * THE FIX — split the two jobs and gate them differently:
 *   • NOTIFY LOOP: always runs (even hidden), because missing a reminder is bad.
 *     But it uses an ADAPTIVE interval — 1s only when something is within the
 *     final minute, otherwise 5/15/30s. No React work here at all.
 *   • RENDER LOOP: drives setCountdowns() for the on-screen numbers. It ONLY
 *     runs while the window is actually visible. Minimize to tray → it stops
 *     completely → zero render cost while hidden.
 *
 * Kept from v1 (do not "simplify" away):
 *   • tasksRef holds the DB snapshot; loadTasks() mutates it in place with NO
 *     setState — prevents the render race that froze TaskCard buttons.
 *   • Stable sort on stable fields only (never on time_remaining_ms).
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getAllTasks } from "../lib/database";
import { calculateCountdown } from "../lib/countdown";
import { checkAndNotify } from "../lib/notifier";
import { CountdownResult } from "../types";

// How soon the nearest deadline is → how often we need to re-check.
function notifyDelayFor(nearestMs: number): number {
  if (nearestMs <= 90_000) return 1_000;       // within 90s → 1s precision
  if (nearestMs <= 10 * 60_000) return 5_000;  // within 10min → 5s
  if (nearestMs <= 60 * 60_000) return 15_000; // within 1h → 15s
  return 30_000;                               // otherwise → 30s
}

function computeResults(tasks: any[]): CountdownResult[] {
  const results: CountdownResult[] = [];
  for (const task of tasks) {
    const r = calculateCountdown(task);
    if (r) results.push(r);
  }
  // Stable sort — NEVER on time_remaining_ms (changes every tick → remounts).
  results.sort((a, b) => {
    if (a.is_completed_this_cycle !== b.is_completed_this_cycle)
      return a.is_completed_this_cycle ? 1 : -1;
    if (Boolean(b.task.is_urgent) !== Boolean(a.task.is_urgent))
      return Boolean(b.task.is_urgent) ? 1 : -1;
    if (Boolean(b.task.is_priority) !== Boolean(a.task.is_priority))
      return Boolean(b.task.is_priority) ? 1 : -1;
    return a.task.id - b.task.id;
  });
  return results;
}

export function useCountdowns() {
  const [countdowns, setCountdowns] = useState<CountdownResult[]>([]);
  const [loading, setLoading] = useState(true);
  const tasksRef = useRef<any[]>([]);

  // ── Load tasks from DB — updates tasksRef only, NO state update ──────────
  const loadTasks = useCallback(async () => {
    try {
      tasksRef.current = await getAllTasks();
    } catch (err) {
      console.error("[useCountdowns] loadTasks error:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshTasks = useCallback(async () => {
    await loadTasks();
  }, [loadTasks]);

  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

  // ── NOTIFY LOOP — always on, adaptive frequency, no React render ─────────
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;

    const runNotifyTick = () => {
      if (stopped) return;
      const results = computeResults(tasksRef.current);

      const active = results.filter(r =>
        !r.is_completed_this_cycle &&
        r.urgency !== "expired" &&
        r.time_remaining_ms > 10_000
      );
      checkAndNotify(active);

      const nearest = active.reduce(
        (min, r) => Math.min(min, r.time_remaining_ms),
        Number.POSITIVE_INFINITY
      );
      timer = setTimeout(runNotifyTick, notifyDelayFor(nearest));
    };

    runNotifyTick();
    return () => { stopped = true; clearTimeout(timer); };
  }, []);

  // ── RENDER LOOP — only while the window is visible ──────────────────────
  useEffect(() => {
    let renderTimer: ReturnType<typeof setInterval> | null = null;
    let unlisten: (() => void) | undefined;
    let disposed = false;

    const win = getCurrentWindow();

    const startRender = () => {
      if (renderTimer !== null) return;
      setCountdowns(computeResults(tasksRef.current)); // immediate fresh paint
      renderTimer = setInterval(() => {
        setCountdowns(computeResults(tasksRef.current));
      }, 1_000);
    };

    const stopRender = () => {
      if (renderTimer !== null) {
        clearInterval(renderTimer);
        renderTimer = null;
      }
    };

    (async () => {
      try {
        if (await win.isVisible()) startRender();
      } catch { startRender(); }

      try {
        const off = await win.onFocusChanged(async ({ payload: focused }) => {
          if (disposed) return;
          // Pause when we lose focus (covers fullscreen game / livestream where
          // the window is still "visible" but nobody is looking at it) OR when
          // actually hidden to tray. Resume only when focused AND visible.
          if (!focused) { stopRender(); return; }
          try {
            if (await win.isVisible()) startRender();
            else stopRender();
          } catch { startRender(); }
        });
        unlisten = off;
      } catch { /* no window events — render loop already running */ }

      const onVis = () => {
        if (document.visibilityState === "visible") startRender();
        else stopRender();
      };
      document.addEventListener("visibilitychange", onVis);
      const prev = unlisten;
      unlisten = () => {
        prev?.();
        document.removeEventListener("visibilitychange", onVis);
      };
    })();

    return () => {
      disposed = true;
      stopRender();
      unlisten?.();
    };
  }, []);

  return { countdowns, loading, refreshTasks };
}