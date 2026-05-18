import { useState, useRef, useEffect } from "react";
import { Clock, ChevronUp, ChevronDown } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

interface Props {
  value: string; // "HH:MM" 24h format
  onChange: (value: string) => void;
}

export default function TimePicker({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const [rawHour, rawMinute] = value.split(":").map(Number);
  const isPM = rawHour >= 12;
  const displayHour = rawHour % 12 === 0 ? 12 : rawHour % 12;

  const [hourInput, setHourInput] = useState(String(displayHour).padStart(2, "0"));
  const [minInput, setMinInput] = useState(String(rawMinute).padStart(2, "0"));

  useEffect(() => {
    const [h, m] = value.split(":").map(Number);
    const dh = h % 12 === 0 ? 12 : h % 12;
    setHourInput(String(dh).padStart(2, "0"));
    setMinInput(String(m).padStart(2, "0"));
  }, [value]);

  const commit = (h12: number, m: number, pm: boolean) => {
    let h24 = h12 % 12;
    if (pm) h24 += 12;
    onChange(`${String(h24).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
  };

  const handleHourBlur = () => {
    let h = parseInt(hourInput) || 12;
    if (h < 1) h = 1;
    if (h > 12) h = 12;
    setHourInput(String(h).padStart(2, "0"));
    commit(h, parseInt(minInput) || 0, isPM);
  };

  const handleMinBlur = () => {
    let m = parseInt(minInput) || 0;
    if (m < 0) m = 0;
    if (m > 59) m = 59;
    setMinInput(String(m).padStart(2, "0"));
    commit(displayHour, m, isPM);
  };

  const nudgeHour = (delta: number) => {
    let h = displayHour + delta;
    if (h > 12) h = 1;
    if (h < 1) h = 12;
    setHourInput(String(h).padStart(2, "0"));
    commit(h, rawMinute, isPM);
  };

  const nudgeMinute = (delta: number) => {
    let m = rawMinute + delta;
    if (m >= 60) m = 0;
    if (m < 0) m = 55;
    setMinInput(String(m).padStart(2, "0"));
    commit(displayHour, m, isPM);
  };

  const toggleAMPM = () => commit(displayHour, rawMinute, !isPM);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const displayStr = `${String(displayHour).padStart(2, "0")}:${String(rawMinute).padStart(2, "0")} ${isPM ? "PM" : "AM"}`;

  return (
    <div ref={ref} className="relative">
      {/* Trigger */}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={`w-full flex items-center gap-3 bg-white/5 border rounded-xl px-4 py-3 text-white text-sm transition-all ${
          open ? "border-purple-500" : "border-white/10 hover:border-white/20"
        }`}
      >
        <Clock size={15} className="text-white/40 flex-shrink-0" />
        <span className="font-mono font-semibold tracking-wider">{displayStr}</span>
        <span className="ml-auto text-white/30 text-xs">Reset time</span>
      </button>

      {/* Picker dropdown */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.12 }}
            className="absolute z-50 top-full mt-2 left-0 right-0 bg-gray-900 border border-white/10 rounded-2xl p-5 shadow-2xl shadow-black/70"
          >
            <div className="flex items-center justify-center gap-2">

              {/* Hour column */}
              <div className="flex flex-col items-center gap-2">
                <button
                  type="button"
                  onClick={() => nudgeHour(1)}
                  className="p-2 rounded-xl bg-white/5 hover:bg-white/15 text-white/50 hover:text-white transition-all"
                >
                  <ChevronUp size={18} />
                </button>
                <input
                  type="text"
                  inputMode="numeric"
                  value={hourInput}
                  onChange={e => setHourInput(e.target.value.replace(/\D/, "").slice(0, 2))}
                  onFocus={e => e.target.select()}
                  onBlur={handleHourBlur}
                  onKeyDown={e => {
                    if (e.key === "ArrowUp") { e.preventDefault(); nudgeHour(1); }
                    if (e.key === "ArrowDown") { e.preventDefault(); nudgeHour(-1); }
                    if (e.key === "Enter") handleHourBlur();
                  }}
                  className="w-16 h-16 text-center font-mono font-bold text-3xl text-white bg-white/8 border border-white/10 rounded-2xl focus:outline-none focus:border-purple-500 focus:bg-purple-500/10 transition-all"
                />
                <button
                  type="button"
                  onClick={() => nudgeHour(-1)}
                  className="p-2 rounded-xl bg-white/5 hover:bg-white/15 text-white/50 hover:text-white transition-all"
                >
                  <ChevronDown size={18} />
                </button>
                <span className="text-white/30 text-xs">Hour</span>
              </div>

              {/* Colon */}
              <span className="font-mono font-bold text-3xl text-white/30 mb-6">:</span>

              {/* Minute column */}
              <div className="flex flex-col items-center gap-2">
                <button
                  type="button"
                  onClick={() => nudgeMinute(5)}
                  className="p-2 rounded-xl bg-white/5 hover:bg-white/15 text-white/50 hover:text-white transition-all"
                >
                  <ChevronUp size={18} />
                </button>
                <input
                  type="text"
                  inputMode="numeric"
                  value={minInput}
                  onChange={e => setMinInput(e.target.value.replace(/\D/, "").slice(0, 2))}
                  onFocus={e => e.target.select()}
                  onBlur={handleMinBlur}
                  onKeyDown={e => {
                    if (e.key === "ArrowUp") { e.preventDefault(); nudgeMinute(5); }
                    if (e.key === "ArrowDown") { e.preventDefault(); nudgeMinute(-5); }
                    if (e.key === "Enter") handleMinBlur();
                  }}
                  className="w-16 h-16 text-center font-mono font-bold text-3xl text-white bg-white/8 border border-white/10 rounded-2xl focus:outline-none focus:border-purple-500 focus:bg-purple-500/10 transition-all"
                />
                <button
                  type="button"
                  onClick={() => nudgeMinute(-5)}
                  className="p-2 rounded-xl bg-white/5 hover:bg-white/15 text-white/50 hover:text-white transition-all"
                >
                  <ChevronDown size={18} />
                </button>
                <span className="text-white/30 text-xs">Min</span>
              </div>

              {/* AM / PM */}
              <div className="flex flex-col gap-2 ml-2 mb-6">
                <button
                  type="button"
                  onClick={() => isPM && toggleAMPM()}
                  className={`w-14 py-3 rounded-xl font-bold text-sm transition-all ${
                    !isPM
                      ? "bg-purple-600 text-white shadow-lg shadow-purple-500/30"
                      : "bg-white/5 text-white/30 hover:bg-white/10 hover:text-white"
                  }`}
                >
                  AM
                </button>
                <button
                  type="button"
                  onClick={() => !isPM && toggleAMPM()}
                  className={`w-14 py-3 rounded-xl font-bold text-sm transition-all ${
                    isPM
                      ? "bg-purple-600 text-white shadow-lg shadow-purple-500/30"
                      : "bg-white/5 text-white/30 hover:bg-white/10 hover:text-white"
                  }`}
                >
                  PM
                </button>
              </div>
            </div>

            {/* Done */}
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="w-full mt-1 py-2.5 bg-gradient-to-r from-purple-600 to-indigo-600 rounded-xl text-white text-sm font-semibold hover:opacity-90 transition-all"
            >
              Done — {displayStr}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}