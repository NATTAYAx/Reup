/**
 * dateUtil.ts — single source of truth for "today" in Bangkok time.
 *
 * THE BUG THIS FIXES:
 * The old pattern was `new Date(Date.now() + 7*3600*1000).toISOString()`.
 * toISOString() always converts back to UTC, so manually adding 7 hours and
 * then calling toISOString() shifts the clock 7h ahead of UTC — which only
 * happens to match Bangkok during part of the day. Between ~00:00 and ~07:00
 * Bangkok time, UTC is still "yesterday", and the trick produces the WRONG
 * date. That's why opening the app in the morning showed yesterday.
 *
 * THE FIX:
 * Use Intl.DateTimeFormat with timeZone 'Asia/Bangkok'. It returns the correct
 * civil date/time in Thailand at any hour, with no manual offset math.
 *
 * RULE: never write `Date.now() + 7*...` or `.toISOString().split("T")[0]`
 * for "today" anywhere again. Import from here instead.
 */

const BKK = "Asia/Bangkok";

// en-CA formats as YYYY-MM-DD, which is exactly the ISO date string we want.
const _dateFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: BKK,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const _partsFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: BKK,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** Today's date in Bangkok as "YYYY-MM-DD". Correct at every hour. */
export function todayBangkok(date: Date = new Date()): string {
  return _dateFmt.format(date);
}

/** Current month in Bangkok as "YYYY-MM". */
export function monthBangkok(date: Date = new Date()): string {
  return todayBangkok(date).slice(0, 7);
}

/** Convert any Date to its Bangkok "YYYY-MM-DD" string. */
export function toBangkokDateStr(d: Date): string {
  return _dateFmt.format(d);
}

/**
 * Bangkok "now" as a Date whose LOCAL y/m/d/h/m match Thailand wall-clock.
 * Use this only when you need a Date object to read .getFullYear()/.getMonth()
 * /.getDate() as Bangkok values (e.g. calendar view state). Do NOT feed this
 * back into toISOString().
 */
export function bangkokNow(date: Date = new Date()): Date {
  const p: Record<string, string> = {};
  for (const part of _partsFmt.formatToParts(date)) {
    if (part.type !== "literal") p[part.type] = part.value;
  }
  return new Date(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    0,
    0
  );
}

/** Bangkok hour 0–23, for greetings / time-of-day logic. */
export function bangkokHour(date: Date = new Date()): number {
  return bangkokNow(date).getHours();
}