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

/**
 * A clock that only ever moves forward, one row in one table.
 *
 * `strftime('now')` alone is not enough. On Windows the system timer ticks about
 * every sixteen milliseconds, so a delete and the row created to replace it can
 * both land on the same reading. Two rows sharing a timestamp is not a rounding
 * error: "what have I changed since my last push" is `updated_at > watermark`,
 * and a row written in the same tick as the watermark is never seen again. It is
 * not sent, no error is raised anywhere, and the other device simply never
 * learns about it.
 *
 * Bumping to `max(now, previous + 1ms)` makes two equal stamps impossible, so
 * the strict comparison is correct by construction rather than by luck. It also
 * survives the system clock being set backwards, which `now` on its own does
 * not.
 *
 * The cost is one extra UPDATE per write, against a single-row table, inside a
 * database that only allows one writer at a time anyway.
 */
const SQL_BUMP = `UPDATE sync_clock SET t = max(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', t, '+0.001 seconds')) WHERE id = 1`;

/** The reading itself. Always preceded by a bump, never used alone. */
const SQL_CLOCK = `(SELECT t FROM sync_clock WHERE id = 1)`;

interface SyncTable {
  name: string;
  /** Tables that hard-delete need a tombstone; ones that already keep the row do not. */
  needsDeleted: boolean;
  /** Used to seed updated_at for rows that already exist. */
  hasCreatedAt: boolean;
}

export const SYNC_TABLES: SyncTable[] = [
  // tasks and budgets were once false here, with the reasoning that is_active =
  // 0 already keeps the row so no tombstone was needed. That is true of the
  // trash, which is a state a row is in, and false of the purge button and of
  // the thirty-day sweep, which both run a real DELETE. Under sync a deleted
  // row that leaves no trace is worse than one that stays: the other device
  // still has it, pushes it back, and it returns from the dead with no error
  // anywhere. A tombstone costs one column.
  { name: "tasks",        needsDeleted: true,  hasCreatedAt: true  },
  { name: "income",       needsDeleted: true,  hasCreatedAt: true  },
  { name: "expenses",     needsDeleted: true,  hasCreatedAt: true  },
  { name: "budgets",      needsDeleted: true,  hasCreatedAt: false },
  { name: "saving_goals", needsDeleted: true,  hasCreatedAt: true  },
  // Hidden is not deleted, so the tombstone here is only for a category a
  // future version might truly remove. It costs one column to have it ready.
  { name: "expense_categories", needsDeleted: true, hasCreatedAt: false },
  // Already has its own deleted flag, so only uid and updated_at are added.
  { name: "expected_income", needsDeleted: false, hasCreatedAt: true },
  // Append-only, so the tombstone column is dead weight: nothing here is ever
  // deleted or edited, and two devices merging events is a union rather than a
  // negotiation. It still needs uid and updated_at like everything else,
  // because that is how a row travels at all.
  { name: "task_events", needsDeleted: true, hasCreatedAt: false },
  // The settings that describe a person. A tombstone because a key can be
  // retired, and a retired key that leaves no trace is a setting the other
  // device pushes back and resurrects — the same failure as a deleted task,
  // with the difference that nobody would think to look for it here.
  { name: "user_settings", needsDeleted: true, hasCreatedAt: false },
];

/**
 * One statement, and whether failing is normal.
 *
 * The migrations are returned as data rather than run inline for one reason:
 * the phone has to apply exactly these, and a second implementation that has to
 * match this one by somebody remembering is the disease this project keeps
 * curing. As a list, the two can be compared string by string in a vector file.
 */
/**
 * One row into the outbox, from inside a trigger on `table`.
 *
 * Reads the row back by rowid rather than using NEW, because on an insert the
 * uid and the timestamp are filled by a second trigger and NEW still holds the
 * nulls the statement arrived with. Reading the table gives whatever is there
 * once every trigger on this statement has run.
 */
const outboxEnqueue = (table: string) => `INSERT INTO sync_outbox (tbl, uid, updated_at)
          SELECT '${table}', uid, updated_at FROM ${table}
           WHERE id = NEW.id AND uid IS NOT NULL AND updated_at IS NOT NULL
        ON CONFLICT (tbl, uid) DO UPDATE SET updated_at = excluded.updated_at`;

export interface Migration {
  sql: string;
  /** ALTER TABLE ADD COLUMN throws when the column is already there, which is
   *  the normal path on every launch after the first. */
  ignoreErrors?: boolean;
}

/**
 * Every statement needed to bring any database, new or old, up to what sync
 * expects. Pure — it touches nothing and can be printed, compared or replayed.
 */
/**
 * Queue every row there is, once.
 *
 * WHY EVERYTHING RATHER THAN A CUTOFF
 *
 * On the launch the outbox first appears it is empty, and the only record of
 * what has been sent is the watermark — the number this table exists because it
 * cannot be trusted. Seeding everything costs one full upload per device, once,
 * which the far side applies as zero rows because merge is idempotent. It
 * cannot lose an edit, which the cheaper version can.
 *
 * WHY A FLAG RATHER THAN "IF THE OUTBOX IS EMPTY"
 *
 * An outbox that is empty because everything has been sent is the normal state.
 * Seeding on that would re-upload the database on every launch for ever.
 *
 * Exported because changing folders needs exactly this and nothing else: a new
 * folder has heard none of it. See outboxReseed.
 */
export function outboxSeed(): Migration[] {
  const out: Migration[] = [];
  for (const t of SYNC_TABLES) {
    out.push({
      sql: `INSERT INTO sync_outbox (tbl, uid, updated_at)
            SELECT '${t.name}', uid, updated_at FROM ${t.name}
             WHERE uid IS NOT NULL AND updated_at IS NOT NULL
               AND (SELECT seeded FROM sync_outbox_state WHERE id = 1) = 0
          ON CONFLICT (tbl, uid) DO UPDATE SET updated_at = excluded.updated_at`,
    });
  }
  out.push({ sql: `UPDATE sync_outbox_state SET seeded = 1 WHERE id = 1` });
  return out;
}

/**
 * The same thing again, for a folder that has heard none of it.
 *
 * Lowering the flag first is what makes the shared list run a second time. The
 * alternative was a second copy of the same seven statements without the guard,
 * which is the shape of every bug this project has spent a month removing.
 */
export function outboxReseed(): Migration[] {
  return [{ sql: `UPDATE sync_outbox_state SET seeded = 0 WHERE id = 1` }, ...outboxSeed()];
}

export function syncMigrations(): Migration[] {
  const out: Migration[] = [];

  // The clock has to exist before anything can read it, so it goes first.
  out.push({
    sql: `CREATE TABLE IF NOT EXISTS sync_clock (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            t  TEXT NOT NULL
          )`,
  });
  out.push({
    sql: `INSERT OR IGNORE INTO sync_clock (id, t) VALUES (1, '1970-01-01T00:00:00.000Z')`,
  });
  // Seeded forward on every launch. Starting at the epoch would otherwise mean
  // the first few writes after a fresh install carry 1970 timestamps.
  out.push({ sql: SQL_BUMP });

  // ── the outbox ───────────────────────────────────────────────────────────
  //
  // What this device has not sent yet, as a fact rather than as a comparison.
  //
  // It used to be a comparison: every row whose updated_at is above a
  // watermark. That reads as a question about this device answered with a
  // number, and the number is one that other devices also write into. Rows
  // arriving from a phone carry the phone's clock; the watermark is set to the
  // newest timestamp the run looked at, phone rows included. A phone an hour
  // ahead therefore pushes this device's watermark an hour into the future,
  // and every local edit made in that hour is stamped by this device's own
  // clock, lands below the watermark, and is never sent. No error, no retry,
  // and the two databases quietly stop agreeing.
  //
  // A row in a table cannot be contaminated by anyone else's clock. Nothing
  // reads this table yet — the engine still uses the watermark — and that is
  // deliberate: the table and its triggers land in the same round on both
  // devices, and the switch is one change on its own afterwards.
  out.push({
    sql: `CREATE TABLE IF NOT EXISTS sync_outbox (
            tbl        TEXT NOT NULL,
            uid        TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (tbl, uid)
          )`,
  });
  // Whether the one-time seed below has already run. A separate table rather
  // than a column on sync_clock, because the clock is read inside triggers on
  // every write and this is read once per launch.
  out.push({
    sql: `CREATE TABLE IF NOT EXISTS sync_outbox_state (
            id     INTEGER PRIMARY KEY CHECK (id = 1),
            seeded INTEGER NOT NULL DEFAULT 0
          )`,
  });
  out.push({ sql: `INSERT OR IGNORE INTO sync_outbox_state (id, seeded) VALUES (1, 0)` });

  // ── the spill ────────────────────────────────────────────────────────────
  //
  // Columns that arrived on a row this database has no column for, kept beside
  // the row so that sending it back does not strip them. See rows.ts:spillRead.
  //
  // Not a column on each table, because the whole point is that this schema has
  // nowhere to put them — a column would only move the problem one level up.
  out.push({
    sql: `CREATE TABLE IF NOT EXISTS sync_spill (
            tbl  TEXT NOT NULL,
            uid  TEXT NOT NULL,
            cols TEXT NOT NULL,
            PRIMARY KEY (tbl, uid)
          )`,
  });


  for (const t of SYNC_TABLES) {
    out.push({ sql: `ALTER TABLE ${t.name} ADD COLUMN uid TEXT`, ignoreErrors: true });
    out.push({ sql: `ALTER TABLE ${t.name} ADD COLUMN updated_at TEXT`, ignoreErrors: true });
    if (t.needsDeleted) {
      out.push({
        sql: `ALTER TABLE ${t.name} ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0`,
        ignoreErrors: true,
      });
    }

    // Backfill rows that existed before this migration. randomblob() is
    // evaluated per row, so every row gets its own UUID from one statement.
    //
    // created_at was written as "YYYY-MM-DD HH:MM:SS" while every new timestamp
    // is ISO with a T and a Z. Mixing the two in one column would make string
    // comparison, which is all "changed since X" has, quietly wrong. So old
    // values are reformatted rather than copied.
    const source = t.hasCreatedAt ? "COALESCE(updated_at, created_at)" : "updated_at";
    const seed = `COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', ${source}), ${SQL_CLOCK})`;
    out.push({
      sql: `UPDATE ${t.name}
          SET uid = COALESCE(uid, ${SQL_UUID4}),
              updated_at = ${seed}
        WHERE uid IS NULL OR updated_at IS NULL`,
    });

    // uid is the identity a server keys on, so it must be unique. NULLs are
    // allowed to repeat in SQLite, which is fine: the insert trigger fills them.
    out.push({
      sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_${t.name}_uid ON ${t.name}(uid)`,
    });
    // "everything changed since my last sync" is the one query sync runs most.
    out.push({
      sql: `CREATE INDEX IF NOT EXISTS idx_${t.name}_updated ON ${t.name}(updated_at)`,
    });

    // Both triggers are dropped before they are created. They are created with
    // IF NOT EXISTS, which means an install that already has the old body would
    // silently keep it: the migration would report success and change nothing.
    out.push({ sql: `DROP TRIGGER IF EXISTS ${t.name}_sync_insert` });
    out.push({ sql: `DROP TRIGGER IF EXISTS ${t.name}_sync_update` });

    // New rows: stamp identity and time, whatever code did the insert.
    out.push({
      sql: `
      CREATE TRIGGER IF NOT EXISTS ${t.name}_sync_insert
      AFTER INSERT ON ${t.name}
      FOR EACH ROW WHEN NEW.uid IS NULL OR NEW.updated_at IS NULL
      BEGIN
        ${SQL_BUMP};
        UPDATE ${t.name}
           SET uid = COALESCE(NEW.uid, ${SQL_UUID4}),
               updated_at = COALESCE(NEW.updated_at, ${SQL_CLOCK})
         WHERE id = NEW.id;
      END;
    `,
    });

    // Any write bumps the clock. The WHEN guard means a statement that sets
    // updated_at itself is left alone, which is how an incoming sync keeps the
    // sender's timestamp, and it also stops the trigger firing on itself.
    out.push({
      sql: `
      CREATE TRIGGER IF NOT EXISTS ${t.name}_sync_update
      AFTER UPDATE ON ${t.name}
      FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at
      BEGIN
        ${SQL_BUMP};
        UPDATE ${t.name} SET updated_at = ${SQL_CLOCK} WHERE id = NEW.id;
      END;
    `,
    });

    // The outbox triggers, and why they have no WHEN guard.
    //
    // The two above skip a write that sets updated_at itself, which is how an
    // incoming sync keeps the sender's timestamp. These must not skip it,
    // because softDelete also sets updated_at itself and a delete that is
    // never queued is a row that comes back from the dead on the other device.
    // So everything written to a synced table is queued, including rows that
    // arrived from elsewhere, and apply() removes those again by name and
    // version. One rule with one exception undone in the one place that knows
    // it is an exception, rather than a guard that has to be right about four
    // different callers.
    out.push({ sql: `DROP TRIGGER IF EXISTS ${t.name}_outbox_insert` });
    out.push({ sql: `DROP TRIGGER IF EXISTS ${t.name}_outbox_update` });
    out.push({ sql: `DROP TRIGGER IF EXISTS ${t.name}_outbox_delete` });

    out.push({
      sql: `
      CREATE TRIGGER IF NOT EXISTS ${t.name}_outbox_insert
      AFTER INSERT ON ${t.name}
      FOR EACH ROW
      BEGIN
        ${outboxEnqueue(t.name)};
      END;
    `,
    });
    out.push({
      sql: `
      CREATE TRIGGER IF NOT EXISTS ${t.name}_outbox_update
      AFTER UPDATE ON ${t.name}
      FOR EACH ROW
      BEGIN
        ${outboxEnqueue(t.name)};
      END;
    `,
    });
    // A real DELETE only happens to a tombstone old enough to sweep, so what
    // it leaves behind is an entry naming a row that no longer exists. The
    // pending query joins the table and would simply not see it, which means
    // it would sit there for the life of the install without ever being wrong
    // enough to notice.
    out.push({
      sql: `
      CREATE TRIGGER IF NOT EXISTS ${t.name}_outbox_delete
      AFTER DELETE ON ${t.name}
      FOR EACH ROW
      BEGIN
        DELETE FROM sync_outbox WHERE tbl = '${t.name}' AND uid = OLD.uid;
      END;
    `,
    });
  }

  out.push(...outboxSeed());

  return out;
}

export async function applySyncMigrations(db: Database): Promise<void> {
  for (const m of syncMigrations()) {
    try {
      await db.execute(m.sql);
    } catch (e) {
      if (!m.ignoreErrors) throw e;
    }
  }
}