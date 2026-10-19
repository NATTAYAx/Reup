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

import { outboxReseed, syncMigrations } from "../src/lib/syncMeta";
import {
  CURRENCY_KEY,
  DAY_START_KEY,
  GOOGLE_TOKENS_KEY,
  LANG_KEY,
  NOTE_STYLE_KEY,
  QUIET_KEY,
  SYNC_CONFIG_KEY,
  SYNC_STATE_KEY,
  THEME_ID_KEY,
} from "../src/lib/settingKeys";
import { THEME_IDS } from "../src/lib/theme";
import { SETTING_UPSERT_SQL, parseQuiet } from "../src/lib/userSettings";
import {
  NOTE_COLORS,
  NOTE_INK,
  NOTE_LEAD,
  NOTE_LOOKS,
  NOTE_MAX_CHARS,
  NOTE_PAPER,
  NOTE_STYLE_DEFAULT,
  NOTE_STYLES,
  NOTES_SHOWN,
  SQL_ADD_NOTE,
  SQL_EDIT_NOTE,
  SQL_LIVE_NOTES,
  SQL_PEEL_NOTE,
  SQL_UNPEEL_NOTE,
  noteBody,
  noteTilt,
  noteTyped,
} from "../src/lib/notes";
import { SQL_BUMP, SQL_CLOCK_READ, SQL_SEEN } from "../src/lib/sync/sqlLocalStore";
import { TASK_COLUMNS, TASK_EDITABLE, sanitizeText, taskProblems, taskUpdate, taskValues } from "../src/lib/taskDraft";
import {
  EXPENSE_COLUMNS,
  INCOME_COLUMNS,
  SQL_MONTH_OTHER_COUNT,
  SQL_MONTH_RECEIVED,
  SQL_MONTH_SPENT,
  SQL_RECENT_MONEY,
  SQL_DELETE_EXPENSE,
  SQL_DELETE_INCOME,
  moneyUpdate,
  moneyUpdateSql,
  CATEGORY_FALLBACK,
  CURRENCY_FALLBACK,
  expenseProblems,
  expenseValues,
  incomeProblems,
  incomeValues,
} from "../src/lib/moneyDraft";
import {
  byUids,
  deletionsFirst,
  freeNaturalKeys,
  incomingLosesClash,
  naturalKeyClash,
  payloadColumns,
  pending,
  spillDrop,
  spillRead,
  spillWrite,
  recordFromRow,
  settle,
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
  const schemaFile = path.resolve(process.argv[3] ?? "schema.sql");
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

  // What refilling the queue runs, which is what a snapshot is made of.
  //
  // Kept as its own section rather than folded into the migrations, because it
  // is the one list that is run outside startup: on changing folders, and now
  // before every snapshot push. Two implementations of it that agree on the
  // seven tables but not on the flag statement around them would produce two
  // devices that disagree about what a snapshot contains, which is the failure
  // the whole retention rule rests on not happening.
  // The three statements that make up the clock.
  //
  // Never vectored before, and they are the one thing in this project that both
  // languages retype by hand: every timestamp either device writes comes out of
  // these, and two copies that drift would put the two clocks on different
  // scales without a single error anywhere.
  V.clock = [SQL_BUMP, SQL_CLOCK_READ, SQL_SEEN];

  V.reseed = outboxReseed().map((m) => ({
    sql: flat(m.sql),
    ignoreErrors: m.ignoreErrors === true,
  }));

  // How a stored quiet-hours value reads, which two languages have to agree on.
  //
  // The value is the localStorage string verbatim, so the parser is the only
  // thing standing between one format and two readings of it. The cases below
  // are the ones where a reasonable second implementation would differ: a
  // missing flag, a flag that is a string, bounds that are equal, bounds that
  // are unreadable while the switch is on.
  V.quiet = [
    null,
    "",
    "not json",
    "[]",
    "{}",
    '{"start":"23:00","end":"08:00"}',
    '{"enabled":false}',
    '{"enabled":false,"start":"23:00","end":"08:00"}',
    '{"enabled":"true","start":"23:00","end":"08:00"}',
    '{"enabled":1,"start":"23:00","end":"08:00"}',
    '{"enabled":null,"start":"23:00","end":"08:00"}',
    '{"enabled":true,"start":"23:00","end":"08:00"}',
    '{"enabled":true,"start":"08:00","end":"08:00"}',
    '{"enabled":true,"start":"7:00","end":"08:00"}',
    '{"enabled":true,"start":"23:00"}',
    '{"enabled":true,"start":"00:00","end":"23:59"}',
  ].map((raw) => ({ raw, expected: parseQuiet(raw) }));

  // What a draft becomes on the way into the tasks table.
  //
  // Generated from the values `createTask` was already building, so the vectors
  // describe what the desktop has always written rather than what would be
  // tidier. The phone is about to be the second thing that can make a task, and
  // sixteen coercions reproduced from reading the other side is the shape this
  // project keeps removing.
  V.sanitizeText = [
    null,
    "",
    "2026-08-19",
    "07:30",
    "2026-08-19T07:30:00.123Z",
    "2026-08-19T07:30:00Z",
    "2026-08-19T07:30:00.123+07:00",
    "2026-08-19T07:30:00+07:00",
    "2026-08-19T07:30:00.123",
    "2026-08-19T07:30:00",
    "2026-08-19 07:30:00",
    "whatever",
  ].map((raw) => ({ raw, expected: sanitizeText(raw) }));

  const drafts: Record<string, unknown>[] = [
    { name: "ยาความดัน", reset_type: "daily", reset_time: "09:00" },
    { name: "", reset_type: "daily" },
    { name: "   ", reset_type: "daily" },
    { name: "raid", reset_type: "weekly", reset_day: 1, reset_time: "05:00", is_priority: true },
    // Sunday is zero, which is falsy. A guard written with a truthiness test
    // makes Sunday the one day a weekly task cannot be set to.
    { name: "raid", reset_type: "weekly", reset_day: 0 },
    { name: "raid", reset_type: "weekly" },
    { name: "raid", reset_type: "weekly", reset_day: 9 },
    { name: "raid", reset_type: "biweekly", reset_day: "3" },
    { name: "bins", reset_type: "custom_days", reset_interval_days: 14, anchor_date: "2026-08-01" },
    { name: "bins", reset_type: "custom_days" },
    { name: "bins", reset_type: "custom_days", reset_interval_days: 0 },
    { name: "event", reset_type: "event_window", event_start: "2026-08-01T00:00:00+07:00", event_end: "2026-08-09T23:59:00+07:00" },
    { name: "event", reset_type: "event_window", event_start: "2026-08-01" },
    { name: "dentist", reset_type: "specific_date", specific_date: "2026-09-02" },
    { name: "dentist", reset_type: "specific_date" },
    { name: "x", reset_type: "sometimes" },
    { name: "x", reset_type: "daily", reset_time: "9:00" },
    { name: "x", reset_type: "daily", intent: "want" },
    { name: "x", reset_type: "daily", intent: "maybe" },
    { name: "x", reset_type: "daily", is_urgent: 1, description: "", category: "personal" },
    // Allowed through quiet hours. A flag like is_urgent, pinned so the phone
    // writes the same 1 the desktop does.
    { name: "pills", reset_type: "daily", reset_time: "02:00", ring_in_quiet: 1, category: "personal" },
    { name: "x", reset_type: "daily", min_step: "", time_zone: "Asia/Bangkok" },
  ];
  V.taskColumns = [...TASK_COLUMNS];
  V.taskEditable = Object.keys(TASK_EDITABLE);

  // Editing an existing row. Separate from the draft cases because the question
  // is different: not what sixteen values a new row gets, but which of them an
  // edit is allowed to touch and in what order they come out.
  V.taskUpdate = ([
    { ring_in_quiet: 1 },
    {},
    { name: "x" },
    { nope: 1, name: "x" },
    { is_priority: true, is_urgent: false },
    { is_priority: 1, is_urgent: 0 },
    { reset_day: "0" },
    { reset_day: null },
    { min_step: "" },
    { min_step: "\u0e25\u0e49\u0e32\u0e07\u0e08\u0e32\u0e19 1 \u0e43\u0e1a" },
    { time_zone: null, intent: "want" },
    { intent: "maybe" },
    { notes: "hello" },
    { specific_date: "2026-09-02", reset_time: "07:30" },
    { event_end: "2026-08-19T07:30:00.123Z" },
    // Order comes from the allowlist, not from the object, so two devices
    // produce the same statement for the same edit.
    { intent: "must", name: "z", reset_time: "01:00" },
  ] as Record<string, unknown>[]).map((fields) => ({ fields, ...taskUpdate(fields) }));
  V.taskDraft = drafts.map((draft) => ({
    draft,
    values: taskValues(draft),
    problems: taskProblems(draft),
  }));

  // What a draft becomes on the way into the expenses table.
  //
  // A task written slightly wrong rings at the wrong time and somebody notices.
  // An amount written slightly wrong is a number inside a total, and a total is
  // the kind of thing nobody audits until the month it matters.
  const KNOWN = ["food", "transport", "other"];
  V.expenseCategories = KNOWN;
  V.expenseColumns = [...EXPENSE_COLUMNS];
  V.expenseDraft = ([
    { amount: 60, currency: "THB", category: "food", note: "กาแฟ", date: "2026-08-19" },
    { amount: "1200", currency: "THB", category: "food", note: "", date: "2026-08-19" },
    { amount: " 45.50 ", currency: "THB", category: "transport", note: "", date: "2026-08-19" },
    { amount: "", currency: "THB", category: "food", date: "2026-08-19" },
    { amount: "abc", currency: "THB", category: "food", date: "2026-08-19" },
    { amount: 0, currency: "THB", category: "food", date: "2026-08-19" },
    { amount: -5, currency: "THB", category: "food", date: "2026-08-19" },
    // Filed under other rather than refused. The money is the part that
    // matters; the label can be fixed afterwards.
    { amount: 20, currency: "THB", category: "gadgets", date: "2026-08-19" },
    { amount: 20, currency: "THB", date: "2026-08-19" },
    { amount: 20, currency: "THB", category: "", date: "2026-08-19" },
    { amount: 20, category: "food", date: "2026-08-19" },
    { amount: 20, currency: "THB", category: "food" },
    { amount: 20, currency: "THB", category: "food", date: "19/08/2026" },
    // Empty rather than a string, because the unique index tolerates any
    // number of nulls and exactly one of each string.
    { amount: 20, currency: "THB", category: "food", date: "2026-08-19", slip_ref: "" },
    { amount: 20, currency: "THB", category: "food", date: "2026-08-19", slip_ref: "REF123" },
    { amount: 20, currency: "USD", category: "food", date: "2026-08-19", nope: 1 },
  ] as Record<string, unknown>[]).map((draft) => ({
    draft,
    values: expenseValues(draft, KNOWN),
    problems: expenseProblems(draft, KNOWN),
  }));

  // And the other direction. The same three questions, so the same codes, which
  // is the property worth pinning: a validator that refuses a negative expense
  // and accepts a negative payment is the shape this file exists to prevent.
  V.incomeColumns = [...INCOME_COLUMNS];
  V.incomeDraft = ([
    { amount: 6516, source: "TELUS", note: "", date: "2026-08-19", currency: "THB" },
    { amount: "180", source: "3Play", note: "test 2", date: "2026-08-19", currency: "USD" },
    // Blank stays blank rather than becoming "other", because that is what the
    // desktop has always written.
    { amount: 100, source: "", date: "2026-08-19", currency: "THB" },
    { amount: 100, date: "2026-08-19", currency: "THB" },
    { amount: "", source: "x", date: "2026-08-19", currency: "THB" },
    { amount: "abc", source: "x", date: "2026-08-19", currency: "THB" },
    { amount: 0, source: "x", date: "2026-08-19", currency: "THB" },
    { amount: -5, source: "x", date: "2026-08-19", currency: "THB" },
    { amount: 100, source: "x", date: "2026-08-19" },
    { amount: 100, source: "x", currency: "THB" },
    { amount: 100, source: "x", date: "19/08/2026", currency: "THB" },
    { amount: 100, source: "x", date: "2026-08-19", currency: "THB", nope: 1 },
  ] as Record<string, unknown>[]).map((draft) => ({
    draft,
    values: incomeValues(draft),
    problems: incomeProblems(draft),
  }));

  // The statements a screen needs to answer "how am I doing this month", and
  // the one that answers "what have I actually written down lately".
  //
  // Two of them the desktop already ran and now shares; the other two exist
  // because filtering by currency silently is how a screen shows a confident,
  // wrong-looking zero, and because a total cannot tell you the same coffee
  // went in twice.
  //
  // The fourth pins a number as well as a shape: the twenty is inside the
  // string, so the two sides cannot come to mean different things by "lately".
  V.moneyQueries = [
    SQL_MONTH_SPENT,
    SQL_MONTH_RECEIVED,
    SQL_MONTH_OTHER_COUNT,
    SQL_RECENT_MONEY,
    SQL_DELETE_EXPENSE,
    SQL_DELETE_INCOME,
  ];

  // Editing one row. Same shape as taskUpdate and for the same reason: the
  // columns an UPDATE touches are a property of moneyDraft rather than of the
  // object a caller happened to build, and the statement is compared byte for
  // byte against the phone's. Two devices building the same edit in a different
  // order build two different strings.
  V.moneyUpdate = ([
    ["expenses", { amount: "60" }],
    ["expenses", { note: "  \u0e01\u0e32\u0e41\u0e1f  ", amount: 60 }],
    ["expenses", { date: "2026-08-19", category: "food", currency: "THB", note: "", amount: "12.5" }],
    ["expenses", { note: "x", date: "2026-08-01", amount: "1" }],
    ["expenses", { amount: "5", slip_ref: "abc", id: 3, uid: "u", deleted: 1 }],
    ["expenses", {}],
    ["income", { amount: "6516", source: "TELUS" }],
    ["income", { source: "", note: "", currency: "USD", date: "2026-08-19", amount: 0 }],
    ["income", { amount: "abc" }],
  ] as [("expenses" | "income"), Record<string, unknown>][]).map(([table, fields]) => {
    const { columns, values } = moneyUpdate(table, fields);
    return { table, fields, columns, values, sql: moneyUpdateSql(table, columns) };
  });

  // The two strings that decide what happens when nobody said. Neither can fail
  // loudly if the two sides disagree — one device just files a month in a unit
  // the other one filters out.
  V.moneyFallbacks = [CURRENCY_FALLBACK, CATEGORY_FALLBACK];

  // The names a setting is stored under.
  //
  // Both machines look these rows up by name, and a spelling that disagrees
  // does not throw or log anything: one side writes a row the other never
  // reads, so the setting has no effect on the device that did not write it.
  // Quiet hours that apply to one phone, a currency that reverts, a sync config
  // the phone cannot find.
  //
  // Order matters, because the phone compares the list rather than the values.
  V.settingKeys = [
    QUIET_KEY,
    CURRENCY_KEY,
    LANG_KEY,
    SYNC_CONFIG_KEY,
    GOOGLE_TOKENS_KEY,
    SYNC_STATE_KEY,
    THEME_ID_KEY,
    NOTE_STYLE_KEY,
    DAY_START_KEY,
  ];

  // The six themes, by the name that travels.
  //
  // The colours are not shared and are not meant to be: this side needs a
  // gradient and a border alpha, the phone needs a card, a field and an ink
  // colour for text on the primary. What both sides must spell identically is
  // which theme is called what, because that string is the whole of what
  // crosses. An id spelled differently on one side is a theme picked here that
  // the phone reads, fails to recognise, and correctly ignores - so the setting
  // simply never arrives, quietly, for that one theme.
  //
  // Order matters here too: it is the order of the picker on both machines, so
  // that "the third one" means the same thing out loud.
  V.themeIds = [...THEME_IDS];

  // The write both machines make into user_settings.
  //
  // The WHERE on the upsert is the part worth pinning rather than the INSERT.
  // Without it, saving a settings screen with nothing changed bumps updated_at,
  // fires the outbox trigger and puts a row on the wire - every time, on both
  // devices, for ever. A phone that wrote the plain upsert instead would look
  // like it was working while quietly filling the folder.
  V.settingQueries = [SETTING_UPSERT_SQL];

  // Notes stuck on the home screen. Both machines write the table, so the
  // statements are pinned like every other write - the peel most of all, which
  // blanks the words on its way to being a tombstone, and a phone that only
  // set the flag would send a month of somebody's notes into the sync folder.
  V.noteQueries = [SQL_LIVE_NOTES, SQL_ADD_NOTE, SQL_EDIT_NOTE, SQL_PEEL_NOTE, SQL_UNPEEL_NOTE];
  // The papers and the ink, by name and in picker order: the name is what is
  // stored, and an unknown one is drawn as the first.
  V.noteColors = NOTE_COLORS.map((name) => ({ name, paper: NOTE_PAPER[name], ink: NOTE_INK }));
  V.noteLimits = [{ maxChars: NOTE_MAX_CHARS, shown: NOTES_SHOWN, lead: NOTE_LEAD }];
  // How the papers look: one setting for every note, synced like the theme.
  // The names are what travels and the colours are what both machines draw,
  // so both are pinned - a style spelled differently is a setting that never
  // arrives, and a colour that drifted is the same note in two shades.
  V.noteStyles = [...NOTE_STYLES];
  V.noteStyleDefault = [NOTE_STYLE_DEFAULT];
  V.noteLooks = NOTE_STYLES.flatMap((style) =>
    NOTE_COLORS.map((color) => ({ style, color, paper: NOTE_LOOKS[style][color].paper, ink: NOTE_LOOKS[style][color].ink })),
  );
  // The one rule about what a note may say. The cases are where a second
  // implementation would differ: Windows line ends, blank lines, a no-break
  // space at the end of a line (trimmed here, and not by every trim), a cut
  // that would land inside an emoji, and nothing left at all.
  V.noteBody = [
    { id: "plain", raw: "ซื้อนม 2 ขวด" },
    { id: "outer-space", raw: "   โทรหาร้านซ่อม  " },
    { id: "lines", raw: "เอาผ้าออก\nจากเครื่อง" },
    { id: "windows-lines", raw: "เอาผ้าออก\r\nจากเครื่อง\r" },
    { id: "blank-lines", raw: "\n\nบรรทัดแรก\n\n\n  \nบรรทัดสอง\n\n" },
    { id: "no-break-space", raw: "ปิดแก๊ส\u00A0\n\u00A0ล็อกประตู" },
    { id: "byte-order-mark", raw: "\uFEFFจ่ายค่าไฟ" },
    { id: "nothing", raw: "   \n \t \n" },
    { id: "empty", raw: "" },
    { id: "long", raw: "ก".repeat(NOTE_MAX_CHARS + 30) },
    { id: "cut-at-emoji", raw: "ก".repeat(NOTE_MAX_CHARS - 1) + "🐱🐱" },
    { id: "cut-leaves-space", raw: "ก".repeat(NOTE_MAX_CHARS - 1) + " ข" },
  ].map((c) => ({ ...c, expected: noteBody(c.raw) }));
  V.noteTilt = ["", "a", "11111111-1111-4111-8111-111111111111", "ffffffff-ffff-4fff-bfff-ffffffffffff", "โน้ต", "zzzzzzzzzzzzzzzz"]
    .map((uid) => ({ uid, expected: noteTilt(uid) }));
  // The box a note is written in. Nothing here is stored, so it is not a sync
  // rule; pinned anyway, so the two boxes behave alike under the same hands:
  // never more than a note may say, and a paste that would go over keeps what
  // was written and as much of itself as fits, with no emoji cut in half.
  const k = (n: number) => "ก".repeat(n);
  V.noteTyped = [
    { id: "fits", was: "", now: "ซื้อนม" },
    { id: "just-fits", was: k(NOTE_MAX_CHARS - 1), now: k(NOTE_MAX_CHARS) },
    { id: "paste-at-end", was: k(100), now: k(100) + "ข".repeat(50) },
    { id: "paste-in-middle", was: k(50) + "ค".repeat(60), now: k(50) + "ข".repeat(40) + "ค".repeat(60) },
    { id: "full-box", was: k(60) + "ค".repeat(60), now: k(60) + "ข" + "ค".repeat(60) },
    { id: "room-for-one-emoji", was: k(NOTE_MAX_CHARS - 1), now: k(NOTE_MAX_CHARS - 1) + "🐱🐱" },
    { id: "same-first-unit", was: k(NOTE_MAX_CHARS - 1) + "🐶", now: k(NOTE_MAX_CHARS - 1) + "🐱🐶" },
  ].map((c) => ({ ...c, expected: noteTyped(c.was, c.now) }));

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
    // tasks.ring_in_quiet is NOT NULL. A writer that knows it sends it; one
    // that has never heard of it - an older build, or a file from before the
    // column existed - sends nothing, and the column has to be left out of the
    // statement rather than bound as null. The second case is the one that
    // stopped a new phone's first sync.
    {
      id: "upsert-task-that-knows-ring-in-quiet",
      table: "tasks",
      record: taskRecord({ fields: { ...taskRecord().fields, ring_in_quiet: 1 } }),
    },
    {
      id: "upsert-task-from-a-writer-without-ring-in-quiet",
      table: "tasks",
      record: (() => {
        const r = taskRecord();
        const fields: Record<string, unknown> = { ...r.fields };
        delete fields.ring_in_quiet;
        return { ...r, fields };
      })(),
    },
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

  // The outbox pair, which replaced "everything above a watermark". Both halves
  // are here because they are only correct together: pending joins the queue and
  // settle empties it, and a port that got one of the two spellings wrong would
  // either send the same rows for ever or drop an edit made mid-upload.
  V.pending = [...SYNCED_TABLES].map((name) => ({
    id: `pending-${name}`,
    table: name,
    expected: flat(pending(shapeOf(name)).sql),
  }));

  // The spill, which is how a column this schema cannot hold survives a round
  // trip through this device. Both spellings are here because the pair is only
  // correct together: read has to find exactly what write stored, and a device
  // that got the key order wrong would quietly carry nothing.
  V.spill = [
    {
      id: "spill-read-one",
      kind: "read",
      pairs: [{ table: "tasks", uid: "u-1" }],
    },
    {
      id: "spill-read-many",
      kind: "read",
      pairs: [
        { table: "tasks", uid: "u-1" },
        { table: "expenses", uid: "u-2" },
      ],
    },
    { id: "spill-write", kind: "write", table: "tasks", uid: "u-1", cols: '{"mood_after":3}' },
    { id: "spill-drop", kind: "drop", table: "budgets", uid: "u-'2" },
  ].map((c) => {
    const q =
      c.kind === "read"
        ? spillRead(c.pairs as { table: string; uid: string }[])
        : c.kind === "write"
          ? spillWrite(c.table as string, c.uid as string, c.cols as string)
          : spillDrop(c.table as string, c.uid as string);
    return { ...c, expected: { sql: flat(q.sql), params: q.params } };
  });

  // updated_at is in the WHERE, and that is the whole point of these cases: a
  // settle by name alone would clear an entry the trigger had already replaced
  // with a newer version, which loses an edit silently and only on a slow link.
  V.settle = [
    { id: "settle-task", table: "tasks", uid: "u-1", updatedAt: "2026-08-16T03:00:00.000Z" },
    { id: "settle-budget", table: "budgets", uid: "u-2", updatedAt: "2026-08-16T03:00:00.001Z" },
    // A uid with a quote in it would break a query built by concatenation. It
    // cannot happen — uids are generated — but the binding is what makes that
    // true rather than the generator, and this is where that is stated.
    { id: "settle-awkward-uid", table: "expenses", uid: "u-'3", updatedAt: "1970-01-01T00:00:00.000Z" },
  ].map((c) => {
    const q = settle(c.table, c.uid, c.updatedAt);
    return { ...c, expected: { sql: flat(q.sql), params: q.params } };
  });

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
    {
      id: "free-expense-tombstone-with-no-slip-keeps-it-null",
      table: "expenses",
      record: {
        table: "expenses",
        uid: "55555555-5555-4555-8555-555555555555",
        updatedAt: "2026-08-16T21:00:00.000Z",
        deleted: true,
        origin: DEVICE,
        fields: {
          amount: 1200, category: "food", note: "", date: "2026-08-16",
          created_at: "2026-08-16 21:00:00", currency: "THB", slip_ref: null,
        },
      },
    },
    {
      id: "free-expense-tombstone-with-a-slip-releases-it",
      table: "expenses",
      record: {
        table: "expenses",
        uid: "55555555-5555-4555-8555-555555555555",
        updatedAt: "2026-08-16T21:00:00.000Z",
        deleted: true,
        origin: DEVICE,
        fields: {
          amount: 1200, category: "food", note: "", date: "2026-08-16",
          created_at: "2026-08-16 21:00:00", currency: "THB", slip_ref: "slip-abc",
        },
      },
    },
  ].map((c) => ({ ...c, expected: freeNaturalKeys(shapeOf(c.table), c.record) }));

  const expenseFields: Record<string, unknown> = {
    amount: 1200,
    category: "food",
    note: "",
    date: "2026-08-16",
    created_at: "2026-08-16 21:00:00",
    currency: "THB",
    slip_ref: null,
  };
  const expenseRecord = (over: Partial<ChangeRecord> = {}): ChangeRecord => ({
    table: "expenses",
    uid: "55555555-5555-4555-8555-555555555555",
    updatedAt: "2026-08-16T21:00:00.000Z",
    deleted: false,
    origin: DEVICE,
    fields: expenseFields,
    ...over,
  });
  const existingExpense: Row = {
    id: 9,
    uid: "22222222-2222-4222-8222-222222222222",
    updated_at: "2026-08-16T20:00:00.000Z",
    deleted: 0,
    amount: 60.5,
    category: "food",
    note: "",
    date: "2026-08-16",
    created_at: "2026-08-16 20:00:00",
    currency: "THB",
    slip_ref: null,
  };

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
    // A unique index on a nullable column constrains nothing when the value is
    // null, which is the state of nearly every expense. Treating two of them as
    // one another's duplicate deleted a real row; these two cases are the rule
    // the database has always had, written down where both languages read it.
    {
      id: "clash-two-null-slips-are-not-the-same-expense",
      table: "expenses",
      incoming: expenseRecord(),
      existing: existingExpense,
    },
    {
      id: "clash-the-same-real-slip-still-clashes",
      table: "expenses",
      incoming: expenseRecord({ fields: { ...expenseFields, slip_ref: "slip-abc" } }),
      existing: { ...existingExpense, slip_ref: "slip-abc" },
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
    ["clock", (V.clock as unknown[]).length],
    ["reseed", (V.reseed as unknown[]).length],
    ["quiet", (V.quiet as unknown[]).length],
    ["sanitizeText", (V.sanitizeText as unknown[]).length],
    ["taskDraft", (V.taskDraft as unknown[]).length],
    ["taskUpdate", (V.taskUpdate as unknown[]).length],
    ["expenseDraft", (V.expenseDraft as unknown[]).length],
    ["incomeDraft", (V.incomeDraft as unknown[]).length],
    ["moneyQueries", (V.moneyQueries as unknown[]).length],
    ["moneyUpdate", (V.moneyUpdate as unknown[]).length],
    ["moneyFallbacks", (V.moneyFallbacks as unknown[]).length],
    ["settingKeys", (V.settingKeys as unknown[]).length],
    ["themeIds", (V.themeIds as unknown[]).length],
    ["settingQueries", (V.settingQueries as unknown[]).length],
    ["noteQueries", (V.noteQueries as unknown[]).length],
    ["noteColors", (V.noteColors as unknown[]).length],
    ["noteBody", (V.noteBody as unknown[]).length],
    ["noteTilt", (V.noteTilt as unknown[]).length],
    ["noteTyped", (V.noteTyped as unknown[]).length],
    ["noteLooks", (V.noteLooks as unknown[]).length],
    ["shapes", (V.shapes as unknown[]).length],
    ["recordFromRow", (V.recordFromRow as unknown[]).length],
    ["upsert", (V.upsert as unknown[]).length],
    ["pending", (V.pending as unknown[]).length],
    ["settle", (V.settle as unknown[]).length],
    ["spill", (V.spill as unknown[]).length],
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
    const schemaPath = path.resolve("schema.sql");
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
      const body = lines.map((l: string) => `    "${esc(l)}\\n"`).join(" +\n");
      const kt =
        "package app.reup.sync\n\n" +
        "// GENERATED by reup/scripts/gen-store-vectors.ts from reup/schema.sql.\n" +
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