// ─── settingKeys.ts — the names a setting is stored under ────────────────────
//
// A leaf module on purpose: it imports nothing, so anything can import it —
// including the generator scripts, which run under plain node and cannot follow
// a chain that ends at a Vite-only import.
//
// WHY THESE SIX ARE WORTH GATHERING
//
// They are rows in app_settings and user_settings, and both machines look them
// up by name. If the phone spells a key differently from the desktop, nothing
// throws and nothing is logged: one side writes a row the other never reads,
// and the setting simply has no effect on the machine that did not write it.
// Quiet hours that only apply to one device, a currency that reverts, a sync
// config the phone cannot find.
//
// Two of them were already declared twice on this side alone — LANG_KEY in
// i18n.ts as well as userSettings.ts, CURRENCY_KEY in money.ts as well. They
// agreed. Nothing was making them.
//
// The other half of the pair lives in Kotlin, and the store vectors hold the
// two together: gen-store-vectors writes this list into store-vectors.json and
// StoreTest checks its own constants against it.

/** Quiet hours, as JSON. Synced: it describes a person, not a machine. */
export const QUIET_KEY = "gamesched_quiet_hours_v1";

/** The unit money is counted in. Synced. */
export const CURRENCY_KEY = "gamesched_currency";

/** Which language the app speaks. Synced. */
export const LANG_KEY = "gamesched_lang_v1";

/** Which theme, by id. Synced — and only the id: the two machines hold
 *  different colour fields under the same six names, so sending a palette
 *  would either lose half of them or carry colours nobody checked. See
 *  lib/theme.ts. */
export const THEME_ID_KEY = "gamesched_theme_id_v1";

/** Where this device syncs to and with which key. Never synced: it is the way
 *  in, and a device that copied another device's would be syncing with itself. */
export const SYNC_CONFIG_KEY = "sync_config_v1";

/** The Google refresh token. Never synced, for the obvious reason. */
export const GOOGLE_TOKENS_KEY = "sync_google_tokens";

/** How far through the folder this device has read. Never synced: it is a fact
 *  about one device's progress and means nothing on another. */
export const SYNC_STATE_KEY = "sync_state_v1";