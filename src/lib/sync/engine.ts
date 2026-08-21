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
// ─── HOW A DEVICE KNOWS WHAT IT HAS NOT SENT ───────────────────────────
//
// From a table, not from a clock. `pending()` reads `sync_outbox`, which a
// trigger fills on every write. The version that asked `updated_at > watermark`
// is gone: rows pulled from a phone carry the phone's clock, the watermark rose
// to meet them, and every local edit made in the meantime sorted below it and
// was never sent — no error, no retry, two databases quietly disagreeing.
//
// ─── WHY THE LOG DOES NOT GROW FOR EVER, AND WHY AGE IS THE WRONG AXIS ────
//
// The folder is append-only, so without something else it grows until the
// account fills. The obvious rule is "delete what is older than a month", and
// it loses rows.
//
// A device that has been in a drawer for six weeks holds a cursor pointing into
// the deleted range. It does not error — `filesToFetch` asks for "greater than",
// so it simply reads what is left and moves on, having silently skipped every
// change announced in the files that are gone. Those rows are still in the other
// device's database, but the outbox only holds what has changed since the last
// sync, so nothing will ever send them again. The two devices disagree for ever
// and neither has anything to report.
//
// Age is a proxy for the question that actually matters, which is "could anyone
// still need this file". A snapshot answers that question exactly.
//
// Every so often a device sends its whole database instead of just its queue.
// On the wire that is an ordinary batch — no flag, no version bump, nothing for
// a reader to understand — it is simply large. The device writing it is the only
// one that needs to know, and it remembers two numbers: the sequence of its most
// recent snapshot, and the one before that.
//
// The rule is then one line: a device may delete its own files below its PRIOR
// snapshot. Whatever a reader's cursor says, one of two things is true. Either
// the cursor is at or above that snapshot, in which case nothing it still needed
// was touched; or it is below, in which case it will read that snapshot — a
// complete copy of the writer's database — and every file after it. Complete
// either way, with no coordination, no published cursors, and no detection.
//
// Prior rather than newest is one snapshot of slack, kept on purpose: if the
// newest one turns out to be truncated or unreadable, the one before it plus
// the deltas still reconstructs the same database.
//
// The trigger for writing one is the number of files this device has in the
// folder, not their age. File count is the thing being bounded, so it is the
// thing to measure; a device that writes four files a year is not a problem
// that needs solving, and a device that writes four hundred in a week is one
// that a calendar would not have caught in time.
//
// Reaching the threshold makes the next push a snapshot whether or not there
// was anything to say, because refilling the queue is what gives it something
// to say. That is what lets a folder that has stopped being written to still
// finish cleaning itself up rather than sitting at its high-water mark for ever.
//
// A device that is retired without being told is the one case this does not
// cover: nobody deletes its files, because only it ever could. That is a folder
// that stops growing rather than one that shrinks, and it is the right cost for
// never having to decide on one device that a file belonging to another is
// safe to remove.

import { open, seal } from "./crypto";
import { merge, mergeAll } from "./merge";
import {
  advance,
  fileName,
  filesToFetch,
  parseFileName,
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
  /** Seq of the newest full snapshot this device wrote. 0 means none yet. */
  snapshotSeq: number;
  /**
   * Seq of the snapshot before that. The deletion line: this device's own files
   * below it cannot be the only copy of anything, for any reader, ever.
   */
  priorSnapshotSeq: number;
}

export function emptyState(device: DeviceId): SyncState {
  return { device, seq: 0, cursor: {}, snapshotSeq: 0, priorSnapshotSeq: 0 };
}

/**
 * How many of this device's own files may sit in the folder before the next
 * push is sent as a snapshot instead of a queue.
 *
 * Not a round number of days. See the header: the folder is bounded by file
 * count, so file count is what the rule measures.
 */
export const SNAPSHOT_AFTER_FILES = 64;

/**
 * How many files one run may delete.
 *
 * A first cleanup after this landed could otherwise be hundreds of round trips
 * in the middle of a sync the person is watching. Nothing is lost by going
 * slowly: what is left over is still below the line next time, so the next run
 * takes the next batch. It also bounds the damage when deletes are refused — a
 * folder with the wrong permissions costs 32 failed calls per sync, not one per
 * file for ever.
 */
export const PRUNE_PER_RUN = 32;

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
  /** Rows not sent yet, oldest first. `origin` may be this device. */
  pending(): Promise<ChangeRecord[]>;
  /** These versions are dealt with and must not come back as pending. */
  settle(records: ChangeRecord[]): Promise<void>;
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
  /**
   * Queue every row there is, so the next push is the whole database.
   *
   * Deliberately not a separate `all()` that returns records. A second way to
   * enumerate rows is a second place for the spill columns, the tombstones and
   * the ordering to be got subtly differently from `pending()`, and a snapshot
   * that disagrees with a delta about what a row looks like is the one thing
   * this whole file exists to prevent. Refilling the queue means a snapshot
   * travels down the same path every other batch does.
   */
  reseed(): Promise<void>;
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
 *
 * `full` turns off the echo filter, and only a snapshot passes it. The filter
 * drops rows the remote log was seen to already hold, which is exactly right
 * for a delta and exactly wrong for a snapshot: the whole promise of a snapshot
 * is that it alone reconstructs this database, and a row left out because some
 * other device also mentioned it is a row that vanishes the moment that other
 * device prunes its own log.
 */
export function planPush(
  pending: ChangeRecord[],
  remoteView: Map<string, ChangeRecord>,
  state: SyncState,
  writtenAt: string,
  full = false,
): ChangeBatch | null {
  const changes = full ? pending : pending.filter((r) => !sameVersion(remoteView.get(rowKey(r)), r));
  if (changes.length === 0) return null;
  return {
    version: 1,
    device: state.device,
    seq: state.seq + 1,
    writtenAt,
    changes: changes.map((r) => ({ ...r, origin: state.device })),
  };
}

// ─── planning: when to send everything, and what to delete ───────────────────

/** This device's own files in the folder, as the listing reports them. */
function ownFiles(names: string[], device: DeviceId): RemoteFile[] {
  const out: RemoteFile[] = [];
  for (const n of names) {
    const f = parseFileName(n);
    if (f && f.device === device) out.push(f);
  }
  return out;
}

/**
 * Should this push carry the whole database rather than the queue.
 *
 * One line, and deliberately without a special case for a device that has never
 * written a snapshot. Forcing one on the first sync was tried and it costs the
 * property that a device which only ever pulled writes nothing at all: it would
 * pull the other device's rows and immediately send every one of them back.
 *
 * The anchor arrives on its own. A device with no snapshot has nothing it is
 * allowed to delete either, and it cannot need to: nothing can be deleted until
 * there are files, and the count is what notices there are files.
 */
export function wantsSnapshot(names: string[], state: SyncState): boolean {
  return ownFiles(names, state.device).length >= SNAPSHOT_AFTER_FILES;
}

/**
 * Files this device may delete, oldest first.
 *
 * Own files only, and only below the prior snapshot. Both halves are load
 * bearing and neither is a judgement call: a device cannot know another
 * device's cursor, and it cannot know whether anyone has read past a file that
 * is not covered by a snapshot of its own.
 *
 * Returns names rather than doing anything, so the rule is a line in a vector
 * file that Kotlin has to reproduce rather than a branch inside a function that
 * talks to Drive.
 */
export function planPrune(names: string[], state: SyncState, limit = PRUNE_PER_RUN): string[] {
  if (state.priorSnapshotSeq <= 0) return [];
  return ownFiles(names, state.device)
    .filter((f) => f.seq < state.priorSnapshotSeq)
    .sort((a, b) => a.seq - b.seq)
    .slice(0, limit)
    .map((f) => f.name);
}

/**
 * The two numbers after a snapshot has landed. Pure so the shift is a vector.
 *
 * Called only once the bytes are on the far side. Moving the line before the
 * upload succeeded would authorise deleting the files the new snapshot is
 * supposed to be replacing, on a run where the replacement does not exist.
 */
export function afterSnapshot(state: SyncState, seq: number): SyncState {
  return { ...state, priorSnapshotSeq: state.snapshotSeq, snapshotSeq: seq };
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
  /** Whether what was written was the whole database rather than the queue. */
  snapshot: boolean;
  /** Own files removed from the folder this run. */
  pruned: number;
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
  const snapshot = wantsSnapshot(names, pulledState);
  // Before pending(), so the queue this run reads is the refilled one. Safe to
  // repeat: a run that dies after this and before the upload leaves a full
  // queue, and a full queue is only ever an upload that says more than it had
  // to.
  if (snapshot) await store.reseed();

  const pending = await store.pending();
  const batch = planPush(pending, remoteView, pulledState, deps.now(), snapshot);

  if (!batch) {
    // Nothing to send, and the queue still empties: every pending row was
    // looked at and found to be already known remotely. Skipping a row because
    // the far side has it is a decision, not a postponement, and leaving it
    // queued means making the same decision again on every run for as long as
    // the row exists.
    await store.settle(pending);
    const pruned = await prune(storage, pulledState);
    return {
      read: batches.length,
      applied: toApply.length,
      pushed: 0,
      skipped,
      wrote: null,
      snapshot: false,
      pruned,
    };
  }

  // Reserve the number before the bytes exist. See the header.
  const reserved: SyncState = { ...pulledState, seq: batch.seq };
  await store.saveState(reserved);

  const name = fileName(batch.device, batch.seq);
  const blob = await seal(key, bucketId, batch.device, batch.seq, encodeBatch(batch));
  await storage.put(name, blob);

  // After the bytes are on the far side, never before. Stopping here costs a
  // repeat of one batch, which merge absorbs; stopping the other way round
  // costs the rows themselves.
  await store.settle(pending);

  const settled = snapshot ? afterSnapshot(reserved, batch.seq) : reserved;
  if (snapshot) await store.saveState(settled);

  // Last, and only ever against a line that has been written down. `names` is
  // the listing from the top of this run, which is the conservative one: the
  // file just uploaded is not in it, and it is above the line in any case.
  const pruned = await prune(storage, settled);

  return {
    read: batches.length,
    applied: toApply.length,
    pushed: batch.changes.length,
    skipped,
    wrote: name,
    snapshot,
    pruned,
  };
}

/**
 * Delete what the plan says, and never mind if it will not go.
 *
 * A refused delete is not reported anywhere, which is the one place in this
 * file where silence is right. Nothing is lost by it: the file is still below
 * the line, so the next run tries again, and until then it is a file that costs
 * storage and confuses nobody. There is also nothing a person could do about
 * it, and a sync screen that reports a problem with no action attached is how a
 * screen teaches somebody to stop reading it.
 *
 * Re-listing rather than reusing the listing from the top of the run, because
 * between then and now this device uploaded a file and may have taken minutes
 * doing it, and the other device may have been busy in the same folder.
 */
async function prune(storage: SyncStorage, state: SyncState): Promise<number> {
  if (state.priorSnapshotSeq <= 0) return 0;
  let names: string[];
  try {
    names = await storage.list();
  } catch {
    return 0;
  }
  let n = 0;
  for (const name of planPrune(names, state)) {
    try {
      await storage.delete(name);
      n++;
    } catch {
      // Next run. See above.
    }
  }
  return n;
}