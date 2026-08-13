import { useState, useMemo, useEffect } from "react";
import { Check, Search, Globe } from "lucide-react";
import {
  allTimeZones, zoneOffsetIndex, formatOffset, zoneDisplayName,
  systemTimeZone, indexedOffsetMinutes, ensureZoneNameIndex, zoneNameIndex,
  allTimeZonesSearchable, SYSTEM,
} from "../lib/tz";
import { MAJOR_ZONES, ZONE_ALIASES, aliasWords } from "../lib/zoneNames";
import { t, getLang } from "../lib/i18n";

// ─── TimeZonePicker ───────────────────────────────────────────────────────────
// Three things this has to get right, all of which the first version did not.
//
// Typing "japan" has to find Tokyo. The identifier is "Asia/Tokyo" and contains
// no such word, so matching runs against an alias table as well as the id.
//
// Typing "+9" has to find Tokyo too, because thinking in offsets is how anyone
// who has ever coordinated across a border thinks. Nine zones sit at UTC+9 and
// one of them is a town in Siberia, so well-known zones sort to the top rather
// than whatever alphabetical order happens to produce.
//
// And it has to read in the reader's language. The runtime already knows the
// translation, so nothing is hand-maintained: it is asked one zone at a time,
// for the rows on screen only. The identifier stays visible underneath, quietly,
// because that is the thing actually being stored.
//
// Never more than a screenful is rendered. There are 418 zones and putting them
// all in the DOM to pick one would be the definition of paying for nothing.

const LIMIT = 40;

interface Props {
  /** SYSTEM, or an IANA name. */
  value: string;
  onChange: (pref: string) => void;
}

const cityOf = (zone: string) => (zone.split("/").pop() ?? zone).replace(/_/g, " ");

/** "+9", "utc+9", "-05:30", "7" — anything that is plainly an offset and not a
 *  place. Returns minutes, or null if the query is a word. */
function parseOffsetQuery(q: string): number | null {
  const m = /^(?:utc|gmt)?\s*([+-]?)(\d{1,2})(?::?(\d{2}))?$/.exec(q.replace(/\s+/g, ""));
  if (!m) return null;
  const hours = +m[2];
  if (hours > 14) return null;
  const mins = m[3] ? +m[3] : 0;
  if (mins > 59) return null;
  return (m[1] === "-" ? -1 : 1) * (hours * 60 + mins);
}

export default function TimeZonePicker({ value, onChange }: Props) {
  const [query, setQuery] = useState("");
  // Bumped once the background name index lands, so a search typed before it
  // finished is re-run against it.
  const [indexed, setIndexed] = useState(0);
  const sys = systemTimeZone();
  const locale = getLang() === "th" ? "th" : "en";

  useEffect(() => {
    ensureZoneNameIndex(locale, () => setIndexed(n => n + 1));
  }, [locale]);

  const matches = useMemo(() => {
    const raw = query.trim().toLowerCase();
    const all = allTimeZones();

    // Well-known zones first, so a search never leads with an obscure one that
    // happens to share an offset with the answer. Within that, how squarely the
    // query landed: the whole word beats the start of a word beats letters found
    // somewhere in the middle. Without that, "india" leads with
    // America/Indiana/Knox and "uk" leads with Ukraine.
    const hit = (text: string, needle: string) =>
      text === needle ? 0 : text.startsWith(needle) ? 1 : text.includes(needle) ? 2 : 3;

    const rank = (z: string, needle = "") => {
      const base = MAJOR_ZONES.has(z) ? 0 : 4;
      if (!needle) return base;
      let best = hit(cityOf(z).toLowerCase(), needle);
      for (const w of aliasWords(z)) {
        if (best === 0) break;
        const h = hit(w, needle);
        if (h < best) best = h;
      }
      return base + best;
    };

    if (!raw) {
      const head = [...all].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).slice(0, LIMIT);
      return value !== SYSTEM && !head.includes(value) ? [value, ...head.slice(0, LIMIT - 1)] : head;
    }

    const offset = parseOffsetQuery(raw);
    if (offset !== null) {
      const index = zoneOffsetIndex();
      const hits: string[] = [];
      for (let i = 0; i < all.length; i++) if (index[i] === offset) hits.push(all[i]);
      return hits.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).slice(0, LIMIT);
    }

    // Every word has to land somewhere, which is what makes "sri lanka" and
    // "new zealand" work: neither is one token in any of the three places a
    // match can come from, but both words are present across them.
    const terms = raw.split(/\s+/).filter(Boolean);
    const names = zoneNameIndex();
    const ids = allTimeZonesSearchable();
    const hits: string[] = [];
    for (let i = 0; i < all.length; i++) {
      let ok = true;
      for (const term of terms) {
        if (ids[i].includes(term)) continue;
        if ((ZONE_ALIASES[all[i]] ?? "").includes(term)) continue;
        if (names !== null && names[i].includes(term)) continue;
        ok = false;
        break;
      }
      if (ok) hits.push(all[i]);
    }
    const lead = terms[0] ?? "";
    return hits.sort((a, b) => rank(a, lead) - rank(b, lead) || a.localeCompare(b)).slice(0, LIMIT);
  }, [query, value, indexed]);

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => onChange(SYSTEM)}
        className={`w-full flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors ${
          value === SYSTEM
            ? "bg-purple-600/20 border-purple-500/50"
            : "bg-white/5 border-white/10 hover:border-white/25"
        }`}
      >
        <Globe size={15} className="text-purple-400 shrink-0" />
        <span className="flex-1 min-w-0">
          <span className="block text-white text-sm font-semibold">{t("tz.auto")}</span>
          <span className="block text-white/35 text-[11px] truncate">
            {sys} · {formatOffset(indexedOffsetMinutes(sys))}
          </span>
        </span>
        {value === SYSTEM && <Check size={14} className="text-purple-400 shrink-0" />}
      </button>

      <div className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-xl px-3 py-2 focus-within:border-[var(--color-primary)] transition-colors">
        <Search size={14} className="text-white/30 shrink-0" />
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={t("tz.search")}
          spellCheck={false}
          className="flex-1 min-w-0 bg-transparent text-white text-sm placeholder-white/25 focus:outline-none"
        />
      </div>

      <div className="max-h-52 overflow-y-auto space-y-0.5 pr-0.5">
        {matches.map(zone => {
          const on = value === zone;
          const name = zoneDisplayName(zone, locale) || cityOf(zone);
          return (
            <button
              key={zone}
              type="button"
              onClick={() => onChange(zone)}
              className={`w-full flex items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors ${
                on ? "bg-purple-600/20" : "hover:bg-white/[0.07]"
              }`}
            >
              <span className="flex-1 min-w-0">
                <span className={`block text-sm truncate ${on ? "text-white font-semibold" : "text-white/80"}`}>
                  {name}
                </span>
                {/* The identifier stays on screen because it is what gets stored,
                    and it is what any support page will call this zone. */}
                <span className="block text-white/30 text-[11px] truncate">{zone}</span>
              </span>
              <span className="text-white/35 text-[11px] font-mono shrink-0">
                {formatOffset(indexedOffsetMinutes(zone))}
              </span>
              {on && <Check size={13} className="text-purple-400 shrink-0" />}
            </button>
          );
        })}
        {matches.length === 0 && (
          <p className="text-white/30 text-xs text-center py-4">{t("tz.noMatch")}</p>
        )}
      </div>
    </div>
  );
}
