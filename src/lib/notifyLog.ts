// src/lib/notifyLog.ts
//
// What rang, and when.
//
// ─── WHY ────────────────────────────────────────────────────────────────────
//
// A toast appears in the corner, plays a chime and takes itself away after
// eight seconds. If nobody was looking at the screen in those eight seconds,
// the entire event is a noise that happened, with nothing anywhere afterwards
// that says what it was about.
//
// That came up as a question and there was no way to answer it: a sound at
// around midnight, no card, and nothing to check. The reasoning went as far as
// "several tasks reset near then, so it was probably one of those" — probably,
// about the app's own behaviour, on the machine it runs on.
//
// The rules that produce that sound are not simple. Quiet hours delay a
// reminder unless the deadline itself falls inside the window, in which case it
// rings anyway; the final warning fires at ten minutes regardless of the normal
// window. Both are right, and both mean the honest answer to "why did it ring
// then" is a chain of three conditions. A chain like that is fine to have and
// impossible to check against a memory of a noise.
//
// ─── WHY IT IS NOT A NOTIFICATION CENTRE ────────────────────────────────────
//
// Twenty entries, no badge, no unread count, nothing on the main screen. This
// answers one question — what was that — and the place somebody asks it is the
// notification settings, which is where it lives. A list that greets you at
// launch would be a list of everything not dealt with, which is the completion
// chart wearing yet another coat.
//
// ─── AND WHY IT DOES NOT TRAVEL ─────────────────────────────────────────────
//
// Twenty rolling lines about this machine in the last few days. It is a
// diagnostic, not a record — and it is exactly the kind of thing that would sit
// in a backup file for years being copied around for no reason. Classed as
// transient in storageKeys, with the AI cache.

import { NOTIFY_LOG } from "./storageKeys";

/** Enough to answer "what was that" for a few days of ordinary use. */
const KEEP = 20;

export interface NotifyEntry {
  /** The task's name as it was shown. */
  name: string;
  /** Epoch millis, so it can be rendered in whatever zone is current. */
  at: number;
  /** Which kind of chime it was. */
  label: "critical" | "warning";
  /** True for the ten-minute warning rather than the main reminder. */
  final?: true;
}

/**
 * Write one down. Never throws.
 *
 * Called from the path that fires a notification, so a full disk or a locked
 * profile must not be able to stop a reminder — the reminder is the point and
 * this is the receipt.
 */
export function recordNotify(entry: NotifyEntry): void {
  try {
    const next = [entry, ...read()].slice(0, KEEP);
    localStorage.setItem(NOTIFY_LOG, JSON.stringify(next));
  } catch {
    /* full, or no storage at all */
  }
}

/** Newest first. An unreadable log reads as empty rather than as an error. */
export function read(): NotifyEntry[] {
  try {
    const raw = localStorage.getItem(NOTIFY_LOG);
    if (!raw) return [];
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter(
      (e): e is NotifyEntry =>
        !!e && typeof e.name === "string" && typeof e.at === "number",
    );
  } catch {
    return [];
  }
}