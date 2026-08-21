// ─── sync/rows.ts — the only file that knows a row is not a record ───────────
//
// The engine deals in ChangeRecords: a table name, a uid, a timestamp, a
// deletion flag and a bag of fields. The database deals in rows, which have a
// local integer id, columns in a fixed order, and a schema that is not the same
// on every device. Something has to sit between them, and this is it.
//
// Everything here is pure and takes the table's shape as an argument, which
// matters for one reason: the shape is read from the database at run time with
// PRAGMA rather than written down here. A hardcoded column list is a second
// copy of the schema, and a second copy of the schema is the thing this project
// has spent weeks removing — two parsers, two translation systems, two category
// detectors. The schema already exists in schema.sql; asking SQLite what it
// actually built is free and cannot drift.
//
// It also buys the version-skew case for nothing. A phone running last month's
// schema simply has fewer columns, so a record carrying a column it has never
// heard of loses that column instead of throwing "no such column" and wedging
// sync forever.
//
// That loss is real and is written down at the bottom of this file rather than
// left to be discovered.

import type { ChangeRecord } from "./protocol";

/**
 * Columns that belong to sync rather than to the user.
 *
 * `id` is the local autoincrement primary key and is the important one. It is
 * different on every device for the same row, so sending it would mean two
 * devices arguing about a number that has no meaning outside the machine that
 * generated it.
 */
const NOT_PAYLOAD = new Set(["id", "uid", "updated_at", "deleted"]);

export interface TableShape {
  name: string;
  /** Every column this database actually has, in declaration order. */
  columns: string[];
  /** Declared type per column, as SQLite reports it. Used only by freeNaturalKeys. */
  types: Record<string, string>;
  /** False on an older database that has not run the tombstone migration. */
  hasDeleted: boolean;
  /**
   * Unique constraints other than uid, as column lists.
   *
   * budgets has UNIQUE(category, month) and expense_categories has UNIQUE(key).
   * Those are the reason this field exists — see naturalKeyClash below.
   */
  naturalKeys: string[][];
}

export function payloadColumns(shape: TableShape): string[] {
  return shape.columns.filter((c) => !NOT_PAYLOAD.has(c));
}

// ─── row to record ───────────────────────────────────────────────────────────

export type Row = Record<string, unknown>;

/**
 * SQLite has no boolean, so a flag is an integer, and a driver may hand it back
 * as a number, a string, or already as a boolean depending on the binding.
 * Anything that is not clearly on is treated as off, because guessing "deleted"
 * wrong in the other direction removes a row nobody removed.
 */
function truthy(v: unknown): boolean {
  return v === 1 || v === true || v === "1";
}

export function recordFromRow(shape: TableShape, row: Row, origin: string): ChangeRecord {
  const fields: Record<string, unknown> = {};
  for (const c of payloadColumns(shape)) fields[c] = row[c] ?? null;
  return {
    table: shape.name,
    uid: String(row.uid ?? ""),
    updatedAt: String(row.updated_at ?? ""),
    deleted: shape.hasDeleted && truthy(row.deleted),
    origin,
    fields,
  };
}

/**
 * Fields the record carries that this database has no column for.
 *
 * This happens when the other device is running a newer version of the app. The
 * write drops them, because there is nowhere to put them, and until now it did
 * so without a word — which is the worst way to lose data: the row arrives, it
 * looks right, and a column nobody can see is simply not there any more.
 *
 * Naming them is not the same as keeping them. Keeping them needs somewhere to
 * put a field this schema has no column for, and that is a table and a decision.
 * Until then the rule is that this is said out loud, every time.
 */
export function unknownFieldNames(shape: TableShape, r: ChangeRecord): string[] {
  const known = new Set(shape.columns);
  return Object.keys(r.fields)
    .filter((c) => !known.has(c))
    .sort()
    .map((c) => `${shape.name}.${c}`);
}

// ─── record to statement ─────────────────────────────────────────────────────

export interface Statement {
  sql: string;
  params: unknown[];
}

/**
 * Write a record, whether or not the row is already here.
 *
 * The conflict target is uid, which works because syncMeta creates a unique
 * index on it. The local `id` is never mentioned, so an existing row keeps the
 * one it has and a new row gets a fresh one from the sequence — which is the
 * whole point of not sending ids.
 *
 * Setting updated_at explicitly is what keeps the timestamp the sender's rather
 * than this machine's. The update trigger's guard is `WHEN NEW.updated_at IS
 * OLD.updated_at`, so a statement that changes it is left alone, and the insert
 * trigger's guard is `WHEN NEW.uid IS NULL`, which this never is. Both triggers
 * therefore sit out an incoming sync, which is exactly what they were written
 * for.
 *
 * Fields the local table does not have are dropped rather than refused. See the
 * note at the bottom of the file.
 */
export function upsert(shape: TableShape, r: ChangeRecord): Statement {
  const known = new Set(shape.columns);
  const cols = ["uid", "updated_at"];
  const params: unknown[] = [r.uid, r.updatedAt];

  if (shape.hasDeleted) {
    cols.push("deleted");
    params.push(r.deleted ? 1 : 0);
  }
  for (const c of payloadColumns(shape)) {
    if (!known.has(c)) continue;
    cols.push(c);
    params.push(r.fields[c] ?? null);
  }

  const holes = cols.map(() => "?").join(", ");
  const sets = cols
    .filter((c) => c !== "uid")
    .map((c) => `${c} = excluded.${c}`)
    .join(", ");

  return {
    sql:
      `INSERT INTO ${shape.name} (${cols.join(", ")}) VALUES (${holes}) ` +
      `ON CONFLICT(uid) DO UPDATE SET ${sets}`,
    params,
  };
}

/**
 * Everything this device has not sent yet, from one table.
 *
 * The join is the whole change. The old version of this asked which rows have a
 * timestamp above a watermark, which is a question about this device answered
 * with a number that other devices also write into: rows pulled from a phone
 * carry the phone's clock, the watermark is set to the newest timestamp the run
 * looked at, and a phone an hour ahead therefore pushes this device's watermark
 * an hour into the future. Every local edit made in that hour is stamped by
 * this device's own clock, lands below the watermark, and is never sent. No
 * error, no retry, and the two databases quietly stop agreeing.
 *
 * A row in a table cannot be contaminated by anyone else's clock.
 */
export function pending(shape: TableShape): Statement {
  return {
    sql:
      `SELECT r.* FROM ${shape.name} r ` +
      `JOIN sync_outbox o ON o.tbl = '${shape.name}' AND o.uid = r.uid ` +
      `ORDER BY r.updated_at ASC, r.uid ASC`,
    params: [],
  };
}

/**
 * One row is no longer pending — but only at the version that was dealt with.
 *
 * updated_at is in the WHERE for the reason the whole table exists. A row edited
 * while the upload was in flight has already had its outbox entry replaced by
 * the trigger, so this delete does not match it and it stays queued. Clearing by
 * name alone would drop that edit on the floor, silently, and only ever on a
 * slow connection.
 */
export function settle(table: string, uid: string, updatedAt: string): Statement {
  return {
    sql: `DELETE FROM sync_outbox WHERE tbl = ? AND uid = ? AND updated_at = ?`,
    params: [table, uid, updatedAt],
  };
}

/**
 * SQLite refuses a statement with more than 999 bound parameters by default, and
 * a first sync looks up thousands of rows at once. Splitting here rather than at
 * the call site means every caller is safe without having to remember.
 */
export function chunk<T>(items: T[], size = 400): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function byUids(shape: TableShape, uids: string[]): Statement {
  const holes = uids.map(() => "?").join(", ");
  return { sql: `SELECT * FROM ${shape.name} WHERE uid IN (${holes})`, params: [...uids] };
}

// ─── two devices inventing the same row ──────────────────────────────────────

/**
 * A budget for food in August, created on the desktop and again on the phone
 * before they had ever talked, is two rows with two uids and one natural key.
 * `UNIQUE(category, month)` then refuses the insert, apply throws, the cursor
 * never advances, and sync is stuck permanently rather than briefly.
 *
 * That is a hard stop rather than a silent loss, which is the better of the two,
 * but it is still a bug that ends with the user deleting a budget to make their
 * phone work.
 *
 * The rule is: the smaller uid keeps the natural key, the other becomes a
 * tombstone. Both devices can see both uids, so both reach the same answer
 * without talking about it — the same property the merge rules are built on.
 * Smaller rather than newer because timestamps can tie and uids cannot.
 */
/**
 * A key nobody is holding.
 *
 * SQLite does not constrain rows that carry a NULL in a unique index: two
 * expenses with no slip both satisfy `UNIQUE(slip_ref)` and always have. So a
 * record with a NULL anywhere in a key cannot collide with anything, and asking
 * whether it does is not a cheap extra check — it is a question with the wrong
 * answer built in.
 *
 * Getting this wrong cost a real row. `findClash` asked `slip_ref IS ?` with a
 * null bound, which is `IS NULL`, which matches every expense that has no slip
 * — so the store decided that every slip-less expense was the same expense,
 * kept the one whose uuid sorted first and filed the rest as tombstones. The
 * tombstones then synced, and the other device deleted its copies too. Nothing
 * errored anywhere; the rows were simply gone, and which ones survived was
 * decided by random uuids.
 *
 * The rule is the database's own rule, written where the store can see it.
 */
export function keyIsHeld(key: string[], fields: Record<string, unknown>): boolean {
  return key.every((c) => (fields[c] ?? null) !== null);
}

export function naturalKeyClash(
  shape: TableShape,
  incoming: ChangeRecord,
  existing: Row,
): boolean {
  const existingUid = String(existing.uid ?? "");
  if (existingUid === "" || existingUid === incoming.uid) return false;
  // Compared strictly rather than by printing both sides. A text column is a
  // string on both sides and an integer column is a number on both sides, so
  // there is nothing for a loose comparison to rescue — and printing is exactly
  // where the two languages disagree, because one writes 1200 and the other
  // writes 1200.0.
  return shape.naturalKeys.some(
    (key) =>
      // Both sides, not just the incoming one: a live row with a NULL in the
      // key is not occupying it either, so there is nothing to take from it.
      keyIsHeld(key, incoming.fields) &&
      keyIsHeld(key, existing) &&
      key.every((c) => (incoming.fields[c] ?? null) === (existing[c] ?? null)),
  );
}

export function incomingLosesClash(incoming: ChangeRecord, existing: Row): boolean {
  return incoming.uid > String(existing.uid ?? "");
}

/**
 * Deletions first, then everything else.
 *
 * A delete releases a natural key and a create consumes one, so doing creates
 * first can only fail. The case is not exotic: delete the food budget for
 * August, add it back with a different number, sync. Both rows travel in the
 * same batch, and if the new one is written before the tombstone, it collides
 * with the row the tombstone is about to remove — a row the other device still
 * thinks is live.
 *
 * What made that expensive to find is that it did not fail loudly. The clash
 * rule fired, decided the incoming row was a duplicate of a live row, and filed
 * the new budget as a tombstone. The winner was picked by comparing uids, so
 * whether the afternoon ended with the right budget or with no budget at all
 * depended on which random uuid happened to sort first.
 *
 * The order is stable within each group, so two devices given the same batch
 * still write the same rows in the same sequence.
 */
export function deletionsFirst(records: ChangeRecord[]): ChangeRecord[] {
  return [...records.filter((r) => r.deleted), ...records.filter((r) => !r.deleted)];
}

/**
 * A deleted row has to stop holding its natural key.
 *
 * `UNIQUE(category, month)` does not care whether a row is a tombstone, so a
 * deleted budget for food in August still blocks a new one — and the failure is
 * not a warning, it is an insert that throws and a sync that stops. Deleting a
 * budget and adding it back is an ordinary thing to do, so this would be hit
 * quickly.
 *
 * The replacement is derived from the uid, which matters more than it looks.
 * Both devices compute the same filler without talking, so the tombstone one of
 * them writes is byte-identical to the one the other would have written. If it
 * were a random value or a timestamp, the two copies would differ, each device
 * would think the other's row had changed, and they would push the same
 * tombstone back and forth forever.
 *
 * Only text columns are rewritten. Every natural key in this schema is text,
 * and a numeric one has no value that is both in range and certain to be
 * unique — if one ever appears, it needs an answer of its own rather than a
 * guess made here.
 */
export function freeNaturalKeys(shape: TableShape, r: ChangeRecord): ChangeRecord {
  if (!r.deleted || shape.naturalKeys.length === 0) return r;
  const fields = { ...r.fields };
  for (const key of shape.naturalKeys) {
    // A key with a NULL in it was never held, so there is nothing to release.
    // Stamping a value in would be worse than pointless: it would move the row
    // into the unique index that the live row was never in.
    if (!keyIsHeld(key, r.fields)) continue;
    for (const c of key) {
      const type = (shape.types[c] ?? "").toUpperCase();
      if (!type.includes("CHAR") && !type.includes("TEXT") && !type.includes("CLOB")) continue;
      fields[c] = `deleted:${r.uid}`;
    }
  }
  return { ...r, fields };
}

// ─── the columns this schema has never heard of ──────────────────────────────
//
// A field the local table has no column for used to be dropped, and the loss
// was named out loud but not prevented. That was defensible while only one
// device could originate a row: the older device never pushed, so it could
// never push a row with the column missing.
//
// This round removed that. The phone writes now, which means the older of two
// devices can take a row in, drop a column it does not understand, tick it
// done, and send the row back without it. The newer device then loses a value
// neither person ever touched, and nothing anywhere says so.
//
// So the fields are kept, in a table beside the row rather than in it, and put
// back when the row is read for sending. A device can now carry a column it
// cannot read, cannot display and will never edit.
//
// WHY IT IS OVERWRITTEN ON EVERY APPLY AND NOT MERGED
//
// The spill belongs to the version it arrived with. If the far side sends a
// newer row, its spill replaces this one wholesale, which is the same rule the
// row itself follows. Merging the two would mean inventing a row that existed
// on neither device.

export function spillRead(pairs: { table: string; uid: string }[]): Statement {
  const holes = pairs.map(() => "(?, ?)").join(", ");
  const params: unknown[] = [];
  for (const p of pairs) params.push(p.table, p.uid);
  return { sql: `SELECT tbl, uid, cols FROM sync_spill WHERE (tbl, uid) IN (${holes})`, params };
}

export function spillWrite(table: string, uid: string, cols: string): Statement {
  return {
    sql:
      `INSERT INTO sync_spill (tbl, uid, cols) VALUES (?, ?, ?) ` +
      `ON CONFLICT(tbl, uid) DO UPDATE SET cols = excluded.cols`,
    params: [table, uid, cols],
  };
}

/**
 * No spill for this row any more.
 *
 * Run when a row arrives carrying nothing this schema cannot read, and when it
 * arrives as a tombstone. A tombstone has no payload, so keeping a set of
 * columns beside it would mean re-attaching values to a deleted row on the way
 * out — which is how a deleted row grows a body again.
 */
export function spillDrop(table: string, uid: string): Statement {
  return { sql: `DELETE FROM sync_spill WHERE tbl = ? AND uid = ?`, params: [table, uid] };
}

/** The fields a record carries that this database has no column for. */
export function unknownFields(shape: TableShape, r: ChangeRecord): Record<string, unknown> {
  const known = new Set(shape.columns);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(r.fields).sort()) if (!known.has(k)) out[k] = r.fields[k];
  return out;
}