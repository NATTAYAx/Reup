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
import { WebDavStorage, type HttpTransport, type SyncStorage } from "./storage";

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
  | { kind: "webdav"; baseUrl: string; username: string; password: string };

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
export function storageFor(c: SyncConfig, http: HttpTransport): SyncStorage | null {
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

export async function saveSyncConfig(db: Db, c: SyncConfig): Promise<void> {
  await db.execute(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [SYNC_CONFIG_KEY, serialiseSyncConfig(c)],
  );
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
export async function syncNow(db: Db, http: HttpTransport): Promise<SyncReport | null> {
  const cfg = await loadSyncConfig(db);
  const pairing = pairingOf(cfg);
  if (!pairing) return null;

  const storage = storageFor(cfg, http);
  if (!storage) return null;

  const store = await SqlLocalStore.open(db);
  return syncWith(store, storage, pairing);
}

// ─── what a backup is not allowed to carry ───────────────────────────────────

/**
 * The `app_settings` rows that describe THIS machine rather than the person.
 *
 * Built from the two constants rather than from two more string literals. A list
 * of keys that has to agree with the code that writes them, by somebody
 * remembering, is the disease this project keeps curing.
 */
export const MACHINE_ONLY_SETTINGS = new Set<string>([SYNC_STATE_KEY, SYNC_CONFIG_KEY]);

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
 * The cost is real and worth saying out loud on the screen that restores a
 * backup: sync does not come back with it. The pairing code has to be entered
 * again, from wherever the person wrote it down.
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