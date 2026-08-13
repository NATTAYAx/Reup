import { getLang } from "./i18n";

// ─── Clock convention ─────────────────────────────────────────────────────────
// Thailand runs on a 24-hour clock; a digital display there reads 13:30, and
// "01:30 PM" is a translation of an English convention rather than the Thai one.
// English keeps AM/PM.
//
// This lives in one file because the picker and the cards have to agree. Setting
// a task to 13:30 in the form and then reading "1:30 PM" on the card is the kind
// of small disagreement that makes an app feel untrustworthy.
//
// Storage is unaffected: reset_time is always "HH:MM" in 24-hour, in the
// database and everywhere else. This is presentation only.

export const use24Hour = () => getLang() === "th";

const pad = (n: number) => String(n).padStart(2, "0");

export function formatClock(h24: number, m: number): string {
  if (use24Hour()) return `${pad(h24)}:${pad(m)}`;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${pad(h12)}:${pad(m)} ${h24 >= 12 ? "PM" : "AM"}`;
}

/** "HH:MM" → display string, or null if there is nothing to show. */
export function formatClockStr(hhmm: string | null | undefined): string | null {
  if (!hhmm) return null;
  const [hs, ms] = hhmm.split(":");
  const h = parseInt(hs, 10);
  const m = parseInt(ms, 10);
  if (isNaN(h) || isNaN(m)) return null;
  return formatClock(h, m);
}