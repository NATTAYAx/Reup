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

import { isAlreadyThere, schemaStatements } from "../src/lib/schemaFile";
import { applySyncMigrations } from "../src/lib/syncMeta";
import { HISTORY_SQL, doneDates, hasHistory, type TaskEvent } from "../src/lib/history";
import { KNOWN_KEYS, isKnownKey, sanitizeForBackup } from "../src/lib/storageKeys";
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
  saveSyncConfig,
} from "../src/lib/sync/config";
import {
  PURGE_TASK_SQL,
  sweepTrash,
  sweepTombstones,
  TOMBSTONE_TTL_DAYS,
} from "../src/lib/tombstones";
import type { SyncStorage } from "../src/lib/sync/storage";
import { SYNC_TABLES } from "../src/lib/syncMeta";
import { TASK_COLUMNS, TASK_EDITABLE, taskProblems, taskUpdate, taskValues } from "../src/lib/taskDraft";
import {
  EXPENSE_COLUMNS,
  SQL_MONTH_OTHER_COUNT,
  SQL_MONTH_RECEIVED,
  SQL_MONTH_SPENT,
  SQL_RECENT_MONEY,
  SQL_DELETE_EXPENSE,
  SQL_DELETE_INCOME,
  moneyUpdate,
  moneyUpdateSql,
  expenseProblems,
  expenseValues,
} from "../src/lib/moneyDraft";
import {
  CURRENCY_KEY,
  QUIET_KEY,
  parseQuiet,
  readSettings,
  writeSetting,
} from "../src/lib/userSettings";

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
  // In this repo now, not in the folder next door. It used to live in
  // reup-shared, which is not a git repository — so the one file that says what
  // the tables are had no history, no diff and no backup, and the day a line
  // went missing from it there was nothing to ask when it had happened.
  const p = path.resolve(process.argv[2] ?? "schema.sql");
  if (!fs.existsSync(p)) {
    throw new Error(
      `schema.sql not found at ${p}. Pass the path as an argument, or run this ` +
        `from the reup folder.`,
    );
  }
  return p;
}

async function makeDevice(): Promise<{ db: NodeDb; store: SqlLocalStore }> {
  const db = new NodeDb();
  const sql = fs.readFileSync(schemaPath(), "utf8");
  for (const statement of schemaStatements(sql)) {
    try {
      db.raw.exec(statement);
    } catch (e) {
      // schema.sql carries the ALTERs that migrated an existing database, and
      // on a database built fresh from the same file the column is already
      // there. That is the normal path, not an error.
      if (!isAlreadyThere(e)) throw e;
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

  // ── moving to a different folder ──────────────────────────────────────────
  {
    // Connecting Drive and pressing sync reported "sent 0 out" against a folder
    // that was empty, because pushedThrough still said everything had been
    // uploaded — to WebDAV, hours before. Both devices would have gone on
    // reporting success while the new folder never received the history.
    //
    // Whole-round-trip rather than a unit test of sameTarget, because the bug
    // was not in deciding; it was in nobody asking.
    const cloud = new MemoryStorage();
    const a = await makeDevice();
    a.db.raw.prepare("INSERT INTO tasks (name, reset_type) VALUES (?, ?)").run("dailies", "daily");

    const code = "reup://pair?b=" + "A".repeat(22) + "&k=" + "B".repeat(43);
    const webdav = {
      backend: { kind: "webdav", baseUrl: "https://one/dav", username: "u", password: "p" },
      pairing: code,
    } as const;

    await saveSyncConfig(a.db as never, webdav);
    const first = await runSync(cloud, a);
    check("the first folder receives the database", first.pushed > 0);

    const settled = await runSync(cloud, a);
    check("and a second run against it is quiet", settled.pushed === 0);

    // Same key, different folder. This is the Drive switch.
    await saveSyncConfig(a.db as never, { backend: { kind: "drive" }, pairing: code });
    a.store = await SqlLocalStore.open(a.db);

    const empty = new MemoryStorage();
    const moved = await runSync(empty, a);
    check("a new folder receives the database too", moved.pushed === first.pushed);
    check("and it is not empty afterwards", empty.files.size === 1);

    // A file name must never be reused, even in a folder that never saw it.
    const usedOnce = [...cloud.files.keys()][0];
    check(
      "and the sequence number was not handed out twice",
      ![...empty.files.keys()].includes(usedOnce),
    );

  }

  // ── correcting a setting that does not change the folder ──────────────────
  {
    // The rule has to cut both ways, or every saved keystroke re-uploads the
    // database. A password typed wrong and then typed right is the same folder
    // behind the same door.
    const cloud = new MemoryStorage();
    const a = await makeDevice();
    a.db.raw.prepare("INSERT INTO tasks (name, reset_type) VALUES (?, ?)").run("dailies", "daily");

    const code = "reup://pair?b=" + "A".repeat(22) + "&k=" + "B".repeat(43);
    const at = (password: string) =>
      ({
        backend: { kind: "webdav", baseUrl: "https://one/dav", username: "u", password },
        pairing: code,
      }) as const;

    await saveSyncConfig(a.db as never, at("wrng"));
    await runSync(cloud, a);
    check("settled against the folder first", (await runSync(cloud, a)).pushed === 0);

    await saveSyncConfig(a.db as never, at("right"));
    a.store = await SqlLocalStore.open(a.db);
    check(
      "fixing a password does not re-upload everything",
      (await runSync(cloud, a)).pushed === 0,
    );

    // A new key is a new bucket, even at the same address.
    await saveSyncConfig(a.db as never, {
      backend: at("right").backend,
      pairing: "reup://pair?b=" + "C".repeat(22) + "&k=" + "D".repeat(43),
    });
    a.store = await SqlLocalStore.open(a.db);
    const fresh = new MemoryStorage();
    check(
      "but a new pairing code does",
      (await runSync(fresh, a)).pushed > 0,
    );
  }

  // ── the backend survives being written down ───────────────────────────────
  {
    // The Drive backend has no fields, which made it look like there was
    // nothing to check. There was: the parser has to recognise the name, and
    // when it did not, the settings screen showed Drive selected out of React
    // state while every sync read `off` back from the database and returned
    // null. No error anywhere, and the result line simply never appeared.
    //
    // A round trip is the cheapest test in this file and it is the one that was
    // missing for the one backend that carries nothing.
    const code = "reup://pair?b=" + "A".repeat(22) + "&k=" + "B".repeat(43);
    for (const backend of [
      { kind: "drive" } as const,
      { kind: "webdav", baseUrl: "https://x/dav", username: "u", password: "p" } as const,
      { kind: "off" } as const,
    ]) {
      const before = { backend, pairing: code };
      const after = parseSyncConfig(serialiseSyncConfig(before));
      check(
        `a ${backend.kind} backend reads back as ${backend.kind}`,
        after.backend.kind === backend.kind,
      );
      check(`and a ${backend.kind} config keeps its pairing code`, after.pairing === code);
    }

    check(
      "an unknown backend from a newer version reads as off, not as a crash",
      parseSyncConfig(JSON.stringify({ backend: { kind: "sftp" }, pairing: code })).backend.kind ===
        "off",
    );
  }

  // ── a unique index on a column that is allowed to be null ─────────────────
  {
    // expenses has UNIQUE(slip_ref), and slip_ref is null for every expense
    // that was typed in rather than scanned — which is nearly all of them.
    //
    // SQLite does not constrain those rows: nulls are distinct in a unique
    // index, so any number of slip-less expenses is legal and always was. The
    // store used to ask about them anyway, with `slip_ref IS ?` and a null
    // bound, which is `IS NULL`, which matches every one of them. It concluded
    // they were all the same expense, kept whichever uuid sorted first, and
    // filed the rest as tombstones. Those tombstones then synced, so the other
    // device deleted its copies too.
    //
    // Nothing errored. The rows were just gone, and which ones survived was
    // decided by random uuids. The existing echo check missed it because it
    // seeds one task and no expenses at all, and because it measures the folder
    // only after the first exchange has already happened.
    const cloud = new MemoryStorage();
    const a = await makeDevice();
    const b = await makeDevice();

    const ins = a.db.raw.prepare(
      "INSERT INTO expenses (amount, category, note, date, slip_ref) VALUES (?, ?, ?, ?, ?)",
    );
    ins.run(1200, "food", "dog food", "2026-08-16", null);
    ins.run(60.5, "food", "", "2026-08-16", null);
    ins.run(90, "transport", "", "2026-08-16", null);

    await runSync(cloud, a);
    const first = await runSync(cloud, b);

    check("a device's first sync pushes nothing back", first.pushed === 0);
    check("and writes no file for it", first.wrote === null);
    check(
      "every slip-less expense survives the trip",
      rows(b.db, "SELECT * FROM expenses WHERE deleted = 0").length === 3,
    );

    await runSync(cloud, a);
    check(
      "and none of them is deleted back on the sender",
      rows(a.db, "SELECT * FROM expenses WHERE deleted = 0").length === 3,
    );
  }

  // ── but the same slip really scanned on both devices still settles ─────────
  {
    // The rule above must not become "stop checking". A slip_ref that is
    // actually set is a real natural key, and two rows holding it is exactly
    // the collision the clash rule exists to absorb — without it SQLite refuses
    // the insert, apply throws, and sync stops for good.
    const cloud = new MemoryStorage();
    const a = await makeDevice();
    const b = await makeDevice();

    const ins = (d: { db: NodeDb }, amount: number) =>
      d.db.raw
        .prepare("INSERT INTO expenses (amount, category, note, date, slip_ref) VALUES (?, ?, ?, ?, ?)")
        .run(amount, "food", "", "2026-08-16", "slip-abc");
    ins(a, 1200);
    ins(b, 1250);

    await runSync(cloud, a);
    await runSync(cloud, b);
    await runSync(cloud, a);
    await runSync(cloud, b);

    const la = rows(a.db, "SELECT * FROM expenses WHERE deleted = 0");
    const lb = rows(b.db, "SELECT * FROM expenses WHERE deleted = 0");
    check("one row holds the slip on each device", la.length === 1 && lb.length === 1);
    check("and both devices kept the same one", la[0]?.uid === lb[0]?.uid);
    check(
      "the loser is a tombstone, not a hole",
      rows(a.db, "SELECT * FROM expenses").length === 2,
    );
    check(
      "and it let go of the slip so nothing else collides with it",
      rows(a.db, "SELECT * FROM expenses WHERE deleted = 1")[0]?.slip_ref !== "slip-abc",
    );
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
    // There is deliberately nothing else to compare. What has been sent used to
    // live in this blob as a timestamp; it lives in sync_outbox now, so the
    // blob carrying it across a restart is no longer what makes the next line
    // true.
    check("the queue is empty once everything has been sent",
      rows(a.db, "SELECT * FROM sync_outbox").length === 0);

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
    // The settings that were promoted out of app_settings are ordinary rows in
    // an ordinary table, and the rule that guards the pairing key must not be
    // reading their names as if they were still in there with it.
    check("a promoted setting is not caught by the app_settings rule",
      keepInBackup("user_settings", { key: QUIET_KEY, value: "{}" }));
    check("an ordinary setting is kept", keepInBackup("app_settings", { key: "currency", value: "THB" }));
    for (const k of MACHINE_ONLY_SETTINGS) {
      check(`${k} never reaches the file`, !keepInBackup("app_settings", { key: k, value: "..." }));
    }

    // Named one by one as well as walked as a set. The set is what the code
    // uses; these are the three the reasoning in config.ts is actually about,
    // and a rename that quietly drops one of them from the set would otherwise
    // leave this loop passing over a shorter list.
    check("the device identity stays on the machine that owns it",
      !keepInBackup("app_settings", { key: "sync_state_v1", value: "{}" }));
    check("the pairing code, which is the encryption key, never leaves with the data",
      !keepInBackup("app_settings", { key: "sync_config_v1", value: "{}" }));
    check("and neither does a live Google refresh token",
      !keepInBackup("app_settings", { key: "sync_google_tokens", value: "{}" }));
    check("all three are in the set, so the loop above is walking the whole list",
      MACHINE_ONLY_SETTINGS.size === 3);

    // ── every key the app writes, matched against the list that classifies it ──
    //
    // Both leaks this project has had went the same way. The API keys, because
    // backup.ts knew a name aiProviders had stopped using. The Google refresh
    // token, because the table side listed what to exclude rather than what
    // exists. In each case the default was "copy it", and the thing that made
    // the default dangerous was that nothing enumerated the alternatives.
    //
    // So this reads the source rather than a list somebody keeps up. A key with
    // no line in storageKeys fails here, and a line for a key the source no
    // longer contains fails too — that second one is the orphan case: a feature
    // removed, its key left behind on every machine that ran the old build, and
    // copied into every backup from then on.
    {
      // Relative to where this is run from, the same way schemaPath is: the
      // compiled copy lives under node_modules/.cache, so __dirname points at
      // somewhere with no source in it.
      const dir = path.resolve("src");
      const found = new Set<string>();
      const usedNames = new Set<string>();
      const walk = (p: string) => {
        for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
          const full = path.join(p, entry.name);
          if (entry.isDirectory()) { walk(full); continue; }
          if (!/\.tsx?$/.test(entry.name)) continue;
          // Not the list itself. Reading it would make every entry find
          // itself, and the orphan half of this check would pass for ever
          // while never having looked at anything.
          if (entry.name === "storageKeys.ts") continue;
          const text: string = fs.readFileSync(full, "utf8");
          for (const m of text.matchAll(/gamesched_[a-z0-9_]*/g)) found.add(m[0]);
          // The runtime-built ones, written as `${PREFIX}_thing` rather than as
          // a literal. Without this half, every key in storageKeys itself reads
          // as an orphan.
          for (const m of text.matchAll(/\$\{PREFIX\}(_[a-z0-9_]*)/g)) found.add("gamesched" + m[1]);
          // And the identifiers, for keys used the tidy way: imported by name
          // rather than retyped as a string.
          for (const m of text.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)) usedNames.add(m[1]);
        }
      };
      walk(dir);
      // `gamesched_` on its own is the prefix constant, not a key.
      found.delete("gamesched_");

      const unclassified = [...found].filter(k => !isKnownKey(k)).sort();
      check(`every key in the source has a line in storageKeys${unclassified.length ? " — missing: " + unclassified.join(", ") : ""}`,
        unclassified.length === 0);

      // A key is in use if its text appears somewhere, OR if the constant that
      // declares it is referenced somewhere. The second half was missing and
      // the check said so immediately: the first key added after it went in was
      // used properly, through its exported constant, and read as orphaned.
      //
      // Which is the better way to write it. A scanner that only understands
      // copied string literals rewards copying string literals.
      const declared = fs.readFileSync(path.join(dir, "lib", "storageKeys.ts"), "utf8");
      const named = new Map<string, string>();
      for (const m of declared.matchAll(
        /export const (\w+)\s*=\s*`\$\{PREFIX\}(_[a-z0-9_]*)`/g,
      )) {
        named.set("gamesched" + m[2], m[1]);
      }

      // Prefix entries are exempt from the orphan half: the whole reason they
      // are prefixes is that the rest is built at runtime, so there is no
      // literal anywhere for a scanner to find.
      const orphans = KNOWN_KEYS
        .filter(k => !k.endsWith("_"))
        .filter(k => !found.has(k))
        .filter(k => {
          const constant = named.get(k);
          return !constant || !usedNames.has(constant);
        })
        .sort();
      check(`every line in storageKeys is a key something still writes${orphans.length ? " — orphaned: " + orphans.join(", ") : ""}`,
        orphans.length === 0);

      // And the two that must never reach the file, asked by name rather than
      // only through the predicate that decides it.
      check("an API key is not written into a backup",
        sanitizeForBackup("gamesched_ai_key_gemini", "AIza-live") === null
        && sanitizeForBackup("gamesched_gemini_key", "AIza-live") === null);
      check("neither is the card of names and numbers",
        sanitizeForBackup("gamesched_important_v1", '{"contacts":[{"label":"a","value":"08x"}]}') === null);
      check("the parse log travels without the sentences",
        sanitizeForBackup("gamesched_ai_log_v1", '[{"text":"coffee 60","intent":"log"}]')
          === '[{"text":"","intent":"log"}]');
      check("and an ordinary setting is copied unchanged",
        sanitizeForBackup("gamesched_lang_v1", "th") === "th");
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

  // ── a device whose clock runs ahead cannot freeze the other one ───────────
  {
    // The bug the outbox exists for, and the only one in this file that leaves
    // no trace at all when it happens.
    //
    // "What have I not sent" used to be answered by comparing updated_at to a
    // watermark, and the watermark was moved to the newest timestamp the run
    // had looked at — rows pulled from the other device included. Those carry
    // the other device's clock. One device an hour ahead therefore pushed the
    // other's watermark an hour into the future, and every local edit made in
    // that hour was stamped by its own clock, landed below the watermark, and
    // was never sent. No error, no retry, and the two databases quietly stopped
    // agreeing until real time caught up.
    const cloud = new MemoryStorage();
    const a = await makeDevice();
    const b = await makeDevice();

    // b is an hour fast. Not contrived: two machines agreeing on the
    // millisecond is the thing that does not happen.
    b.db.raw.prepare("UPDATE sync_clock SET t = ? WHERE id = 1").run(
      new Date(Date.now() + 60 * 60 * 1000).toISOString().replace("Z", "Z"),
    );
    b.db.raw
      .prepare("INSERT INTO tasks (name, reset_type, is_active) VALUES (?, ?, 1)")
      .run("from the fast one", "daily");

    await runSync(cloud, b);
    await runSync(cloud, a);
    check(
      "the fast device's row arrives",
      rows(a.db, "SELECT * FROM tasks WHERE deleted = 0").length === 1,
    );

    // Now the slow device makes its own change, stamped by its own clock, which
    // is an hour behind everything it just took in.
    a.db.raw
      .prepare("INSERT INTO tasks (name, reset_type, is_active) VALUES (?, ?, 1)")
      .run("from the slow one", "daily");

    const out = await runSync(cloud, a);
    check("a local edit is still sent after taking in a future timestamp", out.pushed === 1);

    await runSync(cloud, b);
    check(
      "and it reaches the other device",
      rows(b.db, "SELECT * FROM tasks WHERE deleted = 0 AND name = 'from the slow one'").length === 1,
    );

    const idle = await runSync(cloud, a);
    check("while an idle run still sends nothing", idle.pushed === 0 && idle.wrote === null);
  }

  // ── ticking done, which is the write both devices will actually make ──────
  //
  // Everything above proves rows travel. This proves the one row that will be
  // written on both sides at once does, because that is what the notification
  // is for: it goes off on the phone, it is ticked there, and the desktop must
  // not hand back the version from before the tick.
  //
  // The statement is the desktop's own markTaskCompleted, spelled by uid rather
  // than by local id because that is the only name the phone can use.
  {
    const cloud = new MemoryStorage();
    const a = await makeDevice();
    const b = await makeDevice();

    a.db.raw
      .prepare("INSERT INTO tasks (name, reset_type, is_active) VALUES (?, ?, 1)")
      .run("blood pressure meds", "daily");
    await runSync(cloud, a);
    await runSync(cloud, b);

    const uid = rows(b.db, "SELECT uid FROM tasks")[0].uid as string;
    b.db.raw
      .prepare("UPDATE tasks SET completed_until = ?, missed_streak = 0 WHERE uid = ?")
      .run("2026-08-19T09:00:00.000Z", uid);

    check(
      "ticking done queues the row without anyone saying so",
      rows(b.db, "SELECT * FROM sync_outbox WHERE tbl = 'tasks' AND uid = ?", [uid]).length === 1,
    );

    // Meanwhile the other device renames it, which is the case that decides
    // whether the completion group is doing its job: the name is newer, so it
    // wins the row, and the completion still has to survive.
    //
    // WHY THE CLOCK IS PUSHED FORWARD BY HAND FIRST
    //
    // Written without this, the two writes land in the same millisecond often
    // enough that the check failed about one run in three — and failed
    // correctly. LWW here is per row, not per field, so when the rename is not
    // strictly newer the tick's whole row wins and the rename is genuinely
    // gone. That is the trade this design took knowingly, and a check that
    // trips over it at random is testing the trade rather than the thing it
    // was written for. Forcing the order pins the question this is about: with
    // the rename winning the row, does the completion still survive.
    a.db.raw.prepare("UPDATE sync_clock SET t = ? WHERE id = 1")
      .run(new Date(Date.now() + 60_000).toISOString());
    a.db.raw.prepare("UPDATE tasks SET name = ? WHERE uid = ?").run("ยาความดัน", uid);

    await runSync(cloud, b);
    await runSync(cloud, a);
    await runSync(cloud, b);

    const back = rows(a.db, "SELECT name, completed_until FROM tasks WHERE uid = ?", [uid])[0];
    check("the tick reaches the other device", back.completed_until === "2026-08-19T09:00:00.000Z");
    check("and the rename made at the same time is not lost", back.name === "ยาความดัน");

    const mirror = rows(b.db, "SELECT name, completed_until FROM tasks WHERE uid = ?", [uid])[0];
    check("both devices end up holding the same row",
      mirror.name === back.name && mirror.completed_until === back.completed_until);

    const quiet = await runSync(cloud, a);
    check("and nothing is left queued afterwards", quiet.pushed === 0 &&
      rows(a.db, "SELECT * FROM sync_outbox").length === 0);
  }

  // ── a column one device has never heard of ───────────────────────────────
  //
  // The version gap, made real: device A has grown a column, device B has not.
  // Before this round B could only ever receive, so dropping the column cost
  // nothing on the way back. B ticks things done now, which means B pushes,
  // which means B is capable of handing A a row with a value quietly missing
  // from it — a value neither person edited and nobody would be told about.
  {
    const cloud = new MemoryStorage();
    const a = await makeDevice();
    const b = await makeDevice();

    // A is the newer build. Only A has this column.
    //
    // The store is reopened afterwards on purpose: it reads the shape of every
    // table once, at open, and a column added to the table behind a store that
    // is already running is a column that store will never send. Which is the
    // real thing too — the schema changes when the app starts, not while it is
    // running.
    a.db.raw.prepare("ALTER TABLE tasks ADD COLUMN mood_after INTEGER").run();
    a.store = await SqlLocalStore.open(a.db);

    a.db.raw
      .prepare("INSERT INTO tasks (name, reset_type, is_active, mood_after) VALUES (?, ?, 1, ?)")
      .run("เดินเล่น", "daily", 3);
    await runSync(cloud, a);
    await runSync(cloud, b);

    const uid = rows(b.db, "SELECT uid FROM tasks")[0].uid as string;
    check(
      "the older device takes the row in and says what it could not hold",
      rows(b.db, "SELECT name FROM tasks WHERE uid = ?", [uid])[0].name === "เดินเล่น",
    );
    check(
      "and keeps the column it cannot read, rather than dropping it",
      rows(b.db, "SELECT cols FROM sync_spill WHERE tbl = 'tasks' AND uid = ?", [uid]).length === 1,
    );

    // Now the older device does the one thing it learned to do this round.
    b.db.raw
      .prepare("UPDATE tasks SET completed_until = ?, missed_streak = 0 WHERE uid = ?")
      .run("2026-08-19T09:00:00.000Z", uid);
    await runSync(cloud, b);
    await runSync(cloud, a);

    const back = rows(a.db, "SELECT completed_until, mood_after FROM tasks WHERE uid = ?", [uid])[0];
    check("the tick made on the older device arrives", back.completed_until === "2026-08-19T09:00:00.000Z");
    check("and the column the older device cannot read survives the trip", back.mood_after === 3);

    // And it must not cost a batch a run, for ever, by looking different from
    // the copy the far side holds.
    const quiet = await runSync(cloud, b);
    check("a row carrying a spill is not re-sent every run", quiet.pushed === 0 && quiet.wrote === null);

    // A tombstone has no body, so nothing may be re-attached to it later.
    //
    // Stamped from A's own clock rather than from a date typed in here. This
    // line used to read "2026-08-20T00:00:00.000Z", which worked until the day
    // that stopped being in the future — and then B's ordinary copy, stamped
    // with the real time, beat the tombstone and the spill was never cleared.
    // A test with a use-by date on it is worse than no test, because it goes
    // green for a year first.
    //
    // A has already pulled everything B wrote, and a device's clock is never
    // behind what it has been told, so this is newer than B's copy by
    // construction rather than by arithmetic.
    a.db.raw.prepare("UPDATE tasks SET deleted = 1, updated_at = ? WHERE uid = ?")
      .run(await dbNow(a.db), uid);
    await runSync(cloud, a);
    await runSync(cloud, b);
    check(
      "a deleted row keeps no columns beside it",
      rows(b.db, "SELECT cols FROM sync_spill WHERE tbl = 'tasks' AND uid = ?", [uid]).length === 0,
    );
  }

  // ── taking a tick back ────────────────────────────────────────────────────
  //
  // The bug this column exists for. Completion used to be decided by whichever
  // side reached further, which protects a tick and makes UNDOING one
  // impossible: clearing it writes a value that is behind the old one by
  // definition, so the other device's copy won, came back, and was pushed
  // again. Deterministic, not a race, and syncing more often only made it
  // happen faster.
  {
    const cloud = new MemoryStorage();
    const a = await makeDevice();
    const b = await makeDevice();

    a.db.raw.prepare("INSERT INTO tasks (name, reset_type, is_active) VALUES (?, ?, 1)")
      .run("fgo dailies", "daily");
    await runSync(cloud, a);
    await runSync(cloud, b);
    const uid = rows(b.db, "SELECT uid FROM tasks")[0].uid as string;

    // Ticked on one device, seen on the other.
    b.db.raw.prepare("UPDATE tasks SET completed_until = ?, completed_at = ?, missed_streak = 0 WHERE uid = ?")
      .run("2026-08-19T04:00:00.000Z", "2026-08-18T10:00:00.000Z", uid);
    await runSync(cloud, b);
    await runSync(cloud, a);
    check("the tick reaches the other device",
      rows(a.db, "SELECT completed_until FROM tasks WHERE uid = ?", [uid])[0].completed_until
        === "2026-08-19T04:00:00.000Z");

    // And taken back on the device that did not tick it.
    a.db.raw.prepare("UPDATE tasks SET completed_until = NULL, completed_at = ? WHERE uid = ?")
      .run("2026-08-18T11:00:00.000Z", uid);
    await runSync(cloud, a);
    await runSync(cloud, b);
    check("taking the tick back reaches the other device too",
      rows(b.db, "SELECT completed_until FROM tasks WHERE uid = ?", [uid])[0].completed_until === null);

    // The half that matters: the device that still remembers the tick must not
    // hand it back on the next run, which is what made this unfixable by
    // pressing sync again.
    await runSync(cloud, b);
    await runSync(cloud, a);
    check("and the old tick is not handed back on the next run",
      rows(a.db, "SELECT completed_until FROM tasks WHERE uid = ?", [uid])[0].completed_until === null);

    // A device that renames the task has not touched the tick, so its stale
    // completion must still lose — the property the old rule existed for.
    b.db.raw.prepare("UPDATE tasks SET completed_until = ?, completed_at = ? WHERE uid = ?")
      .run("2026-08-19T04:00:00.000Z", "2026-08-18T12:00:00.000Z", uid);
    a.db.raw.prepare("UPDATE sync_clock SET t = ? WHERE id = 1")
      .run(new Date(Date.now() + 60_000).toISOString());
    a.db.raw.prepare("UPDATE tasks SET name = ? WHERE uid = ?").run("เอฟจีโอ", uid);
    await runSync(cloud, b);
    await runSync(cloud, a);
    const both = rows(a.db, "SELECT name, completed_until FROM tasks WHERE uid = ?", [uid])[0];
    check("a rename does not undo a tick it never touched",
      both.name === "เอฟจีโอ" && both.completed_until === "2026-08-19T04:00:00.000Z");
  }

  // ── the history, which is the only thing that remembers ──────────────────
  //
  // `completed_until` is one field that gets overwritten every cycle, so
  // yesterday leaves no trace in it. These rows are the trace, and because they
  // are append-only they are also the easiest thing in the schema to sync:
  // merging two devices' events is a union with nothing to negotiate.
  {
    const cloud = new MemoryStorage();
    const a = await makeDevice();
    const b = await makeDevice();

    a.db.raw.prepare("INSERT INTO tasks (name, reset_type, is_active) VALUES (?, ?, 1)")
      .run("fgo dailies", "daily");
    await runSync(cloud, a);
    await runSync(cloud, b);
    const uid = rows(a.db, "SELECT uid FROM tasks")[0].uid as string;

    // Two ticks a day apart, and an undo in between, each written on whichever
    // device happened to be to hand.
    a.db.raw.prepare("INSERT INTO task_events (task_uid, kind, at, for_cycle) VALUES (?,?,?,?)")
      .run(uid, "done", "2026-08-18T03:10:00.000Z", "2026-08-19T04:00:00.000Z");
    b.db.raw.prepare("INSERT INTO task_events (task_uid, kind, at, for_cycle) VALUES (?,?,?,?)")
      .run(uid, "undone", "2026-08-18T03:20:00.000Z", null);
    a.db.raw.prepare("INSERT INTO task_events (task_uid, kind, at, for_cycle) VALUES (?,?,?,?)")
      .run(uid, "done", "2026-08-19T05:00:00.000Z", "2026-08-20T04:00:00.000Z");

    await runSync(cloud, a);
    await runSync(cloud, b);
    await runSync(cloud, a);

    const onA = rows(a.db, "SELECT kind, at FROM task_events ORDER BY at");
    const onB = rows(b.db, "SELECT kind, at FROM task_events ORDER BY at");
    check("every event reaches both devices", onA.length === 3 && onB.length === 3);
    check("and in the same order on each",
      JSON.stringify(onA) === JSON.stringify(onB));
    check("an undo is kept rather than erasing the tick before it",
      onA.map(r => r.kind).join(",") === "done,undone,done");

    // Append-only means nothing to negotiate, so syncing again must be silent.
    const quiet = await runSync(cloud, a);
    check("history does not churn once it has settled",
      quiet.pushed === 0 && quiet.wrote === null);

    // And a day can be asked about, which is the entire point of the table.
    const thatDay = rows(
      a.db,
      "SELECT kind FROM task_events WHERE at >= ? AND at < ? ORDER BY at",
      ["2026-08-18T00:00:00.000Z", "2026-08-19T00:00:00.000Z"],
    );
    check("a single day can be read back out", thatDay.length === 2);

    // ── the one question this table is allowed to answer ────────────────────
    //
    // Run against the real table, because the risk here is the same one that
    // took the phone's task list down: a column name inside a string literal
    // that nothing checks. `deleted` in particular only exists on this table
    // because of the tombstone migration.
    const events = rows(a.db, HISTORY_SQL, [uid]) as unknown as TaskEvent[];
    check("the history query runs and comes back newest first",
      events.length === 3 && events[0].at > events[2].at);

    // The undo above carries no for_cycle, which is what an older row looks
    // like, so both ticks stand. Nothing here counts anything.
    const dates = doneDates(events);
    check("it answers with days rather than a number of them",
      dates.length === 2 && dates[0] === "2026-08-19" && dates[1] === "2026-08-18");

    // Now an undo that names the occurrence it undid. That tick did not happen.
    a.db.raw.prepare("INSERT INTO task_events (task_uid, kind, at, for_cycle) VALUES (?,?,?,?)")
      .run(uid, "undone", "2026-08-19T06:00:00.000Z", "2026-08-20T04:00:00.000Z");
    const after = doneDates(rows(a.db, HISTORY_SQL, [uid]) as unknown as TaskEvent[]);
    check("a tick that was taken back is not a day it was done",
      after.length === 1 && after[0] === "2026-08-18");

    check("and a daily is not offered an answer at all, because that is a streak",
      !hasHistory("daily") && !hasHistory("specific_date") && hasHistory("weekly"));
  }

  // ── the folder cleans itself up under a device that was away ──────────────
  //
  // The one block in this file where the failure being tested for is a deletion
  // this code performs on purpose. Everything else can be re-run; a file that
  // has been removed from the folder is gone.
  //
  // Device B syncs once and then does not sync again for a hundred batches. By
  // the time it wakes up, every file it stopped at has been deleted by A. What
  // makes that safe is not that B notices — it does not, and there is nothing to
  // notice — but that A never deletes below a snapshot of its own, so whatever
  // is left in the folder is a complete copy plus everything since.
  {
    const cloud = new MemoryStorage();
    const a = await makeDevice();
    const b = await makeDevice();

    a.db.raw.prepare("INSERT INTO tasks (name, reset_type, is_active) VALUES (?, ?, 1)")
      .run("\u0e22\u0e32\u0e04\u0e27\u0e32\u0e21\u0e14\u0e31\u0e19", "daily");
    a.db.raw.prepare("INSERT INTO expenses (amount, category, note, date) VALUES (?, ?, ?, ?)")
      .run(1200, "food", "ค่าอาหารหมา", "2026-08-14");
    await runSync(cloud, a);
    await runSync(cloud, b);
    check("the sleeping device starts in step",
      rows(b.db, "SELECT uid FROM tasks").length === 1 &&
      rows(b.db, "SELECT uid FROM expenses").length === 1);

    const asleepAt = (await b.store.loadState()).cursor[a.store.device] ?? 0;
    const expenseUid = rows(a.db, "SELECT uid FROM expenses")[0].uid as string;

    // Everything that happens while B is in a drawer, including the deletion,
    // which is the row that would come back from the dead if a snapshot carried
    // only live rows.
    await a.store.softDelete("expenses", expenseUid);

    for (let i = 1; i <= 100; i++) {
      a.db.raw.prepare("INSERT INTO tasks (name, reset_type, is_active) VALUES (?, ?, 1)")
        .run(`งาน ${i}`, "daily");
      await runSync(cloud, a);
    }
    // A few runs with nothing new to say, which is where a prune that ran out of
    // its per-run budget finishes.
    for (let i = 0; i < 4; i++) await runSync(cloud, a);

    const mine = [...cloud.files.keys()].filter((n) => n.startsWith(`${a.store.device}-`));
    const seqOf = (n: string) => Number(n.slice(a.store.device.length + 1, -".reup".length));
    check("the folder is bounded rather than cumulative", mine.length < 101);
    check("and the files the sleeping device stopped at are gone",
      Math.min(...mine.map(seqOf)) > asleepAt);
    check("and a device only ever deletes its own",
      [...cloud.files.keys()].every((n) => n.startsWith(`${a.store.device}-`)));

    // B has no idea any of that happened. Its cursor still points into the hole.
    check("the sleeping device noticed nothing",
      ((await b.store.loadState()).cursor[a.store.device] ?? 0) === asleepAt);

    await runSync(cloud, b);
    await runSync(cloud, a);
    await runSync(cloud, b);

    check("it still ends up with every row",
      rows(b.db, "SELECT uid FROM tasks").length ===
      rows(a.db, "SELECT uid FROM tasks").length);
    check("including the hundred announced only in files that are gone",
      rows(b.db, "SELECT uid FROM tasks WHERE is_active = 1").length === 101);
    check("and the deletion made in the same window is not undone",
      row(b.db, "SELECT deleted FROM expenses WHERE uid = ?", [expenseUid])?.deleted === 1);
    check("nor does the desktop get the deleted row back",
      row(a.db, "SELECT deleted FROM expenses WHERE uid = ?", [expenseUid])?.deleted === 1);

    const quiet = await runSync(cloud, a);
    check("and the two of them settle rather than trading snapshots",
      quiet.pushed === 0 && quiet.wrote === null);
  }

  // ── the settings that belong to a person ──────────────────────────────────
  //
  // The named bug: the phone had a hardcoded 23:00 to 08:00 because there was
  // no way for it to learn what night means here, and Repo.kt says so in a
  // comment. What makes that fixable is that the row is in a table the sync
  // layer already reads, rather than behind a rule about key names.
  {
    const cloud = new MemoryStorage();
    const a = await makeDevice();
    const b = await makeDevice();

    await writeSetting(a.db, QUIET_KEY, JSON.stringify({ enabled: true, start: "23:30", end: "07:00" }));
    await runSync(cloud, a);
    await runSync(cloud, b);

    const onB = parseQuiet((await readSettings(b.db)).get(QUIET_KEY));
    check("quiet hours reach the other device",
      onB.kind === "window" && onB.start === "23:30" && onB.end === "07:00");

    // Off has to arrive as off. A device that reads it as "nothing stored" puts
    // its own default night back, which is an alarm at four in the morning on
    // somebody who explicitly turned quiet hours off.
    await writeSetting(a.db, QUIET_KEY, JSON.stringify({ enabled: false, start: "23:30", end: "07:00" }));
    await runSync(cloud, a);
    await runSync(cloud, b);
    check("turning them off is not the same as never having said",
      parseQuiet((await readSettings(b.db)).get(QUIET_KEY)).kind === "off");

    // The whole reason this is a second table. app_settings holds the pairing
    // key and the WebDAV password, and a wallpaper path that means nothing on a
    // phone; promoting three settings out of it must not have dragged it along.
    a.db.raw.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?)")
      .run("wallpaper_path", "D:\\\\wallpapers\\\\rain.mp4");
    await runSync(cloud, a);
    await runSync(cloud, b);
    check("nothing from app_settings travels with it",
      rows(b.db, "SELECT key FROM app_settings WHERE key = 'wallpaper_path'").length === 0);
    check("and only the settings that were promoted are in the new table",
      rows(b.db, "SELECT key FROM user_settings").length === 1);

    // A save with nothing changed is a file on the wire, every time, on both
    // devices, for ever. The upsert carries a WHERE for exactly this.
    await writeSetting(a.db, QUIET_KEY, JSON.stringify({ enabled: false, start: "23:30", end: "07:00" }));
    check("a write that changes nothing queues nothing",
      rows(a.db, "SELECT * FROM sync_outbox WHERE tbl = 'user_settings'").length === 0);

    // Both devices pick a currency before either has heard of the other's. The
    // key is unique, so this is the natural-key clash the store already knows
    // how to settle — and settling it is the difference between one currency
    // and a table with two rows nobody chose between.
    await writeSetting(a.db, CURRENCY_KEY, "THB");
    await wait(A_TICK_APART);
    await writeSetting(b.db, CURRENCY_KEY, "USD");
    await runSync(cloud, a);
    await runSync(cloud, b);
    await runSync(cloud, a);
    await runSync(cloud, b);

    const liveA = rows(a.db, "SELECT key, value FROM user_settings WHERE key = ? AND deleted = 0", [CURRENCY_KEY]);
    const liveB = rows(b.db, "SELECT key, value FROM user_settings WHERE key = ? AND deleted = 0", [CURRENCY_KEY]);
    check("two devices inventing the same setting end up with one row",
      liveA.length === 1 && liveB.length === 1);
    check("and they agree which one it is", liveA[0].value === liveB[0].value);
    // Which one, deliberately not asserted. The clash is settled by comparing
    // uids, not clocks, because the two devices have to reach the same answer
    // without trusting each other's time — see incomingLosesClash. So the first
    // convergence of a setting invented twice is arbitrary, once, and then the
    // row has one uid and every later edit is ordinary last-write-wins.
    //
    // Asserting "the later one wins" here passed on this machine about a third
    // of the time, which is the same shape as the test that went green three
    // times before falling over on the first machine that was not this one.
    check("and it is one of the two that were actually set",
      liveA[0].value === "THB" || liveA[0].value === "USD");

    // What matters day to day, and this one is not arbitrary.
    await runSync(cloud, a);
    await runSync(cloud, b);
    await writeSetting(b.db, CURRENCY_KEY, "JPY");
    await runSync(cloud, b);
    await runSync(cloud, a);
    check("once they hold the same row, the later edit wins",
      rows(a.db, "SELECT value FROM user_settings WHERE key = ? AND deleted = 0", [CURRENCY_KEY])[0]
        .value === "JPY");

    const quiet = await runSync(cloud, a);
    check("and settings stop churning once they have settled",
      quiet.pushed === 0 && quiet.wrote === null);
  }

  // ── there is only one schema now ────────────────────────────────────────
  //
  // There used to be two. database.ts wrote out every CREATE and ALTER of its
  // own, and schema.sql wrote them again for the phone and for the throwaway
  // databases below. The check that lived here built one database from each and
  // compared them column for column, and the first time it ran it found
  // tasks.notify_before_min in one and not the other.
  //
  // It was always meant to retire. Its job was to make merging the two provably
  // safe, and once they were merged there was nothing left to compare. What
  // replaces it is the rule that keeps it merged: no SQL that builds a table
  // goes back into that file.
  {
    const source = fs.readFileSync("src/lib/database.ts", "utf8");
    const literals: string[] = [];
    for (const m of source.matchAll(/`([^`]*)`|\'((?:[^\'\\\n]|\\.)*)\'|"((?:[^"\\\n]|\\.)*)"/g)) {
      const t = (m[1] ?? m[2] ?? m[3] ?? "").trim();
      if (/^(CREATE TABLE|CREATE INDEX|CREATE TRIGGER|ALTER TABLE)\b/i.test(t)) literals.push(t);
    }
    check(
      "database.ts keeps no copy of the schema: " + (literals[0] ?? "none"),
      literals.length === 0,
    );
  }

  // ── every table the schema names actually gets built ────────────────────
  //
  // The check that was missing, and the reason it was missing is worth keeping
  // written down: nothing on this machine builds its real database from
  // schema.sql. The desktop builds its own in database.ts and the phone builds
  // from a constant generated out of this file, so a table that never gets
  // created here is invisible to everybody until somebody installs the phone
  // app fresh.
  //
  // That is what happened to app_settings. Statements in schema.sql are
  // separated by a line containing only `-- @@`, because trigger bodies have
  // semicolons in them, and the line between task_events and app_settings had
  // gone missing. The two CREATE TABLE statements arrived as one string, SQLite
  // ran the first and stopped, and the second table was never made. No build
  // broke, no vector moved, nothing was thrown. It sat there for months.
  //
  // Two checks, both about the shape of the file rather than its contents, so
  // they keep working as tables are added.
  {
    const text = fs.readFileSync(schemaPath(), "utf8");
    const named = [...text.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
    check("schema.sql names some tables at all", named.length > 0);

    const d = await makeDevice();
    for (const t of named) {
      const cols = rows(d.db, `PRAGMA table_info(${t})`).map((c: any) => c.name as string);
      check(`${t} is named in schema.sql and exists once it has been run`, cols.length > 0);
    }

    // The direct form of the same thing, which also covers indexes and
    // triggers. Those three words never appear inside a trigger body, so
    // counting them is safe in a way counting semicolons would not be.
    const chunks = text
      .split(/^[ \t]*--[ \t]*@@[ \t]*$/m)
      .map((c) => c.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n").trim())
      .filter((c) => c.length > 0);
    for (const c of chunks) {
      const creates = c.match(/CREATE (?:TABLE|INDEX|TRIGGER)[^(\n]*/g) ?? [];
      check(
        `one statement per chunk: ${creates[0]?.trim() ?? "(none)"}`,
        creates.length <= 1,
      );
    }
  }

  // ── the backup covers what the database holds ───────────────────────────
  //
  // backup.ts cannot be loaded from here — it reaches the database and the
  // language files — so this checks the property that made its list go stale
  // rather than the list itself: every table the sync layer knows about exists,
  // and a table that exists is one an export has to be able to read.
  //
  // The list in backup.ts is now derived from this one, so the two cannot drift
  // again. What is checked here is that this one is complete.
  {
    const d = await makeDevice();
    for (const t of SYNC_TABLES) {
      const cols = rows(d.db, `PRAGMA table_info(${t.name})`).map((c: any) => c.name as string);
      check(`${t.name} exists and is readable`, cols.length > 0);
      check(`${t.name} carries the columns a restored row needs`,
        cols.includes("uid") && cols.includes("updated_at"));
    }
  }

  // ── a task written from a draft, by either device ──────────────────────
  //
  // The column list and the sixteen coercions beside it are about to be
  // reproduced in Kotlin. What rots a list like that is not the other language
  // — vectors hold that side — but this one: a column renamed in schema.sql
  // with nothing pointing back here, and an INSERT that names a column the
  // table no longer has.
  {
    const d = await makeDevice();
    const cols = rows(d.db, "PRAGMA table_info(tasks)").map((c: any) => c.name as string);
    for (const c of TASK_COLUMNS) {
      check(`tasks still has a column called ${c}`, cols.includes(c));
    }

    const draft = {
      name: "\u0e22\u0e32\u0e04\u0e27\u0e32\u0e21\u0e14\u0e31\u0e19",
      reset_type: "weekly",
      reset_day: 0,
      reset_time: "09:00",
      is_priority: true,
      specific_date: "",
    };
    check("a draft the engine can schedule has nothing wrong with it",
      taskProblems(draft).length === 0);

    const marks = TASK_COLUMNS.map(() => "?").join(", ");
    d.db.raw.prepare(`INSERT INTO tasks (${TASK_COLUMNS.join(", ")}) VALUES (${marks})`)
      .run(...taskValues(draft));

    const saved = row(d.db, "SELECT * FROM tasks WHERE name = ?", [draft.name]);
    check("the row lands with the values the draft asked for",
      saved.reset_type === "weekly" && saved.reset_day === 0 &&
      saved.reset_time === "09:00" && saved.is_priority === 1);
    // Sunday is zero. A guard written as a truthiness test drops it, and the
    // symptom is one day of the week that weekly tasks cannot be set to.
    check("Sunday survives being falsy", saved.reset_day === 0);
    check("a blank date is stored as nothing, not as an empty string",
      saved.specific_date === null);
    check("and the triggers gave it an identity without being asked",
      typeof saved.uid === "string" && saved.uid.length > 0 &&
      typeof saved.updated_at === "string");
    check("and queued it for the next sync",
      rows(d.db, "SELECT * FROM sync_outbox WHERE tbl = 'tasks' AND uid = ?", [saved.uid]).length === 1);

    // The edit side of the same list. Column names go into the SQL text rather
    // than being bound, so a name that has drifted out of the schema is not a
    // wrong answer, it is a statement that will not run at all.
    for (const c of Object.keys(TASK_EDITABLE)) {
      check(`tasks still has an editable column called ${c}`, cols.includes(c));
    }

    const edit = taskUpdate({
      name: "\u0e22\u0e32\u0e04\u0e27\u0e32\u0e21\u0e14\u0e31\u0e19 \u0e40\u0e0a\u0e49\u0e32",
      reset_time: "08:00",
      is_priority: false,
      // Not a column. Must never reach the statement — this is the line that
      // stands between an object from a model reply and arbitrary SQL.
      drop_table_tasks: 1,
    });
    check("an unknown key never reaches the statement",
      !edit.columns.includes("drop_table_tasks") && edit.columns.length === 3);
    d.db.raw.prepare(`UPDATE tasks SET ${edit.columns.map((c) => `${c} = ?`).join(", ")} WHERE uid = ?`)
      .run(...edit.values, saved.uid);

    const edited = row(d.db, "SELECT * FROM tasks WHERE uid = ?", [saved.uid]);
    check("the edit lands", edited.reset_time === "08:00" && edited.is_priority === 0);
    check("and the columns it did not name are untouched", edited.reset_day === 0);
    check("and the row is queued again", rows(d.db,
      "SELECT * FROM sync_outbox WHERE tbl = 'tasks' AND uid = ?", [saved.uid]).length === 1);
  }

  // ── the bin, across two devices ───────────────────────────────────
  //
  // The phone can now throw a task away, and it writes the same two columns
  // this does: is_active to take it off the list, deleted_at to say it was
  // discarded rather than finished. Neither of those is the sync layer's
  // `deleted` flag, and that is the point — a task in the bin is a live row
  // that travels, not a tombstone.
  //
  // What is checked here is the property both screens depend on: throwing
  // something away on one device removes it from the other's list without
  // making it unrecoverable on either.
  {
    const cloud = new MemoryStorage();
    const a = await makeDevice();
    const b = await makeDevice();

    a.db.raw.prepare("INSERT INTO tasks (name, reset_type, is_active) VALUES (?, ?, 1)")
      .run("\u0e22\u0e32\u0e04\u0e27\u0e32\u0e21\u0e14\u0e31\u0e19", "daily");
    await runSync(cloud, a);
    await runSync(cloud, b);
    const uid = rows(a.db, "SELECT uid FROM tasks")[0].uid as string;
    check("both devices have it on the list",
      rows(b.db, "SELECT uid FROM tasks WHERE is_active = 1 AND deleted = 0").length === 1);

    // A's clock is pushed ahead first, because that is the situation this fails
    // in and it is not a contrived one.
    //
    // The clock is `max(system time, last value + 1ms)`, so a device that has
    // done more writes than the other inside one tick of the system timer ends
    // up further ahead of it. On Windows that tick is about sixteen
    // milliseconds, which is long enough for a whole sync, and the two devices
    // are then several milliseconds apart with nothing wrong anywhere. Five
    // minutes here rather than five milliseconds only so the test does not
    // depend on the granularity of the machine running it.
    a.db.raw.prepare(
      "UPDATE sync_clock SET t = strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes') WHERE id = 1",
    ).run();

    // Exactly what the phone's deleteTask writes, and what the desktop's does.
    a.db.raw.prepare(
      "UPDATE tasks SET is_active = 0, deleted_at = ? WHERE uid = ? AND is_active = 1 AND deleted = 0",
    ).run(await dbNow(a.db), uid);
    await runSync(cloud, a);
    await runSync(cloud, b);

    const there = row(b.db, "SELECT * FROM tasks WHERE uid = ?", [uid]);
    check("it leaves the other device's list", there.is_active === 0);
    check("without becoming a tombstone", there.deleted === 0);
    check("and it says it was thrown away, not finished", there.deleted_at !== null);
    check("so the other device can still offer it back",
      rows(b.db,
        "SELECT uid FROM tasks WHERE is_active = 0 AND deleted_at IS NOT NULL AND deleted = 0",
      ).length === 1);

    // Restoring is the desktop's own statement, and it has to travel too, or
    // undeleting something would look like it worked and then come back.
    //
    // B has never had a reason to move its own clock that far. What stops the
    // restore being stamped older than the deletion it undoes is that applying
    // A's row moved B's clock up to meet it. Without that, this write travels
    // and is thrown away at the far end with nothing reported anywhere.
    b.db.raw.prepare(
      "UPDATE tasks SET is_active = 1, deleted_at = NULL WHERE uid = ? AND deleted = 0",
    ).run(uid);
    await runSync(cloud, b);
    await runSync(cloud, a);
    check("and undeleting travels back the other way",
      row(a.db, "SELECT * FROM tasks WHERE uid = ?", [uid]).is_active === 1);
    check("because a device's clock never sits behind what it has been told",
      row(b.db, "SELECT t FROM sync_clock WHERE id = 1").t >=
        row(b.db, "SELECT updated_at FROM tasks WHERE uid = ?", [uid]).updated_at);
  }

  // ── an expense recorded away from the desk ──────────────────────────
  //
  // The phone is about to be able to do this, so the column list and the six
  // coercions beside it are about to exist in Kotlin too. Vectors hold that
  // side. What rots a list like this is the other direction: a column renamed
  // in schema.sql with nothing pointing back at the INSERT that names it.
  {
    const cloud = new MemoryStorage();
    const a = await makeDevice();
    const b = await makeDevice();

    const cols = rows(a.db, "PRAGMA table_info(expenses)").map((c: any) => c.name as string);
    for (const c of EXPENSE_COLUMNS) {
      check(`expenses still has a column called ${c}`, cols.includes(c));
    }

    // Seeded here, because schema.sql builds the table and the app fills it on
    // first run. An empty list is not a broken fixture either — it is what a
    // database looks like before the app has ever opened it, and everything
    // then files under `other`, which is the behaviour and not a bug.
    for (const [i, key] of ["food", "transport", "other"].entries()) {
      a.db.raw.prepare(
        "INSERT INTO expense_categories (key, emoji, sort_order) VALUES (?, ?, ?)",
      ).run(key, "\u{1F4E6}", i);
    }
    const known = rows(a.db, "SELECT key FROM expense_categories").map((r: any) => r.key as string);
    const draft = {
      amount: "60",
      currency: "THB",
      category: "food",
      note: "\u0e01\u0e32\u0e41\u0e1f",
      date: "2026-08-19",
    };
    check("a draft the books can hold has nothing wrong with it",
      expenseProblems(draft, known).length === 0);

    const marks = EXPENSE_COLUMNS.map(() => "?").join(", ");
    const insert = `INSERT INTO expenses (${EXPENSE_COLUMNS.join(", ")}) VALUES (${marks})`;
    a.db.raw.prepare(insert).run(...expenseValues(draft, known));

    const saved = row(a.db, "SELECT * FROM expenses WHERE note = ?", [draft.note]);
    check("the row lands with the amount and the unit it was counted in",
      saved.amount === 60 && saved.currency === "THB" && saved.category === "food");
    // Null rather than "", because the unique index tolerates any number of
    // nulls and exactly one of each string. Two manual entries writing "" would
    // collide from the second one onwards.
    check("a manual entry leaves the slip reference empty, not blank",
      saved.slip_ref === null);
    a.db.raw.prepare(insert).run(...expenseValues({ ...draft, note: "\u0e19\u0e49\u0e33" }, known));
    check("so a second one can be recorded the same minute",
      rows(a.db, "SELECT id FROM expenses").length === 2);

    // An unknown category is filed, not refused. Somebody standing at a counter
    // should not lose a number because a label was renamed on the other device.
    a.db.raw.prepare(insert)
      .run(...expenseValues({ ...draft, category: "gadgets", note: "x" }, known));
    check("an unknown category is filed under other rather than losing the row",
      row(a.db, "SELECT category FROM expenses WHERE note = 'x'").category === "other");

    await runSync(cloud, a);
    await runSync(cloud, b);
    check("and spending recorded on one device reaches the other",
      rows(b.db, "SELECT id FROM expenses WHERE deleted = 0").length === 3);
    check("with the unit it was counted in, not the reader's",
      row(b.db, "SELECT currency FROM expenses WHERE note = ?", [draft.note]).currency === "THB");

    // The three statements a phone screen asks the month with, run against a
    // real database rather than read. A query that names a column the table
    // does not have is not a wrong answer, it is a statement that will not run.
    b.db.raw.prepare(insert)
      .run(...expenseValues({ ...draft, amount: "40", currency: "USD", note: "usd" }, known));
    b.db.raw.prepare(
      "INSERT INTO income (amount, source, note, date, currency) VALUES (?, ?, ?, ?, ?)",
    ).run(6516, "TELUS", "", "2026-08-19", "THB");

    const spent = row(b.db, SQL_MONTH_SPENT, ["THB", "2026-08"]).total as number;
    const got = row(b.db, SQL_MONTH_RECEIVED, ["THB", "2026-08"]).total as number;
    const others = row(b.db, SQL_MONTH_OTHER_COUNT, ["THB", "2026-08", "THB", "2026-08"]).n as number;
    // Three at sixty, all in baht. The fourth is in dollars and is the one
    // that has to be counted separately rather than added in.
    check("the month adds up in one unit at a time", spent === 180 && got === 6516);
    check("and says how many rows it left out rather than filtering in silence",
      others === 1);

    // ─── the list under that line ────────────────────────────────────────────
    //
    // A total cannot say the same coffee went in twice: two identical rows move
    // it by exactly what one row for twice the price would. So the list is not
    // decoration on the summary, it is the part of the question the summary
    // cannot answer.
    //
    // And unlike the three above, it does NOT filter by unit — every row prints
    // the unit it was counted in, so nothing is being added together. Which
    // makes it the place the rows those totals left out become visible instead
    // of merely counted.
    b.db.raw.prepare(insert).run(
      ...expenseValues({ ...draft, amount: "12", note: "\u0e40\u0e01\u0e48\u0e32", date: "2026-07-02" }, known),
    );
    b.db.raw.prepare(insert).run(
      ...expenseValues({ ...draft, amount: "99", note: "\u0e17\u0e34\u0e49\u0e07", date: "2026-08-19" }, known),
    );
    b.db.raw.prepare("UPDATE expenses SET deleted = 1 WHERE note = ?")
      .run("\u0e17\u0e34\u0e49\u0e07");

    const recent = rows(b.db, SQL_RECENT_MONEY);
    check("the list carries both directions and every unit, unlike the totals",
      recent.length === 6
      && recent.some((r: any) => r.kind === "in" && r.amount === 6516)
      && recent.some((r: any) => r.kind === "out" && r.currency === "USD"));
    check("with the name on a payment where a category would be",
      recent.find((r: any) => r.kind === "in").tag === "TELUS"
      && recent.some((r: any) => r.kind === "out" && r.tag === "food"));
    check("newest day first, and a row that was deleted is not in it at all",
      recent[0].date === "2026-08-19"
      && recent[recent.length - 1].date === "2026-07-02"
      && !recent.some((r: any) => r.note === "\u0e17\u0e34\u0e49\u0e07"));

    // The cap is inside the statement rather than beside it, so this is the
    // only place either side could disagree about what "lately" means.
    for (let i = 0; i < 20; i++) {
      b.db.raw.prepare(insert).run(
        ...expenseValues({ ...draft, amount: "5", note: `x${i}`, date: "2026-08-20" }, known),
      );
    }
    const capped = rows(b.db, SQL_RECENT_MONEY);
    check("and it stops at twenty rather than growing without end",
      capped.length === 20 && capped.every((r: any) => r.date === "2026-08-20"));

    // ─── taking one back ─────────────────────────────────────────────────────
    //
    // A tombstone rather than a real delete, because a row that simply vanishes
    // tells the other device nothing and comes back on the next sync. What is
    // worth checking is the other half: that the payload goes with it. A row
    // somebody has said they did not want recorded should not keep travelling
    // with the amount and the note still in it.
    const before = row(b.db, SQL_MONTH_SPENT, ["THB", "2026-08"]).total as number;
    const target = row(b.db, "SELECT uid, note FROM expenses WHERE note = ?", [draft.note]);
    b.db.raw.prepare(SQL_DELETE_EXPENSE).run(target.uid);
    const stone = row(b.db, "SELECT * FROM expenses WHERE uid = ?", [target.uid]);
    check("a deleted row stays as a tombstone rather than vanishing",
      stone !== undefined && stone.deleted === 1);
    check("and nothing readable is left in it to travel or be backed up",
      stone.note === "" && stone.amount === 0 && stone.slip_ref === null);

    const incomeUid = row(b.db, "SELECT uid FROM income LIMIT 1").uid;
    b.db.raw.prepare(SQL_DELETE_INCOME).run(incomeUid);
    check("the same is true of a payment, name on it included",
      row(b.db, "SELECT * FROM income WHERE uid = ?", [incomeUid]).source === "");

    // Twice is not a second write. It would only restamp updated_at, which is
    // one more version for the other device to receive and agree with itself
    // about.
    const stamped = row(b.db, "SELECT updated_at FROM expenses WHERE uid = ?", [target.uid]).updated_at;
    b.db.raw.prepare(SQL_DELETE_EXPENSE).run(target.uid);
    check("deleting the same row twice does not write a second version",
      row(b.db, "SELECT updated_at FROM expenses WHERE uid = ?", [target.uid]).updated_at === stamped);

    // And it leaves the totals, which is the point of the flag.
    check("the month stops counting it",
      (row(b.db, SQL_MONTH_SPENT, ["THB", "2026-08"]).total as number) === before - 60);

    // ─── editing one ─────────────────────────────────────────────────────────
    //
    // Built rather than written, so that the desktop's edit form, the AI path
    // and the phone all produce the same statement for the same edit. Run here
    // because a statement built from an allowlist can still name a column the
    // table does not have, and that is not a wrong answer, it is one that will
    // not run.
    const live = row(b.db, "SELECT uid FROM expenses WHERE note = ?", ["\u0e19\u0e49\u0e33"]);
    const one = moneyUpdate("expenses", { amount: "45", note: "\u0e19\u0e49\u0e33\u0e40\u0e1b\u0e25\u0e48\u0e32" });
    b.db.raw.prepare(moneyUpdateSql("expenses", one.columns)).run(...one.values, live.uid);
    const edited = row(b.db, "SELECT * FROM expenses WHERE uid = ?", [live.uid]);
    check("an edit lands on the columns it named and no others",
      edited.amount === 45 && edited.note === "\u0e19\u0e49\u0e33\u0e40\u0e1b\u0e25\u0e48\u0e32"
      && edited.currency === "THB" && edited.category === "food");
    check("and it counts as a new version, so the other device hears about it",
      edited.updated_at !== null && edited.deleted === 0);

    // A row already gone stays gone. Editing it would put a version of it back
    // on the other device with the flag still up but the payload restored.
    const two = moneyUpdate("expenses", { amount: "999" });
    b.db.raw.prepare(moneyUpdateSql("expenses", two.columns)).run(...two.values, target.uid);
    check("editing a tombstone writes nothing",
      row(b.db, "SELECT amount FROM expenses WHERE uid = ?", [target.uid]).amount === 0);

    const inc = moneyUpdate("income", { source: "3Play", amount: 900 });
    b.db.raw.prepare(moneyUpdateSql("income", inc.columns)).run(...inc.values, incomeUid);
    check("a payment edit runs too, even on one already tombstoned it changes nothing",
      row(b.db, "SELECT source FROM income WHERE uid = ?", [incomeUid]).source === "");

    check("nothing to change is not a statement",
      moneyUpdateSql("expenses", moneyUpdate("expenses", {}).columns) === "");
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