import { getDb } from "./database";
import { PREFIX, isSecretKey, sanitizeForBackup } from "./storageKeys";

// ─── backup.ts — the one thing missing that could actually lose everything ────
//
// Every task, every expense, every saving goal and the important-things card
// live on one SSD in one file. There was no way to get a copy of any of it out.
// A dead drive, a Windows reinstall, a mistyped DELETE — any of those and it is
// gone, with no way back.
//
// This is deliberately the dumbest thing that works. One JSON file. No cloud, no
// account, no server, no sync protocol, nothing to keep running. A file she can
// drop in the Dropbox folder already sitting on her desktop, mail to herself, or
// copy to a USB stick.
//
// WHAT PEOPLE GET WRONG ABOUT THIS
// Half the data is not in the database. The important-things card, the theme,
// the language, the timezone preference, the AI provider settings — all of that
// is in localStorage. A backup that only dumps SQLite silently loses the card
// with the phone numbers on it, which is the single worst thing in here to lose.
// So both halves are in the file.
//
// WHAT IS DELIBERATELY LEFT OUT
// The API key, because a backup file is meant to be copied around and left in
// folders, and a key sitting in a plain-text file in Dropbox is how keys leak.
// It takes ten seconds to paste a new one; it takes longer than that to notice
// it has been stolen. The AI response cache is left out too, for the boring
// reason that it is large and rebuilds itself.

const FORMAT = "game-scheduler-backup";

/**
 * Bump this whenever the SHAPE of the file changes — a new table, a renamed
 * key, anything a reader has to know about. Adding a nullable column no longer
 * requires it, because restore now asks the database which columns exist
 * instead of trusting the file (see fitToTable below); before that change, a
 * file written by a newer build and restored on an older one threw on the first
 * unknown column and dropped the WHOLE table into `skipped`, while the screen
 * still said the restore had worked.
 */
const VERSION = 2;

/** Every table, in an order that does not matter now but would if these ever
 *  gained foreign keys. */
const TABLES = [
  "tasks",
  "income",
  "expenses",
  "budgets",
  "saving_goals",
  "expense_categories",
  "app_settings",
] as const;

// What may leave the machine, and in what state, is decided in lib/storageKeys —
// next to the names of the keys themselves. It used to be decided here, from
// memory, and the memory went stale: this list named the pre-2025 Gemini key
// while aiProviders.ts had already moved to gamesched_ai_key_<provider>, so
// every live API key was being written into backup files in plain text.

export interface BackupFile {
  format: string;
  version: number;
  exportedAt: string;
  tables: Record<string, unknown[]>;
  local: Record<string, string>;
}

export interface RestoreReport {
  tables: Record<string, number>;
  localKeys: number;
  skipped: string[];
}

// ── Export ────────────────────────────────────────────────────────────────────

export async function buildBackup(): Promise<BackupFile> {
  const db = await getDb();
  const tables: Record<string, unknown[]> = {};

  for (const name of TABLES) {
    try {
      tables[name] = await db.select<unknown[]>(`SELECT * FROM ${name}`);
    } catch (err) {
      // A table that does not exist in an older database should not sink the
      // whole backup. Better to save six tables than none.
      console.error(`[backup] could not read ${name}:`, err);
      tables[name] = [];
    }
  }

  const local: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(PREFIX)) continue;
      const value = localStorage.getItem(key);
      if (value === null) continue;
      const safe = sanitizeForBackup(key, value);
      if (safe !== null) local[key] = safe;
    }
  } catch (err) {
    console.error("[backup] could not read local settings:", err);
  }

  return {
    format: FORMAT,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    tables,
    local,
  };
}

export async function buildBackupJson(): Promise<string> {
  return JSON.stringify(await buildBackup(), null, 2);
}

/** A filename that sorts chronologically and says what it is at a glance. */
export function backupFileName(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `game-scheduler-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}` +
         `-${p(now.getHours())}${p(now.getMinutes())}.json`;
}

// ── Restore ───────────────────────────────────────────────────────────────────

export function parseBackup(text: string): BackupFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("notJson");
  }
  const file = parsed as Partial<BackupFile>;
  if (!file || file.format !== FORMAT) throw new Error("notBackup");
  if (typeof file.version !== "number" || file.version > VERSION) throw new Error("tooNew");
  if (!file.tables || typeof file.tables !== "object") throw new Error("notBackup");
  return {
    format: FORMAT,
    version: file.version,
    exportedAt: typeof file.exportedAt === "string" ? file.exportedAt : "",
    tables: file.tables as Record<string, unknown[]>,
    local: (file.local ?? {}) as Record<string, string>,
  };
}

/** Column names SQLite manages itself and that must not be written back. */
const SKIP_COLUMNS = new Set<string>([]);

/**
 * The columns a table actually has right now, straight from SQLite.
 *
 * This is the fix for the failure mode that used to be silent. A row was
 * inserted with whatever keys the JSON happened to carry, so a file written by
 * a build with one extra column, restored on a build without it, threw on the
 * first row — and the catch below swallowed it into `skipped` while the screen
 * reported a successful restore with a table quietly missing.
 *
 * Asking the database means the two directions now behave the way a person
 * would expect: a column the file does not have takes its default, and a column
 * the table does not have is dropped along with a line in the log. Neither
 * loses the rest of the row.
 */
async function tableColumns(db: Awaited<ReturnType<typeof getDb>>, table: string): Promise<Set<string>> {
  const rows = await db.select<{ name: string }[]>(`PRAGMA table_info(${table})`);
  return new Set(rows.map(r => r.name));
}

/**
 * Replaces everything with the contents of the file. This is a restore, not a
 * merge: after it finishes the app holds exactly what the file holds, which is
 * what someone recovering from a dead drive means by "restore my backup".
 *
 * Merging two devices is a genuinely different problem and needs the uid and
 * updated_at columns that lib/syncMeta already puts on every row. That is what
 * they are there for; this is not it.
 *
 * ON SAFETY: there is no wrapping transaction, because the SQL plugin hands out
 * pooled connections and a BEGIN here has no guarantee of landing on the same
 * one as the writes that follow. So the protection is a snapshot of the current
 * data taken before any of this runs — see the caller. If this dies halfway,
 * that snapshot is the way back, and its path is shown on screen.
 */
export async function restoreBackup(file: BackupFile): Promise<RestoreReport> {
  const db = await getDb();
  const report: RestoreReport = { tables: {}, localKeys: 0, skipped: [] };

  for (const name of TABLES) {
    const rows = file.tables[name];
    if (!Array.isArray(rows)) { report.skipped.push(name); continue; }

    try {
      const known = await tableColumns(db, name);
      const dropped = new Set<string>();

      await db.execute(`DELETE FROM ${name}`);
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const entries = Object.entries(row as Record<string, unknown>)
          .filter(([col]) => {
            if (SKIP_COLUMNS.has(col)) return false;
            if (!known.has(col)) { dropped.add(col); return false; }
            return true;
          });
        if (!entries.length) continue;
        const cols = entries.map(([c]) => c);
        const marks = cols.map(() => "?").join(", ");
        // uid and updated_at travel with the row and are written as they were.
        // The sync triggers only fill those in when they arrive null, so a
        // restored row keeps the identity it had rather than being reborn as a
        // stranger that a future sync would treat as a brand new thing.
        await db.execute(
          `INSERT OR REPLACE INTO ${name} (${cols.join(", ")}) VALUES (${marks})`,
          entries.map(([, v]) => v),
        );
      }
      report.tables[name] = rows.length;
      if (dropped.size) {
        // Not an error and not shown to the user: the rows restored fine. It is
        // here because a column disappearing between two builds is exactly the
        // sort of thing worth being able to read back out of a console log.
        console.warn(`[backup] ${name}: ignored unknown columns ${[...dropped].join(", ")}`);
      }
    } catch (err) {
      console.error(`[backup] restore failed on ${name}:`, err);
      report.skipped.push(name);
    }
  }

  try {
    for (const [key, value] of Object.entries(file.local)) {
      if (!key.startsWith(PREFIX)) continue;
      // A key should never be in the file at all, but a file can be edited by
      // hand and an older build wrote them for real. Refusing to write a secret
      // back means restoring an old backup cannot quietly reinstate a key that
      // has since been revoked and replaced.
      if (isSecretKey(key)) continue;
      localStorage.setItem(key, value);
      report.localKeys++;
    }
  } catch (err) {
    console.error("[backup] restore failed on local settings:", err);
  }

  return report;
}