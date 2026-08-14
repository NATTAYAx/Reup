import { useState, useRef, useMemo, useEffect } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Check } from "lucide-react";
import { usePopoverPos, useDismiss } from "../lib/usePopover";
import { ChevronDown } from "lucide-react";
import { COMMON_CURRENCIES, currencySymbol, currencyName, getCurrency, isValidCurrency } from "../lib/money";
import { t } from "../lib/i18n";

// ─── CurrencyPicker — the door the storage layer never had ────────────────────
//
// Every row in `expenses`, `income` and `expected_income` has carried its own
// currency for a while, the totals filter on it, and the read side handles rows
// that do not match. None of that could ever fire, because there was no way to
// enter one: the amount fields printed `currencySymbol()` as a static caption,
// so every row written by every form was in whatever the app was set to.
//
// The only route to a foreign row was to change the global setting, type the
// entry, and change it back — at which point the row vanishes from the totals
// with no explanation. So the feature existed in the schema and behaved, from
// the outside, like a bug.
//
// This is that caption turned into a button. It sits where the symbol already
// sat and takes no extra line, because the ordinary case is one currency and
// this must not tax it.
//
// WHY IT COLOURS ITSELF WHEN IT DIFFERS
//
// Recording ฿1,200 as $1,200 is the mistake this whole area is guarding
// against, and it is invisible after the fact: the number is right, the note is
// right, and only the unit is wrong. So when the picked currency is not the
// one the app is set to, the trigger stops being grey and says the code out
// loud. It is the one state where being noticeable is worth more than being
// quiet.

interface Props {
  /** Undefined means the app's currency, which is what almost every entry is. */
  value?: string;
  onChange: (code: string) => void;
  /** Tailwind text colour for the symbol, so the income form can stay green. */
  tone?: string;
  size?: "sm" | "md" | "lg";
  /**
   * "inline" is the symbol beside an amount field. "row" is a full-width
   * control for a settings screen.
   *
   * Two shapes, ONE list. The settings screen used to draw its own: a grid of
   * forty-two bare three-letter codes in a box a third of them fitted in. That
   * asked the reader to recognise MYR from MMK from MXN by shape, offered the
   * names only as a hover tooltip nobody hovers, and made browsing the default
   * gesture for a question with exactly one right answer that the app had
   * ALREADY guessed correctly from the machine's timezone.
   *
   * It also sat directly above the timezone setting, which answers the same
   * question — where am I — through a searchable list. Two controls, two
   * behaviours, one question, eight pixels apart.
   */
  variant?: "inline" | "row";
}

const TEXT: Record<NonNullable<Props["size"]>, string> = {
  sm: "text-xs",
  md: "text-sm",
  lg: "text-lg",
};

export default function CurrencyPicker({
  value, onChange, tone = "text-white/40", size = "lg", variant = "inline",
}: Props) {
  const base = getCurrency();
  const code = value && isValidCurrency(value) ? value : base;
  const foreign = code !== base;

  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const pos = usePopoverPos(open, ref, { height: 320, width: variant === "row" ? "anchor" : 260 });
  useDismiss(open, () => setOpen(false), ref, panelRef);

  useEffect(() => {
    if (!open) { setQ(""); return; }
    // Forty entries is too many to scroll past on the way to the fourth one you
    // use, and the keyboard is already where the hand is after typing an amount.
    const id = window.setTimeout(() => searchRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open]);

  // Search matches names too, so "baht" and "บาท"-adjacent guesses land, and a
  // person who does not know their own currency's code can still find it.
  const list = useMemo(() => {
    // The one in force leads, then anything already used, then the rest. A
    // currency missing from the shortlist is still reachable by typing its code.
    const seen = new Set<string>();
    const ordered: { code: string; name: string }[] = [];
    const push = (c: { code: string; name: string }) => {
      if (seen.has(c.code)) return;
      seen.add(c.code);
      ordered.push(c);
    };
    push({ code: base, name: currencyName(base) });
    if (foreign) push({ code, name: currencyName(code) });
    for (const c of COMMON_CURRENCIES) push({ code: c.code, name: c.name });

    const needle = q.trim().toUpperCase();
    if (!needle) return ordered;
    const hits = ordered.filter(
      c => c.code.includes(needle) || c.name.toUpperCase().includes(needle),
    );
    // A valid ISO code that is simply not on the shortlist should still be
    // pickable, or the list becomes a whitelist by accident.
    if (hits.length === 0 && isValidCurrency(needle)) return [{ code: needle, name: needle }];
    return hits;
  }, [q, base, code, foreign]);

  const pick = (c: string) => {
    onChange(c);
    setOpen(false);
  };

  return (
    <>
      {variant === "row" ? (
        /* Deliberately the same shape as the timezone button underneath it, so
           the two settings that both answer "where am I" finally look like
           siblings. What it shows is the ANSWER — symbol, code, name — because
           the job of this control ninety-nine times out of a hundred is to let
           someone confirm the guess was right and close the screen. */
        <button
          ref={ref}
          type="button"
          onClick={() => setOpen(o => !o)}
          className="w-full flex items-center gap-3 bg-white/5 border border-white/10 hover:border-white/25 rounded-xl px-3.5 py-2.5 text-left transition-colors focus:outline-none"
        >
          <span className="text-white/70 text-lg w-6 text-center shrink-0">{currencySymbol(code)}</span>
          <span className="min-w-0 flex-1">
            <span className="block text-white text-sm font-semibold leading-snug">{code}</span>
            <span className="block text-white/40 text-[11px] leading-snug truncate">{currencyName(code)}</span>
          </span>
          <ChevronDown size={15}
            className={`text-white/35 shrink-0 transition-transform duration-150 ${open ? "rotate-180" : ""}`} />
        </button>
      ) : (
        <button
          ref={ref}
          type="button"
          onClick={() => setOpen(o => !o)}
          title={t("finance.currencyPick")}
          className={`shrink-0 rounded-md px-1 -mx-1 transition-colors focus:outline-none ${TEXT[size]} ${
            foreign
              ? "text-amber-300/90 hover:text-amber-200"
              : `${tone} hover:text-white/80`
          }`}
        >
          {currencySymbol(code)}
          {foreign && <span className="text-[10px] font-semibold align-super ml-0.5">{code}</span>}
        </button>
      )}

      {createPortal(
        <AnimatePresence>
          {open && pos && (
            <motion.div
              ref={panelRef}
              initial={{ opacity: 0, y: -4, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -4, scale: 0.98 }}
              transition={{ duration: 0.12 }}
              style={{ position: "fixed", top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.maxHeight }}
              className="z-[80] bg-gray-900 border border-white/10 rounded-2xl p-1.5 shadow-2xl shadow-black/70 flex flex-col"
            >
              <input
                ref={searchRef}
                value={q}
                onChange={e => setQ(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(false); }
                  if (e.key === "Enter" && list[0]) { e.preventDefault(); pick(list[0].code); }
                }}
                placeholder={t("finance.currencySearch")}
                className="shrink-0 bg-white/5 border border-white/10 rounded-xl px-2.5 py-1.5 text-white text-xs placeholder-white/25 focus:outline-none focus:border-[var(--color-primary)] mb-1"
              />
              <div className="flex-1 min-h-0 overflow-y-auto">
                {list.map(c => (
                  <button
                    key={c.code}
                    type="button"
                    onClick={() => pick(c.code)}
                    className={`w-full flex items-center gap-2 rounded-xl px-2.5 py-1.5 text-left transition-colors hover:bg-white/[0.07] ${
                      c.code === code ? "bg-purple-600/20" : ""
                    }`}
                  >
                    <span className="w-7 text-white/50 text-xs shrink-0">{currencySymbol(c.code)}</span>
                    <span className="text-white/85 text-xs font-semibold w-9 shrink-0">{c.code}</span>
                    <span className="text-white/35 text-[11px] truncate flex-1">{c.name}</span>
                    {c.code === code && <Check size={13} className="text-purple-400 shrink-0" />}
                  </button>
                ))}
                {list.length === 0 && (
                  <p className="text-white/25 text-[11px] px-2.5 py-2">{t("finance.currencyNone")}</p>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}