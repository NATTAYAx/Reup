// ─── taskDraft.ts — what a new task looks like as a row, decided once ─────────
//
// WHY THIS FILE EXISTS
//
// `createTask` in database.ts built its own sixteen values inline: a `|| ''`
// here, a `? 1 : 0` there, a Number() that has to tell undefined from null, and
// a date sanitiser applied to six of the columns and not the other ten. All of
// it correct, and all of it in a function signature that reads `task: any`.
//
// That was fine while one screen on one machine was the only thing that could
// make a task. It stops being fine the moment a second one can, and a second
// one is exactly what the phone is about to become. A Kotlin version of those
// sixteen coercions, written from reading this one, would be right on the day
// it was written and would drift on the first change either side. The project
// has spent a month removing that shape: two parsers, two translation systems,
// two lists of tables, two clocks.
//
// So the coercions move here, the desktop calls them, the phone reproduces them
// against a vector file, and the argument stops being about who remembered.
//
// ─── WHAT THIS FILE DOES NOT DO ──────────────────────────────────────────────
//
// It does not decide whether a task is allowed to be saved. `problems()` names
// what is wrong and the caller decides what that is worth: the desktop form has
// always refused exactly two of them and quietly defaulted its way past the
// rest, and changing that from here would be a behaviour change smuggled into a
// refactor. The phone can be stricter because it has no defaults to hide behind.

/** The columns a new task row is written with, in the order the values come. */
export const TASK_COLUMNS = [
  "name",
  "description",
  "category",
  "reset_type",
  "reset_time",
  "reset_day",
  "reset_interval_days",
  "anchor_date",
  "event_start",
  "event_end",
  "specific_date",
  "is_priority",
  "is_urgent",
  "min_step",
  "notify_before_min",
  "time_zone",
  "intent",
] as const;

/** The reset types the engine knows how to schedule. */
export const RESET_TYPES = [
  "daily",
  "weekly",
  "biweekly",
  "custom_days",
  "event_window",
  "specific_date",
  "one_time",
] as const;

export type SqlValue = string | number | null;

export interface TaskDraft {
  name?: unknown;
  description?: unknown;
  category?: unknown;
  reset_type?: unknown;
  reset_time?: unknown;
  reset_day?: unknown;
  reset_interval_days?: unknown;
  anchor_date?: unknown;
  event_start?: unknown;
  event_end?: unknown;
  specific_date?: unknown;
  is_priority?: unknown;
  is_urgent?: unknown;
  min_step?: unknown;
  notify_before_min?: unknown;
  time_zone?: unknown;
  intent?: unknown;
  /**
   * Anything else the caller is carrying, and it is dropped.
   *
   * Not laziness. Three of the four call sites hand over `cover_image`, which
   * is form state with no column behind it, and `createTask` has silently
   * ignored it since the day it was written. Without this line, giving that
   * function a real type instead of `any` turns a behaviour that has always
   * been fine into a compile error in three files — which is a refactor
   * demanding changes to code that was not wrong.
   *
   * So the sixteen names above say what is READ, and this says what happens to
   * everything else: nothing. Both facts are worth being able to look up.
   */
  [key: string]: unknown;
}

/**
 * The date and time columns, tidied without being reinterpreted.
 *
 * Moved here from database.ts rather than copied: `updateTask` applies it to the
 * same columns and now imports it, so there is one of these rather than two.
 *
 * The rules, in the order they are tried, and none of them changes what an
 * instant means:
 *
 *   a UTC stamp keeps its Z and loses its milliseconds
 *   an offset stamp keeps its offset and loses its milliseconds
 *   a bare `YYYY-MM-DDTHH:MM:SS` is local time and stays local
 *   a legacy `YYYY-MM-DD HH:MM:SS` becomes the T form, still local
 *   a bare date or a bare time is passed through untouched
 *
 * Milliseconds go because this column is compared as a string in more than one
 * place, and two stamps for the same instant that differ only in a fraction are
 * two different strings.
 */
export function sanitizeText(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/.test(s)) return s.replace(/\.\d+Z$/, "Z");
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+[+-]\d{2}:\d{2}$/.test(s)) {
    return s.replace(/\.\d+([+-])/, "$1");
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(s)) {
    return s.replace(/\.\d+$/, "").replace(/Z$/, "");
  }
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s)) return s.replace(" ", "T");
  return s;
}

/**
 * A number, or null, keeping the difference between "not given" and "cleared".
 *
 * Both arrive as null in the row, which is why the original could get away with
 * a nested ternary. It is written out because the two are not the same question
 * anywhere else in the app, and a reader should not have to work out that here
 * they happen to share an answer.
 */
function num(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** The sixteen values, in TASK_COLUMNS order. */
export function taskValues(d: TaskDraft): SqlValue[] {
  return [
    typeof d.name === "string" ? d.name : String(d.name ?? ""),
    typeof d.description === "string" && d.description !== "" ? d.description : "",
    typeof d.category === "string" ? d.category : null,
    typeof d.reset_type === "string" ? d.reset_type : null,
    sanitizeText(d.reset_time),
    num(d.reset_day),
    num(d.reset_interval_days),
    sanitizeText(d.anchor_date),
    sanitizeText(d.event_start),
    sanitizeText(d.event_end),
    sanitizeText(d.specific_date),
    d.is_priority ? 1 : 0,
    d.is_urgent ? 1 : 0,
    sanitizeText(d.min_step),
    num(d.notify_before_min),
    sanitizeText(d.time_zone),
    d.intent === "want" || d.intent === "must" ? d.intent : null,
  ];
}

// ─── editing an existing row ─────────────────────────────────────────────────

/**
 * Which columns an edit may touch, and how each one is read on the way in.
 *
 * This replaces `UPDATABLE_TASK_COLUMNS` in database.ts, which was a third
 * hand-written list of task columns living two screens away from the other two,
 * with its own `INTEGER_COLS` and `TEXT_DATE_COLS` sets beside it. Three lists
 * describing the same sixteen columns, none of them pointing at the others.
 *
 * It is also the allowlist, and that is the load-bearing part. Column names go
 * into the SQL text itself — they cannot be bound as parameters the way values
 * can — so they have to come from a list written here rather than from whatever
 * keys the caller happened to pass. The `Partial<>` on the old signature looked
 * like it enforced that and did not: types are gone by the time this runs, and
 * an object parsed from a model reply or arriving over sync satisfies no type
 * at all at runtime.
 *
 * `notes` is here and not in TASK_COLUMNS because a new task has no notes yet.
 * That is the one real difference between the two lists.
 */
export const TASK_EDITABLE: Record<string, "raw" | "clean" | "int" | "flag" | "intent"> = {
  name: "raw",
  description: "raw",
  notes: "raw",
  category: "raw",
  reset_type: "raw",
  reset_time: "clean",
  reset_day: "int",
  reset_interval_days: "int",
  anchor_date: "clean",
  event_start: "clean",
  event_end: "clean",
  specific_date: "clean",
  is_priority: "flag",
  is_urgent: "flag",
  min_step: "clean",
  notify_before_min: "int",
  time_zone: "clean",
  intent: "intent",
};

function coerce(how: string, v: unknown): SqlValue {
  switch (how) {
    case "clean":
      return sanitizeText(v);
    case "int":
      return num(v);
    case "flag":
      return v ? 1 : 0;
    case "intent":
      return v === "want" || v === "must" ? v : null;
    default:
      if (v === undefined || v === null) return null;
      return typeof v === "string" ? v : String(v);
  }
}

/**
 * An edit, as the columns to set and the values to bind.
 *
 * Keys the list does not know are dropped in silence rather than reaching the
 * SQL string, which is what the old code did and the reason it did it.
 *
 * Two coercions changed on the way here, and both are named rather than
 * smuggled in. `is_priority` was `Number(v)` and is now the same truthiness
 * test `createTask` has always used, so `true` no longer means something
 * different depending on which of the two functions is looking at it.
 * `min_step` and `time_zone` were passed through raw and now go through the
 * same cleaner as on create, which turns an empty string into null.
 *
 * Neither is observable from any caller in the app today — every form already
 * sends null rather than "" — but "this column means two things depending on
 * whether the row is new" is the kind of difference that is only cheap while
 * nobody has noticed it.
 */
export function taskUpdate(fields: Record<string, unknown>): {
  columns: string[];
  values: SqlValue[];
} {
  const columns: string[] = [];
  const values: SqlValue[] = [];
  // Walking the allowlist rather than the caller's keys, so the shape of an
  // UPDATE is a property of this file and not of whatever built the object.
  // Two devices producing the same SQL for the same edit is worth more than
  // preserving the order somebody happened to type the fields in.
  for (const column of Object.keys(TASK_EDITABLE)) {
    if (!(column in fields)) continue;
    columns.push(column);
    values.push(coerce(TASK_EDITABLE[column], fields[column]));
  }
  return { columns, values };
}

/**
 * What is wrong with this draft, as codes rather than sentences.
 *
 * Codes because two languages and a settings screen all have to agree on the
 * list, and a translated sentence is not something a Kotlin test can compare
 * against. The words belong to i18n; the facts belong here.
 *
 * `name-empty` and `date-missing` are the two the desktop form has always
 * refused. The rest are new information about drafts that form cannot produce,
 * because every control on it has a default — and the phone, the AI parser and
 * a restored file are three things that can.
 */
export function taskProblems(d: TaskDraft): string[] {
  const out: string[] = [];
  const v = taskValues(d);
  const at = (c: (typeof TASK_COLUMNS)[number]): SqlValue => v[TASK_COLUMNS.indexOf(c)];

  const name = at("name");
  if (typeof name !== "string" || name.trim() === "") out.push("name-empty");

  const type = at("reset_type");
  if (typeof type !== "string" || !(RESET_TYPES as readonly string[]).includes(type)) {
    out.push("reset-type-unknown");
    // Everything below is a rule about a particular type. With no type to
    // stand on they would all fire at once and say nothing.
    return out;
  }

  const time = at("reset_time");
  if (time !== null && !/^\d{2}:\d{2}$/.test(String(time))) out.push("time-malformed");

  if (type === "weekly" || type === "biweekly") {
    const day = at("reset_day");
    // Sunday is 0, which is falsy, which is why this asks about null rather
    // than about truthiness. Getting that wrong makes Sunday the one day of
    // the week a weekly task cannot be set to.
    if (day === null) out.push("weekly-needs-day");
    else if (!Number.isInteger(day) || (day as number) < 0 || (day as number) > 6) {
      out.push("day-out-of-range");
    }
  }

  if (type === "custom_days") {
    const n = at("reset_interval_days");
    if (n === null) out.push("custom-needs-interval");
    else if (!Number.isInteger(n) || (n as number) < 1) out.push("interval-out-of-range");
  }

  if (type === "event_window" && (at("event_start") === null || at("event_end") === null)) {
    out.push("event-needs-window");
  }

  if (type === "specific_date" && at("specific_date") === null) out.push("date-missing");

  return out;
}