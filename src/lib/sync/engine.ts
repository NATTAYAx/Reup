// ─── sync/engine.ts — the part that actually moves rows between devices ──────
//
// The four layers below this one each answer a question in isolation. Crypto
// answers "can anyone else read this", merge answers "which version wins",
// protocol answers "what is a batch called", storage answers "where do bytes
// go". None of them knows what a sync is. This file is where they meet, and it
// is the only file in the sync stack that can lose data.
//
// So almost all of it is written as pure functions with names starting `plan`,
// and the impure part at the bottom is a list of calls with no decisions in it.
// That split is not tidiness. A decision inside an async function that also
// does I/O can only be tested by standing up a server; the same decision as a
// function of its inputs is a line in a vector file that Kotlin has to
// reproduce. Everything above `sync()` is checkable in both languages without a
// network, a clock, or a disk.
//
// ─── THE ORDER OF OPERATIONS, WHICH IS THE WHOLE DESIGN ─────────────────────
//
//   list → fetch → decrypt → decode → fold → apply → SAVE CURSOR
//                                                  → collect → seal → put
//                                                  → SAVE SEQ AND WATERMARK
//
// Two rules hold that shape together, and both exist because of a specific way
// to lose a row silently.
//
//   The cursor moves only after the write succeeded. A batch that downloaded
//   and then failed to apply must not be marked as seen, or it is skipped
//   forever and the rows it carried are missing on this device only, with
//   nothing on screen and nothing in any log.
//
//   The cursor moves only through an unbroken prefix. If file 3 fails and file
//   4 succeeds, recording 4 buries 3 permanently, because the next run asks for
//   everything above 4. So each device's cursor stops at its first failure and
//   the rest is retried next time. Out-of-order success is the normal case when
//   one file is mid-upload, not an exotic one.
//
// ─── WHY THE SEQUENCE NUMBER IS RESERVED BEFORE THE FILE IS WRITTEN ─────────
//
// The append-only guarantee is that no name is ever written twice. If the seq
// were saved after a successful upload, a crash between the upload and the save
// would leave the next run writing the same name with different contents — and
// on a backend that overwrites silently, which is all of them, the other device
// would have already read the first version. Two devices then disagree forever
// about what file 7 said.
//
// Reserving first can only skip a number, and a gap costs nothing: the cursor
// asks for "greater than", never for "the next one".
//
// ─── WHAT AN ECHO IS AND WHY IT IS NOT SOLVED BY BEING CLEVER ───────────────
//
// A row pulled from the phone is written locally with the phone's timestamp,
// which is newer than this device's watermark. Next time the desktop looks for
// "what have I changed", it finds that row and sends it straight back. Nothing
// breaks — merge is idempotent — but the log doubles on every sync, forever.
//
// The fix here is that a row is not worth pushing if the remote log already
// holds that exact version. The engine has just folded every batch it read, so
// it knows those versions without asking anyone. Rows it never saw are pushed
// as normal.
//
// The comparison ignores `origin` deliberately. A row that arrived from the
// phone and was written locally comes back out of the database claiming this
// device as its origin, because the local tables do not store where a row came
// from. If origin were compared, every pulled row would look different and the
// echo would be back. Two records with the same table, uid, timestamp, deletion
// flag and fields are the same version whoever claims to have written it; the
// only thing origin decides is a tiebreak that would land in the same place.
//
// ─── THE WATERMARK, AND THE ONE CASE IT LOSES ───────────────────────────────
//
// "What have I changed" is answered by `updated_at > watermark`, which is a
// query any SQLite can run without a schema change, which matters because the
// phone has no database yet and the desktop should not carry a migration for a
// feature that is not wired up.
//
// It has one hole and it should be written down rather than discovered later.
// The watermark advances to the newest timestamp the run looked at. A row
// edited after the snapshot was taken but stamped with that same millisecond is
// never seen again. It needs a write during the couple of seconds a sync takes,
// landing in the same millisecond as the newest row in the batch, on a row that
// was itself in the batch.
//
// The real fix is an outbox table filled by a trigger, so "pending" is a fact
// rather than an inference from a clock. That is a schema change and belongs
// with the phone's database rather than here. Until then this is the trade, and
// it is a known one.

import { open, seal } from "./crypto";
import { merge, mergeAll } from "./merge";
import {
  advance,
  fileName,
  filesToFetch,
  type ChangeBatch,
  type ChangeRecord,
  type Cursor,
  type DeviceId,
  type RemoteFile,
} from "./protocol";
import type { SyncStorage } from "./storage";

// ─── state ───────────────────────────────────────────────────────────────────

/**
 * Everything this device remembers about syncing, and nothing else.
 *
 * Small on purpose: it is written after every step, and a step that fails
 * halfway must leave something a later run can start from.
 */
export interface SyncState {
  /** Stable per installation. Minted once, never reused, never shared. */
  device: DeviceId;
  /** Highest sequence number this device has reserved. Zero means none yet. */
  seq: number;
  /** Highest sequence seen from every other device. */
  cursor: Cursor;
  /** Local rows with `updated_at` above this have not been dealt with yet. */
  pushedThrough: string;
}

export function emptyState(device: DeviceId): SyncState {
  return { device, seq: 0, cursor: {}, pushedThrough: "" };
}

/**
 * The database, as the engine is willing to know it.
 *
 * Six methods, none of which mention a column name. The store turns rows into
 * records and back; the engine decides which records survive. Keeping the line
 * there is what lets the phone and the desktop share the decisions while having
 * nothing in common below it — SQLDelight on one side, tauri-plugin-sql on the
 * other, and this file unaware of either.
 */
export interface LocalStore {
  /** Rows changed after `since`, oldest first. `origin` may be this device. */
  changedSince(since: string): Promise<ChangeRecord[]>;
  /** The local version of each named row, where one exists. Order is free. */
  lookup(keys: RowKey[]): Promise<ChangeRecord[]>;
  /**
   * Write these rows, keeping `updatedAt` exactly as given, in one transaction.
   *
   * Exactly as given is not a detail. If the store lets its own trigger stamp
   * the row with the local clock, the row instantly looks newer than the copy
   * every other device holds, and the next sync pushes it back out as an edit
   * that nobody made.
   */
  apply(records: ChangeRecord[]): Promise<void>;
  loadState(): Promise<SyncState>;
  saveState(state: SyncState): Promise<void>;
}

export interface RowKey {
  table: string;
  uid: string;
}

export function rowKey(r: RowKey): string {
  return `${r.table}\u0000${r.uid}`;
}

function index(records: Iterable<ChangeRecord>): Map<string, ChangeRecord> {
  const m = new Map<string, ChangeRecord>();
  for (const r of records) m.set(rowKey(r), r);
  return m;
}

// ─── comparing versions ──────────────────────────────────────────────────────

/**
 * Equality on one field value, typed rather than printed.
 *
 * The tempting version is `String(a) === String(b)`, which reads as forgiving
 * and is a trap: JavaScript prints 1200 and Kotlin prints 1200.0, so the two
 * implementations would disagree about whether a row had changed — the exact
 * disagreement the ordering in merge.ts already avoids for the same reason.
 *
 * Numbers are compared as numbers rather than by object identity so that the
 * two zeros of floating point do not count as a change nobody made.
 */
function valueEqual(a: unknown, b: unknown): boolean {
  const x = a ?? null;
  const y = b ?? null;
  if (x === null || y === null) return x === y;
  if (typeof x !== typeof y) return false;
  if (typeof x === "number") return x === (y as number);
  return x === y;
}

function fieldsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (!valueEqual(a[k], b[k])) return false;
  }
  return true;
}

/**
 * Same version of the same row, ignoring which device claims to have written it.
 *
 * See the header for why origin is left out. Everything else is compared,
 * including the deletion flag, because a tombstone and a live row with the same
 * timestamp are emphatically not the same thing.
 */
export function sameVersion(a: ChangeRecord | undefined, b: ChangeRecord | undefined): boolean {
  if (!a || !b) return false;
  return (
    a.table === b.table &&
    a.uid === b.uid &&
    a.updatedAt === b.updatedAt &&
    a.deleted === b.deleted &&
    fieldsEqual(a.fields, b.fields)
  );
}

// ─── planning: what to read ──────────────────────────────────────────────────

/**
 * Files worth downloading.
 *
 * Our own are excluded rather than filtered by the cursor. A device's own
 * batches are already in its database, so reading them back is bandwidth spent
 * to learn nothing — and after a restore from backup it would be worse than
 * nothing, because the file would carry a version of a row the restored
 * database has already moved past.
 */
export function planPull(names: string[], state: SyncState): RemoteFile[] {
  return filesToFetch(names, state.cursor).filter((f) => f.device !== state.device);
}

/**
 * Advance the cursor through the unbroken run of successes, per device.
 *
 * `attempted` must be in the order the files were tried, which `planPull`
 * already guarantees. A device that failed anywhere keeps everything from that
 * point on for the next run.
 */
export function advanceThroughPrefix(
  cursor: Cursor,
  attempted: RemoteFile[],
  failed: ReadonlySet<string>,
): Cursor {
  let next = cursor;
  const stopped = new Set<DeviceId>();
  for (const f of attempted) {
    if (stopped.has(f.device)) continue;
    if (failed.has(f.name)) {
      stopped.add(f.device);
      continue;
    }
    next = advance(next, f.device, f.seq);
  }
  return next;
}

// ─── planning: what to write locally ─────────────────────────────────────────

/**
 * What the incoming rows should turn into on this device.
 *
 * The merged record is written, not the remote one. The difference shows up on
 * the field group that tracks completion: the phone can hold a newer name while
 * this device holds a further-along completion, and only the merge has both.
 * Writing the remote record instead would undo a task that was ticked here,
 * which is the single failure this whole design exists to prevent.
 *
 * Rows already equal to what the merge produces are dropped here rather than in
 * the store. A no-op UPDATE still fires the trigger, still bumps the timestamp,
 * and so still produces a row that looks freshly edited to every other device.
 */
export function planApply(
  remote: Map<string, ChangeRecord>,
  local: Map<string, ChangeRecord>,
): ChangeRecord[] {
  const out: ChangeRecord[] = [];
  for (const [key, r] of remote) {
    const mine = local.get(key);
    if (!mine) {
      out.push(r);
      continue;
    }
    const winner = merge(mine, r);
    if (!sameVersion(winner, mine)) out.push(winner);
  }
  return out;
}

// ─── planning: what to send ──────────────────────────────────────────────────

/**
 * The batch to upload, or null when there is nothing to say.
 *
 * Null rather than an empty batch. An empty batch is a file that every other
 * device downloads and decrypts to learn nothing, and since a sync may run on a
 * timer, that is a steady drip of files forever.
 */
export function planPush(
  pending: ChangeRecord[],
  remoteView: Map<string, ChangeRecord>,
  state: SyncState,
  writtenAt: string,
): ChangeBatch | null {
  const changes = pending.filter((r) => !sameVersion(remoteView.get(rowKey(r)), r));
  if (changes.length === 0) return null;
  return {
    version: 1,
    device: state.device,
    seq: state.seq + 1,
    writtenAt,
    changes: changes.map((r) => ({ ...r, origin: state.device })),
  };
}

/**
 * The newest timestamp this run looked at.
 *
 * Rows that were deliberately not pushed count. Skipping a row because the
 * remote already has it is a decision, not a postponement, and leaving the
 * watermark behind it means making the same decision again on every run for as
 * long as the row exists.
 */
export function nextWatermark(current: string, considered: Iterable<ChangeRecord>): string {
  let out = current;
  for (const r of considered) if (r.updatedAt > out) out = r.updatedAt;
  return out;
}

// ─── the envelope on disk ────────────────────────────────────────────────────

export class BatchError extends Error {
  constructor(
    message: string,
    readonly kind: "format" | "version" | "mismatch",
  ) {
    super(message);
    this.name = "BatchError";
  }
}

export function encodeBatch(batch: ChangeBatch): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(batch));
}

function isValue(v: unknown): boolean {
  return v === null || typeof v === "boolean" || typeof v === "number" || typeof v === "string";
}

/**
 * Parse and check, rather than parse and hope.
 *
 * The bytes are already authenticated, so this is not defending against a
 * forgery — it is defending against a future version of this app writing a
 * shape today's version would half-understand. Half-understanding a batch is
 * the bad case: an unknown field silently dropped is a column that quietly
 * reverts on the older device every time the newer one syncs.
 *
 * The device and seq inside the file are checked against the name it was found
 * under for a different reason. They are already bound by the AEAD tag, so a
 * renamed file cannot decrypt at all; this catches the case where someone
 * re-encrypts and rewrites, and it costs two comparisons.
 */
export function decodeBatch(bytes: Uint8Array, file: RemoteFile): ChangeBatch {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new BatchError("batch is not JSON", "format");
  }
  if (typeof raw !== "object" || raw === null) throw new BatchError("batch is not an object", "format");
  const b = raw as Record<string, unknown>;

  if (b.version !== 1) {
    throw new BatchError(`batch version ${String(b.version)} is newer than this app understands`, "version");
  }
  if (b.device !== file.device || b.seq !== file.seq) {
    throw new BatchError(`batch says ${String(b.device)}-${String(b.seq)} but is filed as ${file.name}`, "mismatch");
  }
  if (typeof b.writtenAt !== "string") throw new BatchError("writtenAt is missing", "format");
  if (!Array.isArray(b.changes)) throw new BatchError("changes is not an array", "format");

  const changes: ChangeRecord[] = [];
  for (const c of b.changes as unknown[]) {
    if (typeof c !== "object" || c === null) throw new BatchError("change is not an object", "format");
    const r = c as Record<string, unknown>;
    if (typeof r.table !== "string" || r.table === "") throw new BatchError("change has no table", "format");
    if (typeof r.uid !== "string" || r.uid === "") throw new BatchError("change has no uid", "format");
    if (typeof r.updatedAt !== "string") throw new BatchError("change has no updatedAt", "format");
    if (typeof r.deleted !== "boolean") throw new BatchError("change has no deleted flag", "format");
    if (typeof r.origin !== "string") throw new BatchError("change has no origin", "format");
    if (typeof r.fields !== "object" || r.fields === null || Array.isArray(r.fields)) {
      throw new BatchError("change has no fields", "format");
    }
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r.fields as Record<string, unknown>)) {
      if (!isValue(v)) throw new BatchError(`field ${k} is not a value a column can hold`, "format");
      fields[k] = v;
    }
    changes.push({
      table: r.table,
      uid: r.uid,
      updatedAt: r.updatedAt,
      deleted: r.deleted,
      origin: r.origin,
      fields,
    });
  }

  return { version: 1, device: b.device as string, seq: b.seq as number, writtenAt: b.writtenAt, changes };
}

// ─── the driver ──────────────────────────────────────────────────────────────

export interface SyncDeps {
  storage: SyncStorage;
  store: LocalStore;
  bucketId: string;
  key: Uint8Array;
  /** Injected so a test is not at the mercy of the clock. Debug only downstream. */
  now(): string;
}

export interface SkippedFile {
  name: string;
  reason: string;
}

export interface SyncReport {
  read: number;
  applied: number;
  pushed: number;
  /** Files that could not be used. Never fatal; always reported. */
  skipped: SkippedFile[];
  wrote: string | null;
}

/**
 * One round trip. Safe to call again immediately; safe to interrupt anywhere.
 *
 * Interruption is the normal case rather than the exception — this runs on a
 * phone, which is a device that can be put in a pocket mid-request. Every
 * persisted step is therefore ordered so that stopping before it costs a repeat
 * and never a row.
 */
export async function sync(deps: SyncDeps): Promise<SyncReport> {
  const { storage, store, bucketId, key } = deps;
  const state = await store.loadState();
  const skipped: SkippedFile[] = [];

  // ── pull ──────────────────────────────────────────────────────────────────
  const names = await storage.list();
  const wanted = planPull(names, state);

  const batches: ChangeBatch[] = [];
  const failed = new Set<string>();
  for (const f of wanted) {
    try {
      const blob = await storage.get(f.name);
      const plain = await open(key, bucketId, f.device, f.seq, blob);
      batches.push(decodeBatch(plain, f));
    } catch (e) {
      // One unreadable file does not stop the rest. It could be a half-finished
      // upload, a file from a bucket whose key was rotated, or something a
      // future version wrote. All three are worth reporting and none is worth
      // refusing to sync over.
      failed.add(f.name);
      skipped.push({ name: f.name, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  const remoteView = mergeAll(batches.flatMap((b) => b.changes));
  const localForRemote = index(await store.lookup([...remoteView.values()]));
  const toApply = planApply(remoteView, localForRemote);

  if (toApply.length > 0) await store.apply(toApply);

  // Only now. Everything above can be repeated; nothing above is remembered.
  const pulledState: SyncState = {
    ...state,
    cursor: advanceThroughPrefix(state.cursor, wanted, failed),
  };
  await store.saveState(pulledState);

  // ── push ──────────────────────────────────────────────────────────────────
  const pending = await store.changedSince(pulledState.pushedThrough);
  const batch = planPush(pending, remoteView, pulledState, deps.now());

  if (!batch) {
    // Nothing to send, but the watermark still moves: every pending row was
    // looked at and found to be already known remotely.
    const settled: SyncState = {
      ...pulledState,
      pushedThrough: nextWatermark(pulledState.pushedThrough, pending),
    };
    await store.saveState(settled);
    return { read: batches.length, applied: toApply.length, pushed: 0, skipped, wrote: null };
  }

  // Reserve the number before the bytes exist. See the header.
  const reserved: SyncState = { ...pulledState, seq: batch.seq };
  await store.saveState(reserved);

  const name = fileName(batch.device, batch.seq);
  const blob = await seal(key, bucketId, batch.device, batch.seq, encodeBatch(batch));
  await storage.put(name, blob);

  const settled: SyncState = {
    ...reserved,
    pushedThrough: nextWatermark(reserved.pushedThrough, pending),
  };
  await store.saveState(settled);

  return {
    read: batches.length,
    applied: toApply.length,
    pushed: batch.changes.length,
    skipped,
    wrote: name,
  };
}