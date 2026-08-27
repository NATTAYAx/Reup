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

/**
 * A short record of which reminders actually rang.
 *
 * Transient with the cache rather than kept: twenty rolling lines about this
 * machine in the last few days, which answers "what was that noise" and nothing
 * else. Restoring somebody's Tuesday onto a new machine would be carrying a
 * diagnostic around for years for no reason.
 */
export const NOTIFY_LOG = `${PREFIX}_notif_log_v1`;

export function isTransientKey(key: string): boolean {
  return key === AI_CACHE || key === NOTIFY_LOG;
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

// ─── Belongs to this machine, and to nobody's copy of it ─────────────────────
//
// The card of names and numbers was designed from the start to stay on the
// machine: it does not sync, and it was meant not to be backed up either. The
// second half of that was never written down anywhere the code could read, so
// until now it was true only because the card was empty.
//
// The day it is filled in, it is a short list of the people somebody would
// contact on their worst day, with phone numbers — going into the one file this
// project describes as meant to be copied to a USB stick and left in folders.
//
// The trade is real and worth stating rather than hiding: a machine that dies
// takes the card with it, and it has to be typed again. Three contacts take a
// minute to re-enter. A file that has been copied cannot be un-copied.
//
// If that trade ever looks wrong, it is one line — move IMPORTANT_CARD out of
// this function. It is deliberately not spread across three files this time.

export const IMPORTANT_CARD = `${PREFIX}_important_v1`;

/** Cadence and once-per-session flags for the same card. Meaningless elsewhere. */
export const IMPORTANT_FLAGS = [`${PREFIX}_important_shown`, `${PREFIX}_important_reviewed`];

export function isMachineOnlyKey(key: string): boolean {
  return key === IMPORTANT_CARD || IMPORTANT_FLAGS.includes(key);
}

// ─── Every key this app writes ───────────────────────────────────────────────
//
// The list exists so that a key nobody classified cannot quietly take the
// default, and the default here is "copy it into the backup". Both leaks this
// file was written after went the same way: the API keys, because backup.ts
// knew a name aiProviders had stopped using; and a Google refresh token in
// app_settings, because the table side had a list of exclusions rather than a
// list of everything.
//
// A check in check-sync reads the source, finds every gamesched_ literal in it,
// and compares the two directions. A key added without a line here fails it. A
// line here for a key no longer written by anything fails it too — that is the
// orphan case in the note at the top of this file, the one that rides along in
// every backup forever after the feature is gone.
//
// Entries ending in an underscore are prefixes, for the keys built at runtime.

export const KNOWN_KEYS: readonly string[] = [
  `${PREFIX}_ai_baseurl`,
  `${PREFIX}_ai_budget_v1`,
  `${PREFIX}_ai_cache_v1`,
  `${PREFIX}_ai_habits_v3`,
  `${PREFIX}_ai_hints_done`,
  `${PREFIX}_ai_key_`,
  `${PREFIX}_ai_log_v1`,
  `${PREFIX}_ai_max_requests`,
  `${PREFIX}_ai_merchants_v1`,
  `${PREFIX}_ai_model`,
  `${PREFIX}_ai_presets_v1`,
  `${PREFIX}_ai_provider`,
  `${PREFIX}_auto_backup_v1`,
  `${PREFIX}_cal_show_daily`,
  `${PREFIX}_currency`,
  `${PREFIX}_day_start_v1`,
  `${PREFIX}_ease_declined_v1`,
  `${PREFIX}_gemini_key`,
  `${PREFIX}_icon_v1`,
  `${PREFIX}_important_reviewed`,
  `${PREFIX}_important_shown`,
  `${PREFIX}_important_v1`,
  `${PREFIX}_lang_v1`,
  `${PREFIX}_low_power_date`,
  `${PREFIX}_notif_log_v1`,
  `${PREFIX}_notif_sound_name`,
  `${PREFIX}_notif_sound_v1`,
  `${PREFIX}_notifications_muted`,
  `${PREFIX}_quiet_hours_v1`,
  `${PREFIX}_theme_v1`,
  `${PREFIX}_timezone`,
  `${PREFIX}_toast_duration_sec`,
  `${PREFIX}_toast_style_v1`,
  `${PREFIX}_tray_hint_seen`,
  `${PREFIX}_tz_source`,
  `${PREFIX}_weeknote_shown`,
];

/** Whether this key has a line in the list above, prefixes included. */
export function isKnownKey(key: string): boolean {
  return KNOWN_KEYS.some(k => (k.endsWith("_") ? key.startsWith(k) : key === k));
}

/**
 * Returns what should be written to a backup for this key, or null to leave it
 * out entirely. Input and output are both the raw stored string.
 */
export function sanitizeForBackup(key: string, value: string): string | null {
  if (isSecretKey(key) || isTransientKey(key) || isMachineOnlyKey(key)) return null;

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