import { Pin, PinOff } from "lucide-react";
import { getAppTimeZone } from "../lib/tz";
import { t } from "../lib/i18n";

// ─── TimeZonePin ──────────────────────────────────────────────────────────────
// Two kinds of time look identical in a form and are not the same thing.
//
// "Take the medicine at 20:00" means eight in the evening wherever you happen to
// be standing. Fly to Tokyo and it should still go off in the evening.
//
// "The game resets at 04:00" means four in the morning on the server, which did
// not fly anywhere. Landing in Tokyo should show it at 06:00, not move it.
//
// There is no single right answer, so this asks. Leaving it alone gives the
// first behaviour, which is what every task in the database already does, so
// nothing changes for anyone who never touches this. Pinning gives the second.
//
// It only earns its place on screen when it matters, so in the ordinary case it
// is one muted line and a small link, not a control.

interface Props {
  /** Null = floats with the app zone. */
  value: string | null;
  onChange: (zone: string | null) => void;
}

const cityOf = (zone: string) => (zone.split("/").pop() ?? zone).replace(/_/g, " ");

export default function TimeZonePin({ value, onChange }: Props) {
  const appZone = getAppTimeZone();

  if (!value) {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-white/25 text-[11px]">{t("tz.floats")}</span>
        <button
          type="button"
          onClick={() => onChange(appZone)}
          className="flex items-center gap-1 text-[11px] text-white/40 hover:text-white transition-colors"
        >
          <Pin size={10} />
          {t("tz.pinTo", { zone: cityOf(appZone) })}
        </button>
      </div>
    );
  }

  const elsewhere = value !== appZone;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`flex items-center gap-1 text-[11px] rounded-full px-2 py-0.5 border ${
          elsewhere
            ? "bg-amber-500/15 border-amber-500/40 text-amber-200"
            : "bg-purple-600/15 border-purple-500/35 text-purple-200"
        }`}>
          <Pin size={10} />
          {t("tz.pinnedTo", { zone: cityOf(value) })}
        </span>
        <button
          type="button"
          onClick={() => onChange(null)}
          className="flex items-center gap-1 text-[11px] text-white/35 hover:text-white transition-colors"
        >
          <PinOff size={10} />
          {t("tz.unpin")}
        </button>
      </div>
      {/* Only worth saying once the two have actually drifted apart. */}
      <span className="text-white/25 text-[11px]">
        {elsewhere ? t("tz.pinnedElsewhere", { zone: cityOf(appZone) }) : t("tz.pinWhy")}
      </span>
    </div>
  );
}
