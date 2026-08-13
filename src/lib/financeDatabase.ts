import Database from "@tauri-apps/plugin-sql";
import { getDb as getSharedDb } from "./database";
import { t } from "./i18n";
import { todayLocal, monthLocal } from "./dateUtil";

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

// ─── Expense categories ───────────────────────────────────────────────────────
//
// These used to be a TypeScript union of nine strings and a const array, which
// meant the set of categories was a property of the SOURCE CODE. You could not
// add "freelance expenses", could not rename "game" to something that made
// sense to you, and could not hide "education" after graduating. The one thing
// a spending tracker has to adapt to is how a particular person spends.
//
// They live in a table now. Two details make the move safe:
//
//   label is NULLABLE. Null means "this is a built-in, translate it" and the
//   label comes from i18n as before, so the nine defaults stay bilingual. Only
//   a category the user renamed or created carries a literal label.
//
//   Nothing is ever deleted, only hidden. Old expenses still point at the key,
//   and a spending history that silently loses its labels is worse than a
//   cluttered picker.

export type ExpenseCategory = string;

export interface CategoryRow {
  id: number;
  key: string;
  label: string;      // already resolved: stored label, or the translation
  emoji: string;
  color: string;
  sort_order: number;
  is_hidden: number;
}

/** The built-in nine. Seeded once, then owned by the user. */
export const DEFAULT_CATEGORIES: { key: string; emoji: string; color: string }[] = [
  { key: "food",          emoji: "🍜",  color: "from-orange-500 to-amber-500" },
  { key: "transport",     emoji: "🚌",  color: "from-blue-500 to-cyan-500" },
  { key: "entertainment", emoji: "🎬",  color: "from-pink-500 to-rose-500" },
  { key: "shopping",      emoji: "🛍️", color: "from-purple-500 to-violet-500" },
  { key: "health",        emoji: "💊",  color: "from-green-500 to-emerald-500" },
  { key: "education",     emoji: "📚",  color: "from-indigo-500 to-blue-500" },
  { key: "bills",         emoji: "📋",  color: "from-gray-500 to-slate-500" },
  { key: "game",          emoji: "🎮",  color: "from-purple-600 to-indigo-600" },
  { key: "other",         emoji: "📦",  color: "from-gray-400 to-gray-500" },
];

const BUILT_IN_KEYS = new Set(DEFAULT_CATEGORIES.map(c => c.key));

/** Resolve a stored row into something renderable. */
function resolveLabel(key: string, label: string | null): string {
  if (label) return label;
  if (BUILT_IN_KEYS.has(key)) return t(`finance.cat.${key}` as any);
  return key;
}

// A synchronous cache, because a hundred table rows each need a label and an
// emoji while rendering and none of them can await. Refreshed whenever the
// table changes; falls back to the defaults before the first load completes.
let categoryCache: CategoryRow[] = DEFAULT_CATEGORIES.map((c, i) => ({
  id: -1 - i, key: c.key, label: "", emoji: c.emoji, color: c.color,
  sort_order: i, is_hidden: 0,
}));

/** Visible categories, in the user's order. Synchronous — safe inside render. */
export function getCategoryList(): CategoryRow[] {
  return categoryCache
    .filter(c => !c.is_hidden)
    .map(c => ({ ...c, label: c.label || resolveLabel(c.key, null) }));
}

/** Every category including hidden ones, for the management screen. */
export function getAllCategoriesCached(): CategoryRow[] {
  return categoryCache.map(c => ({ ...c, label: c.label || resolveLabel(c.key, null) }));
}

/** Look one up by key. Falls back to a neutral row so an expense whose category
 *  was hidden or renamed still renders instead of disappearing. */
export function lookupCategory(key: string): CategoryRow {
  const found = categoryCache.find(c => c.key === key);
  if (found) return { ...found, label: found.label || resolveLabel(found.key, null) };
  return {
    id: -999, key, label: key, emoji: "💸",
    color: "from-gray-400 to-gray-500", sort_order: 999, is_hidden: 0,
  };
}

/** Read the table into the cache. Call once at startup and after any edit. */
export async function loadCategories(): Promise<CategoryRow[]> {
  const d = await getDb();
  await seedCategoriesIfEmpty(d);
  const rows = await d.select<any[]>(
    `SELECT id, key, label, emoji, color, sort_order, is_hidden
       FROM expense_categories WHERE deleted = 0
      ORDER BY sort_order ASC, id ASC`,
  );
  categoryCache = rows.map(r => ({
    id: r.id,
    key: r.key,
    label: r.label ?? "",
    emoji: r.emoji ?? "📦",
    color: r.color ?? "from-gray-400 to-gray-500",
    sort_order: r.sort_order ?? 0,
    is_hidden: r.is_hidden ?? 0,
  }));
  return getAllCategoriesCached();
}

async function seedCategoriesIfEmpty(d: Database): Promise<void> {
  const [{ n }] = await d.select<{ n: number }[]>(
    "SELECT COUNT(*) as n FROM expense_categories",
  );
  if (n > 0) return;
  for (let i = 0; i < DEFAULT_CATEGORIES.length; i++) {
    const c = DEFAULT_CATEGORIES[i];
    // label stays NULL on purpose: that is what marks it as translatable.
    await d.execute(
      `INSERT INTO expense_categories (key, label, emoji, color, sort_order, is_hidden)
       VALUES (?, NULL, ?, ?, ?, 0)`,
      [c.key, c.emoji, c.color, i],
    );
  }
}

/** Turn a label into a stable key. Keys are what expenses store, so they must
 *  never collide and never change once created. */
function makeKey(label: string, taken: Set<string>): string {
  const base =
    label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") ||
    `cat`;
  let key = base;
  let i = 2;
  while (taken.has(key)) key = `${base}_${i++}`;
  return key;
}

export async function createCategory(label: string, emoji: string): Promise<void> {
  const d = await getDb();
  const existing = await d.select<{ key: string }[]>("SELECT key FROM expense_categories");
  const key = makeKey(label, new Set(existing.map(r => r.key)));
  const [{ n }] = await d.select<{ n: number }[]>(
    "SELECT COALESCE(MAX(sort_order), -1) + 1 as n FROM expense_categories",
  );
  await d.execute(
    `INSERT INTO expense_categories (key, label, emoji, color, sort_order, is_hidden)
     VALUES (?, ?, ?, 'from-gray-400 to-gray-500', ?, 0)`,
    [key, label.trim(), emoji || "📦", n],
  );
  await loadCategories();
}

export async function updateCategory(
  id: number,
  patch: { label?: string; emoji?: string },
): Promise<void> {
  const d = await getDb();
  if (patch.label !== undefined) {
    // An empty label puts a built-in back on its translation.
    const value = patch.label.trim() === "" ? null : patch.label.trim();
    await d.execute("UPDATE expense_categories SET label = ? WHERE id = ?", [value, id]);
  }
  if (patch.emoji !== undefined) {
    await d.execute("UPDATE expense_categories SET emoji = ? WHERE id = ?", [patch.emoji, id]);
  }
  await loadCategories();
}

/** Hide rather than delete: old expenses still point here. */
export async function setCategoryHidden(id: number, hidden: boolean): Promise<void> {
  const d = await getDb();
  await d.execute("UPDATE expense_categories SET is_hidden = ? WHERE id = ?", [hidden ? 1 : 0, id]);
  await loadCategories();
}

export async function moveCategory(id: number, direction: -1 | 1): Promise<void> {
  const d = await getDb();
  const rows = await d.select<{ id: number; sort_order: number }[]>(
    "SELECT id, sort_order FROM expense_categories WHERE deleted = 0 ORDER BY sort_order ASC, id ASC",
  );
  const index = rows.findIndex(r => r.id === id);
  const swapWith = index + direction;
  if (index < 0 || swapWith < 0 || swapWith >= rows.length) return;
  // Rewrite the whole column rather than swapping two values, so an order that
  // has drifted or collided repairs itself the first time anything is moved.
  const reordered = [...rows];
  [reordered[index], reordered[swapWith]] = [reordered[swapWith], reordered[index]];
  for (let i = 0; i < reordered.length; i++) {
    await d.execute("UPDATE expense_categories SET sort_order = ? WHERE id = ?", [i, reordered[i].id]);
  }
  await loadCategories();
}


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
  /** Bank reference when this came from a scanned slip. Null for manual entry,
   *  and null is what makes the unique index tolerate any number of them. */
  slipRef?: string | null;
}): Promise<void> {
  const d = await getDb();
  await d.execute(
    "INSERT INTO expenses (amount, category, note, date, slip_ref) VALUES (?, ?, ?, ?, ?)",
    [expense.amount, expense.category, expense.note, expense.date, expense.slipRef ?? null]
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
  if (!keyword || !keyword.trim()) {
    // Last line of defence. The caller checks too, but this function takes a
    // string straight out of model output and used to call .toLowerCase() on
    // it unconditionally, so a null arrived here as a TypeError rather than as
    // a sentence anybody could act on.
    throw new Error("ไม่รู้ว่าหมายถึงรายการไหน บอกชื่อรายการด้วยนะ");
  }
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
  if (!keyword || !keyword.trim()) {
    // Last line of defence. The caller checks too, but this function takes a
    // string straight out of model output and used to call .toLowerCase() on
    // it unconditionally, so a null arrived here as a TypeError rather than as
    // a sentence anybody could act on.
    throw new Error("ไม่รู้ว่าหมายถึงรายการไหน บอกชื่อรายการด้วยนะ");
  }
  const d = await getDb();
  const rows = await d.select<{ id: number; amount: number; note: string; category: string }[]>(
    `SELECT id, amount, note, category FROM expenses
     WHERE deleted = 0 AND (LOWER(note) LIKE ? OR LOWER(category) LIKE ?)
     ORDER BY created_at DESC LIMIT 1`,
    [`%${keyword.toLowerCase()}%`, `%${keyword.toLowerCase()}%`]
  );
  if (rows.length === 0) throw new Error(`ไม่พบรายการที่มี "${keyword}"`);

  // updateExpense builds its SET clause from whatever is defined and returns
  // quietly when that comes to nothing. Harmless there, wrong here: the caller
  // announces "saved" as soon as this resolves, so an edit with no field to
  // change reported success and altered nothing. Say it plainly instead.
  const hasChange = Object.values(fields).some(v => v !== undefined);
  if (!hasChange) throw new Error(`ไม่รู้ว่าจะเปลี่ยน "${keyword}" เป็นอะไร`);

  await updateExpense(rows[0].id, fields);
  return rows[0].note || rows[0].category;
}

/** Categories ordered by when they were last used, most recent first.
 *  The add sheet lists them in this order so the two or three categories a
 *  person actually uses drift to the front instead of being hunted for in a
 *  nine-button grid every single time. Needs no schema: the answer is already
 *  in the expenses table. */
/** Has this exact slip already been recorded? The unique index enforces it at
 *  the database level too, but asking first lets the UI say so plainly instead
 *  of surfacing a constraint error. */
export async function slipAlreadyRecorded(ref: string): Promise<boolean> {
  if (!ref) return false;
  const d = await getDb();
  const rows = await d.select<{ n: number }[]>(
    "SELECT COUNT(*) as n FROM expenses WHERE slip_ref = ?",
    [ref],
  );
  return (rows[0]?.n ?? 0) > 0;
}

/** A list screenshot carries no reference numbers, so exact duplicate detection
 *  is impossible for it. Same day and same amount is a strong hint though, and
 *  a hint is the right strength here: buying the same coffee twice in one day
 *  is a real thing, so this warns rather than blocks. */
export async function looksLikeDuplicate(date: string, amount: number): Promise<boolean> {
  const d = await getDb();
  const rows = await d.select<{ n: number }[]>(
    "SELECT COUNT(*) as n FROM expenses WHERE deleted = 0 AND date = ? AND ABS(amount - ?) < 0.01",
    [date, amount],
  );
  return (rows[0]?.n ?? 0) > 0;
}

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
  const today = todayOverride ?? todayLocal();
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
  const today = todayLocal();
  await addExpense({ amount, category, note, date: today });
}

/** Get a spending summary string for the AI to read */
export async function getSpendingSummary(): Promise<string> {
  const month = monthLocal();
  const [monthTotal, todayTotal, catTotals] = await Promise.all([
    getMonthTotal(month),
    getTodayTotal(),
    getTotalByCategory(month),
  ]);
  const catStr = catTotals.slice(0, 5).map(c => `${c.category}: ฿${c.total.toLocaleString()}`).join(", ");
  return `วันนี้: ฿${todayTotal.toLocaleString()} | เดือนนี้: ฿${monthTotal.toLocaleString()} | หมวด: ${catStr}`;
}