// ─── moneyDraft.ts — what a new row in the books looks like ──────────────────
//
// The same job taskDraft.ts does, for the other half of the app, and for the
// same reason: the phone is about to become a second thing that can record
// spending, and six columns with six small coercions reproduced in Kotlin from
// reading the TypeScript would be right on the day they were written.
//
// Money makes it worse than tasks did. A task written slightly wrong rings at
// the wrong time and somebody notices. An amount written slightly wrong is a
// number in a total, and a total is exactly the kind of thing nobody audits
// until the month it matters.
//
// ─── WHY MONEY IN AND MONEY OUT ARE IN ONE FILE ──────────────────────────────
//
// They are different tables with different columns, and they ask the same three
// questions on the way in: is this a number, is it more than nothing, and what
// unit is it counted in. Two files would answer those three twice, and the
// copies would drift the first time one of them learned something — which is how
// a validator ends up refusing a negative expense and accepting a negative
// payment, with nothing anywhere saying so.
//
// ─── THE CURRENCY IS NOT OPTIONAL HERE, AND IS ON THE DESKTOP ────────────────
//
// `addExpense` defaults it to whatever the setting says right now. That is the
// right default in a form, where the person can see the symbol next to the box
// they are typing in. It is the wrong default in a shared function, because a
// caller that forgot would silently file spending in whatever unit the machine
// happened to be set to — and money.ts already documents at length why a number
// without its unit is not an amount.
//
// So the caller passes it and the desktop's form is the one that decides what
// "right now" means.

import type { SqlValue } from "./taskDraft";

/** The columns a new expense row is written with, in the order the values come. */
export const EXPENSE_COLUMNS = [
  "amount",
  "currency",
  "category",
  "note",
  "date",
  "slip_ref",
] as const;

export interface ExpenseDraft {
  amount?: unknown;
  currency?: unknown;
  category?: unknown;
  note?: unknown;
  date?: unknown;
  slip_ref?: unknown;
  /** Anything else the caller is carrying, and it is dropped. See TaskDraft. */
  [key: string]: unknown;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Where money goes when nobody said which category.
 *
 * The schema has it as the column default, this file falls back to it, and the
 * phone reproduces both. Three places, one string, and vectors so it can only
 * ever be one string.
 */
export const CATEGORY_FALLBACK = "other";

/**
 * The unit to count in when nothing has said otherwise.
 *
 * This was a private constant in money.ts and a second private constant in the
 * phone's money screen, with nothing connecting them. Two devices disagreeing
 * about what "no setting yet" means is not a crash: it is one machine filing a
 * month in baht and the other filing the same month in something else, and
 * every total on both sides quietly leaving half of it out.
 *
 * Pinned in the vectors for that reason. It is one of the few strings in this
 * project where two copies could disagree without anything failing.
 */
export const CURRENCY_FALLBACK = "THB";

/**
// A category key, or `other`.
//
// Filing rather than refusing, which is what the desktop has always done. A
// category that has been renamed or hidden on one device should not stop a
// number being recorded on the other; the money is the part that matters and
// the label can be fixed afterwards.
//
// `other` is not in the known list on a database that has never loaded its
// categories, and it is still the right answer there — it is the fallback the
// schema ships with.
 */
export function resolveCategory(key: unknown, known: readonly string[]): string {
  if (typeof key !== "string" || key === "") return CATEGORY_FALLBACK;
  return known.includes(key) ? key : CATEGORY_FALLBACK;
}

function num(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

/** The six values, in EXPENSE_COLUMNS order. */
export function expenseValues(d: ExpenseDraft, known: readonly string[]): SqlValue[] {
  return [
    num(d.amount) ?? 0,
    typeof d.currency === "string" && d.currency !== "" ? d.currency : "",
    resolveCategory(d.category, known),
    typeof d.note === "string" ? d.note : "",
    typeof d.date === "string" ? d.date : "",
    // Null rather than an empty string, and that is load bearing: the unique
    // index on this column tolerates any number of nulls and exactly one of
    // each string. Manual entries writing "" would collide with each other
    // from the second one onwards.
    typeof d.slip_ref === "string" && d.slip_ref !== "" ? d.slip_ref : null,
  ];
}

/**
// What is wrong with this draft, as codes rather than sentences.
//
// Nothing here is enforced by the desktop form today, which validates in the
// component and defaults its way past the rest. Those defaults are real and
// this does not remove them; it gives the phone, which has none, something to
// check against.
 */
/**
// Is this a number, and is it more than nothing.
//
// Zero is refused as well as negative. A zero-baht row changes no total and
// takes up a line in every month view for ever, which is a mis-tap rather than
// a thing anyone meant to record.
 */
function amountProblems(v: unknown): string[] {
  if (v === undefined || v === null || v === "") return ["amount-missing"];
  const amount = num(v);
  if (amount === null) return ["amount-not-a-number"];
  if (amount <= 0) return ["amount-not-positive"];
  return [];
}

/** What unit, and which day. The two questions neither side may skip. */
function unitAndDateProblems(currency: unknown, date: unknown): string[] {
  const out: string[] = [];
  if (typeof currency !== "string" || currency === "") out.push("currency-missing");
  if (typeof date !== "string" || date === "") out.push("date-missing");
  else if (!YMD.test(date)) out.push("date-malformed");
  return out;
}

export function expenseProblems(d: ExpenseDraft, known: readonly string[]): string[] {
  // Not a problem, deliberately: an unknown category is filed under `other`
  // rather than refused. See resolveCategory.
  void known;
  return amountProblems(d.amount).concat(unitAndDateProblems(d.currency, d.date));
}

// ─── money coming in ─────────────────────────────────────────────────────────

/** The columns a new income row is written with, in the order the values come. */
export const INCOME_COLUMNS = ["amount", "source", "note", "date", "currency"] as const;

export interface IncomeDraft {
  amount?: unknown;
  /**
   * Who it came from, as free text.
   *
   * Not a fixed list, and not a table the way expense categories are. The
   * desktop has always had this as a plain box, and what goes in it is "TELUS"
   * or "3Play" — the name on the actual payment, which is the thing worth being
   * able to find again. Five tidy buckets would file every one of those under
   * "freelance" and lose the only detail that mattered.
   */
  source?: unknown;
  note?: unknown;
  date?: unknown;
  currency?: unknown;
  /** Anything else the caller is carrying, and it is dropped. */
  [key: string]: unknown;
}

/** The five values, in INCOME_COLUMNS order. */
export function incomeValues(d: IncomeDraft): SqlValue[] {
  return [
    num(d.amount) ?? 0,
    // Blank stays blank rather than becoming "other". That is what the desktop
    // has always written, and this is a move rather than a change of mind. The
    // column's default only applies to a statement that leaves it out, and
    // neither side leaves it out.
    typeof d.source === "string" ? d.source : "",
    typeof d.note === "string" ? d.note : "",
    typeof d.date === "string" ? d.date : "",
    typeof d.currency === "string" && d.currency !== "" ? d.currency : "",
  ];
}

/**
// What is wrong with this draft, as codes rather than sentences.
//
// The same three questions the expense side asks, deliberately answering with
// the same codes, so a screen that can say them once can say them for both.
//
// A blank source is not among them. It is allowed on the desktop and this is
// not the place to start refusing it — and unlike an amount or a unit, a
// payment with no name attached is still a true row.
 */
export function incomeProblems(d: IncomeDraft): string[] {
  return amountProblems(d.amount).concat(unitAndDateProblems(d.currency, d.date));
}

// ─── reading the month back ──────────────────────────────────────────────────
//
// The three statements a screen needs to answer "how am I doing this month",
// written once because both sides ask it now. The phone can record money and
// could not see any of it again without opening the desktop, which makes the
// number in the app something you have to go and look up somewhere else — the
// exact gap recording on the phone was meant to close.
//
// Every one of them filters by currency, and that is not an optimisation. A
// total that sums across units is not a wrong number, it is not a number: it is
// three kilograms plus five metres. money.ts spends a page on why.
//
// Which is why the third one exists. Filtering silently is how a screen shows a
// confident, wrong-looking zero, so anything left out has to be countable.

/** Spent this month, in one unit. `?` is the currency, then the `YYYY-MM`. */
export const SQL_MONTH_SPENT =
  "SELECT COALESCE(SUM(amount), 0) as total FROM expenses " +
  "WHERE deleted = 0 AND currency = ? AND strftime('%Y-%m', date) = ?";

/** Received this month, in one unit. Same parameters, same order. */
export const SQL_MONTH_RECEIVED =
  "SELECT COALESCE(SUM(amount), 0) as total FROM income " +
  "WHERE deleted = 0 AND currency = ? AND strftime('%Y-%m', date) = ?";

/**
 * How many rows this month were counted in some OTHER unit.
 *
 * A count rather than a breakdown, deliberately. The desktop shows the totals
 * per currency because it has the room and the person is sitting down with it;
 * a phone needs one short line that says "there is more, and it is not here".
 * Both answers are honest. Only one of them fits.
 */
export const SQL_MONTH_OTHER_COUNT =
  "SELECT COUNT(*) as n FROM (" +
  "SELECT currency FROM expenses WHERE deleted = 0 AND currency != ? AND strftime('%Y-%m', date) = ? " +
  "UNION ALL " +
  "SELECT currency FROM income WHERE deleted = 0 AND currency != ? AND strftime('%Y-%m', date) = ?" +
  ")";

// ─── the last few entries ────────────────────────────────────────────────────
//
// The month line above answers "how much", and a total is the one thing a total
// cannot tell you: whether the coffee at eleven went in twice. Two identical
// entries move the number by exactly as much as one entry for twice the price,
// and nothing on the screen distinguishes them.
//
// WHY THIS ONE DOES NOT FILTER BY CURRENCY
//
// Every statement above filters by unit, because a sum across units is not a
// number. A list is the opposite case: each row carries its own unit and prints
// it, so nothing has to be added together for the row to mean something. Which
// makes this the place the rows the totals left out can finally be seen — the
// "there is more and it is not here" line stops pointing at another machine.
//
// WHY NOT THIS MONTH ONLY
//
// It would agree more neatly with the line above it, and it would be empty on
// the first of the month, which is the day an empty list is least use. What is
// wanted standing in a shop is the last few things, not the calendar.
//
// WHY THE ORDER IS THREE DEEP
//
// `date` is the day a person would say it happened. `created_at` breaks ties by
// the order things were written down, and it travels with the row, so both
// machines sort the same day the same way. `uid` settles the rest: it is a coin
// toss, but it is the same coin toss on every device, which `id` is not — that
// one counts arrivals, and two devices never receive rows in the same order.
//
// WHY THE LIMIT IS IN THE STRING
//
// It is a decision, not an argument: nothing on either side wants a different
// number, and a decision spelled out in one pinned copy is one that cannot come
// to mean twenty here and fifty there. It also keeps this bindable everywhere —
// the phone's driver has no integer to bind, only a float, and SQLite is within
// its rights to refuse one in a LIMIT.

/** The last twenty entries, both directions, every unit. No parameters. */
export const SQL_RECENT_MONEY =
  "SELECT kind, uid, date, amount, currency, tag, note FROM (" +
  "SELECT 'out' as kind, uid, date, amount, currency, created_at, category as tag, note " +
  "FROM expenses WHERE deleted = 0 " +
  "UNION ALL " +
  "SELECT 'in' as kind, uid, date, amount, currency, created_at, source as tag, note " +
  "FROM income WHERE deleted = 0" +
  ") ORDER BY date DESC, created_at DESC, uid DESC LIMIT 20";

// ─── taking one back ─────────────────────────────────────────────────────────
//
// A row that simply vanishes tells the other device nothing, so it comes back on
// the next sync. What is left behind instead is a tombstone: the row stays, the
// flag goes up, and the payload is emptied.
//
// Emptying it is the part worth pinning. `deleted = 1` alone would leave the
// amount and whatever was typed in the note sitting in a row that travels to
// every device and into every backup, for a purchase somebody has said they did
// not want recorded. Which columns get cleared is therefore a decision, and a
// decision spelled out in two places is a decision that comes to differ: one
// machine's delete would leave the note behind and the other's would not, and
// the merge would settle it by whichever clock ran later.
//
// Keyed by uid rather than by id, because `id` is an autoincrement that means a
// different row on each machine — the same reason TaskRepo keys alarms by uid.
// The desktop looks the uid up from the id it has on screen; the phone has it in
// hand already, because the list it shows is keyed on it.
//
// `AND deleted = 0` so that deleting twice is not a second write. The second one
// would only restamp updated_at, which is one more version for the other device
// to receive and agree with itself about.

/** Tombstone an expense, payload and all. `?` is the uid. */
export const SQL_DELETE_EXPENSE =
  "UPDATE expenses SET deleted = 1, note = '', amount = 0, slip_ref = NULL " +
  "WHERE uid = ? AND deleted = 0";

/** Tombstone a payment. Same shape, and the name on it goes too. */
export const SQL_DELETE_INCOME =
  "UPDATE income SET deleted = 1, source = '', note = '', amount = 0 " +
  "WHERE uid = ? AND deleted = 0";