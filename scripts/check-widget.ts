/**
 * What the board on the desktop says, on a fixed day in a fixed zone. Run it:
 *
 *   pnpm check:widget
 *
 * The board is the phone's widget read from the desktop's rows, so the cases
 * below are the phone's rules (WidgetFaceTest.kt in reup-mobile) plus the one
 * thing only the desktop has: a one-off whose time has passed and is still on
 * the list. Both now count one window for everything - the card, the list and
 * the bar all look twenty-four hours ahead - and that is checked here too.
 *
 * The clock is pinned to Wednesday 14 October 2026, 18:00 in Bangkok, and the
 * app's zone is Bangkok, so every expected string below is written out in full.
 *
 * The last line is the only one that matters.
 */

// countdown.ts and i18n.ts read localStorage on the way in, so it has to exist
// before they are imported. The zone is set here for the same reason: tz.ts
// reads it once, when it loads.
const bucket: Record<string, string> = { gamesched_timezone: "Asia/Bangkok", gamesched_lang_v1: "th" };
(globalThis as any).localStorage = {
  getItem: (k: string) => (k in bucket ? bucket[k] : null),
  setItem: (k: string, v: string) => { bucket[k] = v; },
  removeItem: (k: string) => { delete bucket[k]; },
  key: (i: number) => Object.keys(bucket)[i] ?? null,
  get length() { return Object.keys(bucket).length; },
};

// calculateCountdown asks the real clock. This one says what it is told to.
const RealDate = Date;
let fakeNow = RealDate.UTC(2026, 9, 14, 11, 0, 0); // 18:00 in Bangkok
class PinnedDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(fakeNow);
    else super(...(args as [string | number]));
  }
  static now() { return fakeNow; }
}
(globalThis as any).Date = PinnedDate;

import {
  widgetRows, widgetFace, shortWhen, tickedToday, moneyLine, isLongCycle, lineText, tallyText,
  type WidgetFace, type WidgetLine,
} from "../src/lib/widgetFace";
import type { Task } from "../src/types";

declare const process: { exit(code: number): void };

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    console.log("  ok   " + name);
  } else {
    failed++;
    console.log("  FAIL " + name + (detail === undefined ? "" : "\n       " + JSON.stringify(detail)));
  }
}

const ZONE = "Asia/Bangkok";
/** A Bangkok wall time as an ISO instant. */
const bkk = (y: number, mo: number, d: number, h: number, mi = 0) =>
  new RealDate(RealDate.UTC(y, mo - 1, d, h - 7, mi)).toISOString();

let nextId = 1;
function task(fields: Partial<Task> & { completed_at?: string | null }): Task {
  return {
    id: nextId++,
    name: "task",
    description: "",
    category: "game",
    reset_type: "daily",
    reset_time: null,
    reset_day: null,
    reset_interval_days: null,
    anchor_date: null,
    event_start: null,
    event_end: null,
    specific_date: null,
    is_priority: false,
    is_urgent: false,
    is_active: true,
    completed_until: null,
    min_step: null,
    notify_before_min: null,
    time_zone: null,
    intent: null,
    cycle_checked_until: null,
    missed_streak: 0,
    paused_until: null,
    deleted_at: null,
    created_at: "2026-10-01T00:00:00.000Z",
    ...fields,
  } as Task;
}

function faceOf(tasks: Task[], lang: "th" | "en" = "th"): WidgetFace {
  const now = Date.now();
  return widgetFace(widgetRows(tasks, now, ZONE), now, ZONE, lang);
}

const lines = (ls: WidgetLine[], lang: "th" | "en" = "th") =>
  ls.map(l => `${l.name}|${lineText(l, lang)}|${l.warn ? "!" : ""}`);

// ─── a full day ──────────────────────────────────────────────────────────────
{
  nextId = 1;
  const day = [
    task({ name: "Dailies", reset_type: "daily", reset_time: "04:00" }),
    task({ name: "Water plants", reset_type: "daily", reset_time: "20:00" }),
    task({ name: "Weekly boss", reset_type: "weekly", reset_day: 5, reset_time: "04:00" }),
    task({ name: "Abyss", reset_type: "custom_days", reset_interval_days: 14, anchor_date: "2026-10-08", reset_time: "04:00" }),
    // Ticked this morning: counts towards the bar.
    task({
      name: "Gym", reset_type: "daily", reset_time: "07:00",
      completed_until: bkk(2026, 10, 15, 7), completed_at: bkk(2026, 10, 14, 10),
    }),
    // Ticked on Monday and still inside its week: done, but not today's.
    task({
      name: "Weekly raid", reset_type: "weekly", reset_day: 0, reset_time: "04:00",
      completed_until: bkk(2026, 10, 18, 4), completed_at: bkk(2026, 10, 12, 21),
    }),
    // Two hours late and never ticked.
    task({ name: "Dentist", reset_type: "specific_date", specific_date: "2026-10-14", reset_time: "16:00", category: "personal" }),
    // Paused: asked not to be reminded, so not on the board.
    task({ name: "Paused", reset_type: "daily", reset_time: "21:00", paused_until: "9999-12-31T00:00:00.000Z" }),
    // Leave at 13:00 for 14:00 tomorrow.
    task({ name: "Meeting", reset_type: "specific_date", specific_date: "2026-10-15", reset_time: "14:00", notify_before_min: 60, category: "work" }),
  ];
  const f = faceOf(day);
  console.log("a full day");
  check("the date reads as the phone's", f.date === "พุธ 14 ตุลาคม", f.date);
  check("the overdue appointment is next, said as overdue, in amber",
    f.next?.name === "Dentist" && f.next.when === "ถึงกำหนดแล้ว" && f.next.warn && f.next.overdue, f.next);
  check("not calm", f.calm === null && f.calmNext === null);
  check("the rest of the day, soonest first, by when to leave",
    JSON.stringify(lines(f.soon)) === JSON.stringify([
      "Water plants|20:00|",
      "Dailies|พรุ่งนี้ 04:00|",
      "Meeting|พรุ่งนี้ 13:00|!",
    ]), lines(f.soon));
  check("each line knows its day and its clock, for the board's day headings",
    JSON.stringify(f.soon.map(l => [l.day, l.clock])) === JSON.stringify([[0, "20:00"], [1, "04:00"], [1, "13:00"]]),
    f.soon.map(l => [l.day, l.clock]));
  check("the longer rounds, by when they run out; under two days is amber",
    JSON.stringify(lines(f.later)) === JSON.stringify([
      "Weekly boss|หมด ศ. 04:00|!",
      "Abyss|หมด 22 ต.ค.|",
    ]), lines(f.later));
  check("only today's tick counts", f.done === 1, f.done);
  check("the bar is today's ticks plus what is due within a day", f.load === 5, f.load);
  check("and says so", f.tally === "ทำแล้ว 1 จาก 5", f.tally);

  const en = faceOf(day, "en");
  console.log("the same day in English");
  check("the date", en.date === "Wednesday, October 14", en.date);
  check("the day's times",
    JSON.stringify(en.soon.map(l => lineText(l, "en"))) === JSON.stringify(["20:00", "Tomorrow 04:00", "Tomorrow 13:00"]),
    en.soon.map(l => lineText(l, "en")));
  check("the longer rounds' times",
    JSON.stringify(en.later.map(l => lineText(l, "en"))) === JSON.stringify(["ends Fri 04:00", "ends Oct 22"]),
    en.later.map(l => lineText(l, "en")));
  check("overdue in English", en.next?.when === "Due now", en.next?.when);
  check("the bar in English", en.tally === "1 of 5 done", en.tally);
}

// ─── an evening with only the night's rounds left ────────────────────────────
//
// The case that was wrong on screen: everything left resets after midnight.
// The card used to say nothing resets today while the bar counted those same
// rounds as today's. Now the card names the first of them.
{
  nextId = 1;
  const f = faceOf([
    task({ name: "Star Rail", reset_type: "daily", reset_time: "03:00" }),
    task({ name: "FGO", reset_type: "daily", reset_time: "04:00" }),
    task({ name: "Ultra Rumble", reset_type: "daily", reset_time: "10:00" }),
    task({ name: "Guild raid", reset_type: "weekly", reset_day: 1, reset_time: "05:00" }),
  ]);
  console.log("an evening with only the night's rounds left");
  check("the first round after midnight is next, not a calm day",
    f.next?.name === "Star Rail" && f.next.when === "พรุ่งนี้ 03:00" && f.calm === null, f.next ?? f.calm);
  check("the rest follow it", JSON.stringify(lines(f.soon)) === JSON.stringify([
    "FGO|พรุ่งนี้ 04:00|",
    "Ultra Rumble|พรุ่งนี้ 10:00|",
  ]), lines(f.soon));
  check("a weekly five days out is not amber", JSON.stringify(lines(f.later)) === JSON.stringify(["Guild raid|หมด จ. 05:00|"]), lines(f.later));
  check("nothing is scored before it is due: no 0 of 3", f.done === 0 && f.load === 3 && f.tally === "3 อย่างภายใน 24 ชั่วโมง", f.tally);
}

// ─── a calm evening ──────────────────────────────────────────────────────────
{
  nextId = 1;
  const f = faceOf([
    task({ name: "Gym", reset_type: "daily", reset_time: "07:00", completed_until: bkk(2026, 10, 15, 7), completed_at: bkk(2026, 10, 14, 10) }),
    task({ name: "Weekly boss", reset_type: "weekly", reset_day: 1, reset_time: "04:00" }),
  ]);
  console.log("a calm evening");
  check("nothing due within a day", f.next === null && f.soon.length === 0);
  check("says it is all done", f.calm === "วันนี้ทำครบแล้ว", f.calm);
  check("names the round after, once", f.calmNext?.name === "Weekly boss" && lineText(f.calmNext, "th") === "จ. 04:00", f.calmNext);
  check("and does not list it again", f.later.length === 0, lines(f.later));
  check("the bar counts the tick", f.done === 1 && f.load === 1 && f.tally === "ทำแล้ว 1 จาก 1", [f.done, f.load, f.tally]);
}

// ─── nothing at all ──────────────────────────────────────────────────────────
{
  const f = faceOf([]);
  console.log("an empty list");
  check("says nothing resets", f.calm === "วันนี้ไม่มีอะไรรีเซ็ต" && f.calmNext === null, f);
  check("and has no bar", f.load === 0 && f.done === 0 && f.tally === null);
}

// ─── late at night ───────────────────────────────────────────────────────────
{
  nextId = 1;
  fakeNow = RealDate.UTC(2026, 9, 14, 16, 30); // 23:30 in Bangkok
  const f = faceOf([task({ name: "Dailies", reset_type: "daily", reset_time: "04:00" })]);
  console.log("half past eleven");
  check("tonight's work is next, though its reset is tomorrow's",
    f.next?.name === "Dailies" && f.next.when === "พรุ่งนี้ 04:00" && f.next.day === 1, f.next);
  check("and it is on the bar", f.load === 1 && f.tally === "1 อย่างภายใน 24 ชั่วโมง", f.tally);
  fakeNow = RealDate.UTC(2026, 9, 14, 11, 0);
}

// ─── the pieces ──────────────────────────────────────────────────────────────
{
  console.log("the pieces");
  const now = RealDate.UTC(2026, 9, 14, 11, 0);
  const at = (d: number, h: number) => RealDate.UTC(2026, 9, d, h - 7, 0);
  check("today is a clock", shortWhen(at(14, 22), now, ZONE, "th") === "22:00");
  check("six days out is a weekday", shortWhen(at(20, 9), now, ZONE, "th") === "อ. 09:00", shortWhen(at(20, 9), now, ZONE, "th"));
  check("seven days out is a date", shortWhen(at(21, 9), now, ZONE, "th") === "21 ต.ค.", shortWhen(at(21, 9), now, ZONE, "th"));
  check("a tick at half past midnight here is today",
    tickedToday("2026-10-13T17:30:00.000Z", now, ZONE));
  check("a tick a minute before midnight here is not",
    !tickedToday("2026-10-13T16:59:00.000Z", now, ZONE));
  check("an unreadable tick is not today", !tickedToday("yesterday", now, ZONE) && !tickedToday(null, now, ZONE));
  check("every 1 day is a daily", !isLongCycle({ reset_type: "custom_days", reset_interval_days: 1 }));
  check("every 3 days is a long round", isLongCycle({ reset_type: "custom_days", reset_interval_days: 3 }));
  check("the bar's words", tallyText(0, 0, "th") === null && tallyText(0, 7, "en") === "7 in the next 24 hours"
    && tallyText(7, 7, "th") === "ทำแล้ว 7 จาก 7");
  const baht = (n: number) => "฿" + n.toLocaleString("en-US");
  check("the money line", moneyLine(1240, 30000, 10, "th", baht) === "ต.ค. จ่าย ฿1,240 · รับ ฿30,000",
    moneyLine(1240, 30000, 10, "th", baht));
  check("the money line with nothing in it", moneyLine(0, 0, 10, "th", baht) === "ต.ค. ยังไม่มีรายการ");
}

console.log(failed === 0 ? "\nclean" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
