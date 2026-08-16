// ─── sync/sqlLocalStore.ts — the engine's LocalStore, backed by SQLite ───────
//
// The engine decides what survives; this decides nothing. Everything here is
// either a query, a translation between a row and a record, or the one place
// that stores what this device remembers about syncing.
//
// ─── WHY IT TAKES A `Db` AND NOT THE TAURI DATABASE ─────────────────────────
//
// Two methods, execute and select, which is all of the Tauri plugin's surface
// that this needs. Narrowing it means the whole store can be run against
// node:sqlite in a check script and against a real database in the app, with
// the same code. That is the difference between "the types line up" and "two
// databases with the real schema and the real triggers ended up holding the
// same rows".
//
// ─── WHY THERE IS NO TRANSACTION AROUND apply() ─────────────────────────────
//
// Not an oversight, and not laziness. tauri-plugin-sql runs on a connection
// pool, so BEGIN and the statements that follow it are not guaranteed to land
// on the same connection — which would give the shape of a transaction and none
// of the protection, and the failure would only show up under load.
//
// It is not needed. Every write here is an upsert keyed on uid that sets
// updated_at to the sender's value, so running it twice leaves the database
// exactly where running it once did. A crash halfway through means the cursor
// was never saved, the next sync fetches the same batches, and the rows that
// did land are written again to no effect. The engine's ordering already
// depends on that being true; this file just does not undo it.
//
// ─── WHERE THE SYNC STATE LIVES ─────────────────────────────────────────────
//
// One row in app_settings. app_settings is deliberately not a synced table, and
// this is the clearest example of why: the cursor is a statement about what THIS
// device has seen. Syncing it would tell the phone it had already read files it
// has never opened, and those rows would be missing on one device with nothing
// anywhere to say so.

import { emptyState, rowKey, type LocalStore, type RowKey, type SyncState } from "./engine";
import type { ChangeRecord } from "./protocol";
import {
  byUids,
  changedSince,
  chunk,
  deletionsFirst,
  unknownFieldNames,
  freeNaturalKeys,
  incomingLosesClash,
  naturalKeyClash,
  recordFromRow,
  upsert,
  type Row,
  type TableShape,
} from "./rows";

/** The slice of the Tauri SQL plugin this file uses, and nothing more. */
export interface Db {
  execute(sql: string, params?: unknown[]): Promise<unknown>;
  select<T>(sql: string, params?: unknown[]): Promise<T>;
}

/**
 * The clock, read from SQLite rather than from JavaScript.
 *
 * Every other timestamp in `updated_at` is written by a trigger using exactly
 * this expression. If the store used `new Date()` instead, one column would be
 * holding readings from two different clocks — and on Windows the system timer
 * ticks about every sixteen milliseconds, so the two can disagree about which
 * of two events came first.
 *
 * That is not a rounding error anyone would notice by eye. It reorders the push
 * batch, which is sorted by this column, and a tombstone that sorts after the
 * row created to replace it turns into a duplicate that never existed.
 *
 * syncMeta already reformats created_at for the same reason: a column that is
 * only ever compared as a string has to come from one source.
 */
export const SQL_BUMP = "UPDATE sync_clock SET t = max(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', t, '+0.001 seconds')) WHERE id = 1";

export const SQL_CLOCK_READ = "SELECT t FROM sync_clock WHERE id = 1";

/**
 * Bump, then read. Never read alone.
 *
 * Reading without bumping would hand out the same value twice whenever two
 * writes fall inside one tick of the system timer, which on Windows is about
 * sixteen milliseconds — long enough for a whole delete-and-recreate.
 */
export async function dbNow(db: Db): Promise<string> {
  await db.execute(SQL_BUMP);
  const r = await db.select<{ t: string }[]>(SQL_CLOCK_READ);
  return r[0].t;
}

/**
 * Exported because two other files need to name this row and neither should do
 * it by retyping the string: the backup has to leave it behind, and the settings
 * screen has to know it is not the person's data.
 */
export const SYNC_STATE_KEY = "sync_state_v1";

/**
 * The tables that sync, named here rather than discovered.
 *
 * Discovering them would mean "every table with a uid column", which is true
 * today and is one migration away from quietly enrolling a table nobody meant
 * to send. Which tables leave the machine is a policy, and policies are written
 * down.
 */
export const SYNCED_TABLES = [
  "tasks",
  "income",
  "expenses",
  "budgets",
  "saving_goals",
  "expense_categories",
  "expected_income",
] as const;

// ─── reading the shape out of the database ───────────────────────────────────

interface PragmaColumn {
  name: string;
  type?: string;
}
interface PragmaIndex {
  name: string;
  unique: number;
  origin: string;
}

/**
 * Ask SQLite what it actually built.
 *
 * `origin` distinguishes an index that came from a UNIQUE clause in the CREATE
 * TABLE from one created afterwards by hand. The uid index is ours and must not
 * be treated as a natural key, or every row would look like a duplicate of
 * itself.
 */
export async function readShape(db: Db, name: string): Promise<TableShape> {
  const cols = await db.select<PragmaColumn[]>(`PRAGMA table_info(${name})`);
  const columns = cols.map((c) => c.name);
  const types: Record<string, string> = {};
  for (const c of cols) types[c.name] = c.type ?? "";

  const indexes = await db.select<PragmaIndex[]>(`PRAGMA index_list(${name})`);
  const naturalKeys: string[][] = [];
  for (const idx of indexes) {
    if (idx.unique !== 1) continue;
    const info = await db.select<PragmaColumn[]>(`PRAGMA index_info(${idx.name})`);
    const key = info.map((c) => c.name);
    if (key.length === 1 && key[0] === "uid") continue;
    if (key.some((c) => c === null)) continue; // an index on an expression
    naturalKeys.push(key);
  }

  return { name, columns, types, hasDeleted: columns.includes("deleted"), naturalKeys };
}

export async function readShapes(db: Db): Promise<Map<string, TableShape>> {
  const out = new Map<string, TableShape>();
  for (const t of SYNCED_TABLES) out.set(t, await readShape(db, t));
  return out;
}

// ─── the store ───────────────────────────────────────────────────────────────

export class SqlLocalStore implements LocalStore {
  private constructor(
    private readonly db: Db,
    private readonly shapes: Map<string, TableShape>,
    private state: SyncState,
    private readonly now: () => Promise<string>,
  ) {}

  /**
   * Reads the shapes once, and mints a device id on first use.
   *
   * The id is random and means nothing to anybody. It is not the machine name,
   * because the machine name is the user's name often enough that it would put
   * a person's name in a filename in a folder shared with other people, for no
   * benefit at all — nothing ever displays it.
   */
  /**
   * Columns other devices sent that this database cannot hold, as `table.column`.
   *
   * Grows during apply and is never cleared: it is the answer to "is the other
   * device newer than this one", which stays true until this one is updated.
   */
  readonly unknownFields = new Set<string>();

  static async open(
    db: Db,
    now: () => Promise<string> = () => dbNow(db),
  ): Promise<SqlLocalStore> {
    const shapes = await readShapes(db);
    const rows = await db.select<{ value: string }[]>(
      "SELECT value FROM app_settings WHERE key = ?",
      [SYNC_STATE_KEY],
    );

    let state: SyncState;
    if (rows.length > 0) {
      state = parseState(rows[0].value);
    } else {
      state = emptyState(newDeviceId());
      await writeState(db, state);
    }
    return new SqlLocalStore(db, shapes, state, now);
  }

  get device(): string {
    return this.state.device;
  }

  private shape(table: string): TableShape {
    const s = this.shapes.get(table);
    if (!s) throw new Error(`${table} is not a synced table`);
    return s;
  }

  async loadState(): Promise<SyncState> {
    return this.state;
  }

  async saveState(state: SyncState): Promise<void> {
    this.state = state;
    await writeState(this.db, state);
  }

  /**
   * Every synced table, oldest change first.
   *
   * Sorted across tables and not just within them, because the watermark is one
   * timestamp for the whole database. If the batch were ordered per table, the
   * newest row in it might belong to a table the engine had already passed, and
   * the watermark would jump over rows in the others.
   */
  async changedSince(since: string): Promise<ChangeRecord[]> {
    const out: ChangeRecord[] = [];
    for (const t of SYNCED_TABLES) {
      const shape = this.shape(t);
      const rows = await this.db.select<Row[]>(changedSince(shape).sql, [since]);
      for (const r of rows) out.push(recordFromRow(shape, r, this.state.device));
    }
    out.sort((a, b) =>
      a.updatedAt === b.updatedAt
        ? a.uid < b.uid
          ? -1
          : a.uid > b.uid
            ? 1
            : 0
        : a.updatedAt < b.updatedAt
          ? -1
          : 1,
    );
    return out;
  }

  async lookup(keys: RowKey[]): Promise<ChangeRecord[]> {
    const byTable = new Map<string, string[]>();
    for (const k of keys) {
      const list = byTable.get(k.table);
      if (list) list.push(k.uid);
      else byTable.set(k.table, [k.uid]);
    }

    const out: ChangeRecord[] = [];
    for (const [table, uids] of byTable) {
      if (!this.shapes.has(table)) continue; // a table this version does not have
      const shape = this.shape(table);
      for (const part of chunk(uids)) {
        const q = byUids(shape, part);
        const rows = await this.db.select<Row[]>(q.sql, q.params);
        for (const r of rows) out.push(recordFromRow(shape, r, this.state.device));
      }
    }
    return out;
  }

  async apply(records: ChangeRecord[]): Promise<void> {
    for (const r of deletionsFirst(records)) {
      if (!this.shapes.has(r.table)) continue; // a table this version does not have
      const shape = this.shape(r.table);

      // A field this schema has no column for is dropped by the write below,
      // because there is nowhere to put it. It is recorded here so that the
      // loss is something the app can say out loud rather than something that
      // happens quietly. See unknownFieldNames for what keeping them would cost.
      for (const name of unknownFieldNames(shape, r)) this.unknownFields.add(name);

      // A row arriving with a natural key another row already holds has to be
      // settled before the insert, because SQLite will otherwise refuse the
      // statement, apply throws, the cursor never advances, and sync stays
      // broken until somebody deletes a budget by hand to make their phone work.
      let incoming = r;
      if (shape.naturalKeys.length > 0 && !r.deleted) {
        const other = await this.findClash(shape, r);
        if (other) {
          if (incomingLosesClash(r, other)) {
            // Kept, but as a tombstone, so nothing is dropped on the floor and
            // the other device reaches the same conclusion from the same pair
            // of uids without either of them saying anything.
            incoming = { ...r, deleted: true, updatedAt: await this.now() };
          } else {
            await this.write(shape, {
              ...recordFromRow(shape, other, this.state.device),
              deleted: true,
              updatedAt: await this.now(),
            });
          }
        }
      }

      await this.write(shape, incoming);
    }
  }

  /** The live row, if any, holding one of this record's natural keys. */
  private async findClash(shape: TableShape, r: ChangeRecord): Promise<Row | null> {
    for (const key of shape.naturalKeys) {
      const where = key.map((c) => `${c} IS ?`).join(" AND ");
      const params = key.map((c) => r.fields[c] ?? null);
      const found = await this.db.select<Row[]>(
        `SELECT * FROM ${shape.name} WHERE ${where}` + (shape.hasDeleted ? " AND deleted = 0" : ""),
        params,
      );
      for (const other of found) if (naturalKeyClash(shape, r, other)) return other;
    }
    return null;
  }

  /**
   * Every write goes through here, so the rule that a tombstone stops holding
   * its natural key is applied in one place and cannot be forgotten by one of
   * the two callers.
   */
  private async write(shape: TableShape, r: ChangeRecord): Promise<void> {
    const s = upsert(shape, freeNaturalKeys(shape, r));
    await this.db.execute(s.sql, s.params);
  }

  /**
   * The delete path the app should call instead of DELETE, for any table that
   * syncs. Exported here rather than left to each caller because a hard delete
   * leaves nothing to send, and a row nobody can see deleted is a row the other
   * device pushes back.
   */
  async softDelete(table: string, uid: string): Promise<void> {
    const shape = this.shape(table);
    const found = await this.db.select<Row[]>(
      `SELECT * FROM ${shape.name} WHERE uid = ?`,
      [uid],
    );
    if (found.length === 0) return;
    await this.write(shape, {
      ...recordFromRow(shape, found[0], this.state.device),
      deleted: true,
      updatedAt: await this.now(),
    });
  }
}

// ─── state, as one string in one row ─────────────────────────────────────────

function newDeviceId(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return "d-" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function writeState(db: Db, state: SyncState): Promise<void> {
  await db.execute(
    "INSERT INTO app_settings (key, value) VALUES (?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [SYNC_STATE_KEY, JSON.stringify(state)],
  );
}

/**
 * A state that will not parse falls back to a fresh one rather than throwing.
 *
 * The worst that costs is one sync that reads everything and decides it has
 * nothing to say, because every planner in the engine is written to be safe to
 * repeat. Throwing would mean one bad settings row stops syncing permanently,
 * which is a far worse trade for the same cause.
 *
 * Losing the device id would be worse than losing the cursor, so it is minted
 * fresh here rather than reused — a new id means new filenames, which is
 * wasteful but cannot collide with the sequence the old id had already used.
 */
export function parseState(text: string): SyncState {
  try {
    const raw = JSON.parse(text) as Partial<SyncState>;
    if (typeof raw.device !== "string" || raw.device === "") throw new Error("no device");
    return {
      device: raw.device,
      seq: typeof raw.seq === "number" ? raw.seq : 0,
      cursor: typeof raw.cursor === "object" && raw.cursor !== null ? raw.cursor : {},
      pushedThrough: typeof raw.pushedThrough === "string" ? raw.pushedThrough : "",
    };
  } catch {
    return emptyState(newDeviceId());
  }
}

/** Exported for the check script, which needs to build keys the same way. */
export { rowKey };