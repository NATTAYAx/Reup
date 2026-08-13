// ============================================================
// smartAI.ts — v3 FULL UPGRADE
// · Thai number words (อีกสามวัน, สองอาทิตย์ข้างหน้า)
// · Thai calendar date format (วันที่ 15 มีนาคม, 15/3)
// · Smarter habit matching (new info overrides memory)
// · Context memory across messages (follow-up support)
// · Edit/delete intent detection (ลบ, เปลี่ยนเวลา)
// · Multi-task via ส่วน/แล้วก็/นอกจากนี้
// ============================================================
import { Category, ResetType } from "../types";
import { todayLocal, localNow } from "./dateUtil";
import { matchLearnedPreset } from "./aiMemory";

// ─── Types ───────────────────────────────────────────────────
export interface ParsedTask {
  name: string;
  description: string;
  category: Category;
  reset_type: ResetType;
  reset_time: string | null;
  reset_day: number | null;
  reset_interval_days: number | null;
  anchor_date: string | null;
  event_start: string | null;
  event_end: string | null;
  specific_date: string | null;
  is_priority: number;  // ⭐ important/priority
  is_urgent: number;    // 🔥 critical/urgent
}

export type AIIntent =
  | "add"         // create new task(s)
  | "delete"      // remove a task by name
  | "edit_time"   // change time of existing task
  | "edit_name"   // rename existing task
  | "edit_priority" // toggle priority
  | "clarify"     // AI needs more info
  | "unknown";

export interface AIConfidence {
  field: string;
  value: string;
  sure: boolean;
}

export interface AIResult {
  intent: AIIntent;
  tasks: ParsedTask[];
  isMulti: boolean;
  reply: string;
  confidence: number;
  details: AIConfidence[];
  needsClarification: boolean;
  clarificationQuestion?: string;
  // For edit/delete intents
  targetTaskName?: string;
  newTime?: string;
  newName?: string;
  newPriority?: boolean;
}

// ─── Conversation context (in-memory across messages) ────────
export interface ConversationTurn {
  userText: string;
  result: AIResult;
  timestamp: number;
}

// Kept in module scope — lives for the session
let conversationHistory: ConversationTurn[] = [];

export function pushHistory(turn: ConversationTurn) {
  conversationHistory.push(turn);
  if (conversationHistory.length > 20) conversationHistory.shift();
}

export function clearHistory() {
  conversationHistory = [];
}

export function getHistory(): ConversationTurn[] {
  return conversationHistory;
}

/** Get the last successfully parsed task context (for follow-ups) */
function getLastTaskContext(): ParsedTask | null {
  for (let i = conversationHistory.length - 1; i >= 0; i--) {
    const r = conversationHistory[i].result;
    if (r.tasks.length > 0 && r.intent === "add") return r.tasks[0];
  }
  return null;
}

// ─── Habit Memory (localStorage) ─────────────────────────────
const HABIT_KEY = "gamesched_ai_habits_v3";

interface HabitEntry {
  input: string;
  result: Partial<ParsedTask>;
  usedCount: number;
  lastUsed: string;
}

export function loadHabits(): HabitEntry[] {
  try { return JSON.parse(localStorage.getItem(HABIT_KEY) || "[]"); }
  catch { return []; }
}

export function saveHabit(input: string, result: Partial<ParsedTask>) {
  const habits = loadHabits();
  const norm = normalizeInput(input);
  const existing = habits.find(h => h.input === norm);
  if (existing) {
    existing.usedCount++;
    existing.lastUsed = new Date().toISOString();
    existing.result = result;
  } else {
    habits.push({ input: norm, result, usedCount: 1, lastUsed: new Date().toISOString() });
  }
  habits.sort((a, b) => b.usedCount - a.usedCount);
  localStorage.setItem(HABIT_KEY, JSON.stringify(habits.slice(0, 50)));
}

/**
 * Smarter habit matching — only use habit if the new input doesn't
 * contain fresh time/date/priority info that should override it.
 */
export function matchHabit(input: string): Partial<ParsedTask> | null {
  const habits = loadHabits();
  const norm = normalizeInput(input);

  // Check if input has new specific info that should take precedence
  const hasNewDate = extractSpecificDate(input) !== null;
  const hasNewTime = extractAllTimes(input).length > 0;
  const hasNewPriority = /ด่วน|เร่งด่วน|สำคัญ|urgent|asap/i.test(input);

  // Exact match — use if no new overriding info
  const exact = habits.find(h => h.input === norm);
  if (exact && !hasNewDate && !hasNewTime && !hasNewPriority) return exact.result;

  // Fuzzy: only match if input is very close and has NO new specific info
  if (!hasNewDate && !hasNewTime) {
    for (const h of habits) {
      // Only if the habit phrase is contained AND input is not much longer
      if (norm.includes(h.input) && norm.length <= h.input.length + 5) {
        return h.result;
      }
    }
  }

  return null;
}

export function getTopHabits(n = 5): HabitEntry[] {
  return loadHabits().sort((a, b) => b.usedCount - a.usedCount).slice(0, n);
}

// ─── Thai number word → integer ───────────────────────────────
const THAI_DIGITS: Record<string, number> = {
  "หนึ่ง": 1, "สอง": 2, "สาม": 3, "สี่": 4, "ห้า": 5,
  "หก": 6, "เจ็ด": 7, "แปด": 8, "เก้า": 9, "สิบ": 10,
  "สิบเอ็ด": 11, "สิบสอง": 12, "สิบสาม": 13, "สิบสี่": 14,
  "สิบห้า": 15, "สิบหก": 16, "สิบเจ็ด": 17, "สิบแปด": 18,
  "สิบเก้า": 19, "ยี่สิบ": 20, "สามสิบ": 30,
};




// ─── Thai month names ─────────────────────────────────────────
const THAI_MONTHS_FULL: Record<string, number> = {
  "มกราคม": 1, "ม.ค.": 1, "กุมภาพันธ์": 2, "ก.พ.": 2,
  "มีนาคม": 3, "มี.ค.": 3, "เมษายน": 4, "เม.ย.": 4,
  "พฤษภาคม": 5, "พ.ค.": 5, "มิถุนายน": 6, "มิ.ย.": 6,
  "กรกฎาคม": 7, "ก.ค.": 7, "สิงหาคม": 8, "ส.ค.": 8,
  "กันยายน": 9, "ก.ย.": 9, "ตุลาคม": 10, "ต.ค.": 10,
  "พฤศจิกายน": 11, "พ.ย.": 11, "ธันวาคม": 12, "ธ.ค.": 12,
};

// ─── Thai time vocabulary ─────────────────────────────────────
const THAI_TIME_MAP: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/เที่ยงคืน/, () => "00:00"],
  [/ตีหนึ่ง/, () => "01:00"],
  [/ตีสอง/, () => "02:00"],
  [/ตีสาม/, () => "03:00"],
  [/ตีสี่/, () => "04:00"],
  [/ตีห้า/, () => "05:00"],
  [/(\d{1,2})\s*โมงเช้า/, m => `${m[1].padStart(2,"0")}:00`],
  [/สิบเอ็ดโมงเช้า/, () => "11:00"],
  [/สิบโมงเช้า/, () => "10:00"],
  [/เก้าโมงเช้า/, () => "09:00"],
  [/แปดโมงเช้า/, () => "08:00"],
  [/เจ็ดโมงเช้า/, () => "07:00"],
  [/หกโมงเช้า/, () => "06:00"],
  [/เที่ยง(?!คืน)/, () => "12:00"],
  [/บ่ายโมง/, () => "13:00"],
  [/บ่ายสอง/, () => "14:00"],
  [/บ่ายสาม/, () => "15:00"],
  [/บ่ายสี่/, () => "16:00"],
  [/บ่าย\s*(\d{1,2})\s*โมง/, m => `${String(parseInt(m[1]) + 12).padStart(2,"0")}:00`],
  [/ห้าโมงเย็น/, () => "17:00"],
  [/หกโมงเย็น/, () => "18:00"],
  [/(\d{1,2})\s*โมงเย็น/, m => `${String(parseInt(m[1]) + 12).padStart(2,"0")}:00`],
  [/ทุ่มหนึ่ง/, () => "19:00"],
  [/สองทุ่ม/, () => "20:00"],
  [/สามทุ่ม/, () => "21:00"],
  [/สี่ทุ่ม/, () => "22:00"],
  [/ห้าทุ่ม/, () => "23:00"],
  [/(\d{1,2})\s*ทุ่ม/, m => `${String(parseInt(m[1]) + 18).padStart(2,"0")}:00`],
  [/สิบ\s*(\d)\s*โมง/, m => `${String(10 + parseInt(m[1])).padStart(2,"0")}:00`],
  [/สิบโมง(?!เช้า)/, () => "10:00"],
  // Bare digit + โมง without เช้า/เย็น qualifier
  // Thai convention: 1–5 โมง (เช้า implied) = 6+n am; 6–11 โมง bare = hour directly; 10-11 = 10-11am
  // Simplest safe rule: digit ≥ 7 → that hour directly (7-11am); digit 1-6 → +6 (7am-12pm)
  [/(?<![ตีบ่าย])\b(\d{1,2})\s*โมง(?!เช้า|เย็น)/, m => {
    const n = parseInt(m[1]);
    const h = n >= 7 ? n : n + 6; // 1โมง=7am, 6โมง=12pm, 7โมง=7am, 10โมง=10am
    return `${String(Math.min(h, 23)).padStart(2,"0")}:00`;
  }],
];

function extractAllTimes(text: string): Array<{ time: string; index: number }> {
  const results: Array<{ time: string; index: number }> = [];
  const used = new Set<number>();

  for (const [pattern, fn] of THAI_TIME_MAP) {
    const g = new RegExp(pattern.source, "g");
    let m: RegExpExecArray | null;
    while ((m = g.exec(text)) !== null) {
      if (!used.has(m.index)) {
        used.add(m.index);
        results.push({ time: applySpokenMinutes(text, m, fn(m)), index: m.index });
      }
    }
  }

  const enPatterns: RegExp[] = [
    /(\d{1,2}):(\d{2})\s*(am|pm)?/gi,
    /(\d{1,2})\s*(am|pm)/gi,
    /\bmidnight\b/gi,
    /\bnoon\b/gi,
  ];
  for (const p of enPatterns) {
    let m: RegExpExecArray | null;
    while ((m = p.exec(text)) !== null) {
      if (used.has(m.index)) continue;
      used.add(m.index);
      const raw = m[0].toLowerCase();
      if (raw === "midnight") { results.push({ time: "00:00", index: m.index }); continue; }
      if (raw === "noon") { results.push({ time: "12:00", index: m.index }); continue; }
      let h = parseInt(m[1]);
      const min = m[2] && m[2].length === 2 && !["am","pm"].includes(m[2].toLowerCase()) ? parseInt(m[2]) : 0;
      const period = m[m.length - 1]?.toLowerCase();
      if (period === "pm" && h !== 12) h += 12;
      if (period === "am" && h === 12) h = 0;
      results.push({ time: `${String(h).padStart(2,"0")}:${String(min).padStart(2,"0")}`, index: m.index });
    }
  }

  return results.sort((a, b) => a.index - b.index);
}

// ─── Weekday helpers ──────────────────────────────────────────
const THAI_WEEKDAY_NUM: Record<string, number> = {
  "อาทิตย์": 0, "วันอาทิตย์": 0,
  "จันทร์": 1, "วันจันทร์": 1,
  "อังคาร": 2, "วันอังคาร": 2,
  "พุธ": 3, "วันพุธ": 3,
  "พฤหัส": 4, "วันพฤหัส": 4, "พฤหัสบดี": 4,
  "ศุกร์": 5, "วันศุกร์": 5,
  "เสาร์": 6, "วันเสาร์": 6,
};

const EN_DAY_NUM: Record<string, number> = {
  sunday: 0, sun: 0, monday: 1, mon: 1,
  tuesday: 2, tue: 2, wednesday: 3, wed: 3,
  thursday: 4, thu: 4, friday: 5, fri: 5, saturday: 6, sat: 6,
};

function nextWeekdayDate(targetDay: number): string {
  const today = new Date();
  let diff = targetDay - today.getDay();
  if (diff <= 0) diff += 7;
  const d = new Date(today);
  d.setDate(today.getDate() + diff);
  return toDateStr(d);
}

function toDateStr(d: Date): string {
  return todayLocal(d);
}

/** Format ISO date "YYYY-MM-DD" → "DD/MM/YYYY" for user-facing replies */
function toDateDisplay(iso: string): string {
  const [y, m, day] = iso.split("-");
  return `${day}/${m}/${y}`;
}

// ─── Date extraction (full upgrade) ──────────────────────────

/** Return type for date extraction — carries optional exact ISO deadline for sub-hour inputs */
interface DateResult {
  /** Calendar date string "YYYY-MM-DD" (always present when not null) */
  date: string;
  /** Full ISO datetime "YYYY-MM-DDTHH:MM:SS" — only set for "อีก X นาที/ชั่วโมง" inputs */
  exactDeadlineISO: string | null;
}

function extractSpecificDate(text: string): DateResult | null {
  // Bangkok-aware "now" so วันนี้/พรุ่งนี้ are correct past midnight UTC
  const today = localNow();

  // ── 0. Thai/English relative minutes/hours → event_window + exact UTC deadline ─────
  // "อีก 5 นาที", "อีกครึ่งชั่วโมง", "in 10 minutes" etc.
  // Uses event_window (displayed as "Limited Event") + event_end = proper UTC "Z" string.
  // new Date("2026-03-07T09:04:16Z") parses correctly in WebKit/Tauri — no timezone bug.
  // event_window stays visible after expiry showing "หมดเวลา", user archives manually.
  const THAI_DIGITS_MAP: Record<string, number> = {
    "หนึ่ง":1,"สอง":2,"สาม":3,"สี่":4,"ห้า":5,"หก":6,"เจ็ด":7,"แปด":8,"เก้า":9,"สิบ":10,
    "ยี่สิบ":20,"สามสิบ":30,"สี่สิบ":40,"ห้าสิบ":50,
  };
  const thaiRelMinPatterns: Array<[RegExp, (n: number) => number]> = [
    [/อีก\s*([ก-๙\d]+)\s*นาที/, n => n],
    [/อีก\s*([ก-๙\d]+)\s*ชั่วโมง/, n => n * 60],
    [/อีกครึ่งชั่วโมง/, () => 30],
    [/in\s*(\d+)\s*minute/, n => n],
    [/in\s*(\d+)\s*hour/, n => n * 60],
  ];
  for (const [pat, toMins] of thaiRelMinPatterns) {
    const m = text.match(pat);
    if (m) {
      let n = 1;
      if (m[1]) {
        // Try Thai word first, then parse as number
        const wordVal = THAI_DIGITS_MAP[m[1]];
        if (wordVal !== undefined) n = wordVal;
        else {
          const parsed = parseInt(m[1]);
          if (!isNaN(parsed)) n = parsed;
        }
      }
      const deadlineMs = Date.now() + toMins(n) * 60 * 1000;
      // Store as clean UTC ISO string — "Z" suffix is unambiguous in every JS engine
      const exactDeadlineISO = new Date(deadlineMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
      return { date: toDateStr(new Date(deadlineMs)), exactDeadlineISO };
    }
  }

  // ── 1. Thai relative words ────────────────────────────────
  // Longest key first, so "เมื่อวานซืน" is not eaten by "เมื่อวาน".
  //
  // The backwards ones were missing entirely, and the way they failed was the
  // problem: "เพิ่มงาน X deadline เมื่อวาน" still classified as specific_date,
  // found no date, and saved a row with specific_date = null. A task with no
  // date has no next occurrence, so it never appeared in the list — saved,
  // confirmed on screen, and invisible.
  const thaiRel: Record<string, number> = {
    "เมื่อวานซืน": -2, "เมื่อวาน": -1, "วานนี้": -1, "วานซืน": -2,
    "วันนี้": 0, "พรุ่งนี้": 1, "มะรืนนี้": 2, "มะรืน": 2,
    "วันพรุ่ง": 1, "อาทิตย์หน้า": 7, "สัปดาห์หน้า": 7,
    "เดือนหน้า": 30,
    "อาทิตย์ที่แล้ว": -7, "สัปดาห์ที่แล้ว": -7, "เดือนที่แล้ว": -30,
  };
  for (const [k, off] of Object.entries(thaiRel)) {
    if (text.includes(k)) {
      const d = new Date(today);
      d.setDate(d.getDate() + off);
      return { date: toDateStr(d), exactDeadlineISO: null };
    }
  }

  // ── 2. Thai number words: "อีก X วัน/อาทิตย์/เดือน" ─────
  const thaiNumDayPatterns: Array<[RegExp, (n: number) => number]> = [
    [/อีก\s*([ก-๙\d]+)\s*วัน/, n => n],
    [/อีก\s*([ก-๙\d]+)\s*อาทิตย์/, n => n * 7],
    [/อีก\s*([ก-๙\d]+)\s*สัปดาห์/, n => n * 7],
    [/อีก\s*([ก-๙\d]+)\s*เดือน/, n => n * 30],
    [/([ก-๙\d]+)\s*วันข้างหน้า/, n => n],
    [/([ก-๙\d]+)\s*อาทิตย์ข้างหน้า/, n => n * 7],
    [/([ก-๙\d]+)\s*สัปดาห์ข้างหน้า/, n => n * 7],
    [/([ก-๙\d]+)\s*เดือนข้างหน้า/, n => n * 30],
  ];
  for (const [pat, calc] of thaiNumDayPatterns) {
    const m = text.match(pat);
    if (m) {
      const rawNum = m[1];
      let n: number | null = null;
      for (const [word, val] of Object.entries(THAI_DIGITS)) {
        if (rawNum === word) { n = val; break; }
      }
      if (n === null) n = parseInt(rawNum);
      if (!isNaN(n!)) {
        const d = new Date(today);
        d.setDate(d.getDate() + calc(n!));
        return { date: toDateStr(d), exactDeadlineISO: null };
      }
    }
  }

  // ── 3. Thai calendar date: "วันที่ 15 มีนาคม" / "15 มีนาคม" ──
  for (const [monthName, monthNum] of Object.entries(THAI_MONTHS_FULL)) {
    const pat = new RegExp(`(?:วันที่\\s*)?(\\d{1,2})\\s*${monthName}(?:\\s*(\\d{4}))?`);
    const m = text.match(pat);
    if (m) {
      const day = parseInt(m[1]);
      let year = m[2] ? parseInt(m[2]) : today.getFullYear();
      if (year > 2500) year -= 543;
      const d = new Date(year, monthNum - 1, day);
      if (!isNaN(d.getTime())) return { date: toDateStr(d), exactDeadlineISO: null };
    }
  }

  // ── 4. Numeric date formats: "15/3", "15/3/68", "15-03-2026" ──
  const numDatePat = /\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/;
  const nd = text.match(numDatePat);
  if (nd) {
    const day = parseInt(nd[1]);
    const month = parseInt(nd[2]);
    let year = nd[3] ? parseInt(nd[3]) : today.getFullYear();
    if (year < 100) year += 2000;
    if (year > 2500) year -= 543;
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      const d = new Date(year, month - 1, day);
      if (!isNaN(d.getTime())) return { date: toDateStr(d), exactDeadlineISO: null };
    }
  }

  // ── 5. Thai weekday → next occurrence ─────────────────────
  for (const [k, num] of Object.entries(THAI_WEEKDAY_NUM)) {
    if (text.includes(k)) return { date: nextWeekdayDate(num), exactDeadlineISO: null };
  }

  // ── 6. English relative + weekday ─────────────────────────
  const lower = text.toLowerCase();
  // "day before yesterday" before "yesterday", and "day after tomorrow" before
  // "tomorrow" — the loop takes the first key that appears in the text, so a
  // shorter key listed earlier would swallow the longer phrase containing it.
  const enRel: Record<string, number> = {
    "day before yesterday": -2, "yesterday": -1,
    "day after tomorrow": 2,
    "today": 0, "tonight": 0, "tomorrow": 1, "next week": 7, "last week": -7,
    "in 2 days": 2, "in two days": 2, "in 3 days": 3, "in three days": 3,
  };
  for (const [k, off] of Object.entries(enRel)) {
    if (lower.includes(k)) {
      const d = new Date(today);
      d.setDate(d.getDate() + off);
      return { date: toDateStr(d), exactDeadlineISO: null };
    }
  }
  const enNumPat = lower.match(/in\s+(\d+)\s+(day|week)/);
  if (enNumPat) {
    const n = parseInt(enNumPat[1]);
    const mult = enNumPat[2] === "week" ? 7 : 1;
    const d = new Date(today);
    d.setDate(d.getDate() + n * mult);
    return { date: toDateStr(d), exactDeadlineISO: null };
  }
  for (const [day, num] of Object.entries(EN_DAY_NUM)) {
    if (lower.includes(`next ${day}`) || lower.includes(day)) {
      return { date: nextWeekdayDate(num), exactDeadlineISO: null };
    }
  }

  return null;
}

// ─── Correction detection (exported for UI layer) ────────────
export function isCorrectionIntent(text: string): boolean {
  return /^(no[,.]?|wait[,.]?|actually|แก้เป็น|เปลี่ยนเป็น|ไม่ใช่|หมายถึง|อ๋อ|เอาใหม่|ขอแก้|fix|change to|make it|ไม่ถูก)\b/i.test(text.trim());
}

/**
 * Minutes spoken after the hour, which the hour table on its own throws away.
 *
 * "บ่ายสามสามสิบ" came out as 15:00. The table matched บ่ายสาม and stopped, and
 * the สามสิบ that followed was left on the floor — the reminder was set half an
 * hour early with nothing on screen to say so, which is the kind of wrong that
 * is only discovered by missing something.
 *
 * Only what directly follows the matched hour is considered, so a minute figure
 * belonging to some other part of the sentence cannot be pulled in.
 */
const SPOKEN_MINUTES: [RegExp, number][] = [
  [/^\s*(?:นาที)?ครึ่ง/, 30],
  [/^\s*สามสิบ(?:นาที)?/, 30],
  [/^\s*สี่สิบห้า(?:นาที)?/, 45],
  [/^\s*สี่สิบ(?:นาที)?/, 40],
  [/^\s*ยี่สิบห้า(?:นาที)?/, 25],
  [/^\s*ยี่สิบ(?:นาที)?/, 20],
  [/^\s*สิบห้า(?:นาที)?/, 15],
  [/^\s*สิบ(?:นาที)?/, 10],
  [/^\s*ห้า(?:นาที)?(?!สิบ)/, 5],
  [/^\s*(\d{1,2})\s*นาที/, -1],   // -1 means "read it from the capture"
];

function applySpokenMinutes(text: string, m: RegExpExecArray, hhmm: string): string {
  if (!/^\d{2}:00$/.test(hhmm)) return hhmm;   // already has minutes
  const rest = text.slice(m.index + m[0].length);

  for (const [re, mins] of SPOKEN_MINUTES) {
    const hit = rest.match(re);
    if (!hit) continue;
    const value = mins === -1 ? parseInt(hit[1], 10) : mins;
    if (!isFinite(value) || value < 1 || value > 59) continue;
    return `${hhmm.slice(0, 2)}:${String(value).padStart(2, "0")}`;
  }
  return hhmm;
}

// ─── Naming helpers ───────────────────────────────────────────
//
// Both of these exist because of one real message:
//
//   เพิ่มงาน "ต" ให้หน่อย deadline ตอนบ่ายสามสามสิบวันนี้
//
// which produced a task called `"ต" ให้หน่อย deadline`. Two separate mistakes,
// each fixed here.

/**
 * A name in quotes is the name. Nothing else in the sentence competes with it.
 *
 * Every other rule in this file is guessing where a name starts and stops.
 * Quotation marks are the person saying it outright, and a guess must never
 * overrule a statement — so this is checked first, everywhere a name is worked
 * out, and it returns immediately.
 *
 * Straight and typographic quotes both, because Windows and phone keyboards
 * disagree about which to insert and whoever typed it did not choose.
 */
function quotedName(raw: string): string | null {
  const m = raw.match(/["'\u201c\u201d\u201e\u00ab\u00bb\u2018\u2019](.{1,80}?)["'\u201c\u201d\u201e\u00ab\u00bb\u2018\u2019]/);
  const inner = m?.[1]?.trim();
  return inner ? inner : null;
}

/** Politeness that trails a request and is never part of what is being named. */
const TRAILING_POLITENESS =
  /\s*(?:ให้หน่อย|ให้ที|ให้ด้วย|หน่อยสิ|หน่อยได้ไหม|หน่อยได้มั้ย|หน่อย|ทีสิ|ที|ด้วยนะ|ด้วย|เลยนะ|นะครับ|นะคะ|ครับ|ค่ะ|คะ|นะ|เลย|deadline|ddl|due)\s*$/i;

/**
 * Strips trailing politeness, repeatedly, because it stacks: "ให้หน่อยนะครับ".
 *
 * `ลบ ต ให้หน่อย` was reaching the database as a task named "ต ให้หน่อย" and
 * finding nothing. The courtesy is addressed to the app; it is not part of what
 * is being pointed at.
 */
function stripPoliteness(s: string): string {
  let out = s.trim();
  for (let i = 0; i < 4; i++) {
    const next = out.replace(TRAILING_POLITENESS, "").trim();
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * Sentences this parser has no verb for, and must therefore not claim.
 *
 * THE FAILURE THIS PREVENTS, WHICH HAPPENED FOR REAL
 *
 *   "เล่น Honkai แล้ว"        → intent=add, confidence 0.97
 *   "พัก Honkai ไว้ก่อน"       → intent=add, confidence 0.97
 *   "ติ๊ก Honkai แล้วบันทึกกาแฟ 60" → intent=add, confidence 0.97
 *
 * All three offered to CREATE a duplicate task. None of them reached the model,
 * because 0.97 clears the local floor of 0.9 and the answer is returned without
 * ever leaving the machine.
 *
 * The cause is that preset matching scores on the NAME. Seeing a known game
 * earns high confidence whether the sentence says to add it, finish it, pause
 * it, or delete it — the verb is never consulted. High confidence about the
 * wrong thing is the worst state available here, because it is the one state
 * that produces no error, no log entry, and no way to find out.
 *
 * So this is a list of what the parser CANNOT do, checked before what it can.
 * It does not teach the parser these verbs — that is the model's job, and the
 * model already has words for every one of them. It only stops the parser
 * answering a question it was never asked.
 *
 * That is the shape this file should keep growing in: narrower and more certain,
 * not wider. Every phrase added to the parser is a phrase that will never again
 * get the model's judgement.
 */
// The object sits BETWEEN the verb and its ending in Thai — "เล่น Honkai แล้ว",
// "พัก Honkai ไว้ก่อน" — so the two halves have to be allowed to be apart. The
// gap is bounded so the match stays inside one clause rather than reaching
// across a whole paragraph to find a word that happens to be there.
const GAP = "[\\s\\S]{0,30}?";

const OUT_OF_LOCAL_SCOPE: RegExp[] = [
  // completed — "เล่น X แล้ว", "ทำเสร็จแล้ว", "ติ๊ก", "done"
  new RegExp(`(?:เล่น|ทำ|กิน|อ่าน|วิ่ง|เคลียร์|รับ|ส่ง)${GAP}(?:แล้ว|เสร็จ)`),
  /เสร็จแล้ว|ติ๊ก|\bdone\b|\bfinished\b|\bcompleted\b/i,
  // not done after all
  /ยังไม่ได้ทำ|ยกเลิกติ๊ก|เอาติ๊กออก|\buncheck\b|\bundone\b/i,
  // set aside / bring back
  new RegExp(`พัก${GAP}(?:ไว้|ก่อน)`),
  new RegExp(`(?:หยุด|เก็บ)${GAP}ไว้ก่อน`),
  /ไม่เอาตอนนี้|\bpause\b|\bsnooze\b/i,
  new RegExp(`เอา${GAP}กลับมา`),
  /เปิดใหม่|\bresume\b|\bunpause\b/i,
  // money coming in — the parser only knows money going out
  /ได้เงิน|ได้ค่า|รายรับ|เงินเข้า|โอนเข้า|เงินเดือน|\bincome\b|\bgot paid\b/i,
  // the bin
  /กู้คืน|เอาคืน|\brestore\b|\bundelete\b/i,
  // the urgent flag on an EXISTING task. Deliberately narrow: "เพิ่มงาน X ด่วน"
  // is an add with a flag on it and the parser handles that correctly, so the
  // bare word ด่วน must not be enough to defer. Only the phrasings that mean
  // "change this one" are listed.
  new RegExp(`(?:ตั้ง|ทำให้|เปลี่ยน)${GAP}(?:เป็น\\s*)?(?:ด่วน|เร่งด่วน)`),
  /เอาด่วนออก|ไม่ด่วนแล้ว|\b(?:mark|set|flag)\b[\s\S]{0,20}?\burgent\b/i,
];

/** True when the sentence asks for something outside this parser's vocabulary. */
function isOutOfLocalScope(text: string): boolean {
  return OUT_OF_LOCAL_SCOPE.some(re => re.test(text));
}

// ─── Intent detection ─────────────────────────────────────────
function detectIntent(text: string): AIIntent {
  const lower = text.toLowerCase();

  // Checked FIRST, ahead of every pattern below, because the patterns below are
  // what produce the confident wrong answer. See OUT_OF_LOCAL_SCOPE.
  if (isOutOfLocalScope(text)) return "unknown";

  // Correction messages — return clarify so smartParse can handle gracefully
  if (isCorrectionIntent(text)) return "clarify";

  // Delete intent — require ลบ as a standalone word to avoid ลบล้าง, ลบเลือน etc.
  //
  // The label chain after ลบ has to be allowed to REPEAT. The old pattern took
  // at most one of งาน/task/ทิ้ง/ออก and then demanded whitespace, so
  // `ลบงานชื่อ "ต"` failed on ชื่อ, fell through every branch, and was classified
  // as ADD — a delete command that created a task named after itself. That is
  // the worst available way to be wrong here, so the labels now repeat freely
  // and an opening quote counts as a boundary just like a space does.
  if (/(?:^|[\s,])ลบ(?:\s*(?:ออก|งาน|task|ทิ้ง|ชื่อ|ที่ชื่อ))*(?:[\s"'\u201c\u201d]|$)|ลบออก|เอาออก|ยกเลิกงาน|\bdelete\s+\S|\bremove\s+\S/.test(text)) return "delete";

  // Edit time — expanded Thai patterns
  if (/เปลี่ยนเวลา|แก้เวลา|ขยับเวลา|เลื่อนเวลา|เลื่อน.*ไป|ย้ายเวลา|change time|update time|reschedule|move.*to/.test(text)) return "edit_time";

  // Edit name
  if (/เปลี่ยนชื่อ|แก้ชื่อ|เปลี่ยนเป็น|rename/.test(text)) return "edit_name";

  // Edit priority
  if (/ทำให้สำคัญ|เพิ่มดาว|mark.*important|set.*priority|make.*priority/.test(lower)) return "edit_priority";
  if (/เอาดาวออก|ไม่สำคัญแล้ว|unmark|remove.*priority/.test(lower)) return "edit_priority";

  // Add intent
  if (/เพิ่ม|ใส่|สร้าง|add|create|new task/.test(lower)) return "add";

  return "add"; // default
}

/** Extract the target task name from an edit/delete command */
function extractTargetName(text: string): string {
  // `ลบ ต ให้หน่อย` was matching the greedy-to-end pattern and returning
  // "ต ให้หน่อย", which then found no task by that name. The politeness is
  // addressed to the app, not part of what is being pointed at.
  // Quoted first, for the same reason cleanName checks quotes first: quotes are
  // the user stating the name outright, and every pattern below is a guess.
  const q = quotedName(text);
  if (q) return q;

  const patterns = [
    // Thai: ลบ "X" / ลบ X ออก / ลบงาน X / ลบงานชื่อ X
    /ลบ\s*(?:(?:งาน|task|ชื่อ|ที่ชื่อ)\s*)*["""]?(.+?)["""]?\s*(?:ออก|ทิ้ง|$)/,
    /ลบ\s*["""](.+?)["""]/,
    // Thai: เปลี่ยนเวลา X เป็น / แก้เวลา X
    /(?:เปลี่ยนเวลา|แก้เวลา|ขยับเวลา|เลื่อนเวลา)\s*["""]?(.+?)["""]?\s*(?:เป็น|to|$)/,
    // Thai: ตั้ง priority / เอาดาวออกจาก X
    /(?:ทำให้สำคัญ|เพิ่มดาวให้|เอาดาวออกจาก)\s*["""]?(.+?)["""]?(?:\s|$)/,
    // English: delete/remove "X" or delete X (greedy to end)
    /(?:delete|remove)\s+(?:task\s+)?["""]?(.+?)["""]?\s*$/i,
    // English: change time of X / rename X to
    /(?:change\s+time\s+(?:of|for)|rename)\s+["""]?(.+?)["""]?\s*(?:to|$)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m?.[1]) {
      const name = stripPoliteness(m[1].trim());
      if (name) return name;
    }
  }
  return "";
}

// ─── Category detection ───────────────────────────────────────
const THAI_CAT_KEYWORDS: Array<[string, Category]> = [
  // school
  ["การบ้าน", "school"], ["แบบฝึกหัด", "school"], ["รายงาน", "school"],
  ["ข้อสอบ", "school"], ["สอบ", "school"], ["ส่งงาน", "school"],
  ["เรียน", "school"], ["วิชา", "school"], ["มหาวิทยาลัย", "school"],
  ["สัมมนา", "school"], ["โปรเจกต์", "school"], ["เทอม", "school"],
  ["มิดเทอม", "school"], ["ไฟนอล", "school"], ["ทำรายงาน", "school"],
  ["ส่งเอกสาร", "school"], ["ป.โท", "school"], ["ป.ตรี", "school"],
  ["ชั้นเรียน", "school"], ["วิทยานิพนธ์", "school"], ["thesis", "school"],
  ["quiz", "school"], ["midterm", "school"], ["final exam", "school"],
  // work
  ["ประชุม", "work"], ["ออฟฟิศ", "work"], ["นัดหมาย", "work"],
  ["งานส่ง", "work"], ["เดทไลน์", "work"], ["deadline", "work"],
  ["นัด", "work"], ["presentation", "work"], ["เพรสเซนเทชั่น", "work"],
  ["ลูกค้า", "work"], ["โปรเจค", "work"], ["บริษัท", "work"],
  ["อีเมล", "work"], ["รีพอร์ต", "work"],
  // game
  ["เกม", "game"], ["รีเซ็ต", "game"], ["บอส", "game"],
  ["สตามิน่า", "game"], ["สแตมินา", "game"], ["เควส", "game"],
  ["gacha", "game"], ["กาชา", "game"], ["พูล", "game"],
  // personal
  ["ออกกำลังกาย", "personal"], ["ยา", "personal"], ["หมอ", "personal"],
  ["คลินิก", "personal"], ["นวด", "personal"], ["ทำความสะอาด", "personal"],
];

function detectCategory(text: string): Category {
  for (const [kw, cat] of THAI_CAT_KEYWORDS) {
    if (text.includes(kw)) return cat;
  }
  const lower = text.toLowerCase();
  if (/homework|assignment|exam|class|school|study|lecture|quiz|midterm|final|thesis|seminar|subject|coursework|submit|due date/.test(lower)) return "school";
  if (/\bwork\b|meeting|deadline|office|report|client|presentation|project|email|invoice|manager/.test(lower)) return "work";
  if (/game|reset|boss|quest|daily|weekly|dungeon|stamina|gacha|banner|pull|recharge|server reset/.test(lower)) return "game";
  return "personal";
}

// ─── Reset type detection ─────────────────────────────────────
function detectResetType(text: string): ResetType {
  if (/ทุกวัน|ทุกๆวัน|รายวัน|ประจำวัน|every\s*day|everyday|daily/.test(text)) return "daily";
  if (/ทุกสัปดาห์|ทุกอาทิตย์|รายสัปดาห์|every\s*week|weekly/.test(text)) return "weekly";
  if (/สองอาทิตย์|ทุกสองสัปดาห์|biweekly|bi-weekly|fortnight/.test(text)) return "biweekly";
  if (/ทุกเดือน|รายเดือน|every\s*month|monthly/.test(text)) return "custom_days";
  if (/event|until|ends|limited/.test(text.toLowerCase())) return "event_window";
  return "one_time";
}

// ─── Flag detection ──────────────────────────────────────────
// is_priority ⭐: "important", "สำคัญ", "priority"  → star flag
function detectPriority(text: string): boolean {
  return /\bimportant\b|\bpriority\b|\bstar\b|สำคัญ(?!มาก)|อย่าลืม/i.test(text);
}
// is_urgent 🔥: "critical", "urgent", "ด่วน", "สำคัญมาก"  → fire flag
function detectUrgentFlag(text: string): boolean {
  return /\bcritical\b|\burgent\b|\basap\b|\bmust\b|ด่วน|เร่งด่วน|รีบด่วน|สำคัญมาก|ห้ามลืม|tonight|due\s*today/i.test(text);
}
// ─── Multi-task split ─────────────────────────────────────────
function detectMultiTaskSegments(text: string): string[] | null {
  // Strong splitters: ส่วน, แล้วก็, นอกจากนี้
  const strongSplitters = /\s*ส่วน\s*|\s*แล้วก็\s*|\s*นอกจากนี้\s*/;
  if (strongSplitters.test(text)) {
    const parts = text.split(strongSplitters).map(s => s.trim()).filter(Boolean);
    if (parts.length >= 2) return parts;
  }

  // วิชา X ... วิชา Y pattern
  const allSubjects = [...text.matchAll(/วิชา\s*\S+/g)];
  if (allSubjects.length >= 2) {
    const positions = allSubjects.map(m => m.index!);
    const segments: string[] = [];
    for (let i = 0; i < positions.length; i++) {
      const start = positions[i];
      const end = i + 1 < positions.length ? positions[i + 1] : text.length;
      segments.push(text.slice(start, end).trim());
    }
    if (segments.length >= 2) return segments;
  }

  // Explicit count "2 task" + กับ separator
  const countMatch = text.match(/(\d+)\s*(?:task|งาน|อย่าง)/);
  const count = countMatch ? parseInt(countMatch[1]) : 0;
  if (count === 2 && text.includes("กับ")) {
    const parts = text.split(/\s*กับ\s*/).map(s => s.trim()).filter(Boolean);
    if (parts.length === 2) return parts;
  }

  return null;
}

// ─── Name cleaning ────────────────────────────────────────────
const THAI_NOISE = [
  /สอบตอน\S*/g,
  /สอบ(?=\s|วัน)/g,
  /ตอน\S*/g,
  /^ส่ง(?=งาน|ของ|เอกสาร)/g, // only strip "ส่ง" as standalone prefix, not inside phrases
  /เวลา\S*/g,
  /ถึง\S*/g,
  /วัน(จันทร์|อังคาร|พุธ|พฤหัส|ศุกร์|เสาร์|อาทิตย์)/g,
  /เมื่อวานซืน|เมื่อวาน|วานซืน|วานนี้|พรุ่งนี้|วันนี้|มะรืน/g,
  /อีก\s*\S+\s*(วัน|อาทิตย์|สัปดาห์|เดือน)/g,
  /\S+ข้างหน้า/g,
  /ทุกวัน|ทุกสัปดาห์|ทุกอาทิตย์/g,
  /หลังอาหาร\S*/g, /ก่อนอาหาร\S*/g, /หลังตื่น\S*/g, /ก่อนนอน/g,
  /รีเซ็ต/g,
  /ใน(?=อีก)/g,          // strip "ใน" before "อีก" first
  /อีก\s*\S*\s*(นาที|ชั่วโมง|minute|hour)/g, /อีกครึ่งชั่วโมง/g,
  /(สำคัญมาก|สำคัญ)|ด่วน|เร่งด่วน|รีบด่วน|อย่าลืม|ห้ามลืม/g,  // Thai flags AFTER อีก strip
  /ใน\s*$/g,     // trailing "ใน" (e.g. "ส่งงานใน " → "ส่งงาน")
  /สองวิชา|แรกเป็น|\d+\s*task/gi,
  /วันที่\s*\d+\s*\S+/g,
  /\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?/g,
  /สิบโมง(เช้า)?/g, /เที่ยง(คืน)?/g,
  /บ่าย(โมง|สอง|สาม|สี่)/g,
  /ห้าโมงเย็น|หกโมงเย็น/g,
  /ทุ่มหนึ่ง|สองทุ่ม|สามทุ่ม/g,
  /(\d{1,2})\s*(โมง|ทุ่ม)(เช้า|เย็น)?/g,
];

function cleanName(raw: string, lang: "th" | "en" | "mixed", isPreset = false): string {
  // Checked before anything else, so no later rule can chip away at it.
  const quoted = quotedName(raw);
  if (quoted) return quoted;

  let s = raw;
  for (const p of THAI_NOISE) s = s.replace(p, "");

  // The instruction is not part of the name. "เพิ่มงานประชุมทีม พฤหัส" was
  // being stored as a task literally called "เพิ่มงานประชุมทีม พฤหัส", verb
  // and all, because nothing stripped the command the sentence opens with.
  const beforeVerb = s;
  s = s.replace(
    /^\s*(?:ช่วย|ขอ)?\s*(?:เพิ่ม|สร้าง|ตั้ง|จด|บันทึก|ใส่|add|create|new|make|set|remind\s+me\s+to)\s*/i,
    "",
  );

  // Only once a verb was actually removed is a following "งาน"/"task" a
  // label rather than part of the name. Thai compounds make this genuinely
  // ambiguous — "งานบ้าน" is housework, not a task called "บ้าน" — so the
  // common compounds are protected by name. The field stays editable, which
  // is the real safety net for anything this list misses.
  if (s !== beforeVerb) {
    const COMPOUND = /^(?:บ้าน|เลี้ยง|แต่ง|ศพ|วิจัย|กลุ่ม|อดิเรก|ประจำ|ฝีมือ)/;
    const withoutLabel = s.replace(/^\s*(?:งาน|เรื่อง|task|todo)\s*/i, "");
    if (withoutLabel.trim().length > 1 && !COMPOUND.test(withoutLabel.trim())) {
      s = withoutLabel;
    }
  }
  // Strip Thai helper/filler words that aren't part of the task name
  s = s.replace(/^มี\s*(?=งาน|เรื่อง|ของ|การ)/, ""); // "มีงาน" → "งาน"
  s = s.replace(/ต้อง(?=ส่ง|ทำ|ไป|เรียน|จ่าย|ซื้อ)/g, ""); // "ต้องส่ง" → "ส่ง"
  s = s.replace(/ต้อง(?=ส่ง|ทำ|ไป|เรียน)/g, ""); // "ต้องส่ง" → "ส่ง"
  s = s
    .replace(/resets?/gi, "")
    .replace(/every\s+(day|week|month|[a-z]+day)/gi, "")
    // Only strip standalone daily/weekly/etc — not when part of a game name like "MapleStory Daily"
    // isPreset flag skips this so preset names keep their suffix
    .replace(isPreset ? /^$/ : /\beveryday\b|\bdaily\b|\bweekly\b|\bmonthly\b|\bbiweekly\b/gi, "")
    .replace(/at\s+\d{1,2}(:\d{2})?\s*(am|pm)?/gi, "")
    .replace(/\d{1,2}(:\d{2})?\s*(am|pm)/gi, "")
    .replace(/midnight|noon|tonight|tomorrow|today/gi, "")
    .replace(/in\s+\d+\s+(days?|weeks?)/gi, "")
    .replace(/in\s+\d+\s+(minutes?|hours?)/gi, "")
    .replace(/next\s+(week|month)/gi, "")
    .replace(/\b(urgent|important|critical|asap|priority)\b/gi, "")
    .replace(/\s+/g, " ").trim();
  s = stripPoliteness(s);
  if (!s) return "";
  if (lang !== "en") return s.trim();
  return s.split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}

function extractSubjectName(segment: string): string {
  const matches = [...segment.matchAll(/วิชา\s*(\S+)/g)];
  if (matches.length > 0) {
    const last = matches[matches.length - 1];
    const raw = last[1]
      .replace(/สอบ.*$/, "").replace(/ตอน.*$/, "")
      .replace(/เวลา.*$/, "").replace(/ถึง.*$/, "").trim();
    return raw ? `สอบ${raw}` : "";
  }
  return "";
}

// ─── Language detection ───────────────────────────────────────
function detectLang(text: string): "th" | "en" | "mixed" {
  const thaiChars = (text.match(/[\u0E00-\u0E7F]/g) || []).length;
  const total = text.replace(/\s/g, "").length;
  if (thaiChars === 0) return "en";
  if (thaiChars / total > 0.4) return "th";
  return "mixed";
}

function normalizeInput(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, " ");
}

// ─── Game presets ─────────────────────────────────────────────
// Built-ins. Anything the user confirms from a model answer joins these at
// runtime through matchLearnedPreset — see src/lib/aiMemory.ts.
const GAME_PRESETS: Record<string, Partial<ParsedTask>> = {
  "honkai star rail": { name: "Honkai Star Rail Daily", category: "game", reset_type: "daily", reset_time: "04:00", description: "Daily stamina & missions" },
  "hsr": { name: "Honkai Star Rail Daily", category: "game", reset_type: "daily", reset_time: "04:00", description: "Daily stamina & missions" },
  "maplestory daily": { name: "MapleStory Daily", category: "game", reset_type: "daily", reset_time: "00:00", description: "Daily quests" },
  "maplestory weekly": { name: "MapleStory Weekly Boss", category: "game", reset_type: "weekly", reset_time: "00:00", reset_day: 1, description: "Weekly boss (Monday)" },
  "maplestory": { name: "MapleStory Daily", category: "game", reset_type: "daily", reset_time: "00:00", description: "Daily quests" },
  "twisted wonderland": { name: "Twisted Wonderland Daily", category: "game", reset_type: "daily", reset_time: "14:00", description: "Daily reset" },
  "twst": { name: "Twisted Wonderland Daily", category: "game", reset_type: "daily", reset_time: "14:00", description: "Daily reset" },
  "my hero ultra rumble": { name: "My Hero Ultra Rumble Daily", category: "game", reset_type: "daily", reset_time: "00:00", description: "Daily missions" },
  "mhur": { name: "My Hero Ultra Rumble Daily", category: "game", reset_type: "daily", reset_time: "00:00", description: "Daily missions" },
  "memory of chaos": { name: "HSR Memory of Chaos", category: "game", reset_type: "biweekly", reset_time: "04:00", anchor_date: "2024-01-01", description: "MoC biweekly" },
  "moc": { name: "HSR Memory of Chaos", category: "game", reset_type: "biweekly", reset_time: "04:00", anchor_date: "2024-01-01", description: "MoC biweekly" },
  "apocalyptic shadow": { name: "HSR Apocalyptic Shadow", category: "game", reset_type: "biweekly", reset_time: "04:00", anchor_date: "2024-01-15", description: "AS biweekly" },
  "pure fiction": { name: "HSR Pure Fiction", category: "game", reset_type: "biweekly", reset_time: "04:00", anchor_date: "2024-01-08", description: "PF biweekly" },
  // ── Fuzzy / short aliases ──────────────────────────────────────────────────
  "honkai": { name: "Honkai Star Rail Daily", category: "game", reset_type: "daily", reset_time: "04:00", description: "Daily stamina & missions" },
  "star rail": { name: "Honkai Star Rail Daily", category: "game", reset_type: "daily", reset_time: "04:00", description: "Daily stamina & missions" },
  "โฮงไก": { name: "Honkai Star Rail Daily", category: "game", reset_type: "daily", reset_time: "04:00", description: "Daily stamina & missions" },
  "maple": { name: "MapleStory Daily", category: "game", reset_type: "daily", reset_time: "00:00", description: "Daily quests" },
  "เมเปิ้ล": { name: "MapleStory Daily", category: "game", reset_type: "daily", reset_time: "00:00", description: "Daily quests" },
  "twisted": { name: "Twisted Wonderland Daily", category: "game", reset_type: "daily", reset_time: "14:00", description: "Daily reset" },
  "wonderland": { name: "Twisted Wonderland Daily", category: "game", reset_type: "daily", reset_time: "14:00", description: "Daily reset" },
  "ทวิสต์": { name: "Twisted Wonderland Daily", category: "game", reset_type: "daily", reset_time: "14:00", description: "Daily reset" },
  "ultra rumble": { name: "My Hero Ultra Rumble Daily", category: "game", reset_type: "daily", reset_time: "00:00", description: "Daily missions" },
  "my hero": { name: "My Hero Ultra Rumble Daily", category: "game", reset_type: "daily", reset_time: "00:00", description: "Daily missions" },
  // ── Other popular gacha / games ────────────────────────────────────────────
  "genshin impact": { name: "Genshin Impact Daily", category: "game", reset_type: "daily", reset_time: "04:00", description: "Daily commissions" },
  "genshin": { name: "Genshin Impact Daily", category: "game", reset_type: "daily", reset_time: "04:00", description: "Daily commissions" },
  "เก็นชิน": { name: "Genshin Impact Daily", category: "game", reset_type: "daily", reset_time: "04:00", description: "Daily commissions" },
  "blue archive": { name: "Blue Archive Daily", category: "game", reset_type: "daily", reset_time: "04:00", description: "Daily missions" },
  "nikke": { name: "NIKKE Daily", category: "game", reset_type: "daily", reset_time: "04:00", description: "Daily missions" },
  "wuthering waves": { name: "Wuthering Waves Daily", category: "game", reset_type: "daily", reset_time: "04:00", description: "Daily tasks" },
  "zenless zone zero": { name: "Zenless Zone Zero Daily", category: "game", reset_type: "daily", reset_time: "04:00", description: "Daily missions" },
  "zenless": { name: "Zenless Zone Zero Daily", category: "game", reset_type: "daily", reset_time: "04:00", description: "Daily missions" },
  "zzz": { name: "Zenless Zone Zero Daily", category: "game", reset_type: "daily", reset_time: "04:00", description: "Daily missions" },
  "path to nowhere": { name: "Path to Nowhere Daily", category: "game", reset_type: "daily", reset_time: "04:00", description: "Daily missions" },
  "limbus company": { name: "Limbus Company Daily", category: "game", reset_type: "daily", reset_time: "04:00", description: "Daily tasks" },
  "arknights": { name: "Arknights Daily", category: "game", reset_type: "daily", reset_time: "04:00", description: "Daily missions" },
};

// ─── Single segment parser ────────────────────────────────────
function parseSegment(
  segment: string,
  sharedDate: string | null,
  sharedCategory: Category,
  _isUrgent: boolean
): { task: ParsedTask; confidence: number; details: AIConfidence[] } {
  const lang = detectLang(segment);
  const details: AIConfidence[] = [];
  let confidence = 0.3;

  const times = extractAllTimes(segment);
  const reset_time = times.length > 0 ? times[0].time : null;
  if (reset_time) {
    details.push({ field: "time", value: reset_time, sure: true });
    confidence += 0.2;
  }

  const description = times.length >= 2 ? `${times[0].time} – ${times[1].time}` : "";
  if (description) details.push({ field: "time range", value: description, sure: true });

  const specific_date = sharedDate;
  if (specific_date) {
    details.push({ field: "date", value: specific_date, sure: true });
    confidence += 0.2;
  }

  // A specific_date task with NO DATE cannot exist on screen: getNextReset has
  // nothing to compute from, so the row saves, reports success, and then never
  // appears in any list. That is the worst shape a task can have — every part
  // of the app behaves correctly and the person is simply told that something
  // happened which did not.
  //
  // It is reachable whenever detectResetType reads a deadline word but the date
  // itself fails to parse, which is exactly what "deadline เมื่อวาน" did before
  // เมื่อวาน was a word this file knew. So the type is only kept when a date
  // came with it; otherwise the task becomes an undated one-off, which is what
  // the sentence actually said. Visible and editable beats correct-in-principle
  // and invisible.
  const detected = specific_date ? "specific_date" : detectResetType(segment);
  const reset_type: ResetType =
    detected === "specific_date" && !specific_date ? "one_time" : detected;
  details.push({ field: "type", value: reset_type, sure: true });
  confidence += 0.15;

  let name = extractSubjectName(segment);
  if (!name) name = cleanName(segment, lang);
  if (!name) name = "งาน";

  details.push({ field: "name", value: name, sure: name !== "งาน" });
  confidence += name !== "งาน" ? 0.15 : 0;
  confidence = Math.min(0.95, confidence);

  const task: ParsedTask = {
    name, description, category: sharedCategory, reset_type,
    // Was: nulled whenever reset_type was "specific_date". That silently
    // discarded "บ่ายสอง" out of "ประชุมทีม พฤหัส บ่ายสอง" — the user named a
    // time and the app threw it away without a word. A one-off task may
    // carry a time now; null still means all day. See countdown.ts.
    reset_time,
    reset_day: null,
    reset_interval_days: reset_type === "custom_days" ? 30 : null,
    anchor_date: null,
    event_start: null, event_end: null,
    // parseSegment gets a pre-resolved date string (never an exact ISO deadline)
    specific_date: reset_type === "specific_date" ? specific_date : null,
    is_priority: detectPriority(segment) ? 1 : 0,
    is_urgent:   detectUrgentFlag(segment) ? 1 : 0,
  };

  return { task, confidence, details };
}

// ─── Main smartParse ──────────────────────────────────────────
export function smartParse(input: string): AIResult {
  const lang = detectLang(input);
  const isThai = lang === "th" || lang === "mixed";
  const intent = detectIntent(input);

  // ── Intent: unknown — hand it over, do not guess ───────────
  //
  // Returning early with a low score is the whole mechanism. Nothing below this
  // line runs, so the preset matcher never gets to award 0.97 for recognising a
  // game name in a sentence that was never about adding a game, and the message
  // drops below the local floor and goes to the model, which has words for what
  // was actually asked.
  if (intent === "unknown") {
    return {
      intent: "unknown",
      tasks: [], isMulti: false,
      reply: "",
      confidence: 0.2,
      details: [],
      needsClarification: false,
    };
  }

  // ── Intent: clarify (correction message received) ─────────
  if (intent === "clarify") {
    const ctx = getLastTaskContext();
    return {
      intent: "clarify",
      tasks: [], isMulti: false,
      reply: ctx
        ? isThai ? `โอเค แก้ "${ctx.name}" เลย — ยืนยันในช่องด้านบนได้เลย 👆` : `Got it — update the preview above and confirm when ready 👆`
        : isThai ? "ไม่แน่ใจว่าหมายถึงอะไร — ลองพิมพ์ใหม่ได้เลย" : "Not sure what to correct — try rephrasing?",
      confidence: 0.5,
      details: [{ field: "intent", value: "correction", sure: false }],
      needsClarification: false,
    };
  }

  // ── Intent: delete ────────────────────────────────────────
  if (intent === "delete") {
    const targetName = extractTargetName(input) || getLastTaskContext()?.name || "";
    return {
      intent: "delete",
      tasks: [], isMulti: false,
      reply: targetName
        ? isThai ? `🗑️ ลบ "${targetName}" เลยไหม?` : `🗑️ Delete "${targetName}"?`
        : isThai ? "ลบงานไหนดี? บอกชื่อด้วยนะ 😊" : "Which task should I delete?",
      confidence: targetName ? 0.85 : 0.3,
      details: [{ field: "intent", value: "delete", sure: true }],
      needsClarification: !targetName,
      clarificationQuestion: !targetName ? (isThai ? "ชื่องานที่จะลบคืออะไร?" : "Task name to delete?") : undefined,
      targetTaskName: targetName || undefined,
    };
  }

  // ── Intent: edit time ─────────────────────────────────────
  if (intent === "edit_time") {
    const targetName = extractTargetName(input) || getLastTaskContext()?.name || "";
    const times = extractAllTimes(input);
    const newTime = times.length > 0 ? times[0].time : undefined;
    return {
      intent: "edit_time",
      tasks: [], isMulti: false,
      reply: targetName && newTime
        ? isThai ? `⏰ เปลี่ยนเวลา "${targetName}" เป็น ${newTime} เลยไหม?` : `⏰ Change "${targetName}" to ${newTime}?`
        : !targetName ? (isThai ? "แก้เวลางานไหนอยู่? บอกชื่อด้วยนะ" : "Which task's time should I update?")
        : (isThai ? `"${targetName}" — เปลี่ยนเป็นเวลาอะไร?` : `"${targetName}" — what's the new time?`),
      confidence: (targetName && newTime) ? 0.9 : 0.3,
      details: [
        { field: "intent", value: "edit_time", sure: true },
        ...(newTime ? [{ field: "new time", value: newTime, sure: true }] : []),
      ],
      needsClarification: !targetName || !newTime,
      targetTaskName: targetName || undefined,
      newTime,
    };
  }

  // ── Intent: edit priority ─────────────────────────────────
  if (intent === "edit_priority") {
    const targetName = extractTargetName(input) || getLastTaskContext()?.name || "";
    const setPriority = /ทำให้สำคัญ|เพิ่มดาว|mark.*important|set.*priority|make.*priority/i.test(input);
    return {
      intent: "edit_priority",
      tasks: [], isMulti: false,
      reply: targetName
        ? isThai
          ? `${setPriority ? "⭐ ตั้ง" : "☆ เอา priority ออกจาก"} "${targetName}"?`
          : `${setPriority ? "⭐ Mark" : "☆ Unmark"} "${targetName}" as priority?`
        : isThai ? "งานไหนที่ต้องการเปลี่ยน priority?" : "Which task?",
      confidence: targetName ? 0.85 : 0.3,
      details: [{ field: "intent", value: "edit_priority", sure: true }],
      needsClarification: !targetName,
      targetTaskName: targetName || undefined,
      newPriority: setPriority,
    };
  }

  // ── Context follow-up: "ใส่ priority ด้วย" / "add priority" ─
  // Short message with no task info but prior context exists
  // Follow-up: message refers to the previous task (by using edit keywords or just a time/priority with no new task name)
  const hasNewTaskName = cleanName(input, lang).length > 2;
  const looksLikeFollowUp = getLastTaskContext() !== null && (
    input.trim().length < 30 ||
    /^(?:เปลี่ยนเวลา|แก้เวลา|ขยับเวลา|เลื่อนเวลา|change time|update time|reschedule|priority|สำคัญ|ดาว|ด่วน|urgent)/i.test(input.trim())
  );
  const isFollowUp = looksLikeFollowUp && !hasNewTaskName;
  if (isFollowUp) {
    const ctx = getLastTaskContext()!;
    if (/priority|สำคัญ|ดาว|ด่วน|urgent/i.test(input)) {
      return {
        intent: "edit_priority",
        tasks: [], isMulti: false,
        reply: isThai ? `ตั้ง "${ctx.name}" เป็น important เลยไหม?` : `Mark "${ctx.name}" as important?`,
        confidence: 0.9,
        details: [{ field: "context follow-up", value: ctx.name, sure: true }],
        needsClarification: false,
        targetTaskName: ctx.name,
        newPriority: true,
      };
    }
    // Follow-up with new time
    const followTimes = extractAllTimes(input);
    if (followTimes.length > 0) {
      return {
        intent: "edit_time",
        tasks: [], isMulti: false,
        reply: isThai ? `เปลี่ยนเวลา "${ctx.name}" เป็น ${followTimes[0].time}?` : `Update "${ctx.name}" time to ${followTimes[0].time}?`,
        confidence: 0.88,
        details: [{ field: "context follow-up", value: ctx.name, sure: true }],
        needsClarification: false,
        targetTaskName: ctx.name,
        newTime: followTimes[0].time,
      };
    }
  }

  // ── Habit memory ──────────────────────────────────────────
  const habit = matchHabit(input);
  if (habit) {
    const task: ParsedTask = {
      name: habit.name || "Task", description: habit.description || "",
      category: habit.category || "personal", reset_type: habit.reset_type || "one_time",
      reset_time: habit.reset_time || null, reset_day: habit.reset_day ?? null,
      reset_interval_days: habit.reset_interval_days ?? null,
      anchor_date: habit.anchor_date || null,
      event_start: null, event_end: null,
      specific_date: habit.specific_date || null,
      is_priority: habit.is_priority ?? 0,
      is_urgent:   (habit as any).is_urgent ?? 0,
    };
    return {
      intent: "add", tasks: [task], isMulti: false,
      reply: isThai ? `🧠 จำได้! "${task.name}" — ยืนยันได้เลย` : `🧠 Remembered "${task.name}" — confirm below`,
      confidence: 0.95,
      details: [{ field: "🧠 memory", value: task.name, sure: true }],
      needsClarification: false,
    };
  }

  // ── Game presets ──────────────────────────────────────────
  const lower = input.toLowerCase();
  // A preset learned from a confirmed answer is checked first: it came from
  // this user's own data, so it beats a generic built-in on a tie.
  const learned = matchLearnedPreset(input);
  const presetEntries: [string, Partial<ParsedTask>][] = learned
    ? [[learned.key, learned.task as Partial<ParsedTask>], ...Object.entries(GAME_PRESETS)]
    : Object.entries(GAME_PRESETS);

  for (const [key, preset] of presetEntries) {
    if (lower.includes(key.toLowerCase())) {
      // User-specified time always wins over the preset default
      const userTimes = extractAllTimes(input);
      const resolvedTime = userTimes.length > 0 ? userTimes[0].time : (preset.reset_time || null);
      const timeOverridden = userTimes.length > 0 && resolvedTime !== preset.reset_time;

      const task: ParsedTask = {
        name: preset.name!, description: preset.description || "",
        category: preset.category || "game", reset_type: preset.reset_type || "daily",
        reset_time: resolvedTime, reset_day: preset.reset_day ?? null,
        reset_interval_days: null, anchor_date: preset.anchor_date || null,
        event_start: null, event_end: null, specific_date: null, is_priority: 0, is_urgent: 0,
      };
      return {
        intent: "add", tasks: [task], isMulti: false,
        reply: `🎮 "${task.name}" — ${task.reset_type}${timeOverridden ? ` · resets at ${resolvedTime}` : ""}`,
        confidence: 0.97,
        details: [
          { field: "game preset", value: key, sure: true },
          ...(timeOverridden ? [{ field: "time", value: resolvedTime!, sure: true }] : []),
        ],
        needsClarification: false,
      };
    }
  }

  // ── Multi-task ────────────────────────────────────────────
  const isPriority  = detectPriority(input);
  const isUrgentFlag = detectUrgentFlag(input);
  const isUrgent = isPriority || isUrgentFlag;
  const dateResult = extractSpecificDate(input);
  const sharedDate = dateResult?.date ?? null;
  const sharedCategory = detectCategory(input);
  const segments = detectMultiTaskSegments(input);

  if (segments && segments.length >= 2) {
    const allTasks: ParsedTask[] = [];
    const allDetails: AIConfidence[] = [];
    let totalConf = 0;
    for (const seg of segments) {
      // For multi-task splits, each segment gets the shared date string only (no exact deadline)
      const { task, confidence, details } = parseSegment(seg, sharedDate, sharedCategory, isUrgent);
      allTasks.push(task);
      allDetails.push(...details);
      totalConf += confidence;
    }
    const names = allTasks.map(t => `"${t.name}"`).join(", ");
    return {
      intent: "add", tasks: allTasks, isMulti: true,
      reply: isThai ? `📋 เจอ ${allTasks.length} งาน: ${names}\nเช็คให้ถูกต้องแล้วยืนยันได้เลย` : `📋 Found ${allTasks.length} tasks: ${names}\nCheck the details and confirm!`,
      confidence: totalConf / allTasks.length,
      details: allDetails,
      needsClarification: false,
    };
  }

  // ── Single task ───────────────────────────────────────────
  const times = extractAllTimes(input);
  const reset_time = times.length > 0 ? times[0].time : null;
  const details: AIConfidence[] = [];
  let confidence = 0.3;

  if (isPriority)   { details.push({ field: "⭐ important", value: "detected", sure: true }); confidence += 0.1; }
  if (isUrgentFlag) { details.push({ field: "🔥 critical",  value: "detected", sure: true }); confidence += 0.1; }
  if (reset_time) { details.push({ field: "time", value: reset_time, sure: true }); confidence += 0.2; }
  if (sharedDate) { details.push({ field: "date", value: sharedDate, sure: true }); confidence += 0.2; }

  // exactDeadlineISO is set ONLY for "อีก X นาที/ชั่วโมง" — exact UTC countdown deadline
  const exactDeadlineISO = dateResult?.exactDeadlineISO ?? null;
  let reset_type: ResetType = exactDeadlineISO ? "event_window"   // exact minute-level deadline
    : sharedDate ? "specific_date"                                  // date-only deadline
    : detectResetType(input);
  // Safety: never produce one_time or event_window without a proper event_end from AI
  // one_time uses Bangkok-local event_end which freezes WebKit buttons
  // event_window (Limited Event) without event_end causes null countdown → invisible task
  // Only promote to specific_date when there IS a date to promote it with —
  // see the note in the single-task path for why an undated specific_date is
  // a task that saves successfully and is then never seen again.
  if (reset_type === "one_time" && sharedDate) reset_type = "specific_date";
  if (reset_type === "event_window" && !exactDeadlineISO) {
    reset_type = sharedDate ? "specific_date" : "one_time";
  }
  if (reset_type === "specific_date" && !sharedDate) reset_type = "one_time";
  details.push({ field: "type", value: reset_type, sure: true });
  confidence += 0.15;
  details.push({ field: "category", value: sharedCategory, sure: true });
  confidence += 0.1;

  let name = extractSubjectName(input);
  if (!name) name = cleanName(input, lang);
  if (!name) name = isThai ? "งานใหม่" : "New Task";

  details.push({ field: "name", value: name, sure: name !== "New Task" && name !== "งานใหม่" });
  confidence = Math.min(0.95, confidence + 0.1);

  const description = times.length >= 2 ? `${times[0].time} – ${times[1].time}` : "";
  const task: ParsedTask = {
    name, description, category: sharedCategory, reset_type,
    // Was: nulled whenever reset_type was "specific_date". That silently
    // discarded "บ่ายสอง" out of "ประชุมทีม พฤหัส บ่ายสอง" — the user named a
    // time and the app threw it away without a word. A one-off task may
    // carry a time now; null still means all day. See countdown.ts.
    reset_time,
    reset_day: null,
    reset_interval_days: reset_type === "custom_days" ? 30 : null,
    anchor_date: null,
    event_start: null,
    // For "อีก X นาที": event_window + event_end = UTC deadline string ("...Z")
    event_end: (exactDeadlineISO && reset_type === "event_window") ? exactDeadlineISO : null,
    specific_date: reset_type === "specific_date" ? sharedDate : null,
    is_priority: isPriority ? 1 : 0,
    is_urgent:   isUrgentFlag ? 1 : 0,
  };

  const needsClarification = (name === "New Task" || name === "งานใหม่") && confidence < 0.4;

  // Build a natural reply with all the key parsed info visible
  const typeLabel: Partial<Record<ResetType, string>> = {
    daily: isThai ? "ทุกวัน" : "daily",
    weekly: isThai ? "ทุกอาทิตย์" : "weekly",
    biweekly: isThai ? "ทุกสองอาทิตย์" : "biweekly",
    custom_days: isThai ? "ทุกเดือน" : "monthly",
    event_window: isThai ? "🎌 limited event" : "🎌 limited event",
    specific_date: sharedDate ? (isThai ? "วันที่ " + toDateDisplay(sharedDate) : toDateDisplay(sharedDate)) : "",
  };
  const typeStr = typeLabel[reset_type] ?? "";
  const timeStr = reset_time ? ` · ${reset_time}` : "";

  const reply = needsClarification
    ? (isThai ? "เข้าใจบางส่วน — ช่วยบอกชื่องานให้ชัดขึ้นได้ไหม? 😊" : "Got some info — what should I name this task?")
    : isThai
      ? `✅ "${name}"${typeStr ? " — " + typeStr : ""}${timeStr}\nยืนยันหรือแก้ไขก่อนบันทึกได้เลย`
      : `✅ "${name}"${typeStr ? " — " + typeStr : ""}${timeStr}\nConfirm or edit before saving`;
  return {
    intent: "add", tasks: [task], isMulti: false,
    reply, confidence, details, needsClarification,
    clarificationQuestion: needsClarification ? (isThai ? "ชื่องานคืออะไร?" : "What's the task name?") : undefined,
  };
}

// ─── Quick presets ────────────────────────────────────────────
export const QUICK_PRESETS = [
  { label: "🌟 HSR Daily", input: "Honkai Star Rail daily" },
  { label: "⚔️ HSR MoC", input: "Memory of Chaos" },
  { label: "🍁 MapleStory", input: "MapleStory daily" },
  { label: "🌹 TWST", input: "Twisted Wonderland" },
  { label: "🦸 MHUR", input: "My Hero Ultra Rumble" },
  { label: "📚 ส่งการบ้าน", input: "ส่งการบ้านพรุ่งนี้ สำคัญ" },
  { label: "📝 สอบ", input: "สอบวันศุกร์" },
  { label: "💊 ยาวันนี้", input: "กินยาวันนี้" },
];

export function parseNaturalLanguage(input: string): ParsedTask {
  return smartParse(input).tasks[0] ?? {
    name: "New Task", description: "", category: "personal",
    reset_type: "one_time", reset_time: null, reset_day: null,
    reset_interval_days: null, anchor_date: null,
    event_start: null, event_end: null, specific_date: null, is_priority: 0, is_urgent: 0,
  };
}