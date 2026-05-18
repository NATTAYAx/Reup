import Database from "@tauri-apps/plugin-sql";

let db: Database | null = null;
let dbReadyPromise: Promise<Database> | null = null;

/** Single shared DB — ALL tables (tasks + finance) created here before any caller proceeds */
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
}


export async function updateTask(id: number, fields: Partial<{
  name: string; description: string; notes: string; category: string;
  reset_type: string; reset_time: string | null; reset_day: number | null;
  reset_interval_days: number | null; anchor_date: string | null;
  event_start: string | null; event_end: string | null;
  specific_date: string | null; is_priority: number; is_urgent: number;
}>): Promise<void> {
  return dbQueue(async () => {
    const db = await getDb();
    const keys = Object.keys(fields) as string[];
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
  return await db.select("SELECT * FROM income WHERE strftime('%Y-%m', date) = ? ORDER BY date DESC", [month]);
}

export async function getMonthIncome(month: string): Promise<number> {
  const db = await getDb();
  const rows = await db.select<{total:number}[]>(
    "SELECT COALESCE(SUM(amount),0) as total FROM income WHERE strftime('%Y-%m', date) = ?", [month]);
  return rows[0]?.total ?? 0;
}

export async function deleteIncome(id: number): Promise<void> {
  const db = await getDb();
  await db.execute('DELETE FROM income WHERE id = ?', [id]);
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
    return await db.select(
      "SELECT * FROM tasks WHERE is_active = 1 ORDER BY id"
    );
  });
}

export async function getTasksForDate(date: string): Promise<any[]> {
  const db = await getDb();
  return await db.select(
    `SELECT * FROM tasks WHERE is_active = 1 AND (
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

export async function getTaskDates(): Promise<string[]> {
  const db = await getDb();
  const rows = await db.select<{specific_date: string}[]>(
    "SELECT DISTINCT specific_date FROM tasks WHERE is_active = 1 AND specific_date IS NOT NULL"
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
     reset_interval_days, anchor_date, event_start, event_end, specific_date, is_priority, is_urgent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    ]
  );
  }); // end dbQueue
}

export async function deleteTask(id: number): Promise<void> {
  return dbQueue(async () => {
    const db = await getDb();
    await db.execute("UPDATE tasks SET is_active = 0 WHERE id = ?", [id]);
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
  await db.execute(
    "UPDATE tasks SET completed_until = ? WHERE id = ?",
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
    "UPDATE tasks SET is_active = 0 WHERE LOWER(name) = LOWER(?) AND is_active = 1",
    [name]
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