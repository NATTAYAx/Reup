// ─── sync/protocol.ts — the shape of what travels between devices ────────────
//
// Nothing in this file does any I/O and nothing in it knows what a task is.
// It describes an envelope. That is deliberate: the moment this file knows
// about tasks, the sync engine has to be re-tested every time a column is
// added, and the whole point of the vector suite is that it does not.
//
// ─── WHY A LOG OF BATCHES AND NOT A DATABASE ────────────────────────────────
//
// The storage backend is the user's, not ours, and the honest assumption about
// somebody else's storage is that it can do four things: list, get, put,
// delete. It cannot run a query, it cannot compare-and-swap, and it cannot be
// trusted to tell the truth about time.
//
// So devices never edit anything. Each one appends files named
//
//     <deviceId>-<seq>.reup
//
// and nothing ever writes to a name that already exists. No two devices can
// collide, because a device only ever writes under its own id. That removes
// the entire category of problems that normally makes WebDAV and Drive behave
// differently — locking, ETags, lost updates — which is why one adapter
// interface can cover both without either being a special case.
//
// ─── WHY THE CURSOR IS A MAP AND NOT A TIMESTAMP ────────────────────────────
//
// "Everything since 3pm" requires trusting a clock. Two phones and a laptop do
// not agree on what time it is, and a phone that has been off for a week can be
// minutes out on the first boot. A sync that silently drops rows when a clock
// is wrong is the worst kind of bug: no error, no crash, just data that is
// missing on one device and present on another.
//
// So the cursor is "the highest sequence number I have seen FROM EACH DEVICE".
// Counting is something a device can do about itself without reference to
// anybody. Nothing here needs a correct clock to be correct.
//
// Clocks are still used to decide WHO WINS a conflict, which is a much weaker
// requirement: being wrong there loses one edit, not a row.

/** A row's identity across devices. UUID v4, minted where the row was born. */
export type Uid = string;

/** Stable per-installation id. Random at first launch, never reused. */
export type DeviceId = string;

/**
 * One row as one device last saw it.
 *
 * `fields` is the row minus `id` (local, meaningless elsewhere) and minus the
 * sync columns, which are lifted out because the merge reads them.
 */
export interface ChangeRecord {
  table: string;
  uid: Uid;
  /** ISO-8601 UTC with milliseconds. Ordering is string comparison. */
  updatedAt: string;
  deleted: boolean;
  /** Which device wrote this version. Also the conflict tiebreaker. */
  origin: DeviceId;
  fields: Record<string, unknown>;
}

/** What one file in the log contains, before encryption. */
export interface ChangeBatch {
  /** Bumped when the envelope shape changes. Readers reject what they cannot read. */
  version: 1;
  device: DeviceId;
  seq: number;
  /** For debugging only. Never used for ordering or merging. */
  writtenAt: string;
  changes: ChangeRecord[];
}

/** Highest seq seen from each device. Missing device means "none yet". */
export type Cursor = Record<DeviceId, number>;

/** A file in the log, as the storage adapter reports it. */
export interface RemoteFile {
  name: string;
  device: DeviceId;
  seq: number;
}

const NAME_RE = /^([A-Za-z0-9_-]{1,64})-(\d{1,12})\.reup$/;

export function fileName(device: DeviceId, seq: number): string {
  return `${device}-${seq}.reup`;
}

/** Null rather than throwing: a stranger's file in the folder is not an error. */
export function parseFileName(name: string): RemoteFile | null {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  return { name, device: m[1], seq: Number(m[2]) };
}

/** Which files this device has not read yet. Sorted so replay is deterministic. */
export function filesToFetch(all: string[], cursor: Cursor): RemoteFile[] {
  return all
    .map(parseFileName)
    .filter((f): f is RemoteFile => f !== null)
    .filter((f) => f.seq > (cursor[f.device] ?? 0))
    .sort((a, b) => (a.device === b.device ? a.seq - b.seq : a.device < b.device ? -1 : 1));
}

/**
 * Advancing the cursor is separate from fetching on purpose.
 *
 * A batch that was downloaded but failed to apply must not move the cursor, or
 * it is skipped forever and the row it carried is missing on this device only.
 * Callers advance after the write succeeds, never before.
 */
export function advance(cursor: Cursor, device: DeviceId, seq: number): Cursor {
  const at = cursor[device] ?? 0;
  return seq > at ? { ...cursor, [device]: seq } : cursor;
}