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
  nextWatermark,
  planApply,
  planPull,
  planPush,
  rowKey,
  sync,
  type LocalStore,
  type SyncState,
} from "../src/lib/sync/engine";
import { mergeAll } from "../src/lib/sync/merge";
import { parseFileName, type ChangeRecord, type Cursor, type RemoteFile } from "../src/lib/sync/protocol";
import type { SyncStorage } from "../src/lib/sync/storage";

declare const require: (m: string) => {
  writeFileSync(p: string, d: string): void;
  mkdirSync(p: string, o: { recursive: boolean }): void;
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

  /** A local edit, as the app would make it. */
  write(r: Omit<ChangeRecord, "origin">): void {
    this.rows.set(rowKey(r), { ...r, origin: this.state.device });
  }

  async changedSince(since: string): Promise<ChangeRecord[]> {
    return [...this.rows.values()]
      .filter((r) => r.updatedAt > since)
      .sort((a, b) => (a.updatedAt === b.updatedAt ? (a.uid < b.uid ? -1 : 1) : a.updatedAt < b.updatedAt ? -1 : 1));
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
    for (const r of records) this.rows.set(rowKey(r), r);
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
  watermark: unknown[];
  decode: unknown[];
}

const V: Vectors = {
  version: 1,
  generatedBy: "gen-engine-vectors.ts",
  planPull: [],
  advance: [],
  planApply: [],
  planPush: [],
  watermark: [],
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

function casePush(id: string, pending: ChangeRecord[], remoteView: ChangeRecord[], device: string, seq: number): void {
  const state = { ...emptyState(device), seq };
  const view = new Map(remoteView.map((x) => [rowKey(x), x]));
  V.planPush.push({
    id,
    pending,
    remoteView,
    device,
    seq,
    writtenAt: "2026-08-15T12:00:00.000Z",
    expected: planPush(pending, view, state, "2026-08-15T12:00:00.000Z"),
  });
}

function caseWatermark(id: string, current: string, records: ChangeRecord[]): void {
  V.watermark.push({ id, current, records, expected: nextWatermark(current, records) });
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

  caseWatermark("wm-empty", "", [mine, theirsNewer]);
  caseWatermark("wm-never-goes-backwards", "2026-08-20T00:00:00.000Z", [mine]);
  caseWatermark("wm-no-records", "2026-08-01T00:00:00.000Z", []);

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
  return `2026-08-15T12:00:${String(tick).padStart(2, "0")}.000Z`;
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
    ["watermark", V.watermark.length],
    ["decode", V.decode.length],
  ] as const;
  for (const [k, n] of counts) console.log(`${k.padEnd(12)} ${n}`);
  console.log(`${"total".padEnd(12)} ${counts.reduce((s, [, n]) => s + n, 0)}`);
  console.log("");

  if (failures > 0) {
    console.log(`${failures} property failures — nothing written`);
    process.exit(1);
  }

  const out = process.argv[2] ?? "../reup-shared/engine-vectors.json";
  const fs = require("fs");
  const path = require("path");
  fs.mkdirSync((path as unknown as { dirname(p: string): string }).dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(V, null, 2));
  console.log(`wrote ${out}`);
  console.log("clean");
}

void main();