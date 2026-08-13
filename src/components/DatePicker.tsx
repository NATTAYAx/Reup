import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { Calendar, ChevronLeft, ChevronRight } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { getLang, t } from "../lib/i18n";
import { usePopoverPos, useDismiss } from "../lib/usePopover";

interface Props {
  value: string;       // "YYYY-MM-DD" or ""
  onChange: (value: string) => void;
  placeholder?: string;
  label?: string;
  /** Renders as a small chip instead of a full-width field. The finance sheets
   *  sit beside "today" and "yesterday" buttons and a full-width field would
   *  not belong there — which is why they were using a bare <input type="date">
   *  and getting Chromium's white system calendar in the middle of a dark app.
   *  The popover is identical either way. */
  compact?: boolean;
  /** Shown on the chip when nothing is picked yet. */
  compactLabel?: string;
}

const MONTHS_EN = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];
const MONTHS_TH = [
  "มกราคม","กุมภาพันธ์","มีนาคม","เมษายน","พฤษภาคม","มิถุนายน",
  "กรกฎาคม","สิงหาคม","กันยายน","ตุลาคม","พฤศจิกายน","ธันวาคม",
];
const DAYS_EN = ["Su","Mo","Tu","We","Th","Fr","Sa"];
const DAYS_TH = ["อา","จ","อ","พ","พฤ","ศ","ส"];

// The rest of the app shows Buddhist years in Thai, so this has to as well —
// a calendar that disagrees with the list beside it is worse than no calendar.
const isThai = () => getLang() === "th";
const MONTHS = new Proxy([] as string[], {
  get: (_t, prop) => (isThai() ? MONTHS_TH : MONTHS_EN)[prop as any],
});
const DAYS = new Proxy([] as string[], {
  get: (_t, prop) => (isThai() ? DAYS_TH : DAYS_EN)[prop as any],
});

function parseDate(val: string): Date | null {
  if (!val) return null;
  const d = new Date(val + "T00:00:00");
  return isNaN(d.getTime()) ? null : d;
}

function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function formatDisplay(val: string): string {
  const d = parseDate(val);
  if (!d) return "";
  if (isThai()) {
    return d.toLocaleDateString("th-TH-u-ca-buddhist", {
      day: "numeric", month: "short", year: "numeric",
    });
  }
  return d.toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
}

export default function DatePicker({ value, onChange, placeholder = "Pick a date", label, compact = false, compactLabel }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Rendered into document.body: the form it sits in is a scrolling box, and an
  // absolutely positioned calendar gets sliced off at the edge of it.
  // A MONTH MUST NEVER SCROLL.
  //
  // It did. The panel asked for 344px and the contents needed about 430, so the
  // last row of the month sat below the fold behind a scrollbar — a calendar
  // where you cannot see the end of the month without scrolling has stopped
  // being a calendar and become a list of numbers.
  //
  // Two things caused it. The height was a guess that was never checked against
  // what is actually in the panel. And a brief attempt to let the width follow
  // the field made it worse: square cells mean height follows width, so a wider
  // field produced a taller calendar and pushed even more of it out of view.
  //
  // So both are fixed now, deliberately. The width is what a seven-column grid
  // wants and nothing else — a calendar is not a text field and has no reason to
  // stretch to match one. The height is the sum of the parts below, not a round
  // number, so adding a row to this panel means changing this figure rather than
  // finding out later that the last week of the month disappeared.
  //
  //   panel padding 32 · header 27 + gap 12 · weekdays 26 + gap 4
  //   · 6 rows x 40 + gaps 10 · footer gap 12 + rule 10 + text 16   =  399
  //
  // The grid is always 42 cells, six rows, whatever month it is — so this is a
  // constant, not a worst case, and the panel is the same height in February as
  // in August. Width is 316 because seven cells plus the padding land near 40px
  // each, matching the cell height without being told to.
  const pos = usePopoverPos(open, ref, { height: 404, width: 316 });
  useDismiss(open, () => setOpen(false), ref, panelRef);

  const today = new Date();
  today.setHours(0,0,0,0);

  const selected = parseDate(value);
  const [viewYear, setViewYear] = useState(selected?.getFullYear() ?? today.getFullYear());
  const [viewMonth, setViewMonth] = useState(selected?.getMonth() ?? today.getMonth());

  // Sync view when value changes externally
  useEffect(() => {
    const d = parseDate(value);
    if (d) { setViewYear(d.getFullYear()); setViewMonth(d.getMonth()); }
  }, [value]);

  const prevMonth = () => {
    if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1); }
    else setViewMonth(m => m - 1);
  };
  const nextMonth = () => {
    if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1); }
    else setViewMonth(m => m + 1);
  };

  // Build calendar grid
  const firstDay = new Date(viewYear, viewMonth, 1).getDay();
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const daysInPrev = new Date(viewYear, viewMonth, 0).getDate();

  const cells: { day: number; month: "prev" | "cur" | "next" }[] = [];
  for (let i = firstDay - 1; i >= 0; i--) {
    cells.push({ day: daysInPrev - i, month: "prev" });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ day: d, month: "cur" });
  }
  while (cells.length < 42) {
    cells.push({ day: cells.length - daysInMonth - firstDay + 1, month: "next" });
  }

  const isToday = (day: number) =>
    viewYear === today.getFullYear() && viewMonth === today.getMonth() && day === today.getDate();

  const isSelected = (day: number) =>
    selected && viewYear === selected.getFullYear() && viewMonth === selected.getMonth() && day === selected.getDate();

  const selectDay = (cell: typeof cells[0]) => {
    let y = viewYear, m = viewMonth;
    if (cell.month === "prev") { m--; if (m < 0) { m = 11; y--; } }
    if (cell.month === "next") { m++; if (m > 11) { m = 0; y++; } }
    const d = new Date(y, m, cell.day);
    onChange(toDateStr(d));
    setOpen(false);
  };

  const goToday = () => {
    setViewYear(today.getFullYear());
    setViewMonth(today.getMonth());
    onChange(toDateStr(today));
    setOpen(false);
  };

  const clear = () => { onChange(""); setOpen(false); };

  const displayStr = formatDisplay(value);

  return (
    <div ref={ref} className="relative">
      {/* Trigger */}
      {compact ? (
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          className={`text-[11px] rounded-full px-3 py-1 border flex items-center gap-1 whitespace-nowrap transition-colors ${
            open || displayStr
              ? "border-white/30 text-white"
              : "border-white/10 text-white/50 hover:text-white"
          }`}
        >
          <Calendar size={11} />
          {displayStr || compactLabel || placeholder}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          className={`w-full flex items-center gap-3 bg-white/5 border rounded-xl px-4 py-3 text-white text-sm transition-colors focus:outline-none ${
            open
              ? "border-[var(--color-primary)]"
              : "border-white/10 hover:border-white/25 focus-visible:border-[var(--color-primary)]"
          }`}
        >
          <Calendar size={15} className="text-white/40 flex-shrink-0" />
          <span className={`font-medium tracking-wide flex-1 text-left ${displayStr ? "text-white" : "text-white/30"}`}>
            {displayStr || placeholder}
          </span>
          {label && <span className="ml-auto text-white/30 text-xs">{label}</span>}
        </button>
      )}

      {/* Dropdown calendar */}
      {createPortal(
      <AnimatePresence>
        {open && pos && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.12 }}
            ref={panelRef}
            style={{ position: "fixed", top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.maxHeight }}
            className="z-[70] bg-gray-900 border border-white/10 rounded-2xl p-4 shadow-2xl shadow-black/70 overflow-y-auto"
          >
            {/* Month/year header */}
            <div className="flex items-center justify-between mb-3">
              <button
                type="button"
                onClick={prevMonth}
                className="p-1.5 rounded-lg bg-white/5 hover:bg-white/15 text-white/50 hover:text-white transition-all"
              >
                <ChevronLeft size={15} />
              </button>

              <button
                type="button"
                onClick={() => {
                  // Cycle through years on click
                  setViewYear(y => y === today.getFullYear() ? y : today.getFullYear());
                  setViewMonth(today.getMonth());
                }}
                className="text-white font-semibold text-sm hover:text-purple-400 transition-colors px-2"
              >
                {MONTHS[viewMonth]} {isThai() ? viewYear + 543 : viewYear}
              </button>

              <button
                type="button"
                onClick={nextMonth}
                className="p-1.5 rounded-lg bg-white/5 hover:bg-white/15 text-white/50 hover:text-white transition-all"
              >
                <ChevronRight size={15} />
              </button>
            </div>

            {/* The row of year chips that used to sit here is gone. It cost 40px
                — most of what was pushing the last week of the month off the
                bottom — to answer a question a task deadline almost never asks.
                The year is already in the header, and holding the month arrows
                moves through it; four more taps for the rare case is a better
                trade than a month that does not fit. */}

            {/* Day headers */}
            <div className="grid grid-cols-7 mb-1">
              {DAYS.map(d => (
                <div key={d} className="text-center text-white/30 text-xs font-semibold py-1">{d}</div>
              ))}
            </div>

            {/* Day cells */}
            <div className="grid grid-cols-7 gap-y-0.5">
              {cells.map((cell, i) => {
                const isCur = cell.month === "cur";
                const todayCell = isCur && isToday(cell.day);
                const selectedCell = isCur && isSelected(cell.day);
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => selectDay(cell)}
                    className={`
                      /* A real height, not aspect-square: the panel is a fixed
                         width now, so the cells do not need to chase it, and
                         tying height to width is what made the calendar grow
                         taller than the space it had. 40px is comfortably above
                         the ~32px where a date stops being easy to hit. */
                      relative h-10 w-full rounded-lg text-sm font-medium transition-all
                      ${!isCur ? "text-white/15 hover:text-white/30 hover:bg-white/5" : ""}
                      ${isCur && !todayCell && !selectedCell
                        ? "text-white/70 hover:bg-purple-500/20 hover:text-white"
                        : ""}
                      ${todayCell && !selectedCell
                        ? "text-purple-400 bg-purple-500/10 ring-1 ring-purple-500/40"
                        : ""}
                      ${selectedCell
                        ? "bg-purple-600 text-white shadow-lg shadow-purple-500/30 font-bold"
                        : ""}
                    `}
                  >
                    {cell.day}
                  </button>
                );
              })}
            </div>

            {/* Footer */}
            <div className="flex justify-between mt-3 pt-2.5 border-t border-white/8">
              <button
                type="button"
                onClick={clear}
                className="text-xs text-white/30 hover:text-red-400 transition-colors font-medium"
              >
                {t("date.clear")}
              </button>
              <button
                type="button"
                onClick={goToday}
                className="text-xs text-purple-400 hover:text-purple-300 transition-colors font-semibold"
              >
                {t("date.today")}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>,
      document.body,
      )}
    </div>
  );
}