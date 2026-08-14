// ─── expectedIncome.ts — money that should arrive and has not yet ─────────────
//
// WHY THIS IS NOT A RECURRING-INCOME FEATURE
//
// The obvious version writes the row on the day: salary on the 25th, so on the
// 25th an income of ฿15,000 appears. Every commercial budgeting app does that,
// and for a salary it is right — same amount, same day, reliably.
//
// It is wrong for the money this app's author actually lives on. TELUS pays a
// different amount every cycle, on a date that moves; RWS pays up to 60 days
// after the invoice; a platform can just be late. Auto-writing on a guessed date
// puts money into the ledger that is not in the bank, and the balance — the one
// number someone checks when they are worried — becomes a lie in the direction
// most likely to hurt.
//
// So nothing is ever written until the money is confirmed. What this table holds
// is an EXPECTATION, and an expectation is not a transaction.
//
// DOING NOTHING IS THE CORRECT ACTION
//
// If the 15th passes and nothing arrived, there is nothing to press. The row
// stays as it is and starts saying it has been waiting a while. No rejecting, no
// dismissing, no clearing a badge. That is deliberate: the app is used by
// someone for whom a screen full of things demanding a tap is itself the
// problem, and "still waiting" is the true state of the world, not an error
// state that needs resolving.
//
// Cancel exists for the one case that is real — work that is never going to be
// paid for — and is not where the eye lands.
//
// WHY NO RED
//
// A list of money owed to you is a list of things going wrong that you cannot
// do anything about. It is displayed as "waiting since the 15th", never as
// "OVERDUE 7 DAYS", and it does not escalate, colour up or count anything. See
// wellbeingRules.ts: the test is not whether the number is correct, it is what
// this looks like on the worst day of the year.

// The table itself is created in database.ts with all the others. Nothing
// here may be called before getDb() has resolved once.
import { getDb, addIncome } from "./database";
import { todayLocal } from "./dateUtil";
import { getCurrency } from "./money";

export type ExpectRepeat = "monthly" | "weekly" | "biweekly" | null;

export interface Expectation {
  id: number;
  source: string;
  /** Null is normal and not a missing value: freelance work is frequently
   *  expected without knowing the figure until it lands. */
  amount: number | null;
  currency: string;
  expect_date: string;      // YYYY-MM-DD
  repeat: ExpectRepeat;
  note: string;
  status: "waiting" | "received" | "cancelled";
}

/** Waiting only, soonest first. Past dates sort to the top, which is where
 *  something that has been waiting longest belongs. */
export async function listWaiting(): Promise<Expectation[]> {
  const db = await getDb();
  return await db.select<Expectation[]>(
    "SELECT * FROM expected_income WHERE deleted = 0 AND status = 'waiting' ORDER BY expect_date ASC",
  );
}

export async function addExpectation(e: {
  source: string;
  amount: number | null;
  expect_date: string;
  repeat?: ExpectRepeat;
  note?: string;
  currency?: string;
}): Promise<void> {
  const db = await getDb();
  await db.execute(
    "INSERT INTO expected_income (source, amount, currency, expect_date, repeat, note) VALUES (?, ?, ?, ?, ?, ?)",
    [e.source, e.amount, e.currency || getCurrency(), e.expect_date, e.repeat ?? null, e.note ?? ""],
  );
}

/**
 * The next date after this one, for an expectation that repeats.
 *
 * Monthly means the same day of the month, not thirty days: a salary paid on
 * the 25th is paid on the 25th, and adding 30 walks it backwards through the
 * year. Clamped for the months that are too short, so the 31st becomes the 30th
 * in April and the 28th in February rather than spilling into the next month.
 */
export function nextExpectDate(date: string, repeat: ExpectRepeat): string | null {
  if (!repeat) return null;
  const [y, m, d] = date.split("-").map(Number);
  if (repeat === "weekly" || repeat === "biweekly") {
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + (repeat === "weekly" ? 7 : 14));
    return dt.toISOString().slice(0, 10);
  }
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  const nd = Math.min(d, lastDay);
  return `${ny}-${String(nm).padStart(2, "0")}-${String(nd).padStart(2, "0")}`;
}

/**
 * The money arrived. This is the only path that writes to the ledger.
 *
 * The amount is passed in rather than taken from the expectation, because what
 * was expected and what turned up are different questions and the second one is
 * the one that goes in the books. The expectation is not corrected to match:
 * it did its job, which was to make someone look.
 */
export async function markReceived(
  id: number,
  actual: { amount: number; date: string; currency?: string },
): Promise<void> {
  const db = await getDb();
  const rows = await db.select<Expectation[]>(
    "SELECT * FROM expected_income WHERE id = ?", [id],
  );
  const e = rows[0];
  if (!e) return;

  await addIncome({
    amount: actual.amount,
    source: e.source,
    note: e.note,
    date: actual.date,
    currency: actual.currency || e.currency,
  });

  await db.execute("UPDATE expected_income SET status = 'received' WHERE id = ?", [id]);

  // A repeating expectation rolls forward from the date it was DUE, not the
  // date it was paid. Otherwise a salary that arrives two days late moves the
  // expectation two days later every month, and after a year it is somewhere
  // else entirely.
  const next = nextExpectDate(e.expect_date, e.repeat);
  if (next) {
    await db.execute(
      "INSERT INTO expected_income (source, amount, currency, expect_date, repeat, note) VALUES (?, ?, ?, ?, ?, ?)",
      [e.source, e.amount, e.currency, next, e.repeat, e.note],
    );
  }
}

/** Not coming. Kept rather than deleted, because a piece of work that went
 *  unpaid is worth being able to look back at. */
export async function markCancelled(id: number): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE expected_income SET status = 'cancelled' WHERE id = ?", [id]);
}

/** Still waiting, but stop asking about it for a while. */
export async function pushBack(id: number, days: number): Promise<void> {
  const db = await getDb();
  const rows = await db.select<{ expect_date: string }[]>(
    "SELECT expect_date FROM expected_income WHERE id = ?", [id],
  );
  const cur = rows[0]?.expect_date;
  if (!cur) return;
  // From today when it is already late, not from the old date, or pushing back
  // a payment three weeks overdue by a week leaves it still overdue.
  const from = cur < todayLocal() ? todayLocal() : cur;
  const dt = new Date(from + "T00:00:00Z");
  dt.setUTCDate(dt.getUTCDate() + days);
  await db.execute(
    "UPDATE expected_income SET expect_date = ? WHERE id = ?",
    [dt.toISOString().slice(0, 10), id],
  );
}

export async function removeExpectation(id: number): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE expected_income SET deleted = 1 WHERE id = ?", [id]);
}