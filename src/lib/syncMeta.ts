// ─── Sync readiness ───────────────────────────────────────────────────────────
//
// Groundwork for the phone app sharing data with the desktop app. No network
// code here — this only makes the local database capable of being synced later.
// It is done now, on purpose, while the only user is the developer and the
// tables hold a few dozen rows. Retrofitting identity onto other people's data
// later is a different and much worse job.
//
// THE PROBLEM WITH AUTOINCREMENT
// ------------------------------
// Every table used `id INTEGER PRIMARY KEY AUTOINCREMENT`. The desktop creates
// task id 5, the phone creates task id 5, and they are different tasks. Nothing
// can reconcile that. So each row also gets `uid`, a UUID minted on the device
// that created it and never reused anywhere.
//
// `id` stays exactly as it was and remains the local key every existing query
// and every React component uses. Nothing above this layer has to change. `uid`
// is only for talking to other devices.
//
// WHY TRIGGERS INSTEAD OF EDITING EVERY QUERY
// -------------------------------------------
// `updated_at` only works if it is right on EVERY write. Hand-editing the ~20
// INSERT and UPDATE statements would work today and rot the first time someone
// adds a twenty-first without remembering. Database triggers cannot be
// forgotten: they fire for writes that do not exist yet.
//
// The triggers are also written so an explicit `updated_at` in a statement wins.
// That matters later — when the sync pulls a row from the server it must keep
// the server's timestamp, not stamp it with the local clock.
//
// WHICH TABLES GET A TOMBSTONE
// ----------------------------
// A sync needs to know the difference between "this row never reached me" and
// "this row was deleted". Tables that hard-delete need a `deleted` flag, since
// a vanished row carries no information. Tables that already soft-delete do not:
//   tasks         is_active = 0 already keeps the row, so no flag needed
//   budgets       upserted by (category, month), never deleted
//   income        hard-deleted today, so it gets a flag
//   expenses      hard-deleted today, so it gets a flag
//   saving_goals  hard-deleted today, so it gets a flag

import type Database from "@tauri-apps/plugin-sql";

/** RFC 4122 v4 UUID, generated inside SQLite so backfill is one statement. */
const SQL_UUID4 = `(
  lower(hex(randomblob(4))) || '-' ||
  lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
)`;

/** ISO-8601 UTC with milliseconds, so ordering is unambiguous across devices. */
const SQL_NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

interface SyncTable {
  name: string;
  /** Tables that hard-delete need a tombstone; ones that already keep the row do not. */
  needsDeleted: boolean;
  /** Used to seed updated_at for rows that already exist. */
  hasCreatedAt: boolean;
}

export const SYNC_TABLES: SyncTable[] = [
  { name: "tasks",        needsDeleted: false, hasCreatedAt: true  },
  { name: "income",       needsDeleted: true,  hasCreatedAt: true  },
  { name: "expenses",     needsDeleted: true,  hasCreatedAt: true  },
  { name: "budgets",      needsDeleted: false, hasCreatedAt: false },
  { name: "saving_goals", needsDeleted: true,  hasCreatedAt: true  },
];

/** ALTER TABLE ADD COLUMN throws if the column is already there. That is the
 *  normal path on every launch after the first, so it is not an error. */
async function addColumn(db: Database, table: string, ddl: string): Promise<void> {
  try {
    await db.execute(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  } catch (_) {
    // already present
  }
}

export async function applySyncMigrations(db: Database): Promise<void> {
  for (const t of SYNC_TABLES) {
    await addColumn(db, t.name, "uid TEXT");
    await addColumn(db, t.name, "updated_at TEXT");
    if (t.needsDeleted) {
      await addColumn(db, t.name, "deleted INTEGER NOT NULL DEFAULT 0");
    }

    // Backfill rows that existed before this migration. randomblob() is
    // evaluated per row, so every row gets its own UUID from one statement.
    //
    // created_at was written as "YYYY-MM-DD HH:MM:SS" while every new timestamp
    // is ISO with a T and a Z. Mixing the two in one column would make string
    // comparison, which is all "changed since X" has, quietly wrong. So old
    // values are reformatted rather than copied.
    const source = t.hasCreatedAt ? "COALESCE(updated_at, created_at)" : "updated_at";
    const seed = `COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', ${source}), ${SQL_NOW})`;
    await db.execute(
      `UPDATE ${t.name}
          SET uid = COALESCE(uid, ${SQL_UUID4}),
              updated_at = ${seed}
        WHERE uid IS NULL OR updated_at IS NULL`,
    );

    // uid is the identity a server will key on, so it must be unique. NULLs are
    // allowed to repeat in SQLite, which is fine: the insert trigger fills them.
    await db.execute(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_${t.name}_uid ON ${t.name}(uid)`,
    );
    // "everything changed since my last sync" is the one query sync runs most.
    await db.execute(
      `CREATE INDEX IF NOT EXISTS idx_${t.name}_updated ON ${t.name}(updated_at)`,
    );

    // New rows: stamp identity and time, whatever code did the insert.
    await db.execute(`
      CREATE TRIGGER IF NOT EXISTS ${t.name}_sync_insert
      AFTER INSERT ON ${t.name}
      FOR EACH ROW WHEN NEW.uid IS NULL OR NEW.updated_at IS NULL
      BEGIN
        UPDATE ${t.name}
           SET uid = COALESCE(NEW.uid, ${SQL_UUID4}),
               updated_at = COALESCE(NEW.updated_at, ${SQL_NOW})
         WHERE id = NEW.id;
      END;
    `);

    // Any write bumps the clock. The WHEN guard means a statement that sets
    // updated_at itself is left alone, which is how an incoming sync keeps the
    // server's timestamp, and it also stops the trigger firing on itself.
    await db.execute(`
      CREATE TRIGGER IF NOT EXISTS ${t.name}_sync_update
      AFTER UPDATE ON ${t.name}
      FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at
      BEGIN
        UPDATE ${t.name} SET updated_at = ${SQL_NOW} WHERE id = NEW.id;
      END;
    `);
  }
}

/** Rows changed since a point in time — the read half of a future sync push. */
export async function changedSince(
  db: Database,
  table: string,
  isoTime: string,
): Promise<any[]> {
  return db.select<any[]>(
    `SELECT * FROM ${table} WHERE updated_at > ? ORDER BY updated_at ASC`,
    [isoTime],
  );
}