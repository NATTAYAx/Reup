-- ─── schema.sql — one place that knows what the tables are ───────────────────
--
-- WHY THIS FILE EXISTS
--
-- Until now the schema lived only in database.ts, as a sequence of db.execute()
-- calls mixed with ALTER TABLE migrations. That was fine while there was one
-- implementation. It stops being fine the moment a second one exists, because
-- then there are two schemas that have to agree, and nothing makes them agree
-- except somebody remembering.
--
-- That is the same disease as the two parsers, the two translation systems and
-- the two category detectors: one decision written down in more than one place.
-- The fix is the same each time — write it once, have everyone read it.
--
-- WHO READS THIS
--
-- It said, for months:
--
--   desktop  loads it at startup and runs the statements in order
--   mobile   hands it to SQLDelight, which compiles typed queries from it
--
-- Neither has ever been true. What actually happens is:
--
--   desktop     builds its database in database.ts, from its own CREATE calls
--   mobile      builds its database from SchemaSql.kt, a constant generated
--               from this file and committed in that repo
--   check-sync  builds throwaway databases from this file to test against
--
-- So the only thing whose real database depends on this file being complete is
-- the phone, and only on a first install. That is the whole explanation for a
-- missing `-- @@` line sitting here for months without anyone noticing: the
-- machine somebody looks at every day never used it.
--
-- WHY THE DESKTOP NEVER STARTED READING IT
--
-- Somebody tried. There was a src/lib/schema.ts with a raw import of
-- shared/schema.sql — a path outside this repository, so the import could not
-- resolve, so nothing imported it, and the rules in that file sat there being
-- correct and never running while database.ts went on doing it its own way.
-- tombstones.ts still carries the note about it.
--
-- That is why the file now lives in the desktop repository rather than in a
-- folder beside it. Not because the desktop owns the schema — because a file
-- nobody can import is a file nobody reads, and being neutral bought nothing
-- while costing exactly the thing the file was made for.
--
-- The round that makes the first line true again is database.ts loading this at
-- startup and deleting its own copy of the CREATE statements. It can, now.
--
-- RULES FOR EDITING
--
--   1. Never change an existing CREATE TABLE. Add an ALTER in the migrations
--      section instead. Databases already exist on real machines; a CREATE
--      TABLE IF NOT EXISTS does nothing to them.
--   2. Every statement must be safe to run on every launch. That is what makes
--      "migrate" and "create" the same code path, which is what stops the two
--      paths drifting.
--   3. Statements are separated by a line containing only `-- @@`. The loaders
--      split on that rather than on semicolons, because triggers contain
--      semicolons inside their bodies.
--
-- WHY `id` STAYS
--
-- Every query and every component uses the local integer id. `uid` is only for
-- talking to other devices. Both exist on purpose; see syncMeta for the long
-- version.

-- ─── tasks ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tasks (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  name                 TEXT NOT NULL,
  description          TEXT DEFAULT '',
  category             TEXT DEFAULT 'game',
  reset_type           TEXT NOT NULL,
  reset_time           TEXT,
  reset_day            INTEGER,
  reset_interval_days  INTEGER,
  anchor_date          TEXT,
  event_start          TEXT,
  event_end            TEXT,
  specific_date        TEXT,
  is_priority          INTEGER DEFAULT 0,
  is_urgent            INTEGER DEFAULT 0,
  is_active            INTEGER DEFAULT 1,
  completed_until      TEXT DEFAULT NULL,
  -- WHEN the tick was last touched, which is a different question from how far
  -- it reaches. Sync compares this one, because "furthest along" cannot say
  -- "undo": clearing the tick produces a value that loses to the old one for
  -- ever. See merge.ts.
  completed_at         TEXT DEFAULT NULL,
  created_at           TEXT DEFAULT (datetime('now'))
);
-- @@

-- ─── income ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS income (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  amount      REAL NOT NULL,
  source      TEXT DEFAULT 'other',
  note        TEXT DEFAULT '',
  date        TEXT NOT NULL,
  created_at  TEXT DEFAULT (datetime('now'))
);
-- @@

-- ─── expenses ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS expenses (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  amount      REAL NOT NULL,
  category    TEXT NOT NULL DEFAULT 'other',
  note        TEXT DEFAULT '',
  date        TEXT NOT NULL,
  created_at  TEXT DEFAULT (datetime('now'))
);
-- @@

-- ─── expected_income ─────────────────────────────────────────────────────────
-- Money that should arrive and has not. Not a ledger entry: nothing here has
-- been counted. It becomes an income row only when someone confirms it did.
CREATE TABLE IF NOT EXISTS expected_income (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source       TEXT NOT NULL,
  amount       REAL,
  currency     TEXT NOT NULL DEFAULT 'THB',
  expect_date  TEXT NOT NULL,
  repeat       TEXT,
  note         TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'waiting',
  created_at   TEXT DEFAULT CURRENT_TIMESTAMP,
  deleted      INTEGER NOT NULL DEFAULT 0
);
-- @@
CREATE INDEX IF NOT EXISTS idx_expected_status ON expected_income(status, expect_date);
-- @@

-- ─── budgets ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS budgets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  category      TEXT NOT NULL,
  limit_amount  REAL NOT NULL,
  month         TEXT NOT NULL,
  UNIQUE(category, month)
);
-- @@

-- ─── saving_goals ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS saving_goals (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  target_amount   REAL NOT NULL,
  current_amount  REAL NOT NULL DEFAULT 0,
  deadline        TEXT,
  emoji           TEXT DEFAULT '🎯',
  is_completed    INTEGER DEFAULT 0,
  created_at      TEXT DEFAULT (datetime('now'))
);
-- @@

-- ─── app_settings ────────────────────────────────────────────────────────────
-- Key-value. Some keys are device-local (a wallpaper path means nothing on a
-- phone) and some are the same everywhere (currency, language). The split is
-- declared in code, not here, because it is a policy and not a shape.
-- ─── what actually happened, as opposed to what is true now ────────────────
--
-- WHY THIS TABLE EXISTS
--
-- `tasks.completed_until` is one field that gets OVERWRITTEN every cycle, so
-- ticking today erases the trace of yesterday. Nothing anywhere records that a
-- thing was done on a given day. That is not a missing screen, it is missing
-- data, and the days that pass before it is collected are gone for good.
--
-- APPEND ONLY. Nothing here is ever updated or deleted. That makes it the
-- easiest table in the schema to sync — two devices merging events is a union,
-- with no last-write-wins, no tombstones and no clash rules — and it makes it
-- the only place that can answer "what happened on the 14th" at all.
--
-- WHAT IS DELIBERATELY NOT RECORDED
--
-- Misses. A row per thing not done is a list that is painful to read and
-- trivial to derive later from the schedule if it is ever genuinely wanted.
-- Recording only what happened keeps this a record and stops it becoming a
-- report card. Same reason there are no rates, totals or streaks stored here:
-- storing a score is what makes a score exist.
--
-- SIZE. About 70 bytes a row. Ten ticks a day is roughly 250 KB a year, which
-- is smaller than one photo, so nothing is summarised away and nothing expires.
-- Raw events keep every future question answerable; a summary answers only the
-- question somebody thought of first.
CREATE TABLE IF NOT EXISTS task_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  -- The task's shared name, not its local row id, so an event still points at
  -- the right task on the other device.
  task_uid   TEXT NOT NULL,
  -- 'done' or 'undone'. Undo is recorded rather than erasing the tick, because
  -- "ticked then untidied it at 9:02" is a different afternoon from "never
  -- ticked", and only one of them can be reconstructed if the other is dropped.
  kind       TEXT NOT NULL,
  -- When it happened, from the same clock the sync triggers use.
  at         TEXT NOT NULL,
  -- The cycle the tick was for, copied from completed_until at the time. Lets a
  -- calendar say which day's dailies this was, even when the tick was made a
  -- minute before the reset.
  for_cycle  TEXT
);

-- @@

-- This separator was missing, and the loader splits on nothing else. Without
-- it the two CREATE TABLE statements above and below arrived as one string,
-- and SQLite runs the first statement in a string and stops. So task_events
-- was created and app_settings silently was not.
--
-- It was invisible for months because no device had ever built this schema
-- from scratch: every phone and every desktop already had app_settings from
-- an earlier version that made it elsewhere. The first fresh install found it
-- immediately, with `no such table: app_settings` on the sync line.
CREATE TABLE IF NOT EXISTS app_settings (
  key    TEXT PRIMARY KEY,
  value  TEXT
);
-- @@

-- ─── user_settings ───────────────────────────────────────────────────
-- The half of app_settings that describes a person rather than a machine.
--
-- WHY A SECOND TABLE AND NOT A COLUMN OR A KEY PREFIX
--
-- app_settings holds the pairing key and the WebDAV password. Whatever decides
-- which rows may leave this machine has to be right every time, and a predicate
-- over key names is a decision the store, the backup, the migration and both
-- languages would each have to make separately and identically. A table name is
-- a decision the sync layer already knows how to read: SYNC_TABLES lists it or
-- it does not.
--
-- So this is not a split of app_settings so much as a promotion out of it. What
-- stays behind is the machine's own business — secrets, sync bookkeeping, the
-- wallpaper path — and none of it is one line of policy away from being sent.
--
-- The shape copies expense_categories on purpose: an autoincrement id so the
-- sync triggers work unchanged, and a UNIQUE key so two devices that invent the
-- same setting independently collide on the natural key and settle, rather than
-- ending up with two rows nobody chose between.
--
-- `key` is the localStorage name, character for character, and `value` is the
-- localStorage string, byte for byte. Not a tidier scheme, deliberately: any
-- translation between the two would be a second format with a second parser on
-- each side, and four parsers that have to agree is the shape of every bug this
-- project has spent a month removing.
CREATE TABLE IF NOT EXISTS user_settings (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  key    TEXT NOT NULL UNIQUE,
  value  TEXT
);
-- @@

-- ─── expense_categories ──────────────────────────────────────────────────────
-- User data, not a constant in the source. `label` is nullable and null means
-- "built-in, translate it", which keeps the defaults bilingual while letting
-- anything the user makes carry a literal name.
CREATE TABLE IF NOT EXISTS expense_categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT NOT NULL UNIQUE,
  label       TEXT,
  emoji       TEXT NOT NULL DEFAULT '📦',
  color       TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_hidden   INTEGER NOT NULL DEFAULT 0
);
-- @@

-- ─── migrations ──────────────────────────────────────────────────────────────
--
-- Everything below is an ALTER that must survive being run again. SQLite has no
-- ADD COLUMN IF NOT EXISTS, so the loader swallows the "duplicate column"
-- error, which is the normal path on every launch after the first.
--
-- Append only. Never edit a line here once it has shipped.

ALTER TABLE tasks ADD COLUMN specific_date TEXT;
-- @@
ALTER TABLE tasks ADD COLUMN is_priority INTEGER DEFAULT 0;
-- @@
ALTER TABLE tasks ADD COLUMN is_urgent INTEGER DEFAULT 0;
-- @@
ALTER TABLE tasks ADD COLUMN completed_until TEXT DEFAULT NULL;
-- @@
ALTER TABLE tasks ADD COLUMN completed_at TEXT DEFAULT NULL;
-- @@
ALTER TABLE tasks ADD COLUMN notes TEXT DEFAULT '';
-- @@
-- Null = the time floats with the app's zone, which is what every row did
-- before this column existed. A game server resetting at 04:00 Tokyo is pinned;
-- "take the pills at 09:00" floats. Null is a choice, not a missing value.
ALTER TABLE tasks ADD COLUMN time_zone TEXT DEFAULT NULL;
-- @@
ALTER TABLE tasks ADD COLUMN intent TEXT DEFAULT NULL;
-- @@
ALTER TABLE tasks ADD COLUMN cycle_checked_until TEXT DEFAULT NULL;
-- @@
ALTER TABLE tasks ADD COLUMN missed_streak INTEGER DEFAULT 0;
-- @@
ALTER TABLE tasks ADD COLUMN min_step TEXT;
-- @@
ALTER TABLE tasks ADD COLUMN paused_until TEXT DEFAULT NULL;
-- @@
ALTER TABLE tasks ADD COLUMN deleted_at TEXT DEFAULT NULL;
-- @@
ALTER TABLE expenses ADD COLUMN currency TEXT NOT NULL DEFAULT 'THB';
-- @@
ALTER TABLE income ADD COLUMN currency TEXT NOT NULL DEFAULT 'THB';
-- @@
ALTER TABLE budgets ADD COLUMN currency TEXT NOT NULL DEFAULT 'THB';
-- @@
ALTER TABLE saving_goals ADD COLUMN currency TEXT NOT NULL DEFAULT 'THB';
-- @@
ALTER TABLE expenses ADD COLUMN slip_ref TEXT;
-- @@
CREATE UNIQUE INDEX IF NOT EXISTS idx_expenses_slip_ref
  ON expenses(slip_ref) WHERE slip_ref IS NOT NULL;
-- @@

-- ─── sync columns ────────────────────────────────────────────────────────────
--
-- Added last, after every table exists.
--
-- `deleted` on tasks is NEW, and it closes a real hole. The old note said tasks
-- did not need a tombstone because is_active = 0 keeps the row — true for the
-- bin, false for the button that empties it. purgeTask() ran a real DELETE, so
-- the row vanished carrying no information, and under sync the other device
-- would helpfully send it back. The symptom is "I deleted it and it came back",
-- which reads as the machine being haunted.

ALTER TABLE tasks ADD COLUMN uid TEXT;
-- @@
ALTER TABLE tasks ADD COLUMN updated_at TEXT;
-- @@
ALTER TABLE tasks ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;
-- @@
ALTER TABLE income ADD COLUMN uid TEXT;
-- @@
ALTER TABLE income ADD COLUMN updated_at TEXT;
-- @@
ALTER TABLE income ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;
-- @@
ALTER TABLE expenses ADD COLUMN uid TEXT;
-- @@
ALTER TABLE expenses ADD COLUMN updated_at TEXT;
-- @@
ALTER TABLE expenses ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;
-- @@
ALTER TABLE budgets ADD COLUMN uid TEXT;
-- @@
ALTER TABLE budgets ADD COLUMN updated_at TEXT;
-- @@
ALTER TABLE budgets ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;
-- @@
ALTER TABLE saving_goals ADD COLUMN uid TEXT;
-- @@
ALTER TABLE saving_goals ADD COLUMN updated_at TEXT;
-- @@
ALTER TABLE saving_goals ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;
-- @@
ALTER TABLE expense_categories ADD COLUMN uid TEXT;
-- @@
ALTER TABLE expense_categories ADD COLUMN updated_at TEXT;
-- @@
ALTER TABLE expense_categories ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;
-- @@
ALTER TABLE expected_income ADD COLUMN uid TEXT;
-- @@
ALTER TABLE expected_income ADD COLUMN updated_at TEXT;
-- @@
ALTER TABLE tasks ADD COLUMN notify_before_min INTEGER;
-- @@