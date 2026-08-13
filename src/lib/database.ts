import { isPaused } from "../types";
import Database from "@tauri-apps/plugin-sql";
import { applySyncMigrations } from "./syncMeta";

let db: Database | null = null;
let dbReadyPromise: Promise<Database> | null = null;

/** Single shared DB — ALL tables (tasks + finance) created here before any caller proceeds */
/** How long a deleted task stays recoverable. */
export const TRASH_TTL_DAYS = 30;

export async function getDb(): Promise<Database> {
  if (db) return db;
  if (dbReadyPromise) return dbReadyPromise;
  dbReadyPromise = (async () => {
    const d = await Database.load("sqlite:gamescheduler.db");
    await initializeSchema(d);
    db = d;
    return d;
  })();
  return dbReadyPromise;
}

// ── DB operation queue ────────────────────────────────────────────────────────
// tauri-plugin-sql serializes operations internally, but multiple concurrent
// JS-side awaits can pile up. This queue ensures only one operation runs at a
// time, preventing write starvation when rapid refreshTasks() calls (reads)
// block a pending updateTask() (write).
let _dbQueue: Promise<any> = Promise.resolve();

export function dbQueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = _dbQueue.then(() => fn()).catch(() => fn()); // retry once on queue error
  _dbQueue = next.catch(() => {}); // don't let a failed op break the chain
  return next as Promise<T>;
}

async function initializeSchema(db: Database): Promise<void> {
  // ── Tasks table ────────────────────────────────────────────
  await db.execute(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      category TEXT DEFAULT 'game',
      reset_type TEXT NOT NULL,
      reset_time TEXT,
      reset_day INTEGER,
      reset_interval_days INTEGER,
      anchor_date TEXT,
      event_start TEXT,
      event_end TEXT,
      specific_date TEXT,
      is_priority INTEGER DEFAULT 0,
      is_urgent INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      completed_until TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  // Task migrations
  try { await db.execute(`ALTER TABLE tasks ADD COLUMN specific_date TEXT`); } catch (_) {}
  try { await db.execute(`ALTER TABLE tasks ADD COLUMN is_priority INTEGER DEFAULT 0`); } catch (_) {}
  try { await db.execute(`ALTER TABLE tasks ADD COLUMN is_urgent INTEGER DEFAULT 0`); } catch (_) {}
  try { await db.execute(`ALTER TABLE tasks ADD COLUMN completed_until TEXT DEFAULT NULL`); } catch (_) {}
  try { await db.execute(`ALTER TABLE tasks ADD COLUMN notes TEXT DEFAULT ''`); } catch (_) {}
  // Null = the time floats with the app's zone, which is what every row already
  // did before this column existed. Nothing needs backfilling.
  try { await db.execute(`ALTER TABLE tasks ADD COLUMN time_zone TEXT DEFAULT NULL`); } catch (_) {}
  // Null intent means nobody answered, which is read as unknown rather than as
  // obligation — see types/index.ts. The two cycle columns exist so that "was
  // the last cycle completed" is answerable at all; completed_until is a single
  // overwritten value and keeps no history.
  try { await db.execute(`ALTER TABLE tasks ADD COLUMN intent TEXT DEFAULT NULL`); } catch (_) {}
  try { await db.execute(`ALTER TABLE tasks ADD COLUMN cycle_checked_until TEXT DEFAULT NULL`); } catch (_) {}
  try { await db.execute(`ALTER TABLE tasks ADD COLUMN missed_streak INTEGER DEFAULT 0`); } catch (_) {}

  // ── Income table ───────────────────────────────────────────
  await db.execute(`CREATE TABLE IF NOT EXISTS income (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    amount REAL NOT NULL,
    source TEXT DEFAULT 'other',
    note TEXT DEFAULT '',
    date TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  // ── Finance: expenses ──────────────────────────────────────
  await db.execute(`
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      amount REAL NOT NULL,
      category TEXT NOT NULL DEFAULT 'other',
      note TEXT DEFAULT '',
      date TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // ── Finance: budgets ───────────────────────────────────────
  await db.execute(`
    CREATE TABLE IF NOT EXISTS budgets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      limit_amount REAL NOT NULL,
      month TEXT NOT NULL,
      UNIQUE(category, month)
    )
  `);

  // ── Finance: saving goals ──────────────────────────────────
  await db.execute(`
    CREATE TABLE IF NOT EXISTS saving_goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      target_amount REAL NOT NULL,
      current_amount REAL NOT NULL DEFAULT 0,
      deadline TEXT,
      emoji TEXT DEFAULT '🎯',
      is_completed INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // ── App settings (key-value) ───────────────────────────────
  // Generic store for app preferences like wallpaper path/enabled.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  // Categories are user data, not a constant in the source. See the header of
  // the category section in financeDatabase.ts for why. label is NULLABLE and
  // null means "built-in, translate it", which keeps the nine defaults
  // bilingual while letting anything the user makes carry a literal name.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS expense_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      label TEXT,
      emoji TEXT NOT NULL DEFAULT '📦',
      color TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_hidden INTEGER NOT NULL DEFAULT 0
    )
  `);

  // The smallest version of a task that still counts as having done it.
  // "ล้างจาน" is a wall; "ล้างจาน 1 ใบ" is a doorway. Depression and ordinary
  // procrastination both fail at the same place — starting — and shrinking the
  // first step is the standard way through it. Nullable, because most tasks
  // never need one.
  try {
    await db.execute("ALTER TABLE tasks ADD COLUMN min_step TEXT");
  } catch (_) { /* already there */ }

  // A bank reference is the one thing on a slip worth keeping: short, opaque,
  // no account numbers or names in it, and it is what makes photographing the
  // same slip twice detectable instead of silently doubling a month's total.
  // Added separately from CREATE TABLE so existing databases get it too.
  try {
    await db.execute("ALTER TABLE expenses ADD COLUMN slip_ref TEXT");
  } catch (_) { /* already there */ }
  await db.execute(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_expenses_slip_ref ON expenses(slip_ref) WHERE slip_ref IS NOT NULL",
  );

  // Setting a task aside without deleting it. Null means running; a datetime
  // means paused until then. See types/index.ts for why this is not a boolean.
  try {
    await db.execute("ALTER TABLE tasks ADD COLUMN paused_until TEXT DEFAULT NULL");
  } catch (_) { /* already there */ }

  // When the person deleted it, as opposed to the several other ways a row can
  // reach is_active = 0. Only rows with this set are offered back in the bin.
  try {
    await db.execute("ALTER TABLE tasks ADD COLUMN deleted_at TEXT DEFAULT NULL");
  } catch (_) { /* already there */ }

  // Empty the bin. Thirty days is long enough that a mistake noticed a month
  // later is still recoverable, and short enough that the bin does not turn
  // into an archive of everything ever made — which would then ride along in
  // every backup file forever.
  try {
    const cutoff = new Date(Date.now() - TRASH_TTL_DAYS * 86_400_000).toISOString();
    await db.execute("DELETE FROM tasks WHERE deleted_at IS NOT NULL AND deleted_at < ?", [cutoff]);
  } catch (err) {
    console.error("[db] could not purge trash:", err);
  }

  // Give every row a device-independent identity and a modification time, so
  // the phone app can eventually sync with this one. See src/lib/syncMeta.ts.
  // Runs last, after every table exists. Idempotent, so it is safe every boot.
  await applySyncMigrations(db);
}


/** The only columns updateTask may write. Anything else is dropped in silence
 *  rather than reaching the SQL string. Keep in step with the type below. */
const UPDATABLE_TASK_COLUMNS = new Set([
  "name", "description", "category", "reset_type", "reset_time", "reset_day",
  "reset_interval_days", "anchor_date", "event_start", "event_end",
  "specific_date", "is_priority", "is_urgent", "min_step", "time_zone",
  "intent", "notes",
]);

export async function updateTask(id: number, fields: Partial<{
  name: string; description: string; notes: string; category: string;
  reset_type: string; reset_time: string | null; reset_day: number | null;
  reset_interval_days: number | null; anchor_date: string | null;
  event_start: string | null; event_end: string | null;
  specific_date: string | null; is_priority: number; is_urgent: number;
  min_step: string | null; time_zone: string | null;
  intent: "want" | "must" | null;
}>): Promise<void> {
  return dbQueue(async () => {
    const db = await getDb();
    // Column names go into the SQL text itself — they cannot be bound as
    // parameters the way values can — so they have to come from a list written
    // here, not from whatever keys the caller happened to pass. TypeScript's
    // Partial<> above looks like it enforces that, but types are gone by the
    // time this runs: an object parsed from an AI reply or arriving from a sync
    // server satisfies no type at all at runtime. Today every caller is a form
    // in this app; sync will change that, and this is the line that has to hold
    // when it does.
    const keys = Object.keys(fields).filter(k => UPDATABLE_TASK_COLUMNS.has(k));
    if (!keys.length) return;
    const sets = keys.map(k => `${k} = ?`).join(', ');
    const INTEGER_COLS = new Set(["reset_day", "reset_interval_days", "is_priority", "is_urgent"]);
    const TEXT_DATE_COLS = new Set(["reset_time", "anchor_date", "event_start", "event_end", "specific_date"]);
    const rawVals = keys.map(k => {
      const v = (fields as any)[k];
      if (v === undefined) return null;
      if (INTEGER_COLS.has(k)) return v === null ? null : Number(v);
      if (TEXT_DATE_COLS.has(k)) return sanitizeText(v);
      return v;
    });
    const vals = [...rawVals, Number(id)];
    console.log("[updateTask] id=", id, "sets=", sets, "vals=", JSON.stringify(vals));
    await db.execute(`UPDATE tasks SET ${sets} WHERE id = ?`, vals);
  });
}

export async function getTaskById(id: number): Promise<any | null> {
  const db = await getDb();
  const numId = Number(id);
  const rows = await db.select<any[]>('SELECT * FROM tasks WHERE id = ?', [numId]);
  if (!rows || rows.length === 0) {
    console.warn(`[DB] getTaskById(${id}): no rows`);
    return null;
  }
  return rows[0];
}

export async function addIncome(data: { amount: number; source: string; note: string; date: string }): Promise<void> {
  const db = await getDb();
  await db.execute('INSERT INTO income (amount, source, note, date) VALUES (?, ?, ?, ?)',
    [data.amount, data.source, data.note, data.date]);
}

export async function getIncomeByMonth(month: string): Promise<any[]> {
  const db = await getDb();
  return await db.select(
    "SELECT * FROM income WHERE deleted = 0 AND strftime('%Y-%m', date) = ? ORDER BY date DESC",
    [month],
  );
}

export async function getMonthIncome(month: string): Promise<number> {
  const db = await getDb();
  const rows = await db.select<{total:number}[]>(
    "SELECT COALESCE(SUM(amount),0) as total FROM income WHERE deleted = 0 AND strftime('%Y-%m', date) = ?",
    [month]);
  return rows[0]?.total ?? 0;
}

export async function deleteIncome(id: number): Promise<void> {
  const db = await getDb();
  // Tombstone, not a real delete: a row that simply vanishes tells the other
  // device nothing, so it would be re-uploaded on the next sync.
  await db.execute('UPDATE income SET deleted = 1 WHERE id = ?', [id]);
}

export async function getAllTasks(): Promise<any[]> {
  return dbQueue(async () => {
    const db = await getDb();
    // Auto-archive one-shot tasks whose completed_until has passed midnight —
    // they were marked done yesterday, so hide them today.
    await db.execute(`
      UPDATE tasks SET is_active = 0
      WHERE is_active = 1
        AND reset_type IN ('specific_date', 'event_window', 'one_time')
        AND completed_until IS NOT NULL
        AND completed_until < datetime('now')
    `);
    const rows = await db.select<any[]>(
      "SELECT * FROM tasks WHERE is_active = 1 ORDER BY id"
    );
    // Paused tasks are filtered out here rather than in the WHERE clause, so
    // that every caller gets the same answer: the list, the countdowns, the
    // notifier and the context handed to the assistant. Filtering in JS is
    // deliberate — paused_until is an ISO string and SQLite's datetime() is
    // not, so comparing them in SQL is wrong for part of every day.
    const now = new Date();
    return rows.filter(r => !isPaused(r, now));
  });
}

/** Set aside. `until` is an ISO datetime, or PAUSE_FOREVER for no end date. */
export async function pauseTask(id: number, until: string): Promise<void> {
  return dbQueue(async () => {
    const db = await getDb();
    await db.execute("UPDATE tasks SET paused_until = ? WHERE id = ?", [until, id]);
  });
}

/**
 * Back on the list.
 *
 * missed_streak is cleared and cycle_checked_until is wiped along with it. That
 * is the whole point of the feature: a task deliberately set aside was not
 * missed, and coming back to a smaller version of it — or to any consequence at
 * all — would make pausing something to avoid. cycle_checked_until being null
 * makes lib/cycles adopt the current boundary on its next pass without judging
 * the gap, which is exactly how it treats a task it has never seen.
 */
export async function resumeTask(id: number): Promise<void> {
  return dbQueue(async () => {
    const db = await getDb();
    await db.execute(
      "UPDATE tasks SET paused_until = NULL, missed_streak = 0, cycle_checked_until = NULL WHERE id = ?",
      [id],
    );
  });
}

/** Everything currently set aside, newest first. */
export async function getPausedTasks(): Promise<any[]> {
  return dbQueue(async () => {
    const db = await getDb();
    const rows = await db.select<any[]>(
      "SELECT * FROM tasks WHERE is_active = 1 AND paused_until IS NOT NULL ORDER BY id DESC",
    );
    const now = new Date();
    return rows.filter(r => isPaused(r, now));
  });
}

/**
 * The bin: deleted by hand, not yet purged.
 *
 * The deleted_at IS NOT NULL is doing real work. One-shot tasks archive
 * themselves to is_active = 0 once they are done and the day has turned, and
 * those are completed, not discarded. Offering to undelete a finished task
 * would be both confusing and a way to quietly refill the list with things
 * already dealt with.
 */
export async function getTrashedTasks(): Promise<any[]> {
  return dbQueue(async () => {
    const db = await getDb();
    return await db.select<any[]>(
      "SELECT * FROM tasks WHERE is_active = 0 AND deleted_at IS NOT NULL ORDER BY deleted_at DESC",
    );
  });
}

/** Undelete. Comes back running, not paused, with no missed cycles owed. */
export async function restoreTask(id: number): Promise<void> {
  return dbQueue(async () => {
    const db = await getDb();
    await db.execute(
      "UPDATE tasks SET is_active = 1, deleted_at = NULL, missed_streak = 0, cycle_checked_until = NULL WHERE id = ?",
      [id],
    );
  });
}

/** Gone for good, now rather than in thirty days. */
export async function purgeTask(id: number): Promise<void> {
  return dbQueue(async () => {
    const db = await getDb();
    await db.execute("DELETE FROM tasks WHERE id = ? AND deleted_at IS NOT NULL", [id]);
  });
}

/**
 * What was on a given day — including things that were finished and put away.
 *
 * The list and the calendar answer different questions. The list asks WHAT
 * NEEDS DOING, so a one-off completed yesterday correctly disappears from it.
 * The calendar asks WHAT HAPPENED ON THIS DAY, and for that question a finished
 * task is the best answer there is.
 *
 * Both used to read `is_active = 1`, which meant they shared a flag that only
 * ever meant "still on the to-do list". The consequence was that looking back
 * at last month, a day where something was finished and a day where nothing
 * happened at all rendered identically — both empty — which is backwards.
 *
 * So archived rows are let through and deleted ones are not: `deleted_at IS
 * NULL` is the whole distinction. Something thrown away should leave no trace;
 * something completed should leave exactly one.
 */
export async function getTasksForDate(date: string): Promise<any[]> {
  const db = await getDb();
  return await db.select(
    `SELECT * FROM tasks WHERE (is_active = 1 OR deleted_at IS NULL) AND (
      specific_date = ? OR
      reset_type IN ('daily', 'weekly', 'biweekly', 'custom_days') OR
      (reset_type = 'one_time' AND substr(event_end, 1, 10) = ?) OR
      (reset_type = 'event_window' AND (
        (event_start IS NOT NULL AND event_end IS NOT NULL AND ? BETWEEN substr(event_start,1,10) AND substr(event_end,1,10)) OR
        (event_start IS NULL AND event_end IS NOT NULL AND substr(event_end,1,10) = ?)
      ))
    ) ORDER BY is_priority DESC, is_urgent DESC, name`,
    [date, date, date, date]
  );
}

/**
 * Everything the calendar may draw, on any day of any month.
 *
 * The month grid was building its cells from getAllTasks, which is the to-do
 * list — so after the day panel learned to keep completed one-offs, the two
 * halves of the same screen disagreed: a finished task appeared in the panel on
 * the right and left no mark on the grid on the left. Same screen, same day,
 * two answers.
 */
export async function getCalendarTasks(): Promise<any[]> {
  return dbQueue(async () => {
    const db = await getDb();
    return await db.select<any[]>(
      "SELECT * FROM tasks WHERE is_active = 1 OR deleted_at IS NULL ORDER BY id",
    );
  });
}

/** Which days have a marker on them. Same rule as getTasksForDate, or the dot
 *  and the day panel would disagree about whether anything is there. */
export async function getTaskDates(): Promise<string[]> {
  const db = await getDb();
  const rows = await db.select<{specific_date: string}[]>(
    "SELECT DISTINCT specific_date FROM tasks WHERE (is_active = 1 OR deleted_at IS NULL) AND specific_date IS NOT NULL"
  );
  return rows.map(r => r.specific_date);
}

export async function getPriorityTasksForMonth(year: number, month: number): Promise<any[]> {
  const db = await getDb();
  const start = `${year}-${String(month + 1).padStart(2, "0")}-01`;
  const end = `${year}-${String(month + 1).padStart(2, "0")}-31`;
  return await db.select(
    `SELECT * FROM tasks WHERE is_active = 1 AND (is_priority = 1 OR is_urgent = 1)
     AND specific_date BETWEEN ? AND ?
     ORDER BY specific_date`,
    [start, end]
  );
}

// Sanitize a value destined for a SQLite TEXT column.
// Rules:
//   1. UTC strings ("...Z" or "...+00:00") → keep as-is (strip ms only)
//      new Date("2026-03-07T07:30:00Z") always parses correctly everywhere.
//   2. Bangkok-local strings with "+07:00" → keep as-is (strip ms only)
//      countdown.ts detects the bare "YYYY-MM-DDTHH:MM" pattern and appends +07:00.
//   3. Legacy space-separator → convert space to T (no Z = Bangkok local, handled by countdown.ts)
//   4. Bare date-only strings ("YYYY-MM-DD") and time-only ("HH:MM") → pass through unchanged.
function sanitizeText(v: any): string | null {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v);
  // UTC with Z — strip milliseconds but keep Z
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/.test(s)) {
    return s.replace(/\.\d+Z$/, 'Z');
  }
  // UTC Z without ms — already clean
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(s)) return s;
  // With timezone offset (e.g. +07:00) — strip ms
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+[+-]\d{2}:\d{2}$/.test(s)) {
    return s.replace(/\.\d+([+-])/, '$1');
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(s)) return s;
  // Has T already, no Z, no offset — Bangkok local, strip ms
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(s)) {
    return s.replace(/\.\d+$/, '').replace(/Z$/, '');
  }
  // Has space separator (old data) — convert to T form (Bangkok local)
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s)) {
    return s.replace(' ', 'T');
  }
  return s;
}

export async function createTask(task: any): Promise<void> {
  return dbQueue(async () => {
  const db = await getDb();
  console.log('[createTask]', task.name, task.reset_type, 'event_end=', task.event_end, 'specific_date=', task.specific_date);
  await db.execute(
    `INSERT INTO tasks (name, description, category, reset_type, reset_time, reset_day,
     reset_interval_days, anchor_date, event_start, event_end, specific_date, is_priority, is_urgent,
     min_step, time_zone, intent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      task.name, task.description || '', task.category, task.reset_type,
      sanitizeText(task.reset_time),
      task.reset_day === undefined ? null : (task.reset_day === null ? null : Number(task.reset_day)),
      task.reset_interval_days === undefined ? null : (task.reset_interval_days === null ? null : Number(task.reset_interval_days)),
      sanitizeText(task.anchor_date),
      sanitizeText(task.event_start),
      sanitizeText(task.event_end),
      sanitizeText(task.specific_date),
      task.is_priority ? 1 : 0,
      task.is_urgent ? 1 : 0,
      sanitizeText(task.min_step),
      sanitizeText(task.time_zone),
      task.intent === "want" || task.intent === "must" ? task.intent : null,
    ]
  );
  }); // end dbQueue
}

export async function deleteTask(id: number): Promise<void> {
  return dbQueue(async () => {
    const db = await getDb();
    await db.execute(
      "UPDATE tasks SET is_active = 0, deleted_at = ? WHERE id = ?",
      [new Date().toISOString(), id],
    );
  });
}

export async function togglePriority(id: number, is_priority: boolean): Promise<void> {
  return dbQueue(async () => {
    const db = await getDb();
    await db.execute("UPDATE tasks SET is_priority = ? WHERE id = ?", [is_priority ? 1 : 0, id]);
  });
}

export async function toggleUrgent(id: number, is_urgent: boolean): Promise<void> {
  return dbQueue(async () => {
    const db = await getDb();
    await db.execute("UPDATE tasks SET is_urgent = ? WHERE id = ?", [is_urgent ? 1 : 0, id]);
  });
}

/**
 * Mark a task done until a specific ISO datetime.
 * For recurring tasks: untilIso = next reset time → auto-unmarks when cycle resets.
 * For one-time tasks: we archive them instead (see archiveTask).
 */
export async function markTaskCompleted(id: number, untilIso: string): Promise<void> {
  const db = await getDb();
  // Doing it once clears the easing straight away. It was never a penalty to be
  // worked off, so there is nothing to earn back.
  await db.execute(
    "UPDATE tasks SET completed_until = ?, missed_streak = 0 WHERE id = ?",
    [untilIso, id]
  );
}

/**
 * Archive a finished one-time / event / specific-date task.
 * Sets is_active = 0 so it disappears from the active list.
 */
export async function archiveTask(id: number): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE tasks SET is_active = 0 WHERE id = ?",
    [id]
  );
}

/**
 * Record that a cycle boundary passed, and whether it was met. Called only when
 * a boundary actually passes, so this touches the database about once per cycle
 * per task rather than on any kind of loop. See lib/cycles.
 */
export async function recordCycleRollover(
  id: number, checkedUntil: string, missedStreak: number,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE tasks SET cycle_checked_until = ?, missed_streak = ? WHERE id = ?",
    [checkedUntil, missedStreak, id],
  );
}

/**
 * Undo completion — clears completed_until so the countdown reappears.
 */
export async function unmarkTaskCompleted(id: number): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE tasks SET completed_until = NULL WHERE id = ?",
    [id]
  );
}

// ─── AI assistant functions ───────────────────────────────────

export async function deleteTaskByName(name: string): Promise<void> {
  const db = await getDb();
  const result = await db.execute(
    "UPDATE tasks SET is_active = 0, deleted_at = ? WHERE LOWER(name) = LOWER(?) AND is_active = 1",
    [new Date().toISOString(), name]
  );
  if (result.rowsAffected === 0) {
    throw new Error(`No task found with name "${name}"`);
  }
}

export async function updateTaskTime(name: string, newTime: string): Promise<void> {
  const db = await getDb();
  const result = await db.execute(
    "UPDATE tasks SET reset_time = ? WHERE LOWER(name) = LOWER(?) AND is_active = 1",
    [newTime, name]
  );
  if (result.rowsAffected === 0) {
    throw new Error(`No task found with name "${name}"`);
  }
}

export async function updateTaskPriority(name: string, value: 0 | 1): Promise<void> {
  const db = await getDb();
  const result = await db.execute(
    "UPDATE tasks SET is_priority = ? WHERE LOWER(name) = LOWER(?) AND is_active = 1",
    [value, name]
  );
  if (result.rowsAffected === 0) {
    throw new Error(`No task found with name "${name}"`);
  }
}

export async function updateTaskUrgent(name: string, value: 0 | 1): Promise<void> {
  const db = await getDb();
  const result = await db.execute(
    "UPDATE tasks SET is_urgent = ? WHERE LOWER(name) = LOWER(?) AND is_active = 1",
    [value, name]
  );
  if (result.rowsAffected === 0) {
    throw new Error(`No task found with name "${name}"`);
  }
}
// ─── App settings (key-value store) ────────────────────────────────────────
export async function getSetting(key: string): Promise<string | null> {
  return dbQueue(async () => {
    const db = await getDb();
    const rows = await db.select<{ value: string }[]>(
      "SELECT value FROM app_settings WHERE key = ?",
      [key]
    );
    return rows.length > 0 ? rows[0].value : null;
  });
}

export async function setSetting(key: string, value: string): Promise<void> {
  return dbQueue(async () => {
    const db = await getDb();
    await db.execute(
      `INSERT INTO app_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value]
    );
  });
}