import { getLang } from "./i18n";

// Month names — switch based on language
const MONTHS_EN = [
  "January", "February", "March", "April",
  "May", "June", "July", "August",
  "September", "October", "November", "December"
];
const MONTHS_TH = [
  "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน",
  "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม",
  "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"
];

// Day abbreviations — switch based on language
const DAYS_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAYS_TH = ["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"];

/** Language-aware month names array (for direct index use) */
export function getMonthNames(): string[] {
  return getLang() === "th" ? MONTHS_TH : MONTHS_EN;
}

/** Language-aware day abbreviations array (for direct index use) */
export function getDayNames(): string[] {
  return getLang() === "th" ? DAYS_TH : DAYS_EN;
}

// Keep legacy exports for backward compatibility — they'll read correct lang at call time
export const THAI_MONTHS = new Proxy([] as string[], {
  get(_, prop) {
    const months = getLang() === "th" ? MONTHS_TH : MONTHS_EN;
    if (typeof prop === "string" && !isNaN(Number(prop))) return months[Number(prop)];
    if (prop === "length") return months.length;
    if (prop === Symbol.iterator) return months[Symbol.iterator].bind(months);
    return (months as any)[prop];
  }
});

export const THAI_DAYS_SHORT = new Proxy([] as string[], {
  get(_, prop) {
    const days = getLang() === "th" ? DAYS_TH : DAYS_EN;
    if (typeof prop === "string" && !isNaN(Number(prop))) return days[Number(prop)];
    if (prop === "length") return days.length;
    if (prop === Symbol.iterator) return days[Symbol.iterator].bind(days);
    if (prop === "map") return days.map.bind(days);
    return (days as any)[prop];
  }
});

// Convert to Buddhist Era year (พ.ศ.)
export function toBuddhistYear(date: Date): number {
  return date.getFullYear() + 543;
}

export function formatThaiDate(date: Date): string {
  const months = getLang() === "th" ? MONTHS_TH : MONTHS_EN;
  return `${months[date.getMonth()]} ${date.getDate()}, พ.ศ. ${toBuddhistYear(date)}`;
}

export function formatThaiMonthYear(date: Date): string {
  const months = getLang() === "th" ? MONTHS_TH : MONTHS_EN;
  if (getLang() === "th") {
    return `${months[date.getMonth()]} พ.ศ. ${toBuddhistYear(date)}`;
  }
  return `${months[date.getMonth()]} ${date.getFullYear()}`;
}

export function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

export function getFirstDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 1).getDay();
}

export function toDateString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}

export function isToday(date: Date): boolean {
  return isSameDay(date, new Date());
}