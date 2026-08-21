/**
 * Generates shared/engine-vectors.json and proves the engine converges. Run it:
 *
 *   pnpm gen:engine-vectors
 *
 * WHY THIS EXISTS
 *
 * Two jobs that are really one, same as gen-sync-vectors.ts.
 *
 *   1. Check that two devices reach the same rows, by simulation rather than by
 *      example, including when files arrive out of order and one is unreadable.
 *   2. Write down every decision the pure planners made, so the Kotlin port has
 *      to make the same ones.
 *
 * WHAT THE SIMULATION IS FOR AND WHAT IT IS NOT
 *
 * The scenarios below run the real engine against an in-memory storage and an
 * in-memory database. That is not a substitute for running it against Drive —
 * it cannot find a wrong header or a rate limit — and it is not trying to be.
 * It is there for the failures that have no symptom: a row that arrives on one
 * device and not the other, a task that comes back undone, a log that doubles
 * every time it runs. None of those throws, and all of them are invisible until
 * weeks later.
 *
 * The last line is the only one that matters. Anything other than `clean` means
 * two devices can end up holding different rows while both believe they are in
 * sync.
 *
 * WHY NODE IS REACHED THROUGH `declare` AND NOT AN IMPORT
 *
 * The project has no @types/node, and adding it for one script is a dependency
 * the app itself never uses. eval-parser.ts and gen-sync-vectors.ts already
 * solved this the same way.
 */

import { open } from "../src/lib/sync/crypto";
import {
  advanceThroughPrefix,
  decodeBatch,
  emptyState,
  planApply,
  planPrune,
  planPull,
  planPush,
  rowKey,
  SNAPSHOT_AFTER_FILES,
  sync,
  wantsSnapshot,
  type LocalStore,
  type SyncState,
} from "../src/lib/sync/engine";
import { mergeAll } from "../src/lib/sync/merge";
import { parseFileName, type ChangeRecord, type Cursor, type RemoteFile } from "../src/lib/sync/protocol";
import type { SyncStorage } from "../src/lib/sync/storage";

declare const require: (m: string) => {
  writeFileSync(p: string, d: string): void;
  mkdirSync(p: string, o: { recursive: boolean }): void;
  copyFileSync(from: string, to: string): void;
  existsSync(p: string): boolean;
  dirname(p: string): string;
  resolve(p: string): string;
};
declare const process: { argv: string[]; exit(code: number): void };

// ─── fakes ───────────────────────────────────────────────────────────────────

class MemoryStorage implements SyncStorage {
  readonly files = new Map<string, Uint8Array>();
  /** Names that fail on read, to stand in for a half-finished upload. */
  readonly unreadable = new Set<string>();

  async list(): Promise<string[]> {
    return [...this.files.keys()];
  }
  async get(name: string): Promise<Uint8Array> {
    if (this.unreadable.has(name)) throw new Error("truncated upload");
    const b = this.files.get(name);
    if (!b) throw new Error(`no such file: ${name}`);
    return b;
  }
  async put(name: string, bytes: Uint8Array): Promise<void> {
    if (this.files.has(name)) throw new Error(`append-only violated: ${name} already exists`);
    this.files.set(name, bytes);
  }
  async delete(name: string): Promise<void> {
    this.files.delete(name);
  }
}

/**
 * A database that behaves like SQLite with the sync triggers in place: a local
 * edit stamps the clock, an applied row keeps the timestamp it arrived with.
 */
class MemoryStore implements LocalStore {
  readonly rows = new Map<string, ChangeRecord>();
  private state: SyncState;

  constructor(device: string) {
    this.state = emptyState(device);
  }

  /** Standing in for sync_outbox: what has been written and not yet settled. */
  private queued = new Set<string>();

  /** A local edit, as the app would make it. The trigger queues it. */
  write(r: Omit<ChangeRecord, "origin">): void {
    this.rows.set(rowKey(r), { ...r, origin: this.state.device });
    this.queued.add(rowKey(r) + "@" + r.updatedAt);
  }

  /**
   * Everything written here that has not been settled.
   *
   * A Set standing in for sync_outbox, which is the point: the real store's
   * answer comes from a table rather than from a comparison with a timestamp,
   * and a fake that still filtered by `since` would generate vectors for an
   * engine that no longer exists.
   */
  async pending(): Promise<ChangeRecord[]> {
    return [...this.rows.values()]
      .filter((r) => this.queued.has(rowKey(r) + "@" + r.updatedAt))
      .sort((a, b) => (a.updatedAt === b.updatedAt ? (a.uid < b.uid ? -1 : 1) : a.updatedAt < b.updatedAt ? -1 : 1));
  }

  async settle(records: ChangeRecord[]): Promise<void> {
    for (const r of records) this.queued.delete(rowKey(r) + "@" + r.updatedAt);
  }
  /**
   * Every row back in the queue, which is what `outboxReseed()` does to the
   * real one. Tombstones included: a device that has been away needs to be told
   * about a deletion as much as about a row.
   */
  async reseed(): Promise<void> {
    for (const r of this.rows.values()) this.queued.add(rowKey(r) + "@" + r.updatedAt);
  }
  async lookup(keys: { table: string; uid: string }[]): Promise<ChangeRecord[]> {
    const out: ChangeRecord[] = [];
    for (const k of keys) {
      const r = this.rows.get(rowKey(k));
      if (r) out.push(r);
    }
    return out;
  }
  async apply(records: ChangeRecord[]): Promise<void> {
    // Queued like anything else written to the table, because that is what the
    // triggers do and a fake that quietly knew better would generate vectors
    // for a store nobody has. The push half is what sorts them out: rows the
    // far side already holds are dropped there and settled, and rows that came
    // out of a merge carrying this device's version are sent, which is the case
    // that made unqueueing here look right and be wrong.
    for (const r of records) {
      this.rows.set(rowKey(r), r);
      this.queued.add(rowKey(r) + "@" + r.updatedAt);
    }
  }
  async loadState(): Promise<SyncState> {
    return this.state;
  }
  async saveState(s: SyncState): Promise<void> {
    this.state = s;
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

const KEY = new Uint8Array(32).fill(7);
const BUCKET = "bucket-for-the-suite";

function rec(
  uid: string,
  updatedAt: string,
  fields: Record<string, unknown>,
  extra: Partial<ChangeRecord> = {},
): ChangeRecord {
  return {
    table: "tasks",
    uid,
    updatedAt,
    deleted: false,
    origin: "dev-aaa",
    fields,
    ...extra,
  };
}

function task(name: string, completedUntil: string | null = null, missed = 0): Record<string, unknown> {
  return {
    name,
    category: "game",
    reset_type: "daily",
    reset_time: "04:00",
    is_active: 1,
    completed_until: completedUntil,
    cycle_checked_until: completedUntil,
    missed_streak: missed,
  };
}

let failures = 0;
function check(what: string, ok: boolean): void {
  if (!ok) {
    failures++;
    console.log(`  FAIL  ${what}`);
  }
}

function rowsMatch(a: MemoryStore, b: MemoryStore): boolean {
  if (a.rows.size !== b.rows.size) return false;
  for (const [k, ra] of a.rows) {
    const rb = b.rows.get(k);
    if (!rb) return false;
    if (ra.updatedAt !== rb.updatedAt || ra.deleted !== rb.deleted) return false;
    if (JSON.stringify(ra.fields) !== JSON.stringify(rb.fields)) return false;
  }
  return true;
}

// ─── the vector file ─────────────────────────────────────────────────────────

interface Vectors {
  version: number;
  generatedBy: string;
  planPull: unknown[];
  advance: unknown[];
  planApply: unknown[];
  planPush: unknown[];
  wantsSnapshot: unknown[];
  planPrune: unknown[];
  decode: unknown[];
}

const V: Vectors = {
  version: 1,
  generatedBy: "gen-engine-vectors.ts",
  planPull: [],
  advance: [],
  planApply: [],
  planPush: [],
  wantsSnapshot: [],
  planPrune: [],
  decode: [],
};

function casePull(id: string, names: string[], cursor: Cursor, device: string): void {
  const state = { ...emptyState(device), cursor };
  V.planPull.push({ id, names, cursor, device, expected: planPull(names, state).map((f) => f.name) });
}

function caseAdvance(id: string, cursor: Cursor, attempted: string[], failed: string[]): void {
  const files = attempted.map((n) => parseFileName(n)).filter((f): f is RemoteFile => f !== null);
  V.advance.push({
    id,
    cursor,
    attempted,
    failed,
    expected: advanceThroughPrefix(cursor, files, new Set(failed)),
  });
}

function caseApply(id: string, remote: ChangeRecord[], local: ChangeRecord[]): void {
  const r = mergeAll(remote);
  const l = new Map(local.map((x) => [rowKey(x), x]));
  V.planApply.push({ id, remote, local, expected: planApply(r, l) });
}

function casePush(
  id: string,
  pending: ChangeRecord[],
  remoteView: ChangeRecord[],
  device: string,
  seq: number,
  full = false,
): void {
  const state = { ...emptyState(device), seq };
  const view = new Map(remoteView.map((x) => [rowKey(x), x]));
  V.planPush.push({
    id,
    pending,
    remoteView,
    device,
    seq,
    full,
    writtenAt: "2026-08-15T12:00:00.000Z",
    expected: planPush(pending, view, state, "2026-08-15T12:00:00.000Z", full),
  });
}

function caseSnapshot(id: string, names: string[], device: string, snapshotSeq: number): void {
  const state = { ...emptyState(device), snapshotSeq };
  V.wantsSnapshot.push({ id, names, device, snapshotSeq, expected: wantsSnapshot(names, state) });
}

function casePrune(id: string, names: string[], device: string, priorSnapshotSeq: number, limit: number): void {
  const state = { ...emptyState(device), priorSnapshotSeq };
  V.planPrune.push({
    id,
    names,
    device,
    priorSnapshotSeq,
    limit,
    expected: planPrune(names, state, limit),
  });
}

function caseDecode(id: string, text: string, file: RemoteFile): void {
  let outcome: { ok: boolean; kind?: string } = { ok: true };
  try {
    decodeBatch(new TextEncoder().encode(text), file);
  } catch (e) {
    outcome = { ok: false, kind: (e as { kind?: string }).kind ?? "format" };
  }
  V.decode.push({ id, text, file, expected: outcome });
}

// ─── cases ───────────────────────────────────────────────────────────────────

function buildVectors(): void {
  const all = ["dev-aaa-1.reup", "dev-aaa-2.reup", "dev-bbb-1.reup", "notes.txt", "dev-bbb-3.reup"];

  casePull("pull-fresh", all, {}, "dev-ccc");
  casePull("pull-own-files-are-skipped", all, {}, "dev-aaa");
  casePull("pull-partly-seen", all, { "dev-aaa": 1 }, "dev-ccc");
  casePull("pull-nothing-new", all, { "dev-aaa": 9, "dev-bbb": 9 }, "dev-ccc");
  casePull("pull-ignores-strangers", ["notes.txt", "readme", "dev-aaa-.reup"], {}, "dev-ccc");

  caseAdvance("adv-all-good", {}, ["dev-aaa-1.reup", "dev-aaa-2.reup", "dev-bbb-1.reup"], []);
  caseAdvance("adv-stops-at-gap", {}, ["dev-aaa-1.reup", "dev-aaa-2.reup", "dev-aaa-3.reup"], ["dev-aaa-2.reup"]);
  caseAdvance(
    "adv-one-device-failing-does-not-block-another",
    {},
    ["dev-aaa-1.reup", "dev-bbb-1.reup", "dev-bbb-2.reup"],
    ["dev-aaa-1.reup"],
  );
  caseAdvance("adv-never-goes-backwards", { "dev-aaa": 5 }, ["dev-aaa-2.reup"], []);

  const mine = rec("u1", "2026-08-14T09:00:00.000Z", task("mine"));
  const theirsNewer = rec("u1", "2026-08-14T10:00:00.000Z", task("theirs"), { origin: "dev-bbb" });
  const theirsOlder = rec("u1", "2026-08-14T08:00:00.000Z", task("older"), { origin: "dev-bbb" });
  const theirsDone = rec("u1", "2026-08-14T08:00:00.000Z", task("older", "2026-08-15T04:00:00.000Z"), {
    origin: "dev-bbb",
  });

  caseApply("apply-new-row", [theirsNewer], []);
  caseApply("apply-newer-wins", [theirsNewer], [mine]);
  caseApply("apply-older-loses-and-writes-nothing", [theirsOlder], [mine]);
  caseApply("apply-identical-writes-nothing", [{ ...mine, origin: "dev-bbb" }], [mine]);
  caseApply("apply-completion-survives-an-older-base", [theirsDone], [mine]);
  caseApply("apply-tombstone", [{ ...theirsNewer, deleted: true }], [mine]);

  casePush("push-fresh", [mine], [], "dev-aaa", 0);
  casePush("push-skips-what-remote-already-has", [mine], [{ ...mine, origin: "dev-bbb" }], "dev-aaa", 4);
  casePush("push-sends-a-newer-local-edit", [theirsNewer], [mine], "dev-aaa", 4);
  casePush("push-nothing-to-say", [], [], "dev-aaa", 4);
  casePush("push-stamps-our-origin", [{ ...mine, origin: "dev-zzz" }], [], "dev-aaa", 0);
  // The one case the echo filter must not touch. A snapshot that leaves out a
  // row because some other device also mentioned it is a snapshot that stops
  // being a complete copy the moment that device prunes its own log.
  casePush("push-full-keeps-what-remote-already-has", [mine], [{ ...mine, origin: "dev-bbb" }], "dev-aaa", 4, true);
  casePush("push-full-of-nothing-is-still-nothing", [], [], "dev-aaa", 4, true);

  const many = (device: string, from: number, to: number): string[] => {
    const out: string[] = [];
    for (let i = from; i <= to; i++) out.push(`${device}-${i}.reup`);
    return out;
  };

  caseSnapshot("snap-an-empty-folder-needs-nothing", [], "dev-aaa", 0);
  caseSnapshot("snap-a-device-that-never-snapshotted-still-waits", many("dev-aaa", 1, 3), "dev-aaa", 0);
  caseSnapshot("snap-not-yet", many("dev-aaa", 1, 10), "dev-aaa", 5);
  caseSnapshot("snap-one-below-the-line", many("dev-aaa", 1, 63), "dev-aaa", 5);
  caseSnapshot("snap-exactly-at-the-line", many("dev-aaa", 1, 64), "dev-aaa", 5);
  // A folder full of somebody else's files is somebody else's problem: they are
  // the only device that can delete them, so counting them here would make this
  // device snapshot for ever over a mess it cannot clean up.
  caseSnapshot("snap-other-devices-do-not-count", [...many("dev-bbb", 1, 90), "dev-aaa-1.reup"], "dev-aaa", 5);
  caseSnapshot("snap-strangers-do-not-count", ["notes.txt", "a.reup", "dev-aaa-.reup", "dev-aaa-1.reup"], "dev-aaa", 5);

  casePrune("prune-nothing-before-a-second-snapshot", many("dev-aaa", 1, 20), "dev-aaa", 0, 32);
  casePrune("prune-below-the-line-only", many("dev-aaa", 1, 20), "dev-aaa", 10, 32);
  // The prior snapshot itself is the floor, not the first casualty. It is the
  // file that makes every other deletion safe.
  casePrune("prune-keeps-the-prior-snapshot-itself", many("dev-aaa", 8, 12), "dev-aaa", 10, 32);
  casePrune("prune-never-touches-another-device", [...many("dev-bbb", 1, 9), ...many("dev-aaa", 1, 9)], "dev-aaa", 5, 32);
  casePrune("prune-ignores-strangers", ["holiday.jpg", "dev-aaa-2.reup", "readme"], "dev-aaa", 9, 32);
  casePrune("prune-takes-the-oldest-first-and-stops", many("dev-aaa", 1, 40), "dev-aaa", 40, 32);
  casePrune("prune-with-nothing-to-do", many("dev-aaa", 5, 9), "dev-aaa", 5, 32);

  const file: RemoteFile = { name: "dev-bbb-3.reup", device: "dev-bbb", seq: 3 };
  const good = {
    version: 1,
    device: "dev-bbb",
    seq: 3,
    writtenAt: "2026-08-15T12:00:00.000Z",
    changes: [mine],
  };
  caseDecode("decode-good", JSON.stringify(good), file);
  caseDecode("decode-empty-batch-is-legal", JSON.stringify({ ...good, changes: [] }), file);
  caseDecode("decode-future-version", JSON.stringify({ ...good, version: 2 }), file);
  caseDecode("decode-wrong-device", JSON.stringify({ ...good, device: "dev-ccc" }), file);
  caseDecode("decode-wrong-seq", JSON.stringify({ ...good, seq: 4 }), file);
  caseDecode("decode-not-json", "{ this is not json", file);
  caseDecode("decode-missing-uid", JSON.stringify({ ...good, changes: [{ ...mine, uid: "" }] }), file);
  caseDecode(
    "decode-nested-field-is-not-a-column",
    JSON.stringify({ ...good, changes: [{ ...mine, fields: { name: { a: 1 } } }] }),
    file,
  );
  caseDecode(
    "decode-deleted-must-be-a-boolean",
    JSON.stringify({ ...good, changes: [{ ...mine, deleted: 1 }] }),
    file,
  );
}

// ─── the simulation ──────────────────────────────────────────────────────────

let tick = 0;
function clock(): string {
  tick++;
  // Rolls into minutes rather than printing a sixty-first second. Nothing reads
  // this — `writtenAt` is debug only — but a scenario that runs a hundred syncs
  // should not leave impossible timestamps in a file somebody will one day open.
  const mm = String(Math.floor(tick / 60)).padStart(2, "0");
  const ss = String(tick % 60).padStart(2, "0");
  return `2026-08-15T12:${mm}:${ss}.000Z`;
}

async function runSync(cloud: MemoryStorage, store: MemoryStore) {
  return sync({ storage: cloud, store, bucketId: BUCKET, key: KEY, now: clock });
}

async function simulate(): Promise<void> {
  // ── two devices, edits on both, converging ────────────────────────────────
  {
    const cloud = new MemoryStorage();
    const pc = new MemoryStore("dev-aaa");
    const phone = new MemoryStore("dev-bbb");

    pc.write({ table: "tasks", uid: "u1", updatedAt: "2026-08-14T09:00:00.000Z", deleted: false, fields: task("dailies") });
    phone.write({ table: "tasks", uid: "u2", updatedAt: "2026-08-14T09:05:00.000Z", deleted: false, fields: task("meds") });

    await runSync(cloud, pc);
    await runSync(cloud, phone);
    await runSync(cloud, pc);

    check("two devices end up with the same rows", rowsMatch(pc, phone));
    check("both devices have both tasks", pc.rows.size === 2 && phone.rows.size === 2);
  }

  // ── the echo ──────────────────────────────────────────────────────────────
  {
    const cloud = new MemoryStorage();
    const pc = new MemoryStore("dev-aaa");
    const phone = new MemoryStore("dev-bbb");

    pc.write({ table: "tasks", uid: "u1", updatedAt: "2026-08-14T09:00:00.000Z", deleted: false, fields: task("dailies") });
    await runSync(cloud, pc);
    await runSync(cloud, phone);

    const after = cloud.files.size;
    for (let i = 0; i < 5; i++) {
      await runSync(cloud, pc);
      await runSync(cloud, phone);
    }
    check("an idle sync writes nothing at all", cloud.files.size === after);
    check("a pulled row is not sent straight back", ![...cloud.files.keys()].includes("dev-bbb-1.reup"));
  }

  // ── ticking a task done on the phone ──────────────────────────────────────
  {
    const cloud = new MemoryStorage();
    const pc = new MemoryStore("dev-aaa");
    const phone = new MemoryStore("dev-bbb");

    pc.write({ table: "tasks", uid: "u1", updatedAt: "2026-08-14T09:00:00.000Z", deleted: false, fields: task("dailies") });
    await runSync(cloud, pc);
    await runSync(cloud, phone);

    // Ticked on the phone at 10:00, renamed on the desktop at 11:00. The rename
    // is newer, so it wins the base — but the completion must survive it.
    phone.write({
      table: "tasks",
      uid: "u1",
      updatedAt: "2026-08-14T10:00:00.000Z",
      deleted: false,
      fields: task("dailies", "2026-08-15T04:00:00.000Z"),
    });
    pc.write({
      table: "tasks",
      uid: "u1",
      updatedAt: "2026-08-14T11:00:00.000Z",
      deleted: false,
      fields: task("dailies renamed"),
    });

    await runSync(cloud, phone);
    await runSync(cloud, pc);
    await runSync(cloud, phone);

    const row = pc.rows.get("tasks\u0000u1");
    check("the newer name won", row?.fields.name === "dailies renamed");
    check("the tick was not undone", row?.fields.completed_until === "2026-08-15T04:00:00.000Z");
    check("and the phone agrees", rowsMatch(pc, phone));
  }

  // ── a file that cannot be read ────────────────────────────────────────────
  {
    const cloud = new MemoryStorage();
    const pc = new MemoryStore("dev-aaa");
    const phone = new MemoryStore("dev-bbb");

    pc.write({ table: "tasks", uid: "u1", updatedAt: "2026-08-14T09:00:00.000Z", deleted: false, fields: task("one") });
    await runSync(cloud, pc);
    pc.write({ table: "tasks", uid: "u2", updatedAt: "2026-08-14T09:01:00.000Z", deleted: false, fields: task("two") });
    await runSync(cloud, pc);
    pc.write({ table: "tasks", uid: "u3", updatedAt: "2026-08-14T09:02:00.000Z", deleted: false, fields: task("three") });
    await runSync(cloud, pc);

    cloud.unreadable.add("dev-aaa-2.reup");
    const r = await runSync(cloud, phone);
    check("the unreadable file is reported, not thrown", r.skipped.length === 1);
    check("the phone got the batches it could read", phone.rows.has("tasks\u0000u1") && phone.rows.has("tasks\u0000u3"));

    // Applying batch 3 without batch 2 is deliberately allowed. Order does not
    // change the answer — that is what the merge properties buy — so there is
    // no reason to hold back rows that did arrive. The cursor is what has to
    // stop, and it stops at 1, so batch 2 comes back next run rather than being
    // buried under a cursor that has moved past it.
    const seen = (await phone.loadState()).cursor["dev-aaa"];
    check("the cursor stopped at the gap rather than jumping it", seen === 1);

    cloud.unreadable.delete("dev-aaa-2.reup");
    await runSync(cloud, phone);
    check("the retry picks up exactly what was missed", rowsMatch(pc, phone));
  }

  // ── a stranger's file in the folder ───────────────────────────────────────
  {
    const cloud = new MemoryStorage();
    const pc = new MemoryStore("dev-aaa");
    cloud.files.set("holiday.jpg", new TextEncoder().encode("not ours"));
    pc.write({ table: "tasks", uid: "u1", updatedAt: "2026-08-14T09:00:00.000Z", deleted: false, fields: task("one") });
    const r = await runSync(cloud, pc);
    check("a file that is not ours is not even attempted", r.skipped.length === 0);
  }

  // ── interrupted between reserving a number and writing the file ───────────
  {
    const cloud = new MemoryStorage();
    const pc = new MemoryStore("dev-aaa");
    pc.write({ table: "tasks", uid: "u1", updatedAt: "2026-08-14T09:00:00.000Z", deleted: false, fields: task("one") });

    const broken = {
      list: () => cloud.list(),
      get: (n: string) => cloud.get(n),
      put: async () => {
        throw new Error("network dropped mid-upload");
      },
      delete: (n: string) => cloud.delete(n),
    };
    let threw = false;
    try {
      await sync({ storage: broken, store: pc, bucketId: BUCKET, key: KEY, now: clock });
    } catch {
      threw = true;
    }
    check("a failed upload surfaces", threw);

    await runSync(cloud, pc);
    check("the retry uses a fresh number rather than reusing one", cloud.files.has("dev-aaa-2.reup"));
    check("and the skipped number is never written", !cloud.files.has("dev-aaa-1.reup"));

    const phone = new MemoryStore("dev-bbb");
    await runSync(cloud, phone);
    check("a gap in the sequence does not stop the other device", phone.rows.has("tasks\u0000u1"));
  }

  // ── deletion ──────────────────────────────────────────────────────────────
  {
    const cloud = new MemoryStorage();
    const pc = new MemoryStore("dev-aaa");
    const phone = new MemoryStore("dev-bbb");
    pc.write({ table: "expenses", uid: "e1", updatedAt: "2026-08-14T09:00:00.000Z", deleted: false, fields: { amount: 1200, category: "food" } });
    await runSync(cloud, pc);
    await runSync(cloud, phone);
    check("the expense arrived", phone.rows.has("expenses\u0000e1"));

    pc.write({ table: "expenses", uid: "e1", updatedAt: "2026-08-14T10:00:00.000Z", deleted: true, fields: { amount: 1200, category: "food" } });
    await runSync(cloud, pc);
    await runSync(cloud, phone);
    check("the tombstone arrived", phone.rows.get("expenses\u0000e1")?.deleted === true);

    // The oldest failure in this design: an old copy of the row turns up later
    // and brings it back from the dead.
    phone.write({ table: "expenses", uid: "e1", updatedAt: "2026-08-14T08:00:00.000Z", deleted: false, fields: { amount: 1200, category: "food" } });
    await runSync(cloud, phone);
    await runSync(cloud, pc);
    check("a deleted row is not resurrected by an older copy", pc.rows.get("expenses\u0000e1")?.deleted === true);
  }

  // ── the blob really is opaque ─────────────────────────────────────────────
  {
    const cloud = new MemoryStorage();
    const pc = new MemoryStore("dev-aaa");
    pc.write({ table: "tasks", uid: "u1", updatedAt: "2026-08-14T09:00:00.000Z", deleted: false, fields: task("blood pressure meds") });
    await runSync(cloud, pc);
    const bytes = [...cloud.files.values()][0];
    const asText = new TextDecoder().decode(bytes);
    check("the task name is not sitting in the file", !asText.includes("blood pressure"));

    const wrongKey = new Uint8Array(32).fill(9);
    let refused = false;
    try {
      await open(wrongKey, BUCKET, "dev-aaa", 1, bytes);
    } catch {
      refused = true;
    }
    check("another bucket's key opens nothing", refused);

    let renamed = false;
    try {
      await open(KEY, BUCKET, "dev-aaa", 2, bytes);
    } catch {
      renamed = true;
    }
    check("a file moved to another name no longer authenticates", renamed);
  }

  // ── the folder is pruned under a device that was away ─────────────────────
  //
  // The failure this block exists to prevent, run rather than argued. The phone
  // syncs once, sleeps through a hundred edits, and comes back to a folder whose
  // early files no longer exist. Nothing errors either way — the question is
  // only whether it ends up holding the same rows.
  {
    const cloud = new MemoryStorage();
    const pc = new MemoryStore("dev-aaa");
    const phone = new MemoryStore("dev-bbb");

    pc.write({ table: "tasks", uid: "u0", updatedAt: "2026-08-14T09:00:00.000Z", deleted: false, fields: task("first") });
    const first = await runSync(cloud, pc);
    check("an ordinary first push is not a snapshot", !first.snapshot && first.wrote !== null);

    const arriving = await runSync(cloud, phone);
    check("a device that only pulled writes nothing", arriving.wrote === null);
    check("the phone starts out in step", rowsMatch(pc, phone));
    const asleepAt = (await phone.loadState()).cursor["dev-aaa"];

    // A hundred edits on the desktop while the phone is in a drawer.
    for (let i = 1; i <= 100; i++) {
      pc.write({
        table: "tasks",
        uid: `u${i}`,
        updatedAt: `2026-08-14T10:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`,
        deleted: false,
        fields: task(`task ${i}`),
      });
      await runSync(cloud, pc);
    }
    // And a few idle runs, which is where a prune that ran out of its budget
    // finishes the job.
    for (let i = 0; i < 4; i++) await runSync(cloud, pc);

    const left = [...cloud.files.keys()].filter((n) => n.startsWith("dev-aaa-"));
    // 101 batches went in; what is left is the two snapshots and the deltas
    // since. The number is not the point — the point is that it is bounded by
    // the threshold rather than by how long the app has been installed.
    check("the folder is bounded rather than cumulative", left.length < SNAPSHOT_AFTER_FILES);
    const lowest = Math.min(...left.map((n) => Number(n.slice("dev-aaa-".length, -".reup".length))));
    check("and the files the phone stopped at are gone", lowest > asleepAt);

    // The cursor still points into the hole. Nothing detects that, and nothing
    // needs to: what is left starts with a snapshot.
    check("the phone has not noticed anything", (await phone.loadState()).cursor["dev-aaa"] === asleepAt);

    await runSync(cloud, phone);
    await runSync(cloud, pc);
    await runSync(cloud, phone);
    check("a device that slept through the deleted window still catches up", rowsMatch(pc, phone));
    check("including every row announced only in a file that is gone", phone.rows.size === 101);
  }

  // ── a deletion made inside the pruned window ──────────────────────────────
  //
  // Worse than a missing row, because the phone holds a live copy of its own:
  // if the snapshot does not carry tombstones, the row comes back from the dead
  // and the desktop is the one that changes its mind.
  {
    const cloud = new MemoryStorage();
    const pc = new MemoryStore("dev-aaa");
    const phone = new MemoryStore("dev-bbb");

    pc.write({ table: "expenses", uid: "e1", updatedAt: "2026-08-14T09:00:00.000Z", deleted: false, fields: { amount: 1200, category: "food" } });
    await runSync(cloud, pc);
    await runSync(cloud, phone);
    check("the phone has the expense", phone.rows.get("expenses\u0000e1")?.deleted === false);

    pc.write({ table: "expenses", uid: "e1", updatedAt: "2026-08-14T09:30:00.000Z", deleted: true, fields: { amount: 1200, category: "food" } });
    for (let i = 1; i <= 100; i++) {
      pc.write({
        table: "tasks",
        uid: `u${i}`,
        updatedAt: `2026-08-14T11:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`,
        deleted: false,
        fields: task(`task ${i}`),
      });
      await runSync(cloud, pc);
    }
    for (let i = 0; i < 4; i++) await runSync(cloud, pc);

    await runSync(cloud, phone);
    await runSync(cloud, pc);
    check("a deletion announced only in a deleted file still lands", phone.rows.get("expenses\u0000e1")?.deleted === true);
    check("and the desktop does not have it back", pc.rows.get("expenses\u0000e1")?.deleted === true);
  }

  // ── pruning does not make an idle sync noisy ──────────────────────────────
  {
    const cloud = new MemoryStorage();
    const pc = new MemoryStore("dev-aaa");
    pc.write({ table: "tasks", uid: "u1", updatedAt: "2026-08-14T09:00:00.000Z", deleted: false, fields: task("one") });
    await runSync(cloud, pc);

    const after = cloud.files.size;
    for (let i = 0; i < 10; i++) {
      const r = await runSync(cloud, pc);
      check("an idle sync does not keep snapshotting", !r.snapshot);
    }
    check("and writes nothing at all", cloud.files.size === after);
  }

  // ── three devices, arriving in every order ────────────────────────────────
  {
    const orders: string[][] = [
      ["a", "b", "c", "a", "b", "c"],
      ["c", "b", "a", "c", "b", "a"],
      ["a", "a", "b", "c", "b", "c", "a"],
      ["b", "c", "a", "b", "a", "c", "b", "a", "c"],
    ];
    for (const order of orders) {
      const cloud = new MemoryStorage();
      const stores: Record<string, MemoryStore> = {
        a: new MemoryStore("dev-aaa"),
        b: new MemoryStore("dev-bbb"),
        c: new MemoryStore("dev-ccc"),
      };
      stores.a.write({ table: "tasks", uid: "u1", updatedAt: "2026-08-14T09:00:00.000Z", deleted: false, fields: task("one") });
      stores.b.write({ table: "tasks", uid: "u1", updatedAt: "2026-08-14T09:00:00.001Z", deleted: false, fields: task("one edited") });
      stores.c.write({ table: "tasks", uid: "u2", updatedAt: "2026-08-14T09:00:00.000Z", deleted: false, fields: task("two") });

      for (const who of order) await runSync(cloud, stores[who]);
      // One more round so the last writer's batch reaches everyone.
      for (const who of ["a", "b", "c", "a", "b", "c"]) await runSync(cloud, stores[who]);

      const same = rowsMatch(stores.a, stores.b) && rowsMatch(stores.b, stores.c);
      check(`three devices agree whatever order they sync in (${order.join("")})`, same);
    }
  }
}

// ─── run ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  buildVectors();
  await simulate();

  const counts = [
    ["planPull", V.planPull.length],
    ["advance", V.advance.length],
    ["planApply", V.planApply.length],
    ["planPush", V.planPush.length],
    ["wantsSnapshot", V.wantsSnapshot.length],
    ["planPrune", V.planPrune.length],
    ["decode", V.decode.length],
  ] as const;
  for (const [k, n] of counts) console.log(`${k.padEnd(12)} ${n}`);
  console.log(`${"total".padEnd(12)} ${counts.reduce((s, [, n]) => s + n, 0)}`);
  console.log("");

  if (failures > 0) {
    console.log(`${failures} property failures — nothing written`);
    process.exit(1);
  }

  const DEFAULT_OUT = "../reup-shared/engine-vectors.json";
  const out = process.argv[2] ?? DEFAULT_OUT;
  const fs = require("fs");
  const path = require("path") as unknown as { dirname(p: string): string; resolve(p: string): string };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(V, null, 2));
  console.log(`wrote ${out}`);

  // The phone reads its copy from its own test resources, and until now that
  // copy was kept in step by hand. A vector file the two sides disagree about is
  // the worst possible one: the phone goes green against rules the desktop has
  // stopped following. gen-store-vectors.ts already mirrors for this reason.
  if (out === DEFAULT_OUT) {
    const mirror = path.resolve(
      "../reup-mobile/shared/src/jvmTest/resources/engine-vectors.json",
    );
    if (fs.existsSync(path.dirname(mirror))) {
      fs.copyFileSync(path.resolve(out), mirror);
      console.log(`mirrored ${mirror}`);
    } else {
      console.log("no phone checkout next door, nothing mirrored");
    }
  }

  console.log("clean");
}

void main();