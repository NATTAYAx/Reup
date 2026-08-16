/**
 * Generates shared/store-vectors.json. Run it:
 *
 *   pnpm gen:store-vectors
 *
 * WHY THIS EXISTS
 *
 * check-sync.ts proves the desktop store against a real SQLite with the real
 * schema and the real triggers. That proof is worth something only on the
 * desktop. The phone will run a second store, and a second implementation of
 * anything is the point where this project has gone wrong every time — two
 * parsers, two translation systems, two category detectors.
 *
 * So rather than describing the store in prose and hoping the port matches, the
 * desktop writes down every statement it would emit and every decision it would
 * make, and the port has to reproduce them exactly. If the strings match, the
 * proof that the desktop's statements do the right thing against real SQLite
 * carries over without being repeated.
 *
 * The shapes are not invented here. They are read out of a real database built
 * from the real schema.sql, so the port is tested against the tables that exist
 * rather than against a tidy example of them.
 *
 * WHY THE SQL IS COMPARED WITH ITS WHITESPACE COLLAPSED
 *
 * A trigger body is a template literal here and a raw string there, and the two
 * will never indent the same way. Insisting on identical whitespace would mean
 * a test that fails for a reason nobody cares about, which is a test people
 * learn to ignore. What has to match is the statement.
 */

import { syncMigrations } from "../src/lib/syncMeta";
import {
  byUids,
  changedSince,
  deletionsFirst,
  freeNaturalKeys,
  incomingLosesClash,
  naturalKeyClash,
  payloadColumns,
  recordFromRow,
  upsert,
  type Row,
  type TableShape,
} from "../src/lib/sync/rows";
import { readShapes, SYNCED_TABLES, type Db } from "../src/lib/sync/sqlLocalStore";
import type { ChangeRecord } from "../src/lib/sync/protocol";

declare const require: (m: string) => any;
declare const process: { argv: string[]; exit(code: number): void };

const { DatabaseSync } = require("node:sqlite");
const fs = require("fs");
const path = require("path");

class NodeDb implements Db {
  readonly raw = new DatabaseSync(":memory:");
  async execute(sql: string, params: unknown[] = []): Promise<unknown> {
    if (params.length === 0) return this.raw.exec(sql);
    return this.raw.prepare(sql).run(...(params as never[]));
  }
  async select<T>(sql: string, params: unknown[] = []): Promise<T> {
    return this.raw.prepare(sql).all(...(params as never[])) as T;
  }
}

/** The one normalisation both sides apply before comparing a statement. */
function flat(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function buildDb(schemaFile: string): NodeDb {
  const db = new NodeDb();
  const sql = fs.readFileSync(schemaFile, "utf8");
  for (const stmt of sql.split(/^[ \t]*--[ \t]*@@[ \t]*$/m)) {
    const t = stmt
      .split("\n")
      .filter((l: string) => !l.trim().startsWith("--"))
      .join("\n")
      .trim();
    if (t === "") continue;
    try {
      db.raw.exec(t);
    } catch (e) {
      if (!String(e).includes("duplicate column")) throw e;
    }
  }
  for (const m of syncMigrations()) {
    try {
      db.raw.exec(m.sql);
    } catch (e) {
      if (!m.ignoreErrors) throw e;
    }
  }
  return db;
}

// ─── fixtures ────────────────────────────────────────────────────────────────

const DEVICE = "d-1122334455667788";

function taskRecord(over: Partial<ChangeRecord> = {}): ChangeRecord {
  return {
    table: "tasks",
    uid: "11111111-1111-4111-8111-111111111111",
    updatedAt: "2026-08-15T09:00:00.000Z",
    deleted: false,
    origin: DEVICE,
    fields: {
      name: "dailies",
      description: "",
      category: "game",
      reset_type: "daily",
      reset_time: "04:00",
      reset_day: null,
      is_priority: 0,
      is_urgent: 1,
      is_active: 1,
      completed_until: null,
    },
    ...over,
  };
}

function budgetRecord(over: Partial<ChangeRecord> = {}): ChangeRecord {
  return {
    table: "budgets",
    uid: "22222222-2222-4222-8222-222222222222",
    updatedAt: "2026-08-15T09:00:00.000Z",
    deleted: false,
    origin: DEVICE,
    fields: { category: "food", limit_amount: 5000, month: "2026-08" },
    ...over,
  };
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const schemaFile = path.resolve(process.argv[3] ?? "../reup-shared/schema.sql");
  if (!fs.existsSync(schemaFile)) {
    throw new Error(`schema.sql not found at ${schemaFile}`);
  }

  const db = buildDb(schemaFile);
  const shapes = await readShapes(db);

  const shapeOf = (name: string): TableShape => {
    const s = shapes.get(name);
    if (!s) throw new Error(`no shape for ${name}`);
    return s;
  };

  const V: Record<string, unknown> = {
    version: 1,
    generatedBy: "gen-store-vectors.ts",
  };

  // The migrations, in order, exactly as the desktop would run them.
  V.migrations = syncMigrations().map((m) => ({
    sql: flat(m.sql),
    ignoreErrors: m.ignoreErrors === true,
  }));

  // The shapes as SQLite actually reports them, which is also the fixture the
  // rest of the cases are built on.
  V.shapes = [...SYNCED_TABLES].map((name) => {
    const s = shapeOf(name);
    return {
      name: s.name,
      columns: s.columns,
      types: s.types,
      hasDeleted: s.hasDeleted,
      naturalKeys: s.naturalKeys,
      payloadColumns: payloadColumns(s),
    };
  });

  // A row as SQLite hands it back, turned into a record.
  const liveRow: Row = {
    id: 7,
    uid: "11111111-1111-4111-8111-111111111111",
    updated_at: "2026-08-15T09:00:00.000Z",
    deleted: 0,
    name: "dailies",
    reset_type: "daily",
    reset_time: "04:00",
    is_active: 1,
    completed_until: null,
  };
  V.recordFromRow = [
    {
      id: "row-live",
      table: "tasks",
      row: liveRow,
      origin: DEVICE,
      expected: recordFromRow(shapeOf("tasks"), liveRow, DEVICE),
    },
    {
      id: "row-tombstone",
      table: "tasks",
      row: { ...liveRow, deleted: 1 },
      origin: DEVICE,
      expected: recordFromRow(shapeOf("tasks"), { ...liveRow, deleted: 1 }, DEVICE),
    },
    {
      // The driver may hand a flag back as 1, "1" or true. Only clearly-on
      // counts, because guessing "deleted" the other way removes a row nobody
      // removed.
      id: "row-deleted-as-text",
      table: "tasks",
      row: { ...liveRow, deleted: "1" },
      origin: DEVICE,
      expected: recordFromRow(shapeOf("tasks"), { ...liveRow, deleted: "1" }, DEVICE),
    },
  ];

  const upsertCases: { id: string; table: string; record: ChangeRecord }[] = [
    { id: "upsert-task", table: "tasks", record: taskRecord() },
    { id: "upsert-task-tombstone", table: "tasks", record: taskRecord({ deleted: true }) },
    {
      id: "upsert-task-with-a-column-this-schema-does-not-have",
      table: "tasks",
      record: taskRecord({ fields: { ...taskRecord().fields, invented_next_year: 5 } }),
    },
    { id: "upsert-budget", table: "budgets", record: budgetRecord() },
    {
      id: "upsert-expense",
      table: "expenses",
      record: {
        table: "expenses",
        uid: "33333333-3333-4333-8333-333333333333",
        updatedAt: "2026-08-15T10:00:00.000Z",
        deleted: false,
        origin: DEVICE,
        fields: { amount: 1200, category: "food", note: "dog food", date: "2026-08-15" },
      },
    },
  ];
  V.upsert = upsertCases.map((c) => {
    const s = upsert(shapeOf(c.table), freeNaturalKeys(shapeOf(c.table), c.record));
    return { ...c, expected: { sql: flat(s.sql), params: s.params } };
  });

  V.changedSince = [...SYNCED_TABLES].map((name) => ({
    id: `changed-${name}`,
    table: name,
    expected: flat(changedSince(shapeOf(name)).sql),
  }));

  V.byUids = [
    { id: "by-uids-one", table: "tasks", uids: ["a"] },
    { id: "by-uids-three", table: "expenses", uids: ["a", "b", "c"] },
  ].map((c) => {
    const q = byUids(shapeOf(c.table), c.uids);
    return { ...c, expected: { sql: flat(q.sql), params: q.params } };
  });

  V.freeNaturalKeys = [
    { id: "free-live-row-is-untouched", table: "budgets", record: budgetRecord() },
    { id: "free-budget-tombstone", table: "budgets", record: budgetRecord({ deleted: true }) },
    { id: "free-task-tombstone-has-no-natural-key", table: "tasks", record: taskRecord({ deleted: true }) },
    {
      id: "free-category-tombstone",
      table: "expense_categories",
      record: {
        table: "expense_categories",
        uid: "44444444-4444-4444-8444-444444444444",
        updatedAt: "2026-08-15T09:00:00.000Z",
        deleted: true,
        origin: DEVICE,
        fields: { key: "food", label: null, emoji: "🍜", color: null, sort_order: 0, is_hidden: 0 },
      },
    },
  ].map((c) => ({ ...c, expected: freeNaturalKeys(shapeOf(c.table), c.record) }));

  const existingBudget: Row = {
    id: 3,
    uid: "11111111-1111-4111-8111-111111111111",
    updated_at: "2026-08-15T08:00:00.000Z",
    deleted: 0,
    category: "food",
    limit_amount: 4000,
    month: "2026-08",
  };
  V.clash = [
    {
      id: "clash-same-key-incoming-uid-is-larger",
      table: "budgets",
      incoming: budgetRecord(),
      existing: existingBudget,
    },
    {
      id: "clash-same-key-incoming-uid-is-smaller",
      table: "budgets",
      incoming: budgetRecord({ uid: "00000000-0000-4000-8000-000000000000" }),
      existing: existingBudget,
    },
    {
      id: "clash-same-uid-is-not-a-clash",
      table: "budgets",
      incoming: budgetRecord({ uid: String(existingBudget.uid) }),
      existing: existingBudget,
    },
    {
      id: "clash-different-month-is-not-a-clash",
      table: "budgets",
      incoming: budgetRecord({ fields: { category: "food", limit_amount: 5000, month: "2026-09" } }),
      existing: existingBudget,
    },
    {
      id: "clash-a-table-with-no-natural-key",
      table: "tasks",
      incoming: taskRecord(),
      existing: { ...liveRow, uid: "99999999-9999-4999-8999-999999999999" },
    },
  ].map((c) => ({
    ...c,
    expected: {
      clashes: naturalKeyClash(shapeOf(c.table), c.incoming, c.existing as Row),
      incomingLoses: incomingLosesClash(c.incoming, c.existing as Row),
    },
  }));

  // The order apply() puts them in. A delete releases a natural key and a
  // create consumes one, so a batch that does the create first can only fail —
  // and it fails as a duplicate that never existed rather than as an error.
  V.applyOrder = [
    {
      id: "order-delete-before-create",
      records: [
        budgetRecord({ uid: "bbbb", updatedAt: "2026-08-15T10:00:01.000Z" }),
        budgetRecord({ uid: "aaaa", updatedAt: "2026-08-15T10:00:02.000Z", deleted: true }),
      ],
    },
    {
      id: "order-is-stable-within-each-group",
      records: [
        taskRecord({ uid: "u1" }),
        taskRecord({ uid: "u2", deleted: true }),
        taskRecord({ uid: "u3" }),
        taskRecord({ uid: "u4", deleted: true }),
      ],
    },
    { id: "order-nothing-to-do", records: [] },
  ].map((c) => ({ ...c, expected: deletionsFirst(c.records).map((r) => r.uid) }));

  const counts: [string, number][] = [
    ["migrations", (V.migrations as unknown[]).length],
    ["shapes", (V.shapes as unknown[]).length],
    ["recordFromRow", (V.recordFromRow as unknown[]).length],
    ["upsert", (V.upsert as unknown[]).length],
    ["changedSince", (V.changedSince as unknown[]).length],
    ["byUids", (V.byUids as unknown[]).length],
    ["freeNaturalKeys", (V.freeNaturalKeys as unknown[]).length],
    ["clash", (V.clash as unknown[]).length],
    ["applyOrder", (V.applyOrder as unknown[]).length],
  ];
  for (const [k, n] of counts) console.log(`${k.padEnd(16)} ${n}`);
  console.log(`${"total".padEnd(16)} ${counts.reduce((s, [, n]) => s + n, 0)}`);
  console.log("");

  const DEFAULT_OUT = "../reup-shared/store-vectors.json";
  const out = process.argv[2] ?? DEFAULT_OUT;
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(V, null, 2));
  console.log(`wrote ${out}`);

  // The phone's test suite reads this file out of its own resources folder, so
  // there are two copies of it and only one generator. A copy that has to be
  // made by hand is a copy that will be a week out of date, and the way that
  // shows up is a Kotlin test failing on a line that only says the file is
  // missing a key — which is a long way from "you forgot to copy a file".
  //
  // Here rather than in package.json because the path is a sibling of the
  // default output path, which is already assumed a few lines up, and because
  // a copy step written as a shell command is a copy step that works on one OS.
  if (out === DEFAULT_OUT) {
    const mirror = path.resolve(
      "../reup-mobile/shared/src/jvmTest/resources/store-vectors.json",
    );
    if (fs.existsSync(path.dirname(mirror))) {
      fs.copyFileSync(path.resolve(out), mirror);
      console.log(`mirrored ${mirror}`);
    } else {
      console.log("no phone checkout next door, nothing mirrored");
    }
  }

  // ── the schema, as a Kotlin constant ──────────────────────────────────────
  //
  // The phone needs the same CREATE TABLE statements the desktop uses, and the
  // canonical copy of them is shared/schema.sql. Shipping it as an Android asset
  // would mean a Gradle copy task and a file read at runtime that can fail; a
  // generated constant cannot be out of date without this script running, and
  // cannot be missing at runtime at all.
  //
  // Emitted as ASCII with \uXXXX escapes rather than as a raw string, which is
  // not fussiness. schema.sql carries emoji in two column defaults, and a
  // compiler that reads the file in the wrong charset turns those into "?"
  // silently — the code compiles, the app runs, and one column has the wrong
  // default forever. Escaped, the file is bytes no encoding setting can change.
  if (out === DEFAULT_OUT) {
    const schemaPath = path.resolve("../reup-shared/schema.sql");
    const ktPath = path.resolve(
      "../reup-mobile/shared/src/commonMain/kotlin/app/reup/sync/SchemaSql.kt",
    );
    if (fs.existsSync(schemaPath) && fs.existsSync(path.dirname(ktPath))) {
      const lines = fs.readFileSync(schemaPath, "utf8").replace(/\r\n/g, "\n").split("\n");
      const esc = (s: string) =>
        // split("") and not [...s]: the spread iterates by code point, which
        // keeps an emoji whole and then emits only its high surrogate. Code
        // units are what \uXXXX means.
        s
          .split("")
          .map((ch) => {
            const c = ch.charCodeAt(0);
            if (ch === "\\") return "\\\\";
            if (ch === '"') return '\\"';
            if (ch === "$") return "\\$";
            if (c < 0x20 || c > 0x7e) return "\\u" + c.toString(16).padStart(4, "0");
            return ch;
          })
          .join("");
      const body = lines.map((l) => `    "${esc(l)}\\n"`).join(" +\n");
      const kt =
        "package app.reup.sync\n\n" +
        "// GENERATED by reup/scripts/gen-store-vectors.ts from reup-shared/schema.sql.\n" +
        "// Do not edit. Run `pnpm gen:store-vectors` in the desktop repo instead.\n" +
        "//\n" +
        "// The desktop reads that file directly. The phone gets it as a constant so\n" +
        "// that there is no asset to ship, no file to find at runtime, and no way for\n" +
        "// the two to disagree without this line changing in a commit.\n" +
        "//\n" +
        "// Pure ASCII on purpose: concatenated literals are still a compile-time\n" +
        "// constant, and no charset setting anywhere can alter what this says.\n\n" +
        "const val SCHEMA_SQL: String =\n" +
        body +
        "\n";
      fs.writeFileSync(ktPath, kt);
      console.log(`wrote ${ktPath}`);
    }
  }

  console.log("clean");

}

void main();