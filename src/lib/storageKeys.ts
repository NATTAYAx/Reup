// ─── storageKeys.ts — one place that knows what is in localStorage ────────────
//
// WHY THIS FILE EXISTS
//
// There are roughly twenty-five `gamesched_*` keys spread across the files that
// own them, and until now nowhere listed them. That is fine while a feature is
// being written and bad in two directions afterwards:
//
//   1. REMOVING a feature leaves its key behind on every machine that ever ran
//      the old build, and backup.ts copies anything with the right prefix, so
//      the orphan rides along in every backup file forever.
//
//   2. Deciding a key is a SECRET has to happen somewhere, and if that somewhere
//      is a different file from the one that writes it, the two drift. That is
//      exactly what happened: backup.ts excluded "gamesched_gemini_key" while
//      aiProviders.ts had already moved to per-provider names, so live API keys
//      for all three providers were being written into backup files in plain
//      text — into the one file the comments describe as "meant to be copied
//      around and left in folders".
//
// So the rule from here on: a key's NAME and its BACKUP POLICY are declared
// together, in this file, and backup.ts asks rather than remembers.
//
// This is deliberately not a big-bang refactor. Existing modules keep their own
// private constants for now; what matters is that the policy below is complete,
// because that is the half that leaks. Moving each call site over can happen
// whenever the file is being touched for another reason anyway.

/** Everything the app writes is prefixed with this. */
export const PREFIX = "gamesched";

// ─── Secrets ──────────────────────────────────────────────────────────────────
//
// Never written to a backup file, never shown in a log, never sent anywhere but
// the provider the key belongs to. A key takes ten seconds to paste back in and
// considerably longer to notice has been stolen, so the trade is not close.

/** Per-provider key names, as written by lib/aiProviders. */
export const AI_KEY_PREFIX = `${PREFIX}_ai_key_`;

/** The original single-provider name, still mirrored for backwards compat. */
export const LEGACY_GEMINI_KEY = `${PREFIX}_gemini_key`;

export function isSecretKey(key: string): boolean {
  return key.startsWith(AI_KEY_PREFIX) || key === LEGACY_GEMINI_KEY;
}

// ─── Transient ────────────────────────────────────────────────────────────────
//
// Left out of backups because restoring them is worthless, not because they are
// dangerous: they are large, they rebuild themselves from use, and a stale copy
// is worse than an empty one.

export const AI_CACHE = `${PREFIX}_ai_cache_v1`;

export function isTransientKey(key: string): boolean {
  return key === AI_CACHE;
}

// ─── Needs scrubbing before it leaves the machine ─────────────────────────────
//
// The call log exists so that improvements to the offline parser can be aimed
// rather than guessed at, and for that job the intent, the confidence and the
// token counts are the useful part. The raw sentence is not — and the raw
// sentence is a verbatim record of the last three hundred things typed into the
// assistant, including every line of spending. That is not something to write
// into a file whose whole purpose is to be copied to a USB stick.
//
// So the log still travels, minus the text. Telemetry survives; the diary does
// not go with it.

export const AI_LOG = `${PREFIX}_ai_log_v1`;

/**
 * Returns what should be written to a backup for this key, or null to leave it
 * out entirely. Input and output are both the raw stored string.
 */
export function sanitizeForBackup(key: string, value: string): string | null {
  if (isSecretKey(key) || isTransientKey(key)) return null;

  if (key === AI_LOG) {
    try {
      const log = JSON.parse(value);
      if (!Array.isArray(log)) return null;
      // Drop the sentence, keep the shape. `text` is read back by the escapes
      // screen for grouping, so it becomes an empty string rather than being
      // deleted: a missing field would have to be guarded for at every reader.
      return JSON.stringify(log.map((rec: Record<string, unknown>) => ({ ...rec, text: "" })));
    } catch {
      return null;
    }
  }

  return value;
}