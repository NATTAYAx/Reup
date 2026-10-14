// ─── widgetLook.ts — how the board on the desktop looks ──────────────────────
//
// Two settings, both read by the board itself and both changed from the
// settings screen. They live in the page storage the two windows share, so a
// slider moved in settings changes the board while it is being moved: the
// board hears the write as a storage event and repaints. Where the board sits
// and whether it is on are the Rust side's - see src-tauri/src/widget.rs.

/** How strong the shade behind the words is, 0-85 percent. The shade has no
 *  edge (see DesktopWidget's NO BOX), so it can go darker than a box could
 *  without turning into one. */
export const WIDGET_TINT_KEY = "gamesched_widget_tint_v1";

/** Whether the month's money is on the board. Off unless switched on: a
 *  desktop is seen by whoever walks past it. */
export const WIDGET_MONEY_KEY = "gamesched_widget_money_v1";

export const TINT_DEFAULT = 55;
export const TINT_MAX = 85;

export function readTint(): number {
  try {
    const raw = localStorage.getItem(WIDGET_TINT_KEY);
    if (raw === null || raw === "") return TINT_DEFAULT;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.min(TINT_MAX, Math.max(0, Math.round(n))) : TINT_DEFAULT;
  } catch {
    return TINT_DEFAULT;
  }
}

export function writeTint(n: number): void {
  try {
    localStorage.setItem(WIDGET_TINT_KEY, String(Math.min(TINT_MAX, Math.max(0, Math.round(n)))));
  } catch {
    /* private mode or quota: the board keeps the default */
  }
}

export function moneyOn(): boolean {
  try {
    return localStorage.getItem(WIDGET_MONEY_KEY) === "1";
  } catch {
    return false;
  }
}

export function setMoneyOn(on: boolean): void {
  try {
    if (on) localStorage.setItem(WIDGET_MONEY_KEY, "1");
    else localStorage.removeItem(WIDGET_MONEY_KEY);
  } catch {
    /* as above */
  }
}
