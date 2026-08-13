import { Heart, CircleCheck } from "lucide-react";
import { t } from "../lib/i18n";

// ─── IntentPicker ─────────────────────────────────────────────────────────────
// One bit: is this on the list because you want it there, or because it has to
// be? That is the whole question, and it is deliberately not a scale.
//
// It comes from the behavioural model behind behavioural activation, in which
// depression is maintained by a drop in positive reinforcement, and the
// treatment works by putting some back into the week. A secondary analysis of
// 78 patients doing behavioural activation through an app found something worth
// designing around: what predicted improvement was the pleasure someone
// EXPECTED from an activity when planning it, and the number of tasks completed
// did not. Which is awkward, because the completed count is the one number an
// app like this can collect effortlessly, and the one every dashboard shows.
//
// A full expected-pleasure rating per task would be more faithful to that
// finding and would also be one more thing to fill in on a form that is already
// long. So this is the cheap version: one tap, skippable, and unanswered stays
// unanswered. It is never read as obligation — a week of nulls says nothing,
// only a week of explicit "must" does.
//
// NOTHING IS SCORED. There is no ratio, no chart, no percentage. The only thing
// downstream reads it for is a single sentence, at most once a week, when a
// whole week has been logged and not one entry was something wanted.

interface Props {
  value: "want" | "must" | null;
  onChange: (value: "want" | "must" | null) => void;
}

export default function IntentPicker({ value, onChange }: Props) {
  // Tapping the answer you already gave clears it. Being able to take it back
  // is what makes it safe to answer quickly.
  const pick = (next: "want" | "must") => onChange(value === next ? null : next);

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <button
        type="button"
        onClick={() => pick("want")}
        className={`flex items-center gap-1.5 text-[11px] rounded-full px-2.5 py-1 border transition-colors ${
          value === "want"
            ? "bg-rose-500/15 border-rose-400/45 text-rose-200"
            : "border-white/10 text-white/35 hover:text-white hover:border-white/25"
        }`}
      >
        <Heart size={10} />
        {t("intent.want")}
      </button>
      <button
        type="button"
        onClick={() => pick("must")}
        className={`flex items-center gap-1.5 text-[11px] rounded-full px-2.5 py-1 border transition-colors ${
          value === "must"
            ? "bg-sky-500/15 border-sky-400/45 text-sky-200"
            : "border-white/10 text-white/35 hover:text-white hover:border-white/25"
        }`}
      >
        <CircleCheck size={10} />
        {t("intent.must")}
      </button>
      <span className="text-white/20 text-[11px]">{t("intent.optional")}</span>
    </div>
  );
}