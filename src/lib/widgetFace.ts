// ─── widgetFace.ts — what the board on the desktop says ──────────────────────
//
// THE SAME DAY AS THE PHONE
//
// This is the phone widget's reading of the day (shared/.../WidgetFace.kt in
// reup-mobile), worked out from the desktop's own task rows. The rules are the
// phone's on purpose: a glance at the desk and then at the phone should never
// tell two different stories about what is next.
//
//   next      the soonest thing not done that is due within a day
//   calm      when nothing is: "all done" or "nothing resets today", with the
//             first round after that named underneath
//   soon      everything else due within a day, soonest first
//   later     the longer rounds still open - weeklies, events, anything due
//             further out than a day - in the order they run out
//   done/load ticked today, out of ticked today plus what is due within a day
//
// ONE WINDOW FOR ALL OF IT
//
// "Within a day" rather than "today", because a daily that resets at three in
// the morning is tonight's work at eight in the evening. The first version took
// the card's "next" from the calendar day and everything else from the day
// ahead, and the two halves argued on screen: "nothing resets today" over a bar
// reading "done today 0 of 7". Now the card, the list and the bar all count the
// same twenty-four hours.
//
// NO SCORE BEFORE THE DAY HAS HAPPENED
//
// The task list stopped printing "0 of 3 done" next to a big 0% long ago - it is
// a verdict on a morning that has not happened yet - and says what is coming
// instead. The board does the same: "7 within 24 hours" until something is
// ticked, and only then the bar.
//
// WHAT THE DESKTOP ADDS
//
// A deadline that has passed. The phone only ever sees the future; the desktop
// keeps an overdue one-off on the list until it is ticked or archived, so here
// it shows too - first in line, said in amber.
//
// WHY CLOCKS AND NOT COUNTDOWNS
//
// The board repaints once a minute. "18:00" is true until 18:00; "in 3 h" is
// wrong a minute later and makes a still screen look like it is ticking.
//
// Nothing in this file reads storage or the clock: every input is passed in,
// so scripts/check-widget.ts can pin the time and the zone.

import { isRecurring, isPaused, type Task } from "../types";
import { calculateCountdown } from "./countdown";
import { wallClock } from "./tz";

export type WidgetLang = "en" | "th";

/** One task, reduced to what the board is worked out from. */
export interface WidgetRow {
  id: number;
  name: string;
  /** When it is due: the leave-by time when it has one. Null when nothing is queued. */
  fireAt: number | null;
  /** The appointment, or the end of the round. Later than fireAt when there is a lead time. */
  resetAt: number | null;
  done: boolean;
  /** Ticked today, on the calendar of the app's zone. Only read when done. */
  doneToday: boolean;
  /** Comes back on its own. */
  recurring: boolean;
  /** Comes back less often than every day. */
  longCycle: boolean;
  /** A one-off whose time has passed without a tick. */
  overdue: boolean;
}

/** One line on the board: what, and when. */
export interface WidgetLine {
  id: number;
  name: string;
  /** The moment the line is about: when to act, or for a longer round when it runs out. */
  at: number;
  /** Calendar days from today in the app's zone: 0 today, 1 tomorrow. */
  day: number;
  /** "04:00". */
  clock: string;
  /** "18:00", "พรุ่งนี้ 04:00", "ศ. 04:00", "22 ต.ค.", or "ถึงกำหนดแล้ว" when overdue. */
  when: string;
  /** A longer round: `when` is when it runs out, said "หมด ศ. 04:00" in full. */
  ending: boolean;
  /** Overdue, or not a daily and under two days left. Said in amber. */
  warn: boolean;
  overdue: boolean;
}

export interface WidgetFace {
  /** "พุธ 14 ตุลาคม" / "Wednesday, October 14". */
  date: string;
  next: WidgetLine | null;
  /** Exactly when next is null. */
  calm: string | null;
  /** On a calm day, the round after, if one is queued. */
  calmNext: WidgetLine | null;
  soon: WidgetLine[];
  later: WidgetLine[];
  done: number;
  load: number;
  /** Under the list: what the day holds, or how much of it is done. Null on an empty day. */
  tally: string | null;
}

const DAY_MS = 86_400_000;
const TWO_DAYS_MS = 2 * DAY_MS;

// Sunday first, matching Wall.dow. The Thai lists are the phone's, word for word.
const DAYS = {
  th: ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"],
  en: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
};
const DAYS_SHORT = {
  th: ["อา.", "จ.", "อ.", "พ.", "พฤ.", "ศ.", "ส."],
  en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
};
const MONTHS = {
  th: ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
       "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"],
  en: ["January", "February", "March", "April", "May", "June",
       "July", "August", "September", "October", "November", "December"],
};
const MONTHS_SHORT = {
  th: ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
       "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."],
  en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
};

// Kept here rather than in i18n because they are built into sentences by the
// functions below, and the test needs them without a window to read the
// language setting from.
export const WIDGET_WORDS = {
  tomorrow: { th: "พรุ่งนี้", en: "Tomorrow" },
  ends:     { th: "หมด", en: "ends" },
  overdue:  { th: "ถึงกำหนดแล้ว", en: "Due now" },
  calmDone: { th: "วันนี้ทำครบแล้ว", en: "All done for today" },
  calmNone: { th: "วันนี้ไม่มีอะไรรีเซ็ต", en: "Nothing resets today" },
};

const pad2 = (n: number) => (n < 10 ? "0" + n : String(n));

/** Days since the epoch, on the wall in this zone. */
function dayNumber(at: number, zone: string): number {
  const w = wallClock(at, zone);
  return Math.round(Date.UTC(w.y, w.mo - 1, w.d) / DAY_MS);
}

/** Weekly, every two weeks, every few days. "Every 1 day" is a daily however it was typed. */
export function isLongCycle(task: Pick<Task, "reset_type" | "reset_interval_days">): boolean {
  switch (task.reset_type) {
    case "weekly":
    case "biweekly":
      return true;
    case "custom_days":
      return (task.reset_interval_days ?? 0) > 1;
    default:
      return false;
  }
}

/** Whether a tick happened today where the person is. Anything unparseable is not today. */
export function tickedToday(completedAt: unknown, now: number, zone: string): boolean {
  if (typeof completedAt !== "string" || !completedAt.trim()) return false;
  const at = Date.parse(completedAt);
  if (isNaN(at)) return false;
  return dayNumber(at, zone) === dayNumber(now, zone);
}

/**
 * The rows, soonest first, from the same countdowns the task list is drawn
 * from. calculateCountdown reads the real clock, so `now` here should be the
 * same moment; it is only passed so the day comparisons use one instant.
 */
export function widgetRows(tasks: readonly Task[], now: number, zone: string): WidgetRow[] {
  const rows: WidgetRow[] = [];
  const nowDate = new Date(now);
  for (const task of tasks) {
    if (!task || isPaused(task, nowDate)) continue;
    const r = calculateCountdown(task);
    if (!r) continue;
    const done = r.is_completed_this_cycle;
    const resetAt = r.next_reset.getTime();
    const fireAt = (r.leave_by ?? r.next_reset).getTime();
    rows.push({
      id: Number(task.id),
      name: String(task.name ?? ""),
      fireAt: Number.isFinite(fireAt) ? fireAt : null,
      resetAt: Number.isFinite(resetAt) ? resetAt : null,
      done,
      doneToday: done && tickedToday((task as { completed_at?: unknown }).completed_at, now, zone),
      recurring: isRecurring(task),
      longCycle: isLongCycle(task),
      overdue: !done && r.urgency === "expired",
    });
  }
  rows.sort((a, b) => (a.fireAt ?? Infinity) - (b.fireAt ?? Infinity) || a.id - b.id);
  return rows;
}

/**
 * When, as short as it can be said: "18:00" today, "พรุ่งนี้ 04:00", "ศ. 04:00"
 * inside the week, "22 ต.ค." past it. The phone's shortWhen.
 */
export function shortWhen(at: number, now: number, zone: string, lang: WidgetLang): string {
  const w = wallClock(at, zone);
  const clock = pad2(w.h) + ":" + pad2(w.mi);
  const diff = dayNumber(at, zone) - dayNumber(now, zone);
  if (diff <= 0) return clock;
  if (diff === 1) return WIDGET_WORDS.tomorrow[lang] + " " + clock;
  if (diff <= 6) return DAYS_SHORT[lang][w.dow] + " " + clock;
  return lang === "th"
    ? `${w.d} ${MONTHS_SHORT.th[w.mo - 1]}`
    : `${MONTHS_SHORT.en[w.mo - 1]} ${w.d}`;
}

/** "พุธ 14 ตุลาคม", or "Wednesday, October 14" as the task list's header says it. */
export function boardDate(now: number, zone: string, lang: WidgetLang): string {
  const w = wallClock(now, zone);
  return lang === "th"
    ? `${DAYS.th[w.dow]} ${w.d} ${MONTHS.th[w.mo - 1]}`
    : `${DAYS.en[w.dow]}, ${MONTHS.en[w.mo - 1]} ${w.d}`;
}

/** The whole phrase for a line, as the phone prints it: "หมด ศ. 04:00". */
export function lineText(line: WidgetLine, lang: WidgetLang): string {
  return line.ending ? WIDGET_WORDS.ends[lang] + " " + line.when : line.when;
}

/** What the bar says: the day's size until something is ticked, then the count. */
export function tallyText(done: number, load: number, lang: WidgetLang): string | null {
  if (load <= 0) return null;
  if (done <= 0) return lang === "th" ? `${load} อย่างภายใน 24 ชั่วโมง` : `${load} in the next 24 hours`;
  return lang === "th" ? `ทำแล้ว ${done} จาก ${load}` : `${done} of ${load} done`;
}

/**
 * Under two days left on something that is not a daily. A daily's round is
 * always under a day, so for it this would be on all day, and amber that is
 * always on is a colour rather than a warning.
 */
function runsOut(r: WidgetRow, now: number): boolean {
  if (r.recurring && !r.longCycle) return false;
  const end = r.resetAt ?? r.fireAt;
  return end !== null && end - now < TWO_DAYS_MS;
}

function lineOf(r: WidgetRow, at: number, now: number, zone: string, lang: WidgetLang, ending: boolean): WidgetLine {
  const w = wallClock(at, zone);
  return {
    id: r.id,
    name: r.name,
    at,
    day: dayNumber(at, zone) - dayNumber(now, zone),
    clock: pad2(w.h) + ":" + pad2(w.mi),
    when: r.overdue ? WIDGET_WORDS.overdue[lang] : shortWhen(at, now, zone, lang),
    ending: ending && !r.overdue,
    warn: r.overdue || runsOut(r, now),
    overdue: r.overdue,
  };
}

/** The board, from the rows. Each row lands in exactly one place. */
export function widgetFace(rows: readonly WidgetRow[], now: number, zone: string, lang: WidgetLang): WidgetFace {
  const waiting = rows
    .filter(r => !r.done && r.fireAt !== null)
    .sort((a, b) => a.fireAt! - b.fireAt! || a.id - b.id);
  const within = waiting.filter(r => r.fireAt! - now <= DAY_MS);

  const next = within[0] ?? null;
  const upcoming = next ? null : waiting[0] ?? null;
  const head = next?.id ?? upcoming?.id ?? null;
  const done = rows.filter(r => r.done && r.doneToday).length;
  const load = done + within.length;

  const soon = within
    .filter(r => r.id !== head)
    .map(r => lineOf(r, r.fireAt!, now, zone, lang, false));
  const later = waiting
    .filter(r => r.id !== head && r.fireAt! - now > DAY_MS)
    .map(r => ({ r, end: r.resetAt ?? r.fireAt! }))
    .sort((a, b) => a.end - b.end || a.r.id - b.r.id)
    .map(({ r, end }) => lineOf(r, end, now, zone, lang, true));

  return {
    date: boardDate(now, zone, lang),
    next: next ? lineOf(next, next.fireAt!, now, zone, lang, false) : null,
    calm: next ? null : done > 0 ? WIDGET_WORDS.calmDone[lang] : WIDGET_WORDS.calmNone[lang],
    calmNext: upcoming ? lineOf(upcoming, upcoming.fireAt!, now, zone, lang, false) : null,
    soon,
    later,
    done,
    load,
    tally: tallyText(done, load, lang),
  };
}

/**
 * The month's money in one line, for a board that has been asked to show it:
 * "ต.ค. จ่าย ฿1,240 · รับ ฿30,000". The phone's widgetMoneyLine; `format` is
 * the app's formatMoney, passed in so this file stays free of storage.
 */
export function moneyLine(
  spent: number,
  received: number,
  month: number,
  lang: WidgetLang,
  format: (n: number) => string,
): string {
  const name = MONTHS_SHORT[lang][month - 1] ?? "";
  const parts: string[] = [];
  if (spent > 0) parts.push((lang === "th" ? "จ่าย " : "spent ") + format(spent));
  if (received > 0) parts.push((lang === "th" ? "รับ " : "in ") + format(received));
  if (parts.length === 0) return lang === "th" ? `${name} ยังไม่มีรายการ` : `${name}: nothing yet`;
  return `${name} ${parts.join(" · ")}`;
}
