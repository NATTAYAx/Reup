import { t } from "../lib/i18n";

// ─── CategoryPicker ───────────────────────────────────────────────────────────
// Four options, two words each. A dropdown for four things hides all of them
// behind a click and shows one, which is the wrong trade at this size. As chips
// they are all readable at a glance and cost one tap instead of two.
//
// The colours are the same ones the calendar and the cards already use for each
// category, so the choice made here is recognisable everywhere else.

const CATS = [
  { value: "game",     icon: "🎮", on: "bg-purple-500/20 border-purple-500/60 text-purple-200" },
  { value: "school",   icon: "📚", on: "bg-blue-500/20 border-blue-500/60 text-blue-200" },
  { value: "work",     icon: "💼", on: "bg-orange-500/20 border-orange-500/60 text-orange-200" },
  { value: "personal", icon: "✨", on: "bg-green-500/20 border-green-500/60 text-green-200" },
] as const;

interface Props {
  value: string;
  onChange: (value: string) => void;
}

export default function CategoryPicker({ value, onChange }: Props) {
  return (
    <div className="grid grid-cols-4 gap-1.5">
      {CATS.map(c => {
        const on = value === c.value;
        return (
          <button
            key={c.value}
            type="button"
            onClick={() => onChange(c.value)}
            className={`flex flex-col items-center gap-1 rounded-xl border py-2.5 transition-all ${
              on
                ? c.on
                : "bg-white/[0.03] border-white/10 text-white/45 hover:bg-white/[0.07] hover:text-white/70"
            }`}
          >
            <span className={`text-lg leading-none transition-opacity ${on ? "" : "opacity-50"}`}>{c.icon}</span>
            <span className="text-[11px] font-medium capitalize leading-none">
              {t(`cat.${c.value}` as "cat.game")}
            </span>
          </button>
        );
      })}
    </div>
  );
}