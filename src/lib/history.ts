// src/lib/history.ts
//
// The one question the history table is allowed to answer.
//
// ─── WHY THIS IS NOT THE BACKWARD CALENDAR THAT WAS ASKED FOR ────────────────
//
// `task_events` was built to make a backward calendar possible, and it has been
// sitting in the plan as "waiting for data" ever since. Now that there is data,
// the thing worth saying is that the calendar as usually imagined does not pass
// the standard the rest of this app is held to.
//
// A grid of days with a mark on the ones that were done is a completion chart.
// It is the same object as the weekly summary that was rejected, and the same
// object as the spending-by-category graph that was rejected — a record of what
// was and was not managed, laid out so that the gaps are the most visible part
// of it, available to be opened again on the day it will hurt most to look at.
// Changing it from a percentage to a dot does not change what it is; it changes
// what it is called.
//
// What survives that standard is not a display, it is an answer. "When did I
// last change the water filter" is a question somebody asks on purpose, about a
// thing they are deciding, and the honest reply is a date.
//
// ─── THREE RULES THAT KEEP IT AN ANSWER ─────────────────────────────────────
//
// DATES, NOT ELAPSED DAYS. "14/08" is a fact. "22 days ago" is a score with a
// unit, and it counts upward for exactly as long as somebody is not managing
// something — which is the shape this app refuses everywhere else.
//
// THREE, NOT ALL. Three is enough to answer "when was the last time" and enough
// to see a rhythm if there is one. A list that keeps going is a record to
// scroll through, and something to scroll through on a bad day is the thing the
// standard was written against.
//
// NOT FOR DAILIES. For something due every day, the last three dates are a
// streak with the word filed off, and the card already answers whether today is
// done. The question this exists for only makes sense when the gap between
// occurrences is long enough to forget.
//
// ─── WHY THERE ARE NO VECTORS FOR THIS ──────────────────────────────────────
//
// Every other statement in the money and task layers is pinned in
// store-vectors.json because there are two copies of it in two languages that
// have to agree. There is one copy of this one. Vectors here would be ceremony
// rather than evidence — the same reasoning Config.kt gives for not having any.
//
// It is still run against a real database in check-sync, which is the half that
// actually catches a column name that does not exist.

// Rules only, no database. Same split as moneyDraft against financeDatabase
// and as the sync planners against the runner: check-sync has to be able to
// load this without a browser, and importing the database here drags in the
// whole app down to the language files, which read localStorage at module
// load. The reader lives next to getDb, in database.ts.

/**
 * The recent events for one task, newest first.
 *
 * Forty rather than three, because a tick that was undone does not count and
 * three rows might be one afternoon of changing one's mind. Forty is far more
 * than enough to find three that stuck, on a table with tens of rows per year.
 */
export const HISTORY_SQL =
  "SELECT kind, at, for_cycle FROM task_events " +
  "WHERE task_uid = ? AND deleted = 0 ORDER BY at DESC, id DESC LIMIT 40";

export interface TaskEvent {
  kind: string;
  at: string;
  for_cycle: string | null;
}

/** The reset kinds where "when did I last do this" is a real question. */
const WORTH_ASKING = new Set(["weekly", "biweekly", "custom_days"]);

export function hasHistory(resetType: string): boolean {
  return WORTH_ASKING.has(resetType);
}

/**
 * The last few times this was done and stayed done, newest first.
 *
 * A tick that was undone afterwards is not a time it was done. That is the
 * whole reason `undone` is recorded rather than the tick being erased: the
 * table can tell the difference, so this has to as well, or the answer is
 * confidently wrong in the one direction that matters.
 *
 * Matched on `for_cycle` rather than on time order, because an undo belongs to
 * the occurrence it undid. Ticking Monday's, then next week ticking Tuesday's
 * and immediately undoing it, leaves Monday's standing — which is what
 * happened.
 *
 * Events with no `for_cycle` are older rows from before that column carried
 * anything. They are counted as done, since the alternative is a task that has
 * been kept up for a year reading as never touched.
 *
 * @param events rows from HISTORY_SQL, newest first
 * @param limit how many dates to return
 */
export function doneDates(events: readonly TaskEvent[], limit = 3): string[] {
  const undone = new Set<string>();
  for (const e of events) {
    if (e.kind === "undone" && e.for_cycle) undone.add(e.for_cycle);
  }

  const out: string[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    if (e.kind !== "done") continue;
    if (e.for_cycle && undone.has(e.for_cycle)) continue;
    
    const day = e.at.slice(0, 10);
    if (day.length !== 10 || seen.has(day)) continue;
    seen.add(day);
    out.push(day);
    if (out.length >= limit) break;
  }
  return out;
}