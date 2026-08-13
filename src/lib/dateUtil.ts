import { wallClock, getAppTimeZone } from "./tz";

/**
 * dateUtil.ts — single source of truth for "today" in the app's timezone.
 *
 * The old note here warned against building a date string out of
 * toISOString().slice(0, 10), because that is UTC's today and only matches
 * Thailand's for part of the day: between midnight and 07:00 Bangkok, UTC is
 * still on yesterday and the trick silently returns the wrong date. That
 * warning still stands.
 *
 * Two things have changed. These functions used to be named after Bangkok and
 * hardcoded to it; they now follow whatever zone the app is set to, so the
 * names say "local" instead — a function called todayLocal that returns a
 * Tokyo date is a trap waiting for whoever reads it next.
 *
 * And they no longer keep Intl formatters of their own. lib/tz already caches a
 * zone offset that is a plain number lookup on the hot path, and reading civil
 * fields off that is cheaper than formatToParts, which allocates a dozen objects
 * every call. todayLocal in particular is called on every finance render.
 */

const p2 = (n: number) => (n < 10 ? "0" + n : String(n));

/** Today's date in the app's zone as "YYYY-MM-DD". Correct at every hour. */
export function todayLocal(date: Date = new Date()): string {
  const w = wallClock(date.getTime());
  return `${w.y}-${p2(w.mo)}-${p2(w.d)}`;
}

/** Current month in the app's zone as "YYYY-MM". */
export function monthLocal(date: Date = new Date()): string {
  const w = wallClock(date.getTime());
  return `${w.y}-${p2(w.mo)}`;
}

/** Convert any Date to its "YYYY-MM-DD" string in the app's zone. */
export const toLocalDateStr = (d: Date): string => todayLocal(d);

/**
 * "Now" as a Date whose LOCAL y/m/d/h/m match the app zone's wall clock.
 * Use this only when you need a Date object to read .getFullYear()/.getMonth()
 * /.getDate() as app-zone values (e.g. calendar view state). Do NOT feed this
 * back into toISOString().
 */
export function localNow(date: Date = new Date()): Date {
  const w = wallClock(date.getTime());
  return new Date(w.y, w.mo - 1, w.d, w.h, w.mi, 0, 0);
}

/** Hour 0–23 in the app's zone, for greetings / time-of-day logic. */
export function localHour(date: Date = new Date()): number {
  return wallClock(date.getTime()).h;
}

/** The zone these functions are speaking in, for anywhere that needs to say so
 *  out loud — the AI prompt does. */
export const localZoneName = getAppTimeZone;