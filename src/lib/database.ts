import { isPaused } from "../types";
import { TASK_COLUMNS, taskUpdate, taskValues, type TaskDraft } from "./taskDraft";
import {
  INCOME_COLUMNS,
  SQL_DELETE_INCOME,
  SQL_MONTH_RECEIVED,
  incomeValues,
} from "./moneyDraft";
import { initSettings, type SettingsDb } from "./userSettings";
import { dbNow } from "./sync/sqlLocalStore";
import Database from "@tauri-apps/plugin-sql";
import { applySyncMigrations, SYNC_TABLES } from "./syncMeta";
import { sweepTrash, sweepTombstones, PURGE_TASK_SQL } from "./tombstones";
import { HISTORY_SQL, doneDates, type TaskEvent } from "./history";
import { getCurrency } from "./money";

let db: Database | null = null;
let dbReadyPromise: Promise<Database> | null = null;

/** Single shared DB — ALL tables (tasks + finance) created here before any caller proceeds */
/** Re-exported so callers keep one import. Defined with the rules that use it. */
export { TRASH_TTL_DAYS } from "./tombstones";

export async function getDb(): Promise<Database> {
  if (db) return db;
  if (dbReadyPromise) return dbReadyPromise;
  dbReadyPromise = (async () => {
    const d = await Database.load("sqlite:gamescheduler.db");
    await initializeSchema(d);
    db = d;
    // After `db` is set, not before: initSettings reads user_settings through
    // the handle it is given rather than through getDb(), but anything it calls
    // one day might not, and a call into getDb() from inside the promise getDb
    // is still building is a deadlock with no error and an empty screen. That
    // has happened once in this file already.
    await initSettings(d as unknown as SettingsDb);
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
  // Added here as well as in schema.sql because this list is what an already
  // installed database is upgraded by; schema.sql only ever builds fresh ones.
  // Two lists that have to agree is the shape of every bug this project has
  // spent a month removing, and the day they are merged is the day this comment
  // can go.
  try { await db.execute(`ALTER TABLE tasks ADD COLUMN completed_at TEXT DEFAULT NULL`); } catch (_) {}

  // Append-only history. Created here as well as in schema.sql, because this
  // list is what an already installed database is upgraded by.
  await db.execute(`CREATE TABLE IF NOT EXISTS task_events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    task_uid  TEXT NOT NULL,
    kind      TEXT NOT NULL,
    at        TEXT NOT NULL,
    for_cycle TEXT
  )`);
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

  // Which unit the number in `amount` is counted in. Added now, while these
  // tables hold a few hundred rows and there is no sync protocol that would
  // have to be renegotiated, for the same reason the sync columns were: the
  // expensive version of this migration is the one done later.
  //
  // Backfilling existing rows as THB is not a guess. Every row that exists was
  // entered when the app could only mean baht.
  try { await db.execute("ALTER TABLE expenses ADD COLUMN currency TEXT NOT NULL DEFAULT 'THB'"); } catch (_) {}
  try { await db.execute("ALTER TABLE income   ADD COLUMN currency TEXT NOT NULL DEFAULT 'THB'"); } catch (_) {}

  // Money that should arrive and has not. Created here with every other table
  // rather than by a helper in its own file, and NOT because that is tidier:
  //
  // the helper called getDb(), and this runs INSIDE getDb(). getDb sets its
  // ready-promise, then awaits this function; the helper then asked for the
  // database, was handed that same not-yet-resolved promise, and waited for it.
  // A promise waiting on a function waiting on that promise. The database never
  // opened, so nothing loaded anywhere in the app — which reads as "it lost all
  // my data" rather than as a hang, because the screens render fine and empty.
  //
  // Every other table is created with a `db` already in hand. Following that
  // made the deadlock impossible rather than merely absent.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS expected_income (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      amount REAL,
      currency TEXT NOT NULL DEFAULT 'THB',
      expect_date TEXT NOT NULL,
      repeat TEXT,
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'waiting',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      deleted INTEGER NOT NULL DEFAULT 0
    )
  `);
  await db.execute(
    "CREATE INDEX IF NOT EXISTS idx_expected_status ON expected_income(status, expect_date)",
  );

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

  // A limit and a target are amounts, and an amount without a unit is not one.
  //
  // These two columns were the last money in the database with no currency
  // beside it, which did not matter while the app could only mean baht and
  // became a silent rewrite the moment it could not: a ฿5,000 food budget was
  // read as $5,000 the instant the setting changed, with nothing on screen
  // saying so, and a 30,000 goal likewise. Nothing was converted and nothing
  // was wrong in the row — the number was simply reinterpreted.
  //
  // Backfilling as THB is not a guess for the same reason it was not one for
  // expenses: every row that exists was entered when baht was the only thing
  // the app could mean.
  try { await db.execute("ALTER TABLE budgets      ADD COLUMN currency TEXT NOT NULL DEFAULT 'THB'"); } catch (_) {}
  try { await db.execute("ALTER TABLE saving_goals ADD COLUMN currency TEXT NOT NULL DEFAULT 'THB'"); } catch (_) {}

  // ── App settings (key-value) ───────────────────────────────
  // Generic store for app preferences like wallpaper path/enabled.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  // The half of the above that describes a person rather than a machine, and
  // therefore the half that syncs. app_settings holds the pairing key and the
  // WebDAV password, so what may leave this machine is decided by which table a
  // row is in rather than by a predicate over key names that four separate
  // places would have to get right identically. See schema.sql.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS user_settings (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      key    TEXT NOT NULL UNIQUE,
      value  TEXT
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
  // Emptying the bin leaves a tombstone rather than removing the row. A row
  // that vanishes cannot be told apart from one the other device never received,
  // so it would be pushed back and the task would return from the dead.
  await sweepTrash(db);

  // Give every row a device-independent identity and a modification time, so
  // the phone app can eventually sync with this one. See src/lib/syncMeta.ts.
  // Runs last, after every table exists. Idempotent, so it is safe every boot.
  await applySyncMigrations(db);

  // And the other end of the same story: a tombstone nobody could still need is
  // finally removed. Runs after the migrations because it needs the `deleted`
  // column that they add.
  await sweepTombstones(db, SYNC_TABLES.map((t) => t.name));
}


export async function updateTask(id: number, fields: Record<string, unknown>): Promise<void> {
  return dbQueue(async () => {
    const db = await getDb();
    // Which columns may be written, and how each value is read, both come from
    // lib/taskDraft. There used to be a third list of task columns here with
    // its own integer and date sets beside it, two screens away from the other
    // two and pointing at neither.
    const { columns, values } = taskUpdate(fields);
    if (!columns.length) return;
    const sets = columns.map((c) => `${c} = ?`).join(", ");
    await db.execute(`UPDATE tasks SET ${sets} WHERE id = ?`, [...values, Number(id)]);
  });
}

export async function getTaskById(id: number): Promise<any | null> {
  const db = await getDb();
  const numId = Number(id);
  const rows = await db.select<any[]>('SELECT * FROM tasks WHERE id = ? AND deleted = 0', [numId]);
  if (!rows || rows.length === 0) {
    console.warn(`[DB] getTaskById(${id}): no rows`);
    return null;
  }
  return rows[0];
}

export async function addIncome(data: {
  amount: number; source: string; note: string; date: string;
  /** Omitted means the currency in force now, which is what a manual entry is. */
  currency?: string;
}): Promise<void> {
  const db = await getDb();
  // The five coercions moved to lib/moneyDraft so the phone can reproduce them
  // against a vector file. Nothing about what gets written changed.
  //
  // The currency is resolved here rather than in there, for the reason that
  // file gives at length: "whatever the setting says right now" is a fact about
  // this screen and this moment, and a shared function that reached for it
  // would be filing money in whichever unit a machine happened to be set to.
  const marks = INCOME_COLUMNS.map(() => "?").join(", ");
  await db.execute(
    `INSERT INTO income (${INCOME_COLUMNS.join(", ")}) VALUES (${marks})`,
    incomeValues({ ...data, currency: data.currency || getCurrency() }),
  );
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
    // One currency at a time. See the note above getMonthTotal in
    // financeDatabase: summing across units invents a number.
    SQL_MONTH_RECEIVED,
    [getCurrency(), month]);
  return rows[0]?.total ?? 0;
}

/**
 * Every currency that actually appears in the books, commonest first.
 *
 * The currency setting is a claim about the future — what the NEXT entry is
 * counted in — and there was nothing anywhere that said what the past was
 * counted in. That gap is what makes a mis-set currency so hard to notice: the
 * screen fills with zeroes and correct-looking empty bars, because every total
 * is filtered to a unit that almost nothing in the database is recorded in.
 *
 * Answering it costs one query, and in the ordinary single-currency life it
 * returns one row, which the settings screen then draws nothing for.
 */
export async function currenciesInUse(): Promise<{ code: string; n: number }[]> {
  const db = await getDb();
  return await db.select<{ code: string; n: number }[]>(`
    SELECT currency AS code, COUNT(*) AS n FROM (
      SELECT currency FROM expenses WHERE deleted = 0
      UNION ALL
      SELECT currency FROM income   WHERE deleted = 0
    ) GROUP BY currency ORDER BY n DESC, code ASC
  `);
}

/**
 * Income this month in currencies OTHER than the one in force.
 *
 * The expense side has had this since the currency column was added; the income
 * side did not, which made the two figures at the top of the screen unequally
 * honest. A month's spending that left rows out said so underneath itself. A
 * month's earnings that left rows out looked exactly like a month with no
 * earnings — and that is the direction that hurts, because the balance beside
 * it is then income minus expenses with the income missing.
 *
 * This is not hypothetical for the person who wrote it: the money coming in is
 * priced in dollars and the money going out is spent in baht.
 */
export async function otherIncomeCurrencyTotals(month: string): Promise<Map<string, number>> {
  const db = await getDb();
  const rows = await db.select<{ currency: string; total: number }[]>(
    "SELECT currency, SUM(amount) as total FROM income WHERE deleted = 0 AND currency != ? AND strftime('%Y-%m', date) = ? GROUP BY currency",
    [getCurrency(), month],
  );
  return new Map(rows.map(r => [r.currency, r.total]));
}

export async function deleteIncome(id: number): Promise<void> {
  const db = await getDb();
  // Tombstone, not a real delete: a row that simply vanishes tells the other
  // device nothing, so it would be re-uploaded on the next sync.
  // Shared with the phone, and keyed by uid for the same reason: `id` is an
  // autoincrement and means a different row on each machine.
  const found = await db.select<{ uid: string }[]>(
    "SELECT uid FROM income WHERE id = ?",
    [id],
  );
  if (found.length === 0 || !found[0].uid) return;
  await db.execute(SQL_DELETE_INCOME, [found[0].uid]);
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
      // `deleted = 0` matters here and only here: a purged task keeps its
      // deleted_at, so without it the bin would show a nameless ghost row for
      // every task that was ever emptied out of it.
      "SELECT * FROM tasks WHERE is_active = 0 AND deleted_at IS NOT NULL AND deleted = 0 ORDER BY deleted_at DESC",
    );
  });
}

/** Undelete. Comes back running, not paused, with no missed cycles owed. */
export async function restoreTask(id: number): Promise<void> {
  return dbQueue(async () => {
    const db = await getDb();
    await db.execute(
      "UPDATE tasks SET is_active = 1, deleted_at = NULL, missed_streak = 0, cycle_checked_until = NULL WHERE id = ? AND deleted = 0",
      [id],
    );
  });
}

/** Gone for good, now rather than in thirty days. */
export async function purgeTask(id: number): Promise<void> {
  return dbQueue(async () => {
    const db = await getDb();
    await db.execute(PURGE_TASK_SQL, [id]);
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
  const rows = await db.select<any[]>(
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
  // Paused here too, for the same reason and by the same rule.
  const now = new Date();
  return rows.filter(r => !isPaused(r, now));
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
    const rows = await db.select<any[]>(
      "SELECT * FROM tasks WHERE is_active = 1 OR deleted_at IS NULL ORDER BY id",
    );
    // Same pause rule as getAllTasks. Without it a set-aside task vanished from
    // the task list and carried on appearing in the calendar - two screens
    // disagreeing about whether something exists, which is the exact failure
    // this function was written to fix inside the calendar and then reproduced
    // across it.
    const now = new Date();
    return rows.filter(r => !isPaused(r, now));
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

// The date sanitiser lives in lib/taskDraft now, next to the other fifteen
// coercions it belongs with, and is imported above.

export async function createTask(task: TaskDraft): Promise<void> {
  return dbQueue(async () => {
    const db = await getDb();
    // The sixteen coercions moved to lib/taskDraft so that the phone can
    // reproduce them against a vector file rather than from reading this.
    // Nothing about what gets written changed; the vectors were generated from
    // the values this function used to build.
    const marks = TASK_COLUMNS.map(() => "?").join(", ");
    await db.execute(
      `INSERT INTO tasks (${TASK_COLUMNS.join(", ")}) VALUES (${marks})`,
      taskValues(task),
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
 * One line in the history, written beside the change that caused it.
 *
 * Looked up by uid rather than taking the row id, because the id means nothing
 * on the other device and this row is going to travel.
 *
 * A failure here must not undo the tick. Losing a line of history is a day that
 * reads slightly wrong in a calendar six months from now; refusing to mark a
 * task done because a log write failed is the app breaking in the hand of
 * somebody who just finished something.
 */
/**
 * The last few times a task was done and stayed done, newest first.
 *
 * Lives here rather than in lib/history because that file is rules only and has
 * to load without a browser — check-sync exercises the query and the filter
 * against a real database, and it cannot import anything that reaches the
 * language files.
 */
export async function recentDone(taskUid: string, limit = 3): Promise<string[]> {
  try {
    const db = await getDb();
    const rows = await db.select<TaskEvent[]>(HISTORY_SQL, [taskUid]);
    return doneDates(rows, limit);
  } catch (err) {
    // A history that will not read is not a reason to fail opening a task.
    console.warn("[history] could not read:", err);
    return [];
  }
}

async function recordTaskEvent(
  db: Database,
  id: number,
  kind: "done" | "undone",
  at: string,
  forCycle: string | null,
): Promise<void> {
  try {
    const rows = await db.select<{ uid: string | null }[]>(
      "SELECT uid FROM tasks WHERE id = ?",
      [id],
    );
    const uid = rows[0]?.uid;
    if (!uid) return;
    await db.execute(
      "INSERT INTO task_events (task_uid, kind, at, for_cycle) VALUES (?, ?, ?, ?)",
      [uid, kind, at, forCycle],
    );
  } catch (err) {
    console.error("[history] could not record", kind, err);
  }
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
  // completed_at is stamped from the same clock the sync trigger uses, not from
  // Date.now(), for the reason syncMeta gives about updated_at: a column that is
  // only ever compared as a string has to come from one place.
  const now = await dbNow(db);
  await db.execute(
    "UPDATE tasks SET completed_until = ?, completed_at = ?, missed_streak = 0 WHERE id = ?",
    [untilIso, now, id]
  );
  await recordTaskEvent(db, id, "done", now, untilIso);
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
  // The tick is cleared and the moment it was cleared is recorded. Without the
  // second half this write cannot travel: sync compares completed_at, and a row
  // that clears the tick without saying when loses to the copy on the other
  // device for ever.
  const now = await dbNow(db);
  await db.execute(
    "UPDATE tasks SET completed_until = NULL, completed_at = ? WHERE id = ?",
    [now, id]
  );
  await recordTaskEvent(db, id, "undone", now, null);
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