import { Minus, Plus, RefreshCw } from "lucide-react";
import DatePicker from "./DatePicker";
import { t, getLang } from "../lib/i18n";
import { dateStrToWall, wallToMs, addDays } from "../lib/tz";

// ─── CycleFields ──────────────────────────────────────────────────────────────
// What "every 2 weeks" and "custom cycle" ask for was a bare number box holding
// 14, with no unit next to it, above a date field whose label sat inside it on
// the right while every other label in the form sat above. Three fields that
// never added up to a sentence, so the only way to know what you had just built
// was to save it and watch what the card said afterwards.
//
// Now the controls read as the sentence they are — repeat every N days, counting
// from this date — and the line underneath answers the question the form was
// silently raising: so when is it next due?

const PRESETS = [3, 7, 14, 30];

interface Props {
  /** Fixed at 14 for biweekly; editable for custom_days. */
  intervalDays: number;
  onIntervalChange?: (days: number) => void;
  anchorDate: string;
  onAnchorChange: (date: string) => void;
  /** "HH:MM", or empty for an all-day task. Only used for the preview. */
  resetTime: string;
  editableInterval: boolean;
}

/** Mirrors getNextCycle in lib/countdown.ts, through the same zone helpers, so
 *  the preview cannot drift from the countdown it is previewing. */
function nextDue(anchorDate: string, intervalDays: number, resetTime: string): Date | null {
  if (!anchorDate || !intervalDays || intervalDays < 1) return null;
  const [h, m] = (resetTime || "23:59").split(":").map(Number);
  const anchor = dateStrToWall(anchorDate, h || 0, m || 0);
  if (!anchor) return null;
  const nowMs = Date.now();
  const cycleMs = intervalDays * 86_400_000;
  let n = Math.floor((nowMs - wallToMs(anchor)) / cycleMs) + 1;
  if (n < 0) n = 0; // a start date in the future: the first one is that date
  let ms = wallToMs(addDays(anchor, n * intervalDays));
  if (ms <= nowMs) ms = wallToMs(addDays(anchor, (n + 1) * intervalDays));
  return new Date(ms);
}

function formatDue(d: Date): string {
  return getLang() === "th"
    ? d.toLocaleDateString("th-TH-u-ca-buddhist", { day: "numeric", month: "short", year: "numeric" })
    : d.toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
}

export default function CycleFields({
  intervalDays, onIntervalChange, anchorDate, onAnchorChange, resetTime, editableInterval,
}: Props) {
  const days = intervalDays || 14;
  const due = nextDue(anchorDate, days, resetTime);
  const clamp = (n: number) => Math.min(365, Math.max(1, n));

  return (
    <div className="space-y-3">
      {editableInterval && (
        <div className="flex flex-col gap-1.5">
          <label className="text-white/40 text-[11px]">{t("cycle.every")}</label>
          <div className="flex items-center gap-1.5">
            <button type="button"
              onClick={() => onIntervalChange?.(clamp(days - 1))}
              className="w-9 h-9 shrink-0 rounded-lg bg-white/5 hover:bg-white/15 text-white/50 hover:text-white flex items-center justify-center transition-colors">
              <Minus size={14} />
            </button>
            <div className="flex-1 flex items-center bg-white/5 border border-white/10 rounded-lg px-3 h-9 focus-within:border-[var(--color-primary)] transition-colors">
              <input
                type="number"
                value={days}
                onChange={e => onIntervalChange?.(clamp(Number(e.target.value)))}
                className="w-full bg-transparent text-white text-sm font-mono tabular-nums focus:outline-none"
              />
              <span className="text-white/35 text-xs shrink-0 pl-2">{t("cycle.days")}</span>
            </div>
            <button type="button"
              onClick={() => onIntervalChange?.(clamp(days + 1))}
              className="w-9 h-9 shrink-0 rounded-lg bg-white/5 hover:bg-white/15 text-white/50 hover:text-white flex items-center justify-center transition-colors">
              <Plus size={14} />
            </button>
          </div>
          <div className="flex gap-1.5 pt-0.5">
            {PRESETS.map(p => (
              <button key={p} type="button"
                onClick={() => onIntervalChange?.(p)}
                className={`text-[11px] rounded-full px-2.5 py-1 border transition-colors ${
                  days === p
                    ? "bg-purple-600/20 border-purple-500/40 text-purple-200"
                    : "border-white/10 text-white/35 hover:text-white hover:border-white/25"
                }`}>
                {p} {t("cycle.days")}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <label className="text-white/40 text-[11px]">{t("cycle.countFrom")}</label>
        <DatePicker
          value={anchorDate}
          onChange={onAnchorChange}
          placeholder={t("cycle.countFromPH")}
        />
      </div>

      <p className="flex items-center gap-1.5 text-[11px] text-white/45 bg-white/[0.03] border border-white/[0.07] rounded-lg px-2.5 py-2">
        <RefreshCw size={11} className="shrink-0 text-purple-400/70" />
        {due
          ? t("cycle.summary", { n: days, date: formatDue(due) })
          : t("cycle.needAnchor")}
      </p>
    </div>
  );
}