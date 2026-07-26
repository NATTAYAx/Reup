// ─── Toast style ──────────────────────────────────────────────────────────────
// Deliberately its own file. If SettingsModal imported these from
// NotificationOverlay, Rollup would hoist the overlay into the main app chunk
// and the tiny notification window would end up downloading the entire app
// bundle before it could show a toast.

export type ToastStyle = "card" | "ring" | "minimal";

export const TOAST_STYLE_KEY = "gamesched_toast_style_v1";

/** Each style needs its own row height so the OS window is sized correctly. */
export const STYLE_HEIGHT: Record<ToastStyle, number> = {
  card: 88,
  ring: 100,
  minimal: 62,
};

export function loadToastStyle(): ToastStyle {
  const v = localStorage.getItem(TOAST_STYLE_KEY);
  return v === "ring" || v === "minimal" ? v : "card";
}

export function saveToastStyle(v: ToastStyle) {
  localStorage.setItem(TOAST_STYLE_KEY, v);
}