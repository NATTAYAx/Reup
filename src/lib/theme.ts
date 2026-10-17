// ─── App Theme System ─────────────────────────────────────────────────────────
//
// ─── WHAT A THEME IS, NOW THAT THERE ARE TWO MACHINES ────────────────────────
//
// It used to be a bag of colours in localStorage. That was the right shape while
// the palette only had to reach the CSS on this screen. It is the wrong shape
// for a choice that has to survive the trip to a phone.
//
// The two machines cannot share colours, and that is not a gap to be closed.
// This side paints a web page and needs a gradient, a border alpha and a muted
// text colour. The phone paints native views and needs a card, a raised
// surface, a field, and an ink colour for text sitting on the primary — which
// on three of its themes is black, because white failed a contrast test this
// side has no equivalent of. Sending one side's palette to the other either
// loses half the fields or carries colours nobody checked.
//
// So what travels is the *id*, and each machine looks up its own colours under
// that name. Six ids, spelled identically in both languages, pinned by
// store-vectors.json the same way the setting keys and the currency fallback
// are: a string two languages must agree on where no compiler ever sees both
// sides at once.
//
// ─── THE ONE RULE FOR AN ID THAT ARRIVES ─────────────────────────────────────
//
// An id this device does not know is not a change this device can make.
//
// That single rule is what lets this side keep a palette it worked out from a
// wallpaper video without inventing a second mechanism for it. Such a palette is
// stored under the id "custom", which is a real id here and a meaningless one on
// the phone: the phone reads it, does not recognise it, and keeps the theme the
// person picked there. The same rule covers anything a later version adds, in
// either direction.
//
// The alternative was a cursor — remembering which id this device had already
// acted on, so that reading an unchanged row would not overwrite a local
// choice. That is a second piece of state to keep honest. Making the *reader*
// refuse ids it cannot express does the same work with nothing to keep.
//
// ─── WHY THE BLOB IS STILL HERE ──────────────────────────────────────────────
//
// gamesched_theme_v1 now holds the custom palette and nothing else, and it never
// travels. Choosing a preset no longer overwrites it, so switching to Forest for
// an afternoon and back to the wallpaper colours later costs nothing.

import { THEME_ID_KEY } from "./settingKeys";
import { putSetting } from "./userSettings";

export interface AppTheme {
  /**
   * The name both machines know this theme by.
   *
   * Absent means a palette this device worked out for itself — from a video or
   * an image — which has no name to share. [themeId] turns that into "custom"
   * at the one place it matters, so the AI and wallpaper paths that build a
   * palette out of pixels do not each have to remember to stamp one on.
   */
  id?: string;
  name: string;
  primary: string;
  secondary: string;
  accent: string;
  bg: string;
  bgCard: string;
  border: string;
  textMuted: string;
}

/** A palette with no shared name. Never matches anything on the other device. */
export const CUSTOM_ID = "custom";

/** Where the custom palette lives. Device-local, and not in SYNCED_SETTING_KEYS. */
export const THEME_BLOB_KEY = "gamesched_theme_v1";

// ─── the six ─────────────────────────────────────────────────────────────────
//
// Same ids and same order as THEMES in the phone's core/Palette.kt. The colours
// are not the same and are not meant to be — see the note at the top. What has
// to match is which name is which position in a picker, so that "the third one"
// means the same thing when somebody is describing it out loud.

const VIOLET: AppTheme = {
  id: "violet",
  name: "Violet",
  primary: "#7c3aed",
  secondary: "#4f46e5",
  accent: "#a78bfa",
  bg: "#030712",
  bgCard: "rgba(255,255,255,0.05)",
  border: "rgba(255,255,255,0.10)",
  textMuted: "rgba(255,255,255,0.40)",
};

const OCEAN: AppTheme = {
  id: "ocean",
  name: "Ocean",
  primary: "#0891b2", secondary: "#0e7490", accent: "#22d3ee",
  bg: "#020f14", bgCard: "rgba(8,145,178,0.08)", border: "rgba(34,211,238,0.15)",
  textMuted: "rgba(255,255,255,0.40)",
};

const FOREST: AppTheme = {
  id: "forest",
  name: "Forest",
  primary: "#16a34a", secondary: "#15803d", accent: "#4ade80",
  bg: "#020d05", bgCard: "rgba(22,163,74,0.08)", border: "rgba(74,222,128,0.15)",
  textMuted: "rgba(255,255,255,0.40)",
};

const EMBER: AppTheme = {
  id: "ember",
  name: "Ember",
  primary: "#d97706", secondary: "#b45309", accent: "#fbbf24",
  bg: "#0c0800", bgCard: "rgba(217,119,6,0.08)", border: "rgba(251,191,36,0.15)",
  textMuted: "rgba(255,255,255,0.40)",
};

const ROSE: AppTheme = {
  id: "rose",
  name: "Rose",
  primary: "#e11d48", secondary: "#be123c", accent: "#fb7185",
  bg: "#0f0509", bgCard: "rgba(225,29,72,0.08)", border: "rgba(251,113,133,0.15)",
  textMuted: "rgba(255,255,255,0.40)",
};

/**
 * For the days when a colour that wants something from you is too much.
 *
 * New on this side, and carried over from the phone rather than invented: it
 * was one of the six there and had no counterpart here, which meant picking it
 * on the phone would have sent this machine an id it could not honour. A theme
 * that exists on one device only is a theme that cannot be chosen from the
 * other.
 */
const QUIET: AppTheme = {
  id: "quiet",
  name: "Quiet",
  primary: "#4b5563", secondary: "#374151", accent: "#c3c8cf",
  bg: "#08090b", bgCard: "rgba(255,255,255,0.05)", border: "rgba(255,255,255,0.10)",
  textMuted: "rgba(255,255,255,0.40)",
};

export const PRESET_THEMES: readonly AppTheme[] = [VIOLET, OCEAN, FOREST, EMBER, ROSE, QUIET];

export const DEFAULT_THEME: AppTheme = VIOLET;

/** The ids, in order. What the vector file pins and the phone must reproduce. */
export const THEME_IDS: readonly string[] = PRESET_THEMES.map(t => t.id as string);

/**
 * The names the presets used to carry, for installs that predate ids.
 *
 * Kept explicitly rather than matched loosely, because the migration below is a
 * one-way door: read the old blob wrong once and the person's theme silently
 * becomes "custom" with the right colours in it, which looks fine and stops
 * following the other machine for ever after.
 */
const LEGACY_NAMES: Readonly<Record<string, string>> = {
  "Default Purple": "violet",
  "Ocean Cyan": "ocean",
  "Forest": "forest",
  "Amber": "ember",
  "Rose Gold": "rose",
};

/** What this theme is called on the wire. */
export function themeId(t: AppTheme): string {
  return t.id ?? CUSTOM_ID;
}

export function presetById(id: string | null | undefined): AppTheme | null {
  if (!id) return null;
  return PRESET_THEMES.find(t => t.id === id) ?? null;
}

function cacheGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * The custom palette, or the default if there is not one worth reading.
 *
 * Merged onto the default rather than trusted whole, so a blob written by an
 * older version — or half-written by a quota error — costs one wrong colour
 * instead of a screen with `undefined` in every CSS variable.
 */
function customTheme(): AppTheme {
  const raw = cacheGet(THEME_BLOB_KEY);
  if (!raw) return DEFAULT_THEME;
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== "object" || v === null || Array.isArray(v)) return DEFAULT_THEME;
    const out: Record<string, unknown> = { ...DEFAULT_THEME };
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k !== "id" && typeof val === "string" && val !== "") out[k] = val;
    }
    out.id = CUSTOM_ID;
    return out as unknown as AppTheme;
  } catch {
    return DEFAULT_THEME;
  }
}

/**
 * Which id an install that predates ids should be treated as having.
 *
 * By name, against the names those presets actually carried. Anything else is
 * a palette somebody derived, and "custom" is the honest answer for it.
 */
export function migratedThemeId(rawBlob: string | null | undefined): string {
  if (!rawBlob) return DEFAULT_THEME.id as string;
  try {
    const v: unknown = JSON.parse(rawBlob);
    if (typeof v !== "object" || v === null) return CUSTOM_ID;
    const name = (v as Record<string, unknown>).name;
    if (typeof name !== "string") return CUSTOM_ID;
    const legacy = LEGACY_NAMES[name];
    if (legacy) return legacy;
    const current = PRESET_THEMES.find(t => t.name === name);
    return current ? (current.id as string) : CUSTOM_ID;
  } catch {
    return CUSTOM_ID;
  }
}

/**
 * The theme for an id that arrived from the other machine, or null.
 *
 * Null means the id names a theme this device cannot express, which is not a
 * change it can make — see the rule at the top of this file. The caller leaves
 * the screen alone.
 */
export function themeForIncomingId(id: string | null | undefined): AppTheme | null {
  if (!id) return null;
  if (id === CUSTOM_ID) return customTheme();
  return presetById(id);
}

export function loadTheme(): AppTheme {
  const stored = cacheGet(THEME_ID_KEY);
  if (stored === null || stored === "") {
    // First launch after ids existed. Work out which one this install has been
    // running, and write it down through putSetting so the row goes with it —
    // if the database is not attached yet the cache alone is written and the
    // row is seeded by hydrateSettings on the next launch.
    const id = migratedThemeId(cacheGet(THEME_BLOB_KEY));
    putSetting(THEME_ID_KEY, id);
    return id === CUSTOM_ID ? customTheme() : (presetById(id) ?? DEFAULT_THEME);
  }
  if (stored === CUSTOM_ID) return customTheme();
  // Locally, an unknown id falls back rather than refusing: this is the value
  // this device is already running on, and there is no current theme to keep.
  return presetById(stored) ?? DEFAULT_THEME;
}

export function saveTheme(t: AppTheme) {
  const id = themeId(t);
  if (id === CUSTOM_ID) {
    try {
      localStorage.setItem(THEME_BLOB_KEY, JSON.stringify({ ...t, id: CUSTOM_ID }));
    } catch {
      /* quota — the id still travels, and the colours come back as the default */
    }
  }
  putSetting(THEME_ID_KEY, id);
}

/**
 * Follow a theme the other machine picked.
 *
 * Called when a sync reports that user_settings moved. Returns whether anything
 * was applied, which is only used by the checker.
 */
export function reapplyThemeFromSettings(): boolean {
  const next = themeForIncomingId(cacheGet(THEME_ID_KEY));
  if (!next) return false;
  applyTheme(next);
  return true;
}

function hexToRgb(hex: string): [number, number, number] {
  const c = hex.replace("#", "");
  return [parseInt(c.slice(0,2),16), parseInt(c.slice(2,4),16), parseInt(c.slice(4,6),16)];
}

export function applyTheme(t: AppTheme) {
  // Set CSS variables
  const s = document.documentElement.style;
  s.setProperty("--color-primary",   t.primary);
  s.setProperty("--color-secondary", t.secondary);
  s.setProperty("--color-accent",    t.accent);
  s.setProperty("--color-bg",        t.bg);
  s.setProperty("--color-card",      t.bgCard);
  s.setProperty("--color-border",    t.border);
  s.setProperty("--color-muted",     t.textMuted);

  // Inject dynamic <style> that overrides all hardcoded Tailwind purple/indigo
  // so every component in the app responds to theme changes immediately.
  const id = "theme-override-style";
  let el = document.getElementById(id) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = id;
    document.head.appendChild(el);
  }

  const [pr, pg, pb] = hexToRgb(t.primary);
  const [sr, sg, sb] = hexToRgb(t.secondary);
  

  el.textContent = `
    /* Dynamic theme override — generated by applyTheme() */

    /* ── Gradient buttons (Add Task, Submit, Done button) ── */
    .bg-gradient-to-r.from-purple-600.to-indigo-600 {
      background: linear-gradient(135deg, ${t.primary}, ${t.secondary}) !important;
    }
    /* Brain icon gradient */
    .bg-gradient-to-br.from-purple-500.to-indigo-600 {
      background: linear-gradient(135deg, ${t.primary}, ${t.secondary}) !important;
    }

    /* ── Solid primary color ── */
    .bg-purple-600 { background-color: ${t.primary} !important; }
    .hover\\:bg-purple-600:hover { background-color: ${t.primary} !important; }

    /* ── Text colors ── */
    .text-purple-400 { color: ${t.accent} !important; }
    /* The two copies disagreed here: bb in this one, cc in the other. Keeping
       bb, which is what every launch has drawn; cc only appeared after the
       theme was changed from the settings screen and lasted until restart. */
    .text-purple-300 { color: ${t.accent}bb !important; }


    /* ── Gradient stops ── */
    .from-purple-500, .from-purple-600 { --tw-gradient-from: ${t.primary} !important; }
    .to-indigo-600   { --tw-gradient-to:   ${t.secondary} !important; }

    .from-purple-600\\/20 { --tw-gradient-from: rgba(${pr},${pg},${pb},0.20) !important; }
    .from-purple-600\\/30 { --tw-gradient-from: rgba(${pr},${pg},${pb},0.30) !important; }
    .to-indigo-600\\/20   { --tw-gradient-to:   rgba(${sr},${sg},${sb},0.20) !important; }
    .to-indigo-600\\/30   { --tw-gradient-to:   rgba(${sr},${sg},${sb},0.30) !important; }

    /* Two rules that existed only in the copy of this function that used to
       live in SettingsModal.tsx. Both copies wrote to the same <style> element,
       so whichever ran last won the whole sheet: these worked while the
       settings screen had been opened and vanished on the next launch. */
    .hover\\:from-purple-600\\/30:hover { --tw-gradient-from: rgba(${pr},${pg},${pb},0.30) !important; }
    .hover\\:to-indigo-600\\/30:hover   { --tw-gradient-to:   rgba(${sr},${sg},${sb},0.30) !important; }

    /* ── Transparent fills ── */
    .bg-purple-500\\/10, .bg-purple-600\\/10 { background-color: rgba(${pr},${pg},${pb},0.10) !important; }
    .bg-purple-600\\/20 { background-color: rgba(${pr},${pg},${pb},0.20) !important; }
    .bg-purple-600\\/90 { background-color: rgba(${pr},${pg},${pb},0.90) !important; }
    .bg-indigo-500\\/10 { background-color: rgba(${sr},${sg},${sb},0.10) !important; }

    /* ── Borders ── */
    .border-purple-500 { border-color: ${t.primary} !important; }
    .border-purple-500\\/30 { border-color: rgba(${pr},${pg},${pb},0.30) !important; }
    .border-purple-500\\/40 { border-color: rgba(${pr},${pg},${pb},0.40) !important; }
    .border-purple-500\\/60 { border-color: rgba(${pr},${pg},${pb},0.60) !important; }
    .hover\\:border-purple-500\\/60:hover { border-color: rgba(${pr},${pg},${pb},0.60) !important; }

    /* ── Focus ── */
    .focus\\:border-purple-500:focus { border-color: ${t.primary} !important; }
    .focus\\:bg-purple-500\\/10:focus { background-color: rgba(${pr},${pg},${pb},0.10) !important; }
    input:focus, select:focus {
      border-color: ${t.primary} !important;
      outline-color: ${t.primary} !important;
    }

    /* ── Glow / shadow ── */
    .theme-glow {
      box-shadow: 0 0 20px rgba(${pr},${pg},${pb},0.35) !important;
    }
    .shadow-purple-500\\/30,
    .shadow-lg.shadow-purple-500\\/30 {
      box-shadow: 0 10px 15px -3px rgba(${pr},${pg},${pb},0.30) !important;
    }

    /* ── Ring ── */
    .ring-2.ring-purple-500 { --tw-ring-color: ${t.primary} !important; }

    /* ── Calendar day count badge ── */
    .bg-purple-600.rounded-full { background-color: ${t.primary} !important; }

    /* ── Accent uses in header stat cards ── */
    .text-\\[var\\(--color-accent\\)\\] { color: ${t.accent} !important; }
  `;
}