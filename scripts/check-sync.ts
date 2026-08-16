/**
 * Runs the whole sync stack against two real SQLite databases. Run it:
 *
 *   pnpm check:sync
 *
 * WHAT THIS IS FOR
 *
 * Everything below the store has been checked as pure logic — vectors for the
 * merge rules, vectors for the engine's planners, fakes for storage. None of
 * that touches SQLite, and SQLite is where the remaining ways to lose a row
 * live: a trigger that stamps its own timestamp over the sender's, a unique
 * index that refuses an insert, a local id that means one thing here and
 * another there.
 *
 * So this builds two databases from the real schema.sql, runs the real
 * migrations so the real triggers exist, and makes two devices sync through the
 * real engine and the real encryption. The only thing standing in for something
 * is the folder in the middle, which is a Map instead of Drive.
 *
 * The last line is the only one that matters. Anything other than `clean` means
 * two devices can end up holding different rows while both believe they are in
 * sync.
 *
 * WHY node:sqlite AND NOT THE TAURI PLUGIN
 *
 * The plugin needs a running app. node:sqlite is the same SQLite, and the store
 * only ever asks for execute and select, so the adapter below is fifteen lines.
 * That is the whole reason the store takes a `Db` rather than the plugin's
 * Database.
 */

import { applySyncMigrations } from "../src/lib/syncMeta";
import { sync, type SyncState } from "../src/lib/sync/engine";
import { SqlLocalStore, SYNCED_TABLES, dbNow, type Db } from "../src/lib/sync/sqlLocalStore";
import {
  SYNC_OFF,
  isReady,
  newPairing,
  pairingOf,
  parseSyncConfig,
  serialiseSyncConfig,
  storageFor,
  syncWith,
  keepInBackup,
  MACHINE_ONLY_SETTINGS,
} from "../src/lib/sync/config";
import {
  PURGE_TASK_SQL,
  sweepTrash,
  sweepTombstones,
  TOMBSTONE_TTL_DAYS,
} from "../src/lib/tombstones";
import type { SyncStorage } from "../src/lib/sync/storage";

declare const require: (m: string) => any;
declare const process: { argv: string[]; exit(code: number): void };

const { DatabaseSync } = require("node:sqlite");
const fs = require("fs");
const path = require("path");

// ─── the adapter ─────────────────────────────────────────────────────────────

class NodeDb implements Db {
  readonly raw = new DatabaseSync(":memory:");

  async execute(sql: string, params: unknown[] = []): Promise<unknown> {
    // exec() rather than prepare() when there is nothing to bind, because a
    // CREATE TRIGGER body contains semicolons and prepare() stops at the first.
    if (params.length === 0) return this.raw.exec(sql);
    return this.raw.prepare(sql).run(...(params as never[]));
  }

  async select<T>(sql: string, params: unknown[] = []): Promise<T> {
    return this.raw.prepare(sql).all(...(params as never[])) as T;
  }
}

// ─── in-memory folder ────────────────────────────────────────────────────────

class MemoryStorage implements SyncStorage {
  readonly files = new Map<string, Uint8Array>();
  async list(): Promise<string[]> {
    return [...this.files.keys()];
  }
  async get(name: string): Promise<Uint8Array> {
    const b = this.files.get(name);
    if (!b) throw new Error(`no such file: ${name}`);
    return b;
  }
  async put(name: string, bytes: Uint8Array): Promise<void> {
    if (this.files.has(name)) throw new Error(`append-only violated: ${name}`);
    this.files.set(name, bytes);
  }
  async delete(name: string): Promise<void> {
    this.files.delete(name);
  }
}

// ─── setup ───────────────────────────────────────────────────────────────────

const KEY = new Uint8Array(32).fill(7);
const BUCKET = "check-sync-bucket";

let failures = 0;
let checked = 0;
function check(what: string, ok: boolean): void {
  checked++;
  if (!ok) {
    failures++;
    console.log(`  FAIL  ${what}`);
  }
}

/**
 * Resolved from the working directory rather than from the compiled script's
 * own location, because the script is compiled into node_modules/.cache and
 * would otherwise be measuring its distance from a folder that moves.
 */
function schemaPath(): string {
  const p = path.resolve(process.argv[2] ?? "../reup-shared/schema.sql");
  if (!fs.existsSync(p)) {
    throw new Error(
      `schema.sql not found at ${p}. Pass the path as an argument, or run this ` +
        `from the reup folder with reup-shared beside it.`,
    );
  }
  return p;
}

async function makeDevice(): Promise<{ db: NodeDb; store: SqlLocalStore }> {
  const db = new NodeDb();
  const sql = fs.readFileSync(schemaPath(), "utf8");
  // "Statements are separated by a line containing only `-- @@`", per the file's
  // own rules. Splitting on the bare substring instead cuts the header in half,
  // because the header is where that rule is written down.
  for (const stmt of sql.split(/^[ \t]*--[ \t]*@@[ \t]*$/m)) {
    // Comment lines are dropped before deciding whether a chunk is empty. The
    // file's own header explains the separator and therefore contains the
    // separator, so splitting leaves one fragment that is the tail of a comment
    // and nothing else.
    const t = stmt
      .split("\n")
      .filter((l: string) => !l.trim().startsWith("--"))
      .join("\n")
      .trim();
    if (t === "") continue;
    try {
      db.raw.exec(t);
    } catch (e) {
      // schema.sql carries the ALTERs that migrated an existing database, and
      // on a database built fresh from the same file the column is already
      // there. That is the normal path, not an error.
      const msg = String(e);
      if (!msg.includes("duplicate column")) throw e;
    }
  }
  await applySyncMigrations(db as never);
  const store = await SqlLocalStore.open(db);
  return { db, store };
}

async function runSync(cloud: MemoryStorage, d: { store: SqlLocalStore }) {
  return sync({
    storage: cloud,
    store: d.store,
    bucketId: BUCKET,
    key: KEY,
    now: () => new Date().toISOString(),
  });
}

/**
 * The trigger stamps `strftime('%f')`, which is milliseconds, and two edits made
 * in the same millisecond on two devices genuinely tie. Merge breaks that tie by
 * origin, which is deterministic and which both devices agree on — but it means
 * "the newer one wins" is only a meaningful claim when one of them really is
 * newer. Three milliseconds is cheaper than making the test lie.
 */
/**
 * Long enough that two devices really are ordered in wall time.
 *
 * A few milliseconds is not. Windows ticks its system timer about every sixteen
 * milliseconds by default, so two writes three milliseconds apart can read the
 * same clock and there is nothing for last-write-wins to compare. The monotonic
 * clock fixes that within one database; it cannot align two of them.
 *
 * That is a real limit of LWW and not a bug to chase: two devices editing the
 * same row inside one timer tick have no ordering to discover. Tests that mean
 * "later" have to wait longer than the platform can measure.
 */
const A_TICK_APART = 25;

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function row(db: NodeDb, sql: string, params: unknown[] = []): any {
  return db.raw.prepare(sql).all(...(params as never[]))[0];
}
function rows(db: NodeDb, sql: string, params: unknown[] = []): any[] {
  return db.raw.prepare(sql).all(...(params as never[]));
}

// ─── the checks ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // ── the migration actually adds what the store expects ────────────────────
  {
    const a = await makeDevice();
    for (const t of SYNCED_TABLES) {
      const cols = rows(a.db, `PRAGMA table_info(${t})`).map((c) => c.name);
      check(`${t} has uid`, cols.includes("uid"));
      check(`${t} has updated_at`, cols.includes("updated_at"));
      check(`${t} has a tombstone column`, cols.includes("deleted"));
    }
  }

  // ── a row makes it across, with the sender's timestamp ────────────────────
  {
    const cloud = new MemoryStorage();
    const a = await makeDevice();
    const b = await makeDevice();

    a.db.raw
      .prepare("INSERT INTO tasks (name, reset_type, reset_time) VALUES (?, ?, ?)")
      .run("dailies", "daily", "04:00");
    const mine = row(a.db, "SELECT * FROM tasks WHERE name = 'dailies'");

    await runSync(cloud, a);
    await runSync(cloud, b);

    const theirs = row(b.db, "SELECT * FROM tasks WHERE uid = ?", [mine.uid]);
    check("the task arrived", theirs !== undefined);
    check("the name came with it", theirs?.name === "dailies");
    check("the schedule came with it", theirs?.reset_type === "daily" && theirs?.reset_time === "04:00");

    // The one that would be invisible: an incoming row must keep the sender's
    // timestamp. If the update trigger stamped it with this machine's clock,
    // the row would instantly look newer than every other copy and be pushed
    // straight back out as an edit nobody made.
    check("the timestamp was not overwritten by the trigger", theirs?.updated_at === mine.updated_at);
    check("the local id is the receiver's own", typeof theirs?.id === "number");
  }

  // ── the echo ──────────────────────────────────────────────────────────────
  {
    const cloud = new MemoryStorage();
    const a = await makeDevice();
    const b = await makeDevice();
    a.db.raw.prepare("INSERT INTO tasks (name, reset_type) VALUES (?, ?)").run("dailies", "daily");

    await runSync(cloud, a);
    await runSync(cloud, b);
    const settled = cloud.files.size;
    for (let i = 0; i < 4; i++) {
      await runSync(cloud, a);
      await runSync(cloud, b);
    }
    check("an idle sync writes nothing at all", cloud.files.size === settled);
  }

  // ── ticking a task done on one device ─────────────────────────────────────
  {
    const cloud = new MemoryStorage();
    const a = await makeDevice();
    const b = await makeDevice();
    a.db.raw.prepare("INSERT INTO tasks (name, reset_type) VALUES (?, ?)").run("dailies", "daily");
    await runSync(cloud, a);
    await runSync(cloud, b);

    b.db.raw.prepare("UPDATE tasks SET completed_until = ?").run("2026-08-16T04:00:00.000Z");
    await runSync(cloud, b);
    await wait(A_TICK_APART);
    a.db.raw.prepare("UPDATE tasks SET name = ?").run("dailies renamed");
    await runSync(cloud, a);
    await runSync(cloud, b);
    await runSync(cloud, a);

    const ra = row(a.db, "SELECT * FROM tasks");
    const rb = row(b.db, "SELECT * FROM tasks");
    check("the newer name won", ra.name === "dailies renamed");
    check("the tick was not undone", ra.completed_until === "2026-08-16T04:00:00.000Z");
    check("both devices agree", ra.name === rb.name && ra.completed_until === rb.completed_until);
  }

  // ── deleting an expense ───────────────────────────────────────────────────
  {
    const cloud = new MemoryStorage();
    const a = await makeDevice();
    const b = await makeDevice();
    a.db.raw
      .prepare("INSERT INTO expenses (amount, category, note, date) VALUES (?, ?, ?, ?)")
      .run(1200, "food", "dog food", "2026-08-15");
    await runSync(cloud, a);
    await runSync(cloud, b);
    check("the expense arrived", rows(b.db, "SELECT * FROM expenses").length === 1);

    a.db.raw.prepare("UPDATE expenses SET deleted = 1, updated_at = ? WHERE category = 'food'").run(
      new Date(Date.now() + 1000).toISOString(),
    );
    await runSync(cloud, a);
    await runSync(cloud, b);
    check("the tombstone arrived", row(b.db, "SELECT * FROM expenses").deleted === 1);
  }

  // ── the same budget invented on both devices ──────────────────────────────
  {
    const cloud = new MemoryStorage();
    const a = await makeDevice();
    const b = await makeDevice();

    // UNIQUE(category, month). Two uids, one natural key. Without a rule this
    // is where apply throws and sync stops permanently.
    a.db.raw
      .prepare("INSERT INTO budgets (category, limit_amount, month) VALUES (?, ?, ?)")
      .run("food", 5000, "2026-08");
    b.db.raw
      .prepare("INSERT INTO budgets (category, limit_amount, month) VALUES (?, ?, ?)")
      .run("food", 4000, "2026-08");

    await runSync(cloud, a);
    await runSync(cloud, b);
    await runSync(cloud, a);
    await runSync(cloud, b);

    const la = rows(a.db, "SELECT * FROM budgets WHERE deleted = 0");
    const lb = rows(b.db, "SELECT * FROM budgets WHERE deleted = 0");
    check("sync survived the duplicate", true);
    check("exactly one budget is live on each device", la.length === 1 && lb.length === 1);
    check("and it is the same one", la[0]?.uid === lb[0]?.uid);
    check(
      "nothing was thrown away",
      rows(a.db, "SELECT * FROM budgets").length === 2 && rows(b.db, "SELECT * FROM budgets").length === 2,
    );
  }

  // ── money, which is the table with the most rows and the least forgiveness ─
  {
    const cloud = new MemoryStorage();
    const a = await makeDevice();
    const b = await makeDevice();
    for (let i = 0; i < 40; i++) {
      a.db.raw
        .prepare("INSERT INTO expenses (amount, category, note, date) VALUES (?, ?, ?, ?)")
        .run(60 + i, "food", `coffee ${i}`, "2026-08-15");
    }
    for (let i = 0; i < 25; i++) {
      b.db.raw
        .prepare("INSERT INTO income (amount, source, note, date) VALUES (?, ?, ?, ?)")
        .run(1800 + i, "telus", `hour ${i}`, "2026-08-15");
    }
    await runSync(cloud, a);
    await runSync(cloud, b);
    await runSync(cloud, a);

    const ea = rows(a.db, "SELECT uid, amount FROM expenses ORDER BY uid");
    const eb = rows(b.db, "SELECT uid, amount FROM expenses ORDER BY uid");
    const ia = rows(a.db, "SELECT uid, amount FROM income ORDER BY uid");
    const ib = rows(b.db, "SELECT uid, amount FROM income ORDER BY uid");
    check("every expense crossed", JSON.stringify(ea) === JSON.stringify(eb) && ea.length === 40);
    check("every income crossed", JSON.stringify(ia) === JSON.stringify(ib) && ia.length === 25);
    check(
      "amounts are still amounts",
      ea.every((r) => typeof r.amount === "number"),
    );
  }

  // ── deleting a budget and adding it back ──────────────────────────────────
  //
  // Run twice, with the uids forced both ways round. The first version of this
  // used whatever uuid came out of the database, so which branch of the clash
  // rule ran was a coin toss — and it passed three times here and failed on the
  // first machine that was not this one.
  for (const newUidIsLarger of [true, false]) {
    const OLD = newUidIsLarger ? "00000000-0000-4000-8000-00000000aaaa" : "ffffffff-ffff-4fff-8fff-ffffffffaaaa";
    const NEW = newUidIsLarger ? "ffffffff-ffff-4fff-8fff-ffffffffbbbb" : "00000000-0000-4000-8000-00000000bbbb";
    const which = newUidIsLarger ? "new uid sorts last" : "new uid sorts first";

    const cloud = new MemoryStorage();
    const a = await makeDevice();
    const b = await makeDevice();
    a.db.raw
      .prepare("INSERT INTO budgets (category, limit_amount, month) VALUES (?, ?, ?)")
      .run("food", 5000, "2026-08");
    a.db.raw.prepare("UPDATE budgets SET uid = ?").run(OLD);
    await runSync(cloud, a);
    await runSync(cloud, b);

    await a.store.softDelete("budgets", OLD);

    // The insert a UNIQUE(category, month) would refuse if the tombstone were
    // still sitting on the key. Deleting a budget and putting it back is an
    // ordinary afternoon, so this is not a corner.
    a.db.raw
      .prepare("INSERT INTO budgets (category, limit_amount, month) VALUES (?, ?, ?)")
      .run("food", 6000, "2026-08");
    a.db.raw.prepare("UPDATE budgets SET uid = ? WHERE limit_amount = 6000").run(NEW);
    check(`the old tombstone does not block the new budget (${which})`, true);

    await runSync(cloud, a);
    await runSync(cloud, b);

    const live = rows(b.db, "SELECT * FROM budgets WHERE deleted = 0");
    const all = rows(b.db, "SELECT * FROM budgets");
    const ok1 = live.length === 1 && live[0].limit_amount === 6000;
    const ok2 = all.length === 2;
    check(`the other device sees exactly the new one (${which})`, ok1);
    check(`and still holds the tombstone (${which})`, ok2);
    if (!ok1 || !ok2) {
      // Printed rather than left to be guessed at from two failing lines. This
      // block failed once on a machine that was not the one it was written on,
      // and the two lines alone were not enough to say why.
      const trim = (r: any) => ({
        uid: String(r.uid).slice(0, 8),
        cat: r.category,
        month: r.month,
        amount: r.limit_amount,
        deleted: r.deleted,
        updated_at: r.updated_at,
      });
      console.log("        a:", JSON.stringify(rows(a.db, "SELECT * FROM budgets").map(trim)));
      console.log("        b:", JSON.stringify(all.map(trim)));
      console.log("        files:", [...cloud.files.keys()].join(", "));
    }
  }

  // ── the delete that arrives after the row replacing it ────────────────────
  //
  // Built by hand rather than left to the clock, because this is the shape that
  // failed on somebody else's machine and never once on the machine it was
  // written on. The tombstone carries a LATER timestamp than the row created to
  // replace it, which sounds impossible until two clocks are involved: the
  // store used to stamp deletions with the JavaScript clock while the triggers
  // stamped everything else with SQLite's, and on Windows the system timer
  // ticks about every sixteen milliseconds. The delete happened first and was
  // recorded as happening second.
  //
  // The push batch is ordered by that column, so the receiving device saw the
  // new budget while it still believed the old one was live, decided it was a
  // duplicate, and filed it as a tombstone. Whether the afternoon ended with the
  // right budget or with none at all came down to which uuid sorted first.
  {
    const OLD = "00000000-0000-4000-8000-00000000aaaa";
    const NEW = "ffffffff-ffff-4fff-8fff-ffffffffbbbb"; // sorts after, so it loses a clash

    const cloud = new MemoryStorage();
    const a = await makeDevice();
    const b = await makeDevice();
    a.db.raw
      .prepare("INSERT INTO budgets (category, limit_amount, month) VALUES (?, ?, ?)")
      .run("food", 5000, "2026-08");
    a.db.raw.prepare("UPDATE budgets SET uid = ?, updated_at = ?").run(OLD, "2026-08-15T10:00:00.000Z");
    await runSync(cloud, a);
    await runSync(cloud, b);

    await a.store.softDelete("budgets", OLD);
    a.db.raw
      .prepare("INSERT INTO budgets (category, limit_amount, month) VALUES (?, ?, ?)")
      .run("food", 6000, "2026-08");

    // The delete recorded as later than the create that followed it.
    a.db.raw.prepare("UPDATE budgets SET updated_at = ? WHERE uid = ?").run("2026-08-15T10:00:02.000Z", OLD);
    a.db.raw
      .prepare("UPDATE budgets SET uid = ?, updated_at = ? WHERE limit_amount = 6000")
      .run(NEW, "2026-08-15T10:00:01.000Z");

    await runSync(cloud, a);
    await runSync(cloud, b);

    const live = rows(b.db, "SELECT * FROM budgets WHERE deleted = 0");
    const ok = live.length === 1 && live[0].limit_amount === 6000;
    check("a delete stamped after its replacement does not eat the replacement", ok);
    check("and both rows are still there", rows(b.db, "SELECT * FROM budgets").length === 2);
    if (!ok) {
      console.log("        b:", JSON.stringify(rows(b.db, "SELECT uid, limit_amount, deleted FROM budgets")));
    }
  }

  // ── a task deleted for good ───────────────────────────────────────────────
  {
    const cloud = new MemoryStorage();
    const a = await makeDevice();
    const b = await makeDevice();
    a.db.raw.prepare("INSERT INTO tasks (name, reset_type) VALUES (?, ?)").run("old event", "daily");
    await runSync(cloud, a);
    await runSync(cloud, b);

    const uid = String(row(a.db, "SELECT uid FROM tasks").uid);
    await a.store.softDelete("tasks", uid);
    await runSync(cloud, a);
    await runSync(cloud, b);
    check("the deletion crossed", row(b.db, "SELECT * FROM tasks WHERE uid = ?", [uid]).deleted === 1);

    // And the row that matters: the other device does not push it back to life.
    for (let i = 0; i < 3; i++) {
      await runSync(cloud, b);
      await runSync(cloud, a);
    }
    check("it stays deleted", row(a.db, "SELECT * FROM tasks WHERE uid = ?", [uid]).deleted === 1);
  }

  // ── the file is opaque ────────────────────────────────────────────────────
  {
    const cloud = new MemoryStorage();
    const a = await makeDevice();
    a.db.raw
      .prepare("INSERT INTO tasks (name, reset_type) VALUES (?, ?)")
      .run("blood pressure meds", "daily");
    await runSync(cloud, a);
    const text = new TextDecoder().decode([...cloud.files.values()][0]);
    check("the task name is not sitting in the file", !text.includes("blood pressure"));
  }

  // ── the state survives a restart ──────────────────────────────────────────
  {
    const cloud = new MemoryStorage();
    const a = await makeDevice();
    a.db.raw.prepare("INSERT INTO tasks (name, reset_type) VALUES (?, ?)").run("dailies", "daily");
    await runSync(cloud, a);
    const before: SyncState = await a.store.loadState();

    const reopened = await SqlLocalStore.open(a.db);
    const after = await reopened.loadState();
    check("the device id is the same after a restart", before.device === after.device);
    check("the sequence number is the same after a restart", before.seq === after.seq);
    check("the watermark is the same after a restart", before.pushedThrough === after.pushedThrough);

    // And nothing new is written, because there is nothing new to say.
    const settled = cloud.files.size;
    await runSync(cloud, { store: reopened });
    check("a restart does not re-push everything", cloud.files.size === settled);
  }

  // ── the clock never hands out the same reading twice ──────────────────────
  //
  // This is the guard for the whole monotonic-clock decision, and it is written
  // as its own check rather than left to the sync scenarios above because those
  // only fail when a collision happens to land on the one row they are watching.
  // That made them pass on a machine with a fine-grained timer and fail on one
  // without, which is the worst way for a test to behave: the green runs teach
  // you to believe something that is not true.
  //
  // Here a collision cannot be missed. A hundred and twenty writes in a tight
  // loop take a few milliseconds, so under a plain `strftime('now')` most of
  // them share a reading and this fails on any platform, immediately.
  {
    const a = await makeDevice();
    const ins = a.db.raw.prepare("INSERT INTO tasks (name, reset_type) VALUES (?, ?)");
    const upd = a.db.raw.prepare("UPDATE tasks SET name = ? WHERE id = ?");
    for (let i = 0; i < 60; i++) ins.run(`t${i}`, "daily");
    for (let i = 1; i <= 60; i++) upd.run(`renamed ${i}`, i);

    const stamps: string[] = a.db.raw
      .prepare("SELECT updated_at FROM tasks ORDER BY id")
      .all()
      .map((r: any) => r.updated_at as string);

    check("every row got a timestamp", stamps.length === 60 && stamps.every(Boolean));
    check("no two writes share a timestamp", new Set(stamps).size === stamps.length);

    // The store's own clock and the triggers' clock are the same clock, so a
    // tombstone written by the store cannot collide with the row that replaces
    // it. That is the collision that started all of this.
    const readings: string[] = [];
    for (let i = 0; i < 20; i++) readings.push(await dbNow(a.db));
    check("the store's readings are all different", new Set(readings).size === readings.length);
    check(
      "the store's readings only move forward",
      readings.every((r, i) => i === 0 || r > readings[i - 1]),
    );
    check(
      "and they are ahead of every row written before them",
      readings[0] > stamps.reduce((m, s) => (s > m ? s : m), ""),
    );
  }

  // ── the app's own deletes, not the sync layer's ───────────────────────────
  //
  // Everything above tests `store.softDelete`, which is what an incoming batch
  // uses. It is not what the app uses. Emptying the bin and the purge button are
  // the two places a person deletes something, and until now both ran a real
  // DELETE — so the sync layer could have been perfect and a deleted task would
  // still have come back from the other device.
  {
    const a = await makeDevice();
    const ins = a.db.raw.prepare(
      "INSERT INTO tasks (name, reset_type, is_active, deleted_at) VALUES (?, ?, 0, ?)",
    );

    // Emptied out of the bin by hand.
    ins.run("purged", "daily", "2026-08-01T00:00:00.000Z");
    const purgedId = row(a.db, "SELECT id FROM tasks WHERE name = 'purged'").id;
    const beforePurge = row(a.db, "SELECT * FROM tasks WHERE id = ?", [purgedId]);
    a.db.raw.prepare(PURGE_TASK_SQL).run(purgedId);
    const purged = row(a.db, "SELECT * FROM tasks WHERE id = ?", [purgedId]);

    check("a purged task is still there as a tombstone", purged !== undefined);
    check("a purged task is marked deleted", purged.deleted === 1);
    check("a purged task keeps the uid that identifies it", purged.uid === beforePurge.uid);
    check("a purged task carries no name around", purged.name === "");
    check(
      "and the trigger, not the statement, moved its clock",
      purged.updated_at > beforePurge.updated_at,
    );

    // Emptied out by the thirty-day timer.
    ins.run("swept", "daily", "2026-01-01T00:00:00.000Z");
    ins.run("still in the bin", "daily", new Date().toISOString());
    await sweepTrash(a.db as never);
    check(
      "the timer tombstones what is past its thirty days",
      row(a.db, "SELECT * FROM tasks WHERE uid = ?", [
        row(a.db, "SELECT uid FROM tasks WHERE deleted = 1 AND name = '' ORDER BY id").uid,
      ]) !== undefined,
    );
    check(
      "and leaves alone what is not",
      row(a.db, "SELECT * FROM tasks WHERE name = 'still in the bin'").deleted === 0,
    );

    // The bin is what the person actually looks at, and a tombstone keeps its
    // deleted_at, so this is the one read that has to know the difference.
    const bin = a.db.raw
      .prepare("SELECT * FROM tasks WHERE is_active = 0 AND deleted_at IS NOT NULL AND deleted = 0")
      .all();
    check("the bin shows only what can still be restored", bin.length === 1);
    check("and that one has its name", (bin[0] as any).name === "still in the bin");
  }

  // ── and the one place a row is genuinely removed ──────────────────────────
  {
    const a = await makeDevice();
    const old = new Date(Date.now() - (TOMBSTONE_TTL_DAYS + 1) * 86_400_000).toISOString();

    // Both uid and updated_at are supplied, which is what a row that arrived
    // from another device looks like. That matters more than it reads: the
    // insert trigger only stands aside when BOTH are present. Supply just the
    // timestamp and the trigger fires for the missing uid, and the UPDATE inside
    // its body fires the update trigger in turn, which stamps the row with the
    // local clock and quietly throws the timestamp away.
    a.db.raw
      .prepare(
        "INSERT INTO tasks (name, reset_type, deleted, uid, updated_at) VALUES (?, ?, 1, ?, ?)",
      )
      .run("", "daily", "00000000-0000-4000-8000-00000000dead", old);
    check("a row that arrives with its own identity keeps it",
      row(a.db, "SELECT * FROM tasks WHERE uid = '00000000-0000-4000-8000-00000000dead'")
        .updated_at === old);
    a.db.raw.prepare("INSERT INTO tasks (name, reset_type, deleted) VALUES (?, ?, 1)").run("", "daily");
    a.db.raw.prepare("INSERT INTO tasks (name, reset_type) VALUES (?, ?)").run("alive", "daily");

    await sweepTombstones(a.db as never, [...SYNCED_TABLES]);
    const left = a.db.raw.prepare("SELECT * FROM tasks ORDER BY id").all() as any[];
    check("a tombstone older than the window is finally removed", left.length === 2);
    check("a recent tombstone is kept", left.some((r) => r.deleted === 1));
    check("and a living row is never touched", left.some((r) => r.name === "alive"));
  }

  // ── settings: the only file that knows how the parts fit together ─────────
  {
    check("nothing at all reads as off", parseSyncConfig(null).backend.kind === "off");
    check("and so does rubbish", parseSyncConfig("{not json").backend.kind === "off");
    check("and so does a backend nobody wrote", parseSyncConfig('{"backend":{"kind":"ftp"}}').backend.kind === "off");
    check(
      "a half-filled backend is not half enabled",
      parseSyncConfig('{"backend":{"kind":"webdav","baseUrl":""}}').backend.kind === "off",
    );

    const cfg = {
      backend: { kind: "webdav" as const, baseUrl: "https://box.example/reup/", username: "u", password: "p" },
      pairing: newPairing(),
    };
    const back = parseSyncConfig(serialiseSyncConfig(cfg));
    check("a config survives the round trip", JSON.stringify(back) === JSON.stringify(cfg));
    check("and is ready to run", isReady(back));

    // The one thing in this file that cannot be undone. A code that does not
    // parse is still the only copy of a key somebody may have mistyped by one
    // character, and it is theirs to fix rather than ours to delete.
    const broken = parseSyncConfig('{"backend":{"kind":"nonsense"},"pairing":"reup://pair?b=x"}');
    check("an unusable pairing code is kept, not thrown away", broken.pairing === "reup://pair?b=x");
    check("but it does not count as set up", pairingOf(broken) === null && !isReady(broken));

    const p1 = pairingOf({ ...SYNC_OFF, pairing: newPairing() })!;
    const p2 = pairingOf({ ...SYNC_OFF, pairing: newPairing() })!;
    check("a new pairing code carries a full-length key", p1.key.length === 32);
    check("and two of them are not the same bucket", p1.bucketId !== p2.bucketId);

    check("off builds no storage at all", storageFor(SYNC_OFF, null as never) === null);
    let refused = false;
    try {
      storageFor(
        { backend: { kind: "webdav", baseUrl: "http://example.com/dav", username: "u", password: "p" }, pairing: null },
        null as never,
      );
    } catch {
      refused = true;
    }
    check("plain http to the open internet is refused at setup, not at request time", refused);
  }

  // ── and the assembly really does carry a row from one device to the other ──
  {
    const cloud = new MemoryStorage();
    const a = await makeDevice();
    const b = await makeDevice();
    const pairing = pairingOf({ ...SYNC_OFF, pairing: newPairing() })!;

    a.db.raw.prepare("INSERT INTO tasks (name, reset_type) VALUES (?, ?)").run("through the front door", "daily");
    await syncWith(a.store, cloud, pairing);
    await syncWith(b.store, cloud, pairing);

    check(
      "a task written on one device arrives on the other",
      row(b.db, "SELECT * FROM tasks").name === "through the front door",
    );

    // The wrong key is the shape a mistyped pairing code takes, and it has to
    // read as "this is not mine" rather than as an empty bucket.
    const c = await makeDevice();
    const stranger = pairingOf({ ...SYNC_OFF, pairing: newPairing() })!;
    const report = await syncWith(c.store, cloud, { bucketId: pairing.bucketId, key: stranger.key });
    check("a bucket opened with the wrong key hands back nothing", report.applied === 0);
    check("and says which files it could not read", report.skipped.length > 0);
  }

  // ── what a backup is allowed to carry ─────────────────────────────────────
  {
    check("a task row is always kept", keepInBackup("tasks", { id: 1, name: "x" }));
    check("an ordinary setting is kept", keepInBackup("app_settings", { key: "currency", value: "THB" }));
    for (const k of MACHINE_ONLY_SETTINGS) {
      check(`${k} never reaches the file`, !keepInBackup("app_settings", { key: k, value: "..." }));
    }
    check(
      "a row with no key at all is not mistaken for one of them",
      keepInBackup("app_settings", { value: "orphan" }),
    );
  }

  // ── a column this version has never heard of ──────────────────────────────
  //
  // The other device runs a newer build and sends a field this schema has no
  // column for. The write cannot keep it; what it must not do is keep quiet
  // about it, because a row that arrives looking right with one column missing
  // is the hardest kind of loss to notice.
  {
    const cloud = new MemoryStorage();
    const newer = await makeDevice();
    const older = await makeDevice();

    // The newer build's extra column, added to one device only.
    newer.db.raw.exec("ALTER TABLE tasks ADD COLUMN mood_after TEXT");
    const reopened = await SqlLocalStore.open(newer.db);
    newer.db.raw
      .prepare("INSERT INTO tasks (name, reset_type, mood_after) VALUES (?, ?, ?)")
      .run("dailies", "daily", "fine");

    await runSync(cloud, { store: reopened });
    await runSync(cloud, older);

    check(
      "the row itself still arrives",
      row(older.db, "SELECT * FROM tasks").name === "dailies",
    );
    check(
      "and the column it could not hold is named, not swallowed",
      older.store.unknownFields.has("tasks.mood_after"),
    );
    check(
      "while the device that has the column keeps the value",
      row(newer.db, "SELECT * FROM tasks").mood_after === "fine",
    );
    check(
      "and a device that understands everything reports nothing",
      reopened.unknownFields.size === 0,
    );
  }

  console.log("");
  console.log(`${checked} checks`);
  if (failures > 0) {
    console.log(`${failures} failures`);
    process.exit(1);
  }
  console.log("clean");
}

void main();