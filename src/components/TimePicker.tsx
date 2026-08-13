import { useState, useRef, useEffect } from "react";
import { Globe, X } from "lucide-react";
import { t } from "../lib/i18n";
import { use24Hour } from "../lib/clock";
import { getAppTimeZone, offsetLabel, convertTimeOfDay } from "../lib/tz";

// ─── TimePicker ───────────────────────────────────────────────────────────────
//
// A text box. That is the whole control.
//
// THE HISTORY IS THE ARGUMENT
//
// Version one had two arrow buttons, two number fields, two AM/PM buttons and a
// large bar restating the answer: six controls for "what time". It was replaced
// because there were three different ways to give the same answer.
//
// Version two swapped all of that for two scrolling columns in a floating panel.
// One way to answer — better — but it brought its own problems, and in a 900×600
// window they are not small. Reaching minute 37 means scrolling a sixty-item
// list through a two-hundred-pixel opening. The panel floats, so it covers the
// form it belongs to. It has to be measured, clamped and re-measured on every
// scroll, and it still came out squeezed the moment two sat side by side in
// Settings.
//
// The lesson from version one was: fewer ways to answer. Version two went from
// three to one. This goes from one control to none — because nobody scrolls a
// list to find a time they already know. They know it is half past eleven, and
// the fastest input for a fact already in your head is typing it.
//
// So: type 2330, or 23:30, or 1130pm, or just 23. It tidies itself when you
// leave the field. Nothing floats, nothing needs positioning, nothing covers the
// form, and it fits anywhere a text box fits — which is the constraint this app
// actually has.
//
// WHAT IS KEPT
//
// The parser, untouched. It is the good part of version two and it is the thing
// that makes typing viable at all. 24-hour under Thai and 12-hour under English,
// because a digital clock in Thailand reads 13:30 and "01:30 PM" is a
// translation of a convention rather than the convention itself.
//
// Cross-zone entry is kept but demoted. A deadline given as "9am China time" is
// real, and doing that sum in your head at the moment of typing is where the
// mistake happens. But it is rare, and it used to sit at the top of the panel
// competing with the common case. It is now a small globe that does nothing
// until pressed, and states plainly what it is doing while it is on.

interface Props {
  value: string; // "HH:MM" 24h — always stored 24h regardless of what is shown
  onChange: (value: string) => void;
  /** Hide the cross-zone control where it would only be noise. */
  showZone?: boolean;
  /** Let an empty box mean "no time", instead of reverting to the last value.
   *  This is how a task becomes all-day: clear the field. It used to take a
   *  separate chip sitting next to the input, which is a second control for
   *  something the first one can already express. */
  allowEmpty?: boolean;
  placeholder?: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

// Short on purpose: the handful anyone actually receives deadlines from. All
// four hundred live in Settings.
const COMMON_ZONES = [
  "UTC", "Europe/London", "Europe/Berlin", "America/New_York",
  "America/Los_Angeles", "Asia/Shanghai", "Asia/Tokyo", "Asia/Seoul",
  "Asia/Kolkata", "Australia/Sydney",
];
const SRC_KEY = "gamesched_tz_source";
const cityOf = (zone: string) => (zone.split("/").pop() ?? zone).replace(/_/g, " ");

/** Reads whatever has been typed so far and returns "HH:MM", or null while it is
 *  not yet a time. Deliberately forgiving: digits alone are enough, the colon is
 *  optional, and under English a 24-hour number is understood rather than
 *  rejected for being the wrong dialect. */
function parseTyped(raw: string, use24: boolean, fallbackPM: boolean): string | null {
  const lower = raw.toLowerCase();
  let typedPM: boolean | null = null;
  if (!use24) {
    if (lower.includes("p")) typedPM = true;
    else if (lower.includes("a")) typedPM = false;
  }

  let h: number;
  let m: number;
  if (raw.includes(":")) {
    const [hs, ms = ""] = lower.split(":");
    const hd = hs.replace(/\D/g, "");
    const md = ms.replace(/\D/g, "");
    if (!hd) return null;
    h = Number(hd);
    m = md ? Number(md) : 0;
  } else {
    const d = lower.replace(/\D/g, "");
    if (!d) return null;
    if (d.length <= 2) { h = Number(d); m = 0; }
    else if (d.length === 3) { h = Number(d[0]); m = Number(d.slice(1)); }
    else { h = Number(d.slice(0, 2)); m = Number(d.slice(2, 4)); }
  }

  if (m > 59) return null;
  if (use24) return h > 23 ? null : `${pad(h)}:${pad(m)}`;

  if (typedPM === null && h >= 13 && h <= 23) return `${pad(h)}:${pad(m)}`;
  if (typedPM === null && h === 0) return `00:${pad(m)}`;
  if (h < 1 || h > 12) return null;
  const pm = typedPM ?? fallbackPM;
  return `${pad((h % 12) + (pm ? 12 : 0))}:${pad(m)}`;
}

/** What the box reads when nobody is typing in it. */
function display(value: string, use24: boolean): string {
  if (!value) return "";
  const [h, m] = value.split(":").map(Number);
  if (isNaN(h) || isNaN(m)) return "";
  if (use24) return `${pad(h)}:${pad(m)}`;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad(m)} ${h >= 12 ? "PM" : "AM"}`;
}

export default function TimePicker({ value, onChange, showZone = true, allowEmpty = false, placeholder }: Props) {
  const use24 = use24Hour();
  // What is in the box mid-typing. null means "show the stored value".
  const [draft, setDraft] = useState<string | null>(null);
  const [bad, setBad] = useState(false);

  const appZone = getAppTimeZone();
  const [srcZone, setSrcZone] = useState(() => {
    try {
      const v = localStorage.getItem(SRC_KEY);
      return v && v !== appZone ? v : appZone;
    } catch { return appZone; }
  });
  const [zoneOpen, setZoneOpen] = useState(false);
  const converting = srcZone !== appZone;
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try { localStorage.setItem(SRC_KEY, srcZone); } catch { /* storage full */ }
  }, [srcZone]);

  /** Turn what is in the box into a stored value, or put the last good one back.
   *  The field is never left holding something half-typed. */
  const commit = (raw: string) => {
    const parsed = parseTyped(raw, use24, !use24 && !/a/i.test(raw));
    if (!parsed) {
      setDraft(null);
      // An empty box is an answer where the caller says it is one.
      if (!raw.trim()) { if (allowEmpty) onChange(""); return; }
      // A typo reverts. Flashing the border for a moment says "that did not take"
      // without adding a line of red text under a field this small.
      setBad(true); setTimeout(() => setBad(false), 1000);
      return;
    }
    let out = parsed;
    if (converting) {
      const [ph, pm] = parsed.split(":").map(Number);
      const c = convertTimeOfDay(ph, pm, srcZone, appZone);
      out = `${pad(c.h)}:${pad(c.mi)}`;
    }
    onChange(out);
    setDraft(null);
    setBad(false);
  };

  return (
    <div className="w-full">
      <div className="flex items-center gap-1.5">
        <input
          ref={inputRef}
          value={draft ?? display(value, use24)}
          onChange={e => setDraft(e.target.value)}
          onFocus={e => { setDraft(value); requestAnimationFrame(() => e.target.select()); }}
          onBlur={e => commit(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") { e.preventDefault(); commit(e.currentTarget.value); e.currentTarget.blur(); }
            if (e.key === "Escape") { e.preventDefault(); setDraft(null); e.currentTarget.blur(); }
          }}
          inputMode="numeric"
          placeholder={placeholder ?? (use24 ? "23:30" : "11:30 PM")}
          title={t("time.typeHint")}
          /* Padding, radius and background copied from Select rather than
             chosen. These two sit side by side on one row, and a field that is
             four pixels shorter than the thing next to it reads as a mistake
             even when nobody can say what is wrong. */
          className={`flex-1 min-w-0 bg-white/5 border rounded-xl px-3.5 py-3 text-white text-sm tabular-nums
            outline-none transition-colors placeholder:text-white/25
            ${bad ? "border-red-400/70" : "border-white/10 hover:border-white/25 focus:border-[var(--color-primary)]"}`}
        />

        {showZone && (
          <button
            type="button"
            onClick={() => setZoneOpen(v => !v)}
            title={t("time.otherZone")}
            className={`shrink-0 p-3 rounded-xl border transition-colors
              ${converting
                ? "border-[var(--color-primary)]/50 bg-[var(--color-primary)]/15 text-[var(--color-primary)]"
                : "border-white/10 bg-white/[0.06] text-white/30 hover:text-white/60"}`}
          >
            <Globe size={14} />
          </button>
        )}
      </div>

      {/* Says what it is doing in the same words every time, and puts the way out
          next to the thing it undoes. */}
      {converting && (
        <div className="flex items-center gap-1.5 mt-1.5 text-[11px] text-[var(--color-primary)]">
          <span className="truncate">{t("time.typingIn")} {cityOf(srcZone)}</span>
          <button
            type="button"
            onClick={() => { setSrcZone(appZone); setZoneOpen(false); }}
            className="shrink-0 text-white/40 hover:text-white transition-colors"
          >
            <X size={11} />
          </button>
        </div>
      )}

      {/* Inline, not floating: it pushes the form down instead of covering it,
          so there is nothing to measure and nothing to clip. */}
      {zoneOpen && (
        <div className="mt-1.5 rounded-lg border border-white/10 bg-white/[0.04] p-1 max-h-40 overflow-y-auto">
          {[appZone, ...COMMON_ZONES.filter(z => z !== appZone)].map(z => (
            <button
              key={z}
              type="button"
              onClick={() => { setSrcZone(z); setZoneOpen(false); inputRef.current?.focus(); }}
              className={`w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-md text-left transition-colors
                ${z === srcZone ? "bg-[var(--color-primary)]/20 text-white" : "text-white/60 hover:bg-white/5"}`}
            >
              <span className="text-xs truncate">
                {cityOf(z)}{z === appZone ? ` · ${t("time.appZone")}` : ""}
              </span>
              <span className="text-[10px] text-white/30 tabular-nums shrink-0">{offsetLabel(z)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}