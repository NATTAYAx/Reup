// ─── config.ts — turning a person's settings into a running sync ─────────────
//
// Everything else in this folder is a part. This is the only file that knows how
// the parts fit together, and it exists because the alternative is a component
// somewhere assembling a store, a transport, a storage adapter and a key inline.
//
// WHERE THE KEY LIVES, AND WHY THAT IS THE WHOLE DESIGN
// ----------------------------------------------------
// The pairing code is the bucket id and the encryption key. The server never
// sees the key, so the server cannot read a single task name — and equally,
// nobody can recover it. Lose the code with no other device holding it and the
// data in the bucket is gone for good. That is not a gap to be closed later; it
// is the thing being bought.
//
// So the code is stored in `app_settings`, which never syncs, and it is kept out
// of the backup file on purpose. A backup that carries the key would put the key
// in whatever folder the backup is kept in, which for most people is the same
// cloud drive holding the encrypted data. Both halves in one place is the same
// as neither half being protected.
//
// The consequence is that the pairing code has to be written down by the person,
// once, somewhere that is not this machine. Any screen that creates one has to
// say so plainly rather than in a footnote.

import { decodePairing, encodePairing, randomBucketId, randomKey, type Pairing } from "./crypto";
import { sync, type SyncReport } from "./engine";
import { SqlLocalStore, SYNC_STATE_KEY, type Db } from "./sqlLocalStore";
import { dataChanged } from "../dataChanged";
import { WebDavStorage, type HttpTransport, type SyncStorage } from "./storage";
import { GoogleDriveStorage, type AccessTokenSource } from "./drive";
import { GOOGLE_TOKENS_KEY } from "./googleAuth";
import { outboxReseed } from "../syncMeta";
import { hydrateSettings, type SettingsDb } from "../userSettings";

/** The one row in `app_settings` that holds all of this. */
export const SYNC_CONFIG_KEY = "sync_config_v1";

/**
 * Google Drive is deliberately absent.
 *
 * The adapter for it is written and tested, but nothing can hand it a token yet:
 * the sign-in flow is a desktop-only loopback listener on one side and Android's
 * Credential Manager on the other, and neither exists. A third option in this
 * union that cannot be selected is a branch that looks supported and is not.
 */
export type SyncBackend =
  | { kind: "off" }
  | { kind: "webdav"; baseUrl: string; username: string; password: string }
  /**
   * Google Drive's appDataFolder.
   *
   * Nothing to store here: the folder is fixed and the tokens live in their own
   * key, written by the sign-in rather than typed into a box. A backend with no
   * fields is still a backend — it is the answer to "where does this device
   * put its blobs", which is the question this union exists for.
   */
  | { kind: "drive" };

export interface SyncConfig {
  backend: SyncBackend;
  /**
   * The pairing code as text, exactly as it is shown to the person.
   *
   * Stored as the string rather than as a parsed bucket id and key so that what
   * is on screen and what is on disk are the same characters. A code that is
   * displayed after a round trip through a parser is a code that can be copied
   * down correctly and still not work.
   */
  pairing: string | null;
}

export const SYNC_OFF: SyncConfig = { backend: { kind: "off" }, pairing: null };

/**
 * Reading never throws and never discards.
 *
 * A malformed backend falls back to off, because the worst case there is that
 * sync stays quiet until someone sets it up again. A malformed pairing code is
 * kept exactly as found: dropping it would delete the only copy of a key, which
 * is the one mistake in this file that cannot be undone. Whether it is usable is
 * decided at the point of use, by `pairingOf`.
 */
export function parseSyncConfig(raw: string | null): SyncConfig {
  if (!raw) return SYNC_OFF;

  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return SYNC_OFF;
  }
  if (!v || typeof v !== "object") return SYNC_OFF;

  const o = v as Record<string, unknown>;
  const pairing = typeof o.pairing === "string" && o.pairing !== "" ? o.pairing : null;
  const b = (o.backend ?? {}) as Record<string, unknown>;

  if (
    b.kind === "webdav" &&
    typeof b.baseUrl === "string" &&
    typeof b.username === "string" &&
    typeof b.password === "string" &&
    b.baseUrl !== ""
  ) {
    return {
      backend: {
        kind: "webdav",
        baseUrl: b.baseUrl,
        username: b.username,
        password: b.password,
      },
      pairing,
    };
  }

  // Drive carries no fields of its own — the folder is fixed and the tokens
  // live under their own key. So there is nothing to validate, only a name to
  // recognise, and forgetting to recognise it is exactly what happened: the
  // config was written as drive and read back as off, so the settings screen
  // showed Drive selected from React state while every sync loaded `off` from
  // the database and returned null. Nothing errored and nothing appeared.
  if (b.kind === "drive") return { backend: { kind: "drive" }, pairing };

  return { backend: { kind: "off" }, pairing };
}

export function serialiseSyncConfig(c: SyncConfig): string {
  return JSON.stringify(c);
}

/** A fresh bucket and a fresh key, as one string to write down. */
export function newPairing(): string {
  return encodePairing({ bucketId: randomBucketId(), key: randomKey() });
}

/** The usable form, or null. Never throws: a bad code is a state, not a crash. */
export function pairingOf(c: SyncConfig): Pairing | null {
  if (!c.pairing) return null;
  try {
    return decodePairing(c.pairing);
  } catch {
    return null;
  }
}

/** Both halves present: somewhere to put it, and something to lock it with. */
export function isReady(c: SyncConfig): boolean {
  return c.backend.kind !== "off" && pairingOf(c) !== null;
}

/**
 * Throws for a URL that cannot be used, because that is a setting to fix rather
 * than a condition to survive. Returns null only for "the person turned it off".
 */
export function storageFor(
  c: SyncConfig,
  http: HttpTransport,
  /**
   * Only Drive needs this, and only to find its refresh token. Optional so that
   * every existing caller and every test that only ever meant WebDAV keeps
   * working unchanged, and so that "Drive with nobody signed in" is a missing
   * argument rather than a runtime surprise.
   */
  tokens?: AccessTokenSource,
): SyncStorage | null {
  if (c.backend.kind === "drive") {
    if (!tokens) return null;
    return new GoogleDriveStorage(http, tokens);
  }
  if (c.backend.kind === "webdav") {
    return new WebDavStorage(http, {
      baseUrl: c.backend.baseUrl,
      username: c.backend.username,
      password: c.backend.password,
    });
  }
  return null;
}

export async function loadSyncConfig(db: Db): Promise<SyncConfig> {
  const rows = await db.select<{ value: string }[]>(
    "SELECT value FROM app_settings WHERE key = ?",
    [SYNC_CONFIG_KEY],
  );
  return parseSyncConfig(rows.length > 0 ? rows[0].value : null);
}

/**
 * Whether two configs describe the same conversation.
 *
 * Not the same settings — the same *folder and key*. Sync state is a record of
 * what has been said to one particular pile of files, locked with one
 * particular key. Point the app at a different folder, or at the same folder
 * with a different key, and every sentence in that record is about something
 * that is no longer there.
 */
function sameTarget(a: SyncConfig, b: SyncConfig): boolean {
  if (a.pairing !== b.pairing) return false;
  if (a.backend.kind !== b.backend.kind) return false;
  if (a.backend.kind === "webdav" && b.backend.kind === "webdav") {
    // Only the address. A password that changed is the same folder behind a new
    // door, and re-uploading everything for a typo corrected would be silly.
    return a.backend.baseUrl === b.backend.baseUrl;
  }
  return true;
}

/**
 * Forget what was said to the old folder, without forgetting who is saying it.
 *
 * WHAT IS KEPT, AND WHY IT IS THE ONE THING
 *
 * `device` is this installation's name and must never change: it is half of
 * every file name this device has ever written, and a device that renames
 * itself becomes a second device that the first one will happily read its own
 * writes back from.
 *
 * `seq` is kept for a sharper reason. It is not "how far through this folder"
 * — it is "the highest number I have ever put on a file". Resetting it to zero
 * would mean writing `d-me-1` again, and if the old folder is ever pointed at
 * again there would be two different files with one name, which is exactly the
 * hazard `an interrupted upload never reuses its sequence number` exists to
 * prevent. Numbers only ever go up, in every folder, for the life of the
 * install.
 *
 * `cursor` is the one that is about the folder, and it is the one that goes —
 * along with the outbox, which is the thing that actually decides what gets
 * sent. Lowering a watermark used to be what put the whole database back in the
 * outgoing pile; with a queue instead of a comparison that has to be said
 * rather than implied, so the queue is refilled here. The seeding is syncMeta's,
 * not a second copy of it.
 *
 * WHAT THIS FIXES
 *
 * Connecting Drive and pressing sync reported `sent 0 out` against an empty
 * folder, because the watermark this used to keep still said everything had
 * been uploaded — to WebDAV, hours earlier. The desktop would then have gone on uploading only
 * future changes, and a phone switched to Drive would have pulled an empty
 * folder and shown no tasks, with both devices reporting success.
 */
async function forgetRemoteProgress(db: Db): Promise<void> {
  const rows = await db.select<{ value: string }[]>(
    "SELECT value FROM app_settings WHERE key = ?",
    [SYNC_STATE_KEY],
  );
  if (rows.length === 0) return;

  let state: Record<string, unknown>;
  try {
    state = JSON.parse(rows[0].value) as Record<string, unknown>;
  } catch {
    // Unreadable state is already going to be replaced wholesale by the next
    // run. Nothing to preserve, and nothing to complain about.
    return;
  }

  await db.execute(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [
      SYNC_STATE_KEY,
      JSON.stringify({
        device: state.device,
        seq: typeof state.seq === "number" ? state.seq : 0,
        cursor: {},
      }),
    ],
  );

  for (const m of outboxReseed()) {
    await db.execute(m.sql);
  }
}

export async function saveSyncConfig(db: Db, c: SyncConfig): Promise<void> {
  // Read before write, so that "did the target change" is answered here rather
  // than remembered by every screen that can change a setting. There is one
  // such screen today; the second one is where this would have been forgotten.
  const previous = await loadSyncConfig(db);

  await db.execute(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [SYNC_CONFIG_KEY, serialiseSyncConfig(c)],
  );

  // Off is not a different folder, it is no folder. Coming back to the same one
  // should not mean re-uploading the database.
  if (c.backend.kind === "off" || previous.backend.kind === "off") return;
  if (!sameTarget(previous, c)) await forgetRemoteProgress(db);
}

/**
 * The assembly, with nothing to look up.
 *
 * Split out from `syncNow` so the whole round trip can be run against an
 * in-memory storage in a test without a database, a transport or a settings row
 * anywhere in sight.
 */
export function syncWith(
  store: SqlLocalStore,
  storage: SyncStorage,
  pairing: Pairing,
): Promise<SyncReport> {
  return sync({
    storage,
    store,
    bucketId: pairing.bucketId,
    key: pairing.key,
    // Debug only downstream: the engine records it in the state blob so a run
    // can be dated, and never compares it against anything.
    now: () => new Date().toISOString(),
  });
}

/**
 * One round trip, or null if sync is not set up.
 *
 * Null rather than an error because "not set up" is the normal state of this
 * app for anyone who has not asked for sync, and a caller on a timer should not
 * have to tell that apart from a failure.
 */
export async function syncNow(
  db: Db,
  http: HttpTransport,
  /**
   * Supplied by the caller for the Drive backend, because building one means
   * asking Tauri for the client credentials.
   *
   * This file is imported by check-sync.ts, which runs under plain node with no
   * Tauri anywhere. An import of the sign-in code from here — even one only
   * reached on the Drive path — makes the whole sync suite unloadable, and the
   * failure is the entire harness rather than one check. Keeping the arrow
   * pointing this way is what keeps the engine runnable outside the app, which
   * is the property those 104 checks are made of.
   */
  tokens?: AccessTokenSource,
): Promise<SyncReport | null> {
  const cfg = await loadSyncConfig(db);
  const pairing = pairingOf(cfg);
  if (!pairing) return null;

  // Not signed in yet reads as "not set up", the same as no address typed into
  // the WebDAV boxes: a state to fix on the settings screen, not a failure for
  // a caller on a timer to report.
  if (cfg.backend.kind === "drive" && !tokens) return null;

  const storage = storageFor(cfg, http, tokens);
  if (!storage) return null;

  const store = await SqlLocalStore.open(db);
  const report = await syncWith(store, storage, pairing);

  // A setting that arrived is a row like any other, and every reader of one is
  // synchronous and reads a cache. Nothing would have noticed until the next
  // launch: the currency would still be the old one on screen and the quiet
  // window the scheduler used would still be the old one too.
  if (store.appliedTables.has("user_settings")) {
    try {
      await hydrateSettings(db as unknown as SettingsDb);
    } catch {
      // Same reasoning as at startup: a settings row that will not read is not
      // a reason to report the sync itself as having failed.
    }
  }

  // The rows are in the database; the screen showing them does not know yet.
  // Announced from here rather than from the button, because a timer will call
  // this too one day and the news is the same either way. See dataChanged.
  dataChanged(store.appliedTables);

  return report;
}

// ─── what a backup is not allowed to carry ───────────────────────────────────

/**
 * The `app_settings` rows that describe THIS machine rather than the person.
 *
 * Built from the two constants rather than from two more string literals. A list
 * of keys that has to agree with the code that writes them, by somebody
 * remembering, is the disease this project keeps curing.
 */
export const MACHINE_ONLY_SETTINGS = new Set<string>([
  SYNC_STATE_KEY,
  SYNC_CONFIG_KEY,
  GOOGLE_TOKENS_KEY,
]);

/**
 * One rule, asked in both directions.
 *
 * `sync_state_v1` is the device id, the sequence number it has issued up to, and
 * how far it has read every other device. Restore that onto a second machine and
 * two devices claim one identity: they hand out the same file names, each
 * overwrites the other's batches in the bucket, and the rows in the overwritten
 * ones are gone with nothing reporting it.
 *
 * `sync_config_v1` holds the pairing code, which is the encryption key. A backup
 * carrying it puts the key in whatever folder the backup is kept in, which for
 * most people is the same cloud drive holding the encrypted data. Both halves in
 * one place is the same as neither half being protected.
 *
 * `sync_google_tokens` holds a Google refresh token, and that one is worse than
 * either. The pairing code protects data that is already the person's own; a
 * refresh token is a live credential to somebody's Google account, good until
 * it is explicitly revoked and unaffected by changing the password. A backup
 * file is written to be copied — onto a second machine, into a cloud folder,
 * attached to a message asking for help with a bug — and every copy of it would
 * have carried one.
 *
 * It was missed for the reason this comment already gives about the API keys: a
 * list of names that has to agree with the code that writes them, by somebody
 * remembering. The key now comes from the file that writes it rather than from
 * a second copy of the string, so the next round of this has one less way to go
 * wrong.
 *
 * The cost is real and worth saying out loud on the screen that restores a
 * backup: sync does not come back with it. The pairing code has to be entered
 * again, from wherever the person wrote it down, and Google has to be connected
 * again — which is one button and a browser, and is the correct amount of
 * trouble for what it buys.
 *
 * It lives here rather than in backup.ts because backup.ts cannot be loaded
 * outside the app — it reaches the database and the language files — and a rule
 * about what leaves the machine is a rule that has to be testable.
 */
export function keepInBackup(table: string, row: unknown): boolean {
  if (table !== "app_settings") return true;
  if (!row || typeof row !== "object") return true;
  const key = (row as Record<string, unknown>).key;
  return typeof key !== "string" || !MACHINE_ONLY_SETTINGS.has(key);
}