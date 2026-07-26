import Database from "@tauri-apps/plugin-sql";
import { getDb as getSharedDb } from "./database";
import { t } from "./i18n";
import { todayBangkok, monthBangkok } from "./dateUtil";

// All finance tables are now created inside database.ts initializeSchema,
// so financeDatabase.ts just needs to call getDb() — no schema init needed here.

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Expense {
  id: number;
  amount: number;
  category: ExpenseCategory;
  note: string;
  date: string;          // YYYY-MM-DD
  created_at: string;
}

export interface Budget {
  id: number;
  category: ExpenseCategory;
  limit_amount: number;
  month: string;         // YYYY-MM
}

export interface SavingGoal {
  id: number;
  name: string;
  target_amount: number;
  current_amount: number;
  deadline: string | null;
  emoji: string;
  is_completed: number;
  created_at: string;
}

export type ExpenseCategory =
  | "food"
  | "transport"
  | "entertainment"
  | "shopping"
  | "health"
  | "education"
  | "bills"
  | "game"
  | "other";

export const EXPENSE_CATEGORIES: { key: ExpenseCategory; label: string; emoji: string; color: string }[] = [
  { key: "food",          get label() { return t("finance.cat.food"); },          emoji: "🍜", color: "from-orange-500 to-amber-500" },
  { key: "transport",     get label() { return t("finance.cat.transport"); },     emoji: "🚌", color: "from-blue-500 to-cyan-500" },
  { key: "entertainment", get label() { return t("finance.cat.entertainment"); }, emoji: "🎬", color: "from-pink-500 to-rose-500" },
  { key: "shopping",      get label() { return t("finance.cat.shopping"); },      emoji: "🛍️", color: "from-purple-500 to-violet-500" },
  { key: "health",        get label() { return t("finance.cat.health"); },        emoji: "💊", color: "from-green-500 to-emerald-500" },
  { key: "education",     get label() { return t("finance.cat.education"); },     emoji: "📚", color: "from-indigo-500 to-blue-500" },
  { key: "bills",         get label() { return t("finance.cat.bills"); },         emoji: "📋", color: "from-gray-500 to-slate-500" },
  { key: "game",          get label() { return t("finance.cat.game"); },          emoji: "🎮", color: "from-purple-600 to-indigo-600" },
  { key: "other",         get label() { return t("finance.cat.other"); },         emoji: "📦", color: "from-gray-400 to-gray-500" },
];

// ─── DB accessor ──────────────────────────────────────────────────────────────

async function getDb(): Promise<Database> {
  return getSharedDb();
}

// ─── Expenses ─────────────────────────────────────────────────────────────────

export async function addExpense(expense: {
  amount: number;
  category: ExpenseCategory;
  note: string;
  date: string;
}): Promise<void> {
  const d = await getDb();
  await d.execute(
    "INSERT INTO expenses (amount, category, note, date) VALUES (?, ?, ?, ?)",
    [expense.amount, expense.category, expense.note, expense.date]
  );
}

export async function getExpensesByMonth(month: string): Promise<Expense[]> {
  const d = await getDb();
  return await d.select<Expense[]>(
    "SELECT * FROM expenses WHERE deleted = 0 AND strftime('%Y-%m', date) = ? ORDER BY date DESC, created_at DESC",
    [month]
  );
}

export async function getExpensesByDate(date: string): Promise<Expense[]> {
  const d = await getDb();
  return await d.select<Expense[]>(
    "SELECT * FROM expenses WHERE deleted = 0 AND date = ? ORDER BY created_at DESC",
    [date]
  );
}

export async function getExpensesLast30Days(): Promise<Expense[]> {
  const d = await getDb();
  return await d.select<Expense[]>(
    "SELECT * FROM expenses WHERE deleted = 0 AND date >= date('now', '-30 days') ORDER BY date DESC"
  );
}

export async function deleteExpense(id: number): Promise<void> {
  const d = await getDb();
  await d.execute("UPDATE expenses SET deleted = 1 WHERE id = ?", [id]);
}

export async function updateExpense(id: number, fields: {
  amount?: number;
  category?: ExpenseCategory;
  note?: string;
  date?: string;
}): Promise<void> {
  const d = await getDb();
  const sets: string[] = [];
  const vals: any[] = [];
  if (fields.amount !== undefined) { sets.push("amount = ?"); vals.push(fields.amount); }
  if (fields.category !== undefined) { sets.push("category = ?"); vals.push(fields.category); }
  if (fields.note !== undefined) { sets.push("note = ?"); vals.push(fields.note); }
  if (fields.date !== undefined) { sets.push("date = ?"); vals.push(fields.date); }
  if (sets.length === 0) return;
  vals.push(id);
  await d.execute(`UPDATE expenses SET ${sets.join(", ")} WHERE id = ?`, vals);
}

/** AI: delete the most recent expense matching a keyword in note/category */
export async function aiDeleteExpenseByKeyword(keyword: string): Promise<string> {
  const d = await getDb();
  const rows = await d.select<{ id: number; amount: number; note: string; category: string }[]>(
    `SELECT id, amount, note, category FROM expenses
     WHERE deleted = 0 AND (LOWER(note) LIKE ? OR LOWER(category) LIKE ?)
     ORDER BY created_at DESC LIMIT 1`,
    [`%${keyword.toLowerCase()}%`, `%${keyword.toLowerCase()}%`]
  );
  if (rows.length === 0) throw new Error(`ไม่พบรายการที่มี "${keyword}"`);
  await d.execute("UPDATE expenses SET deleted = 1 WHERE id = ?", [rows[0].id]);
  return `${rows[0].note || rows[0].category} ฿${rows[0].amount}`;
}

/** AI: edit the most recent expense matching a keyword */
export async function aiEditExpenseByKeyword(keyword: string, fields: {
  amount?: number; category?: ExpenseCategory; note?: string;
}): Promise<string> {
  const d = await getDb();
  const rows = await d.select<{ id: number; amount: number; note: string; category: string }[]>(
    `SELECT id, amount, note, category FROM expenses
     WHERE deleted = 0 AND (LOWER(note) LIKE ? OR LOWER(category) LIKE ?)
     ORDER BY created_at DESC LIMIT 1`,
    [`%${keyword.toLowerCase()}%`, `%${keyword.toLowerCase()}%`]
  );
  if (rows.length === 0) throw new Error(`ไม่พบรายการที่มี "${keyword}"`);
  await updateExpense(rows[0].id, fields);
  return rows[0].note || rows[0].category;
}

/** Categories ordered by when they were last used, most recent first.
 *  The add sheet lists them in this order so the two or three categories a
 *  person actually uses drift to the front instead of being hunted for in a
 *  nine-button grid every single time. Needs no schema: the answer is already
 *  in the expenses table. */
export async function getRecentCategories(): Promise<string[]> {
  const d = await getDb();
  const rows = await d.select<{ category: string }[]>(
    `SELECT category FROM expenses WHERE deleted = 0
      GROUP BY category ORDER BY MAX(created_at) DESC`,
  );
  return rows.map(r => r.category);
}

export async function getTotalByCategory(month: string): Promise<{ category: string; total: number }[]> {
  const d = await getDb();
  return await d.select<{ category: string; total: number }[]>(
    "SELECT category, SUM(amount) as total FROM expenses WHERE deleted = 0 AND strftime('%Y-%m', date) = ? GROUP BY category ORDER BY total DESC",
    [month]
  );
}

export async function getDailyTotals(month: string): Promise<{ date: string; total: number }[]> {
  const d = await getDb();
  return await d.select<{ date: string; total: number }[]>(
    "SELECT date, SUM(amount) as total FROM expenses WHERE deleted = 0 AND strftime('%Y-%m', date) = ? GROUP BY date ORDER BY date ASC",
    [month]
  );
}

export async function getMonthTotal(month: string): Promise<number> {
  const d = await getDb();
  const rows = await d.select<{ total: number }[]>(
    "SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE deleted = 0 AND strftime('%Y-%m', date) = ?",
    [month]
  );
  return rows[0]?.total ?? 0;
}

export async function getTodayTotal(todayOverride?: string): Promise<number> {
  const d = await getDb();
  // Use caller-supplied date (Bangkok local) or derive it here
  const today = todayOverride ?? todayBangkok();
  const rows = await d.select<{ total: number }[]>(
    "SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE deleted = 0 AND date = ?",
    [today]
  );
  return rows[0]?.total ?? 0;
}

// ─── Budgets ──────────────────────────────────────────────────────────────────

export async function setBudget(category: ExpenseCategory, limit: number, month: string): Promise<void> {
  const d = await getDb();
  await d.execute(
    "INSERT INTO budgets (category, limit_amount, month) VALUES (?, ?, ?) ON CONFLICT(category, month) DO UPDATE SET limit_amount = excluded.limit_amount",
    [category, limit, month]
  );
}

export async function getBudgetsForMonth(month: string): Promise<Budget[]> {
  const d = await getDb();
  return await d.select<Budget[]>(
    "SELECT * FROM budgets WHERE month = ?",
    [month]
  );
}

// ─── Saving Goals ─────────────────────────────────────────────────────────────

export async function createGoal(goal: {
  name: string;
  target_amount: number;
  deadline?: string;
  emoji?: string;
}): Promise<void> {
  const d = await getDb();
  await d.execute(
    "INSERT INTO saving_goals (name, target_amount, deadline, emoji) VALUES (?, ?, ?, ?)",
    [goal.name, goal.target_amount, goal.deadline ?? null, goal.emoji ?? "🎯"]
  );
}

export async function addToGoal(id: number, amount: number): Promise<void> {
  const d = await getDb();
  await d.execute(
    "UPDATE saving_goals SET current_amount = MIN(current_amount + ?, target_amount), is_completed = CASE WHEN current_amount + ? >= target_amount THEN 1 ELSE 0 END WHERE id = ?",
    [amount, amount, id]
  );
}

export async function getGoals(): Promise<SavingGoal[]> {
  const d = await getDb();
  return await d.select<SavingGoal[]>(
    "SELECT * FROM saving_goals WHERE deleted = 0 ORDER BY is_completed ASC, created_at DESC"
  );
}

export async function deleteGoal(id: number): Promise<void> {
  const d = await getDb();
  await d.execute("UPDATE saving_goals SET deleted = 1 WHERE id = ?", [id]);
}

// ─── AI-callable helpers ──────────────────────────────────────────────────────

/** Log an expense by natural language parse result */
export async function aiLogExpense(amount: number, category: ExpenseCategory, note: string): Promise<void> {
  const today = todayBangkok();
  await addExpense({ amount, category, note, date: today });
}

/** Get a spending summary string for the AI to read */
export async function getSpendingSummary(): Promise<string> {
  const month = monthBangkok();
  const [monthTotal, todayTotal, catTotals] = await Promise.all([
    getMonthTotal(month),
    getTodayTotal(),
    getTotalByCategory(month),
  ]);
  const catStr = catTotals.slice(0, 5).map(c => `${c.category}: ฿${c.total.toLocaleString()}`).join(", ");
  return `วันนี้: ฿${todayTotal.toLocaleString()} | เดือนนี้: ฿${monthTotal.toLocaleString()} | หมวด: ${catStr}`;
}