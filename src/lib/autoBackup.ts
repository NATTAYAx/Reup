// src/lib/autoBackup.ts
//
// A backup that happens without being asked for.
//
// ─── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────────
//
// There has been an export button since the beginning, and it works. What it
// requires is that somebody thinks of it, on a day when nothing has gone wrong,
// for a file they will only ever want on a day when something has.
//
// That is the exact shape of thing this app is not allowed to rely on. A
// feature that depends on remembering does not work for the person it was built
// for — not for lack of discipline, but because that is the diagnosis, written
// down on the same page as everything else this app was designed around. Every
// other decision in here follows from it: the notification the OS holds rather
// than a card that fades, the question asked on the card at the moment it is
// relevant rather than in a form three weeks earlier. A backup that has to be
// remembered is the last thing left that ignores it.
//
// ─── WHY THERE ARE THREE FIXED NAMES AND NOT A DATED FILE PER WEEK ───────────
//
// Dated names read better and grow without end, and pruning them needs a
// command that can list and delete files in the app's folder — which is a new
// thing that can delete files, written for the sake of tidiness.
//
// Three names, written in turn, need no such thing. The newest write replaces
// the oldest copy because it lands on the oldest name, and nothing is ever
// deleted by anything. Which copy is which is answered by the exportedAt stamp
// already inside every backup, rather than by its filename.
//
// So the whole of this is a call to a command that already exists, and the only
// new code is the decision about when.
//
// ─── WHY THREE ─────────────────────────────────────────────────────────────
//
// One copy is not a backup: the run that overwrites it is the run that could
// have gone wrong. Two is one plus the one being written. Three is three weeks
// of history at a week apart, which is longer than it takes to notice that
// something has gone missing, and it costs a few hundred kilobytes.
//
// ─── WHY IT IS SILENT ───────────────────────────────────────────────────────
//
// It has nothing to report. It succeeded, which is the expected outcome, or it
// failed, in which case telling somebody at the moment they opened the app is
// asking them to deal with a problem they do not have yet, about a file they
// have never needed. The backup card says when the last one landed, for anyone
// who goes looking. That is the whole of its presence.

import { invoke } from "@tauri-apps/api/core";
import { buildBackupJson } from "./backup";
import { personalToday, personalDaysBetween } from "./dateUtil";

const KEY = "gamesched_auto_backup_v1";

/** How many names are written in turn. */
export const SLOTS = 3;

/** A week. Long enough to be cheap, short enough that a lost week is a week. */
export const EVERY_DAYS = 7;

export interface AutoBackupRecord {
  /** Personal-day string of the last successful write. */
  last: string;
  /** Which name was used last, 1..SLOTS. */
  slot: number;
}

/**
 * The record, or null for a machine that has never written one.
 *
 * Anything unreadable is null rather than an error, which means the next run
 * writes a backup. Erring towards one extra backup is the right way round for
 * a function whose failure mode is not having one.
 */
export function readRecord(): AutoBackupRecord | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<AutoBackupRecord>;
    if (typeof v.last !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v.last)) return null;
    const slot = typeof v.slot === "number" && v.slot >= 1 && v.slot <= SLOTS ? v.slot : SLOTS;
    return { last: v.last, slot };
  } catch {
    return null;
  }
}

/**
 * Whether one is due.
 *
 * A record dated in the future means the clock was moved, or a file was carried
 * over from another machine. Treated as due rather than as a reason to wait,
 * because waiting on a date that may be months out is a backup that never
 * happens again and never says so.
 */
export function isDue(record: AutoBackupRecord | null, today: string): boolean {
  if (!record) return true;
  const days = personalDaysBetween(record.last, today);
  return days >= EVERY_DAYS || days < 0;
}

/** The name after this one. Wraps, which is what makes the oldest get replaced. */
export function nextSlot(record: AutoBackupRecord | null): number {
  const last = record?.slot ?? SLOTS;
  return (last % SLOTS) + 1;
}

/** `auto-2.json`. Fixed names, so nothing has to be deleted. */
export function slotName(slot: number): string {
  return `auto-${slot}.json`;
}

/**
 * Write one if it is time, and say nothing either way.
 *
 * The record is written only after the file is, so a run that fails halfway is
 * a run that tries again next time rather than one that believes it succeeded.
 *
 * Everything the backup does not contain, it still does not contain: this calls
 * the same builder the button does, so the API keys and the card of names and
 * numbers stay out of it for the same reasons and by the same code.
 */
export async function runAutoBackupIfDue(): Promise<void> {
  try {
    const record = readRecord();
    const today = personalToday();
    if (!isDue(record, today)) return;

    const slot = nextSlot(record);
    await invoke<string>("write_snapshot", {
      name: slotName(slot),
      contents: await buildBackupJson(),
    });

    localStorage.setItem(KEY, JSON.stringify({ last: today, slot } satisfies AutoBackupRecord));
  } catch (err) {
    // Nowhere to say it and nobody to say it to. A machine with a full disk or
    // a locked folder has a problem, and it is not one that a person who just
    // opened a task list can act on.
    console.warn("[autoBackup] skipped:", err);
  }
}