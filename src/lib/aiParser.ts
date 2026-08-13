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

function extractCategory(text: string): Category {
  const lower = text.toLowerCase();
  if (lower.includes("homework") || lower.includes("assignment") ||
      lower.includes("exam") || lower.includes("class") ||
      lower.includes("school") || lower.includes("study") ||
      lower.includes("lecture") || lower.includes("submit")) return "school";
  if (lower.includes("work") || lower.includes("meeting") ||
      lower.includes("deadline") || lower.includes("project") ||
      lower.includes("office") || lower.includes("report")) return "work";
  if (lower.includes("game") || lower.includes("reset") ||
      lower.includes("boss") || lower.includes("quest") ||
      lower.includes("daily") || lower.includes("weekly")) return "game";
  return "personal";
}

function extractResetType(text: string): ResetType {
  const lower = text.toLowerCase();
  if (lower.includes("every day") || lower.includes("everyday") ||
      lower.includes("daily") || lower.includes("each day")) return "daily";
  if (lower.includes("biweekly") || lower.includes("bi-weekly") ||
      lower.includes("every 2 week") || lower.includes("every two week") ||
      lower.includes("fortnight")) return "biweekly";
  if (lower.includes("every week") || lower.includes("weekly") ||
      lower.includes("each week")) return "weekly";
  if (lower.includes("every month") || lower.includes("monthly")) return "custom_days";
  if (lower.includes("event") || lower.includes("until") ||
      lower.includes("ends")) return "event_window";
  return "one_time";
}

function extractName(text: string): string {
  // Remove time and day references to get clean name
  let name = text
    .replace(/resets?/gi, "")
    .replace(/every\s+(day|week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)/gi, "")
    .replace(/everyday|daily|weekly|monthly/gi, "")
    .replace(/at\s+\d{1,2}(:\d{2})?\s*(am|pm)?/gi, "")
    .replace(/\d{1,2}(:\d{2})?\s*(am|pm)/gi, "")
    .replace(/midnight|noon/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  // Capitalize first letter of each word
  return name.split(" ")
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
    reset_interval_days: reset_type === "custom_days" ? 30 : null,
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