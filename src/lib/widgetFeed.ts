// ─── widgetFeed.ts — the main window handing the board its tasks ─────────────
//
// WHY THE MAIN WINDOW AND NOT THE BOARD ITSELF
//
// The board could open the database on its own. It would then load the list a
// second time on its own schedule, and every place that refreshes the list
// after a tick, an edit or a sync would need a second wire to the board so the
// two did not disagree for a minute. The main window's script is awake all day
// anyway - it runs the notifier - and every one of those paths already ends in
// one function, loadTasks. So that function hands the board a copy, and the
// board never touches the database.
//
// The copy is trimmed to the columns the countdown reads. Descriptions and
// notes can be long and the board shows neither.
//
// WHEN THE BOARD IS NOT THERE
//
// emitTo a window that does not exist is a no-op, so nothing here asks. When
// the board opens it says hello, and this answers with the latest copy.
//
// THE NOTES
//
// Read again at every send rather than handed in like the tasks: one small
// query, and every place that changes a note - this window's own board, a sync
// from the phone - already ends in a send. All of them go, newest first; the
// board decides how many it has room for.

import { emitTo, listen } from "@tauri-apps/api/event";
import { getDb, getMonthIncome } from "./database";
import { getMonthTotal } from "./financeDatabase";
import { monthLocal } from "./dateUtil";
import { getCurrency } from "./money";
import { moneyOn } from "./widgetLook";
import { liveNotes, type NoteColor } from "./notes";

/** The board's window label; the same string as LABEL in widget.rs. */
export const WIDGET_LABEL = "widget";

const FIELDS = [
  "id", "name", "category", "reset_type", "reset_time", "reset_day",
  "reset_interval_days", "anchor_date", "event_start", "event_end",
  "specific_date", "is_priority", "is_urgent", "is_active", "completed_until",
  "completed_at", "notify_before_min", "time_zone", "paused_until",
] as const;

export interface WidgetMoney {
  spent: number;
  received: number;
  currency: string;
  /** 1-12. */
  month: number;
}

/** A note as the board draws it. */
export interface WidgetNote {
  uid: string;
  body: string;
  color: NoteColor;
}

export interface WidgetPayload {
  tasks: Record<string, unknown>[];
  money: WidgetMoney | null;
  /** Newest first. Absent from a main window older than the board. */
  notes?: WidgetNote[];
}

let latest: Record<string, unknown>[] | null = null;
/** The last list that read, kept so a read that fails does not take them all off the board. */
let lastNotes: WidgetNote[] = [];

async function readNotes(): Promise<WidgetNote[]> {
  try {
    const notes = await liveNotes(await getDb());
    lastNotes = notes.map(n => ({ uid: n.uid, body: n.body, color: n.color }));
  } catch {
    /* an older database with no notes table yet, or a busy one: as before */
  }
  return lastNotes;
}

function slim(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of FIELDS) out[k] = row[k] ?? null;
  return out;
}

async function readMoney(): Promise<WidgetMoney | null> {
  const month = monthLocal();
  const [spent, received] = await Promise.all([getMonthTotal(month), getMonthIncome(month)]);
  return { spent, received, currency: getCurrency(), month: Number(month.slice(5, 7)) };
}

/** Which send is the newest; an older one still reading when a newer one starts is dropped. */
let sends = 0;

/** Send the latest copy now. Safe to call any time, as often as wanted. */
export async function sendToWidget(): Promise<void> {
  if (latest === null) return; // not loaded yet; loadTasks will send when it is
  const mine = ++sends;
  const tasks = latest;
  let money: WidgetMoney | null = null;
  if (moneyOn()) {
    try {
      money = await readMoney();
    } catch {
      money = null;
    }
  }
  const notes = await readNotes();
  // A note taken off while this one was reading must not come back with it.
  if (mine !== sends) return;
  const payload: WidgetPayload = { tasks: latest ?? tasks, money, notes };
  try {
    await emitTo(WIDGET_LABEL, "widget-tasks", payload);
  } catch {
    /* no board, or the event system is not up yet - the next load sends again */
  }
}

/** Called by loadTasks with what it just loaded. */
export function feedWidget(tasks: readonly Record<string, unknown>[]): void {
  latest = tasks.map(slim);
  void sendToWidget();
}

/**
 * Answer the board's hello, and keep its money line current while it has one.
 * Spending is written from screens that do not reload the task list, so the
 * line is refreshed every two minutes on its own - one small query, and only
 * while the line is switched on.
 */
export function startWidgetFeed(): () => void {
  const un = listen("widget-hello", () => void sendToWidget());
  const timer = setInterval(() => {
    if (moneyOn()) void sendToWidget();
  }, 120_000);
  return () => {
    un.then(f => f()).catch(() => {});
    clearInterval(timer);
  };
}
