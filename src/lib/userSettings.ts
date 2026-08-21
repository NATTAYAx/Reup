// ─── userSettings.ts — the settings that belong to a person, not a machine ────
//
// WHAT THIS IS FOR
//
// Quiet hours, currency and language have lived in localStorage since the first
// week, which was right while there was one machine. With two, it reads as a
// bug that nobody can name: the phone starts ringing at 04:00 on a person who
// has had the app silent at night for months, because the phone has no way to
// know what "night" means here. That was written down in Repo.kt as a stated
// default rather than an accident, with a note that the proper fix was work of
// its own. This is that work.
//
// ─── WHY A SECOND TABLE AND NOT A FLAG ON app_settings ───────────────────────
//
// app_settings holds the pairing key and the WebDAV password. Whatever decides
// which rows may leave this machine has to be right every single time, and a
// predicate over key names is a decision the store, the backup, the migration
// and both languages would each have to make separately and identically. A
// table name is a decision the sync layer already knows how to read.
//
// So `user_settings` is not so much a split of app_settings as a promotion out
// of it. What stays behind is the machine's own business, and none of it is one
// line of policy away from being sent.
//
// ─── WHY localStorage IS STILL THERE ─────────────────────────────────────────
//
// Every reader of these settings is synchronous — `getCurrency()` is called
// from render, `getQuietHours()` from a timer — and the database is not. Moving
// the readers would mean turning a dozen call sites async to change where a
// string comes from, which is a large edit whose only purpose is plumbing.
//
// So localStorage stays as a cache and the table becomes the truth. The table
// is read into the cache once at startup and again after any sync that touched
// it; writes go to both. Every existing call site is untouched, which is also
// the note storageKeys.ts left about not doing this as one big refactor.
//
// The cost is one failure mode worth stating: a database write that fails
// leaves the cache ahead of the table, and the next launch reverts that setting
// to the older value. It is visible, it is one setting, and it is redoable —
// against a silent divergence between two machines, which is what the
// alternative costs.

import { dataChanged } from "./dataChanged";

/** The slice of the SQL plugin this file uses. Same shape as sqlLocalStore's. */
export interface SettingsDb {
  execute(sql: string, params?: unknown[]): Promise<unknown>;
  select<T>(sql: string, params?: unknown[]): Promise<T>;
}

// ─── which settings these are ────────────────────────────────────────────────
//
// The localStorage names, character for character. Not a prettier scheme:
// any translation between the two would be a mapping table, and a mapping table
// is one more thing that can be updated on one side only.

/** `{ enabled, start, end }`, as notifier.ts writes it. */
export const QUIET_KEY = "gamesched_quiet_hours_v1";
/** An ISO 4217 code. */
export const CURRENCY_KEY = "gamesched_currency";
/** "th" or "en". */
export const LANG_KEY = "gamesched_lang_v1";

/**
 * Everything that travels, and nothing else.
 *
 * Three, and each one earns its place by being about the person rather than the
 * hardware in front of them. Theme, sound file, toast style, tray hints and the
 * wallpaper path are all about a screen; the API keys and the pairing code are
 * secrets; the "important" card is deliberately never sent anywhere. None of
 * them is here, and adding a fourth means adding it to this list and nowhere
 * else.
 */
export const SYNCED_SETTING_KEYS: readonly string[] = [QUIET_KEY, CURRENCY_KEY, LANG_KEY];

// ─── quiet hours, parsed in one place ────────────────────────────────────────

/**
 * What the stored value means, with "nothing stored" kept separate from "off".
 *
 * The distinction only matters on the other device and it matters a great deal
 * there. A phone that has never synced knows nothing and should fall back to a
 * sensible night; a phone that has synced and been told quiet hours are off
 * must not put them back. Collapsing the two into a nullable would make the
 * second case indistinguishable from the first, and the failure is an alarm at
 * four in the morning that the person explicitly turned off.
 */
export type QuietSetting =
  | { kind: "unknown" }
  | { kind: "off" }
  | { kind: "window"; start: string; end: string };

const HHMM = /^\d{2}:\d{2}$/;

/**
 * Read the stored string, tolerating everything a stored string can be.
 *
 * Anything unreadable is `unknown` rather than an error. This is parsed on a
 * timer and inside a broadcast receiver, and a settings row that somebody
 * edited by hand should cost a default, not a scheduler that refuses to run.
 */
export function parseQuiet(raw: string | null | undefined): QuietSetting {
  if (raw === null || raw === undefined || raw === "") return { kind: "unknown" };
  let p: Record<string, unknown>;
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== "object" || v === null || Array.isArray(v)) return { kind: "unknown" };
    p = v as Record<string, unknown>;
  } catch {
    return { kind: "unknown" };
  }
  if (!("enabled" in p)) return { kind: "unknown" };
  if (p.enabled !== true) return { kind: "off" };
  const start = typeof p.start === "string" && HHMM.test(p.start) ? p.start : null;
  const end = typeof p.end === "string" && HHMM.test(p.end) ? p.end : null;
  // Switched on but with an unreadable window is not off — somebody asked for
  // quiet and the numbers were lost. Reporting `unknown` lets each side apply
  // its own default night rather than silently deciding there is none.
  if (!start || !end) return { kind: "unknown" };
  // Equal bounds are treated as off rather than as a whole day of silence, the
  // same as notifier.ts has always done. Someone who sets both to 08:00 has
  // made a mistake, and losing every reminder for ever is not the failure to
  // pick.
  if (start === end) return { kind: "off" };
  return { kind: "window", start, end };
}

// ─── the table ───────────────────────────────────────────────────────────────

/**
 * A write that changes nothing writes nothing.
 *
 * The `WHERE` on the upsert is what makes that true rather than nearly true.
 * Without it, saving the settings screen with no changes bumps updated_at,
 * fires the outbox trigger and puts a row on the wire — every time, on both
 * devices, for ever.
 */
const UPSERT =
  `INSERT INTO user_settings (key, value) VALUES (?, ?)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value
    WHERE user_settings.value IS NOT excluded.value`;

export async function writeSetting(db: SettingsDb, key: string, value: string): Promise<void> {
  await db.execute(UPSERT, [key, value]);
}

export async function readSettings(db: SettingsDb): Promise<Map<string, string>> {
  const rows = await db.select<{ key: string; value: string | null; deleted: number }[]>(
    `SELECT key, value, deleted FROM user_settings`,
  );
  const out = new Map<string, string>();
  for (const r of rows) {
    // A tombstone is a key that was retired, not a key set to nothing.
    if (r.deleted) continue;
    if (typeof r.value === "string") out.set(r.key, r.value);
  }
  return out;
}

// ─── the mirror ──────────────────────────────────────────────────────────────
//
// One module-level handle, set once at startup. Global state, and it is the
// smallest honest version of the problem: the alternative is threading a
// database through ten synchronous call sites so that a setter can also write a
// row. If nothing has been attached — which is every test, and the settings
// screen before the database opens — writes fall back to localStorage alone and
// nothing breaks.

let attached: SettingsDb | null = null;

export function attachSettingsDb(db: SettingsDb): void {
  attached = db;
}

/** Exported for tests, which must not inherit an attachment from another one. */
export function detachSettingsDb(): void {
  attached = null;
}

function cacheGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function cacheSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* quota, private mode — the table still has it */
  }
}

/**
 * Write a setting to both the cache and the table.
 *
 * Synchronous by design: it returns as soon as the cache is written, so the
 * screen that called it redraws immediately, and the row is written behind it.
 * The failure is swallowed for the same reason it is swallowed in every other
 * setter here — a settings screen that throws because a disk was busy is worse
 * than a setting that has to be picked again.
 */
export function putSetting(key: string, value: string): void {
  cacheSet(key, value);
  const db = attached;
  if (!db) return;
  void writeSetting(db, key, value).catch(() => {
    /* see above; the cache is still right and hydrate will notice next launch */
  });
}

/**
 * Bring the cache in line with the table, and seed the table from the cache.
 *
 * Called at startup and after any sync that touched the table.
 *
 * The seeding half is what makes the first launch after this shipped do the
 * right thing: every existing install has these three in localStorage and an
 * empty table, and without it the first sync would send nothing and the second
 * device would keep its own. It is an INSERT that does nothing on conflict, so
 * it can only ever fill a hole — a device that already has a row keeps it, and
 * the merge decides between two devices that both had one.
 *
 * Returns whether anything in the cache actually changed, so the caller can
 * decide whether the screen needs to hear about it.
 */
export async function hydrateSettings(db: SettingsDb): Promise<boolean> {
  const table = await readSettings(db);
  let changed = false;

  for (const key of SYNCED_SETTING_KEYS) {
    const stored = table.get(key);
    if (stored === undefined) {
      const local = cacheGet(key);
      if (local !== null) {
        await db.execute(
          `INSERT INTO user_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING`,
          [key, local],
        );
      }
      continue;
    }
    if (cacheGet(key) !== stored) {
      cacheSet(key, stored);
      changed = true;
    }
  }

  return changed;
}

/**
 * The startup path: attach, hydrate, and tell the screen if anything moved.
 *
 * Separate from hydrateSettings so that check-sync can exercise the table half
 * without a browser anywhere in sight.
 */
export async function initSettings(db: SettingsDb): Promise<void> {
  attachSettingsDb(db);
  try {
    if (await hydrateSettings(db)) dataChanged(new Set(["user_settings"]));
  } catch {
    // A settings table that will not open is not a reason to refuse to start.
    // The cache is whatever it was, which is what the app used yesterday.
  }
}