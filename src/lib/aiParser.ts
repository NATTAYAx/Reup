import { Category, ResetType } from "../types";
import { todayLocal } from "./dateUtil";

interface ParsedTask {
  name: string;
  description: string;
  category: Category;
  reset_type: ResetType;
  reset_time: string | null;
  reset_day: number | null;
  reset_interval_days: number | null;
  anchor_date: string | null;
  event_start: string | null;
  event_end: string | null;
}

// Game presets database
const GAME_PRESETS: Record<string, Partial<ParsedTask>> = {
  "honkai star rail": {
    name: "Honkai Star Rail Daily",
    category: "game",
    reset_type: "daily",
    reset_time: "04:00",
    description: "Daily stamina & missions reset",
  },
  "hsr": {
    name: "Honkai Star Rail Daily",
    category: "game",
    reset_type: "daily",
    reset_time: "04:00",
    description: "Daily stamina & missions reset",
  },
  "maplestory daily": {
    name: "MapleStory Daily",
    category: "game",
    reset_type: "daily",
    reset_time: "00:00",
    description: "Daily quests reset",
  },
  "maplestory weekly": {
    name: "MapleStory Weekly Boss",
    category: "game",
    reset_type: "weekly",
    reset_time: "00:00",
    reset_day: 1,
    description: "Weekly boss reset (Monday)",
  },
  "maplestory": {
    name: "MapleStory Daily",
    category: "game",
    reset_type: "daily",
    reset_time: "00:00",
    description: "Daily quests reset",
  },
  "twisted wonderland": {
    name: "Twisted Wonderland Daily",
    category: "game",
    reset_type: "daily",
    reset_time: "14:00",
    description: "Daily reset",
  },
  "twst": {
    name: "Twisted Wonderland Daily",
    category: "game",
    reset_type: "daily",
    reset_time: "14:00",
    description: "Daily reset",
  },
  "my hero ultra rumble": {
    name: "My Hero Ultra Rumble Daily",
    category: "game",
    reset_type: "daily",
    reset_time: "00:00",
    description: "Daily missions reset",
  },
  "mhur": {
    name: "My Hero Ultra Rumble Daily",
    category: "game",
    reset_type: "daily",
    reset_time: "00:00",
    description: "Daily missions reset",
  },
  "moc": {
    name: "HSR Memory of Chaos",
    category: "game",
    reset_type: "biweekly",
    reset_time: "04:00",
    anchor_date: "2024-01-01",
    description: "Memory of Chaos biweekly reset",
  },
  "memory of chaos": {
    name: "HSR Memory of Chaos",
    category: "game",
    reset_type: "biweekly",
    reset_time: "04:00",
    anchor_date: "2024-01-01",
    description: "Memory of Chaos biweekly reset",
  },
  "apocalyptic shadow": {
    name: "HSR Apocalyptic Shadow",
    category: "game",
    reset_type: "biweekly",
    reset_time: "04:00",
    anchor_date: "2024-01-15",
    description: "Apocalyptic Shadow biweekly reset",
  },
  "pure fiction": {
    name: "HSR Pure Fiction",
    category: "game",
    reset_type: "biweekly",
    reset_time: "04:00",
    anchor_date: "2024-01-08",
    description: "Pure Fiction biweekly reset",
  },
};

const DAY_MAP: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

function extractTime(text: string): string | null {
  // Match patterns like "3am", "3:00am", "15:00", "3 am", "03:00"
  const patterns = [
    /(\d{1,2}):(\d{2})\s*(am|pm)?/i,
    /(\d{1,2})\s*(am|pm)/i,
    /midnight/i,
    /noon/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      if (match[0].toLowerCase() === "midnight") return "00:00";
      if (match[0].toLowerCase() === "noon") return "12:00";

      let hours = parseInt(match[1]);
      const minutes = match[2] && match[2].length === 2 && !["am","pm"].includes(match[2].toLowerCase())
        ? parseInt(match[2]) : 0;
      const period = match[match.length - 1]?.toLowerCase();

      if (period === "pm" && hours !== 12) hours += 12;
      if (period === "am" && hours === 12) hours = 0;

      return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
    }
  }
  return null;
}

function extractDay(text: string): number | null {
  for (const [dayName, dayNum] of Object.entries(DAY_MAP)) {
    if (text.toLowerCase().includes(dayName)) return dayNum;
  }
  return null;
}

/**
 * Words that NAME a category outright, as opposed to hinting at one.
 *
 * Kept separate from the hints below because an explicit label has to win. The
 * old version had no way to say "personal" at all - it was only ever the
 * fallback - so "blood pressure meds personal daily" was filed under Game,
 * because "daily" was checked first and matched.
 */
const CATEGORY_LABELS: [RegExp, Category][] = [
  [/\bpersonal\b/i, "personal"],
  [/\bschool\b/i, "school"],
  [/\bwork\b/i, "work"],
  [/\bgame\b/i, "game"],
];

/** Words about the subject of a task. Checked when no category was stated. */
const CATEGORY_HINTS: [RegExp, Category][] = [
  [/\b(homework|assignment|exam|class|study|lecture|submit)\b/i, "school"],
  [/\b(meeting|deadline|project|office|report|invoice|shift)\b/i, "work"],
  [/\b(reset|boss|quest|raid|dungeon|gacha|stamina|lockout)\b/i, "game"],
  [/\b(meds|medicine|pill|doctor|dentist|rent|bill|laundry|groceries)\b/i, "personal"],
];

/**
 * The weakest signal there is, and it sits last for a reason.
 *
 * "daily" and "weekly" describe how often something happens, not what it is.
 * They used to be checked as if they meant Game, which is why "blood pressure
 * meds personal daily" was filed under Game - the frequency word was reached
 * before anything else could speak.
 *
 * Dropping them entirely turned out to be worse: an unrecognised game typed as
 * "Genshin Impact daily" has nothing else to go on and landed in Personal. So
 * they stay, as a guess of last resort. Anything that knows better - a stated
 * label, a subject word - is consulted first.
 */
const FREQUENCY_FALLBACK: [RegExp, Category][] = [
  [/\b(daily|weekly|biweekly)\b/i, "game"],
];

function extractCategory(text: string): Category {
  for (const [re, cat] of CATEGORY_LABELS) if (re.test(text)) return cat;
  for (const [re, cat] of CATEGORY_HINTS) if (re.test(text)) return cat;
  for (const [re, cat] of FREQUENCY_FALLBACK) if (re.test(text)) return cat;
  return "personal";
}

/** "every 3 days" -> 3. Null when no interval was given. */
function extractIntervalDays(text: string): number | null {
  const m = text.match(/\bevery\s+(\d{1,3})\s*(day|days)\b/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n >= 1 && n <= 365 ? n : null;
}

function extractResetType(text: string): ResetType {
  const lower = text.toLowerCase();

  // "every 3 days" before the plain-daily check, or "every 3 days" matches
  // nothing and falls all the way through to one_time. Found while testing the
  // name fix: a custom cycle typed in the most obvious way possible became a
  // one-off, silently.
  if (extractIntervalDays(lower) !== null) return "custom_days";

  if (lower.includes("every day") || lower.includes("everyday") ||
      lower.includes("daily") || lower.includes("each day")) return "daily";
  if (lower.includes("biweekly") || lower.includes("bi-weekly") ||
      lower.includes("every 2 week") || lower.includes("every two week") ||
      lower.includes("fortnight")) return "biweekly";
  if (lower.includes("every week") || lower.includes("weekly") ||
      lower.includes("each week")) return "weekly";

  // "every friday" is a weekly task. The old version only understood the word
  // "weekly", so naming the day - which is how people actually say it - produced
  // a one-off that fired once and never again.
  if (/\bevery\s+(sun|mon|tues?|wednes|thurs?|fri|satur)(day)?\b/i.test(lower) ||
      (/\bon\s+(sun|mon|tues?|wednes|thurs?|fri|satur)(day)?\b/i.test(lower) &&
       !lower.includes("once"))) return "weekly";

  if (lower.includes("every month") || lower.includes("monthly")) return "custom_days";
  if (lower.includes("event") || lower.includes("until") ||
      lower.includes("ends")) return "event_window";
  return "one_time";
}

/**
 * Everything the other extractors consume, so the name can drop all of it.
 *
 * This is the fix for the bug that produced task names like "Blood Pressure
 * Meds Personal" and "Guild Raid Lockout On". The old version kept its own
 * hand-written list of things to strip, which had drifted out of step with what
 * extractDay and extractCategory actually recognise: a word could be understood
 * by one and left behind by the other, and it ended up in the title.
 *
 * Two lists that have to agree, maintained separately, will not agree. So the
 * day names come from DAY_MAP and the category words from CATEGORY_LABELS -
 * the same tables the parsing reads - and adding a word in one place now
 * removes it from names automatically.
 */
function stripParsedTokens(text: string): string {
  let out = text;

  // Category labels, which the old version never removed at all.
  for (const [re] of CATEGORY_LABELS) out = out.replace(new RegExp(re.source, "gi"), " ");

  // Day names, from the same table extractDay reads. Longest first, or "mon"
  // eats the front of "monday" and leaves "day" sitting in the title.
  const days = Object.keys(DAY_MAP).sort((a, b) => b.length - a.length);
  out = out.replace(new RegExp(`\\b(${days.join("|")})\\b`, "gi"), " ");

  // Frequency and reset words.
  out = out
    .replace(/\bresets?\b/gi, " ")
    .replace(/\b(everyday|daily|weekly|biweekly|bi-weekly|monthly|fortnight(ly)?)\b/gi, " ")
    .replace(/\bevery\s+\d*\s*(day|week|month|year)s?\b/gi, " ")
    .replace(/\beach\s+(day|week|month)\b/gi, " ");

  // Times, in the same shapes extractTime accepts.
  out = out
    .replace(/\b\d{1,2}:\d{2}\s*(am|pm)?/gi, " ")
    .replace(/\b\d{1,2}\s*(am|pm)\b/gi, " ")
    .replace(/\b(midnight|noon)\b/gi, " ");

  // Connectives left stranded once the words around them are gone, plus the
  // separators that turn up when a line is pasted from a table.
  out = out
    .replace(/[|,;]+/g, " ")
    .replace(/\b(at|on|every|each)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  return out;
}

function extractName(text: string): string {
  const stripped = stripParsedTokens(text);

  // A task genuinely called "Work" or "Monday" would be stripped to nothing.
  // Falling back to the raw text is better than inventing "New Task", because
  // what the person typed is at least what they meant.
  const name = stripped || text.trim();

  return name.split(" ")
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

export function parseNaturalLanguage(input: string): ParsedTask {
  const lower = input.toLowerCase().trim();

  // Check game presets first
  for (const [key, preset] of Object.entries(GAME_PRESETS)) {
    if (lower.includes(key)) {
      const time = extractTime(input);
      return {
        name: preset.name || extractName(input),
        description: preset.description || "",
        category: preset.category || "game",
        reset_type: preset.reset_type || "daily",
        reset_time: time || preset.reset_time || null,
        reset_day: preset.reset_day ?? null,
        reset_interval_days: preset.reset_interval_days ?? null,
        anchor_date: preset.anchor_date || null,
        event_start: null,
        event_end: null,
      };
    }
  }

  // Generic parsing
  const reset_type = extractResetType(lower);
  const reset_time = extractTime(input);
  const reset_day = reset_type === "weekly" ? extractDay(lower) : null;
  const category = extractCategory(lower);

  return {
    name: extractName(input) || "New Task",
    description: "",
    category,
    reset_type,
    reset_time,
    reset_day,
    // A stated interval beats the monthly default, which is what "custom_days"
    // used to mean unconditionally.
    reset_interval_days: reset_type === "custom_days"
      ? (extractIntervalDays(lower) ?? 30)
      : null,
    anchor_date: (reset_type === "biweekly" || reset_type === "custom_days")
      ? todayLocal()
      : null,
    event_start: null,
    event_end: null,
  };
}

// Suggestion chips for quick add
export const QUICK_PRESETS = [
  { label: "🌟 HSR Daily", input: "Honkai Star Rail daily reset at 4am" },
  { label: "⚔️ HSR MoC", input: "Memory of Chaos" },
  { label: "🍁 MapleStory Daily", input: "MapleStory daily" },
  { label: "🍁 Maple Weekly Boss", input: "MapleStory weekly" },
  { label: "🌹 Twisted Wonderland", input: "Twisted Wonderland" },
  { label: "🦸 MHUR Daily", input: "My Hero Ultra Rumble" },
];