import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Check } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { usePopoverPos, useDismiss } from "../lib/usePopover";

// ─── Select ───────────────────────────────────────────────────────────────────
// A <select> is the one control a web app cannot style. Chromium hands the
// option list to the operating system, so on Windows it opens as a square grey
// menu in the system font, in the middle of a dark rounded app — and there is no
// room in it for a second line, which is why the six reset types were six bare
// words the reader had to already understand.
//
// The list is rendered into document.body rather than inside the trigger, so the
// form's scrolling box cannot cut it in half. See lib/usePopover.

export interface SelectOption {
  value: string;
  /** Emoji, drawn in its own tile so the labels below it stay left-aligned. */
  icon?: string;
  label: string;
  /** One line, in plain words, saying what picking this actually does. */
  hint?: string;
}

interface Props {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
}

export default function Select({ value, options, onChange, placeholder }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const pos = usePopoverPos(open, ref, { height: 300 });
  useDismiss(open, () => setOpen(false), ref, panelRef);

  const selectedIndex = options.findIndex(o => o.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : null;
  // Keyboard highlight, kept apart from the selection so arrowing through the
  // list does not change the form until Enter is pressed.
  const [active, setActive] = useState(selectedIndex < 0 ? 0 : selectedIndex);

  useEffect(() => {
    if (open) setActive(selectedIndex < 0 ? 0 : selectedIndex);
  }, [open, selectedIndex]);

  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    // While the list is open it owns these keys, or Escape would close the
    // whole form underneath instead of just the list.
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(false); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(i => (i + 1) % options.length); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setActive(i => (i - 1 + options.length) % options.length); return; }
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(options[active].value); return; }
  };

  return (
    <div ref={ref} className="relative" onKeyDown={onKeyDown}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        /* The ring is the theme colour rather than Tailwind's purple, so it
           follows the palette the app pulled out of the wallpaper. */
        className={`w-full flex items-center gap-2.5 bg-white/5 border rounded-xl px-3.5 py-3 text-sm transition-colors focus:outline-none ${
          open
            ? "border-[var(--color-primary)]"
            : "border-white/10 hover:border-white/25 focus-visible:border-[var(--color-primary)]"
        }`}
      >
        {selected?.icon && <span className="text-base leading-none">{selected.icon}</span>}
        <span className={`flex-1 text-left font-medium ${selected ? "text-white" : "text-white/30"}`}>
          {selected ? selected.label : placeholder ?? ""}
        </span>
        <ChevronDown
          size={15}
          className={`text-white/35 shrink-0 transition-transform duration-150 ${open ? "rotate-180" : ""}`}
        />
      </button>

      {createPortal(
        <AnimatePresence>
          {open && pos && (
            <motion.div
              ref={panelRef}
              initial={{ opacity: 0, y: -4, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -4, scale: 0.98 }}
              transition={{ duration: 0.12 }}
              style={{
                position: "fixed",
                top: pos.top,
                left: pos.left,
                width: pos.width,
                maxHeight: pos.maxHeight,
              }}
              className="z-[70] bg-gray-900 border border-white/10 rounded-2xl p-1.5 shadow-2xl shadow-black/70 overflow-y-auto"
            >
              {options.map((opt, i) => {
                const isSelected = opt.value === value;
                const isActive = i === active;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => pick(opt.value)}
                    onMouseEnter={() => setActive(i)}
                    className={`w-full flex items-start gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors ${
                      isSelected
                        ? "bg-purple-600/20"
                        : isActive
                          ? "bg-white/[0.07]"
                          : ""
                    }`}
                  >
                    {opt.icon && (
                      <span className="text-base leading-5 w-5 text-center shrink-0">{opt.icon}</span>
                    )}
                    <span className="flex-1 min-w-0">
                      <span className={`block text-sm leading-5 ${isSelected ? "text-white font-semibold" : "text-white/80"}`}>
                        {opt.label}
                      </span>
                      {opt.hint && (
                        <span className="block text-[11px] leading-4 text-white/35 mt-0.5">{opt.hint}</span>
                      )}
                    </span>
                    {isSelected && <Check size={14} className="text-purple-400 shrink-0 mt-0.5" />}
                  </button>
                );
              })}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
}