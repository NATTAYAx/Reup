// ============================================================
// geminiService.ts
// Smart AI backend:
//   • Online  → Gemini 2.0 Flash (free, 1500 req/day)
//   • Offline → Enhanced local regex parser (no network needed)
//
// HOW TO GET A FREE GEMINI API KEY:
//   1. Go to https://aistudio.google.com/app/apikey
//   2. Sign in with Google → "Create API key"
//   3. Copy the key and paste it in SettingsModal (or .env)
//   4. It's stored in localStorage under "gamesched_gemini_key"
// ============================================================

import { smartParse, AIResult } from "./smartAI";

// ─── Key storage ─────────────────────────────────────────────
const KEY_STORAGE = "gamesched_gemini_key";

export function getGeminiKey(): string {
  return localStorage.getItem(KEY_STORAGE) ?? "";
}
export function setGeminiKey(key: string) {
  localStorage.setItem(KEY_STORAGE, key.trim());
}
export function clearGeminiKey() {
  localStorage.removeItem(KEY_STORAGE);
}

// ─── Online check ────────────────────────────────────────────
// Tauri blocks HEAD pings to external domains via CSP.
// Instead we just try a real Gemini request — if it succeeds we're online.
// For a quick pre-check we use navigator.onLine only.
export async function isOnline(): Promise<boolean> {
  // navigator.onLine is false when there's literally no network adapter
  // but true even on captive portals — good enough as a fast pre-check
  return navigator.onLine;
}

// ─── Gemini system prompt ─────────────────────────────────────
// Tells Gemini exactly what JSON shape to return so we can
// parse it reliably into AIResult / finance actions.

const SYSTEM_PROMPT = `
You are a smart assistant for a personal task and finance tracker app.
The user is Thai, so they may write in Thai, English, or mix both (Thaiglish).
Today's timezone is Asia/Bangkok (UTC+7).

ALWAYS respond with a single JSON object. No markdown fences. No extra text.

For TASK operations return:
{
  "domain": "task",
  "intent": "add" | "delete" | "edit_time" | "edit_priority",
  "reply": "<friendly reply in the SAME language the user used>",
  "tasks": [
    {
      "name": "...",
      "description": "...",
      "category": "game" | "school" | "work" | "personal",
      "reset_type": "daily" | "weekly" | "biweekly" | "custom_days" | "event_window" | "specific_date",
      "reset_time": "HH:MM" or null,
      "reset_day": 0-6 or null,
      "reset_interval_days": number or null,
      "anchor_date": "YYYY-MM-DD" or null,
      "event_start": "YYYY-MM-DD" or null,
      "event_end": "YYYY-MM-DD" or null,
      "specific_date": "YYYY-MM-DD" or null,
      "is_priority": 0 or 1,
      "is_urgent": 0 or 1
    }
  ],
  "targetTaskName": "..." or null,
  "newTime": "HH:MM" or null,
  "newPriority": true | false | null
}

For FINANCE operations return:
{
  "domain": "finance",
  "intent": "log_expense" | "delete_expense" | "edit_expense" | "query_spending" | "log_income",
  "reply": "<friendly reply>",
  "amount": number or null,
  "category": "food" | "transport" | "entertainment" | "shopping" | "health" | "education" | "bills" | "game" | "other" | null,
  "note": "..." or null,
  "keyword": "..." or null,
  "newAmount": number or null,
  "incomeAmount": number or null,
  "incomeNote": "..." or null,
  "querySummary": true or false
}

For UNKNOWN / CONVERSATION return:
{
  "domain": "chat",
  "intent": "chat",
  "reply": "<friendly reply in the same language>"
}

GAME PRESETS (use these exact values if mentioned):
- Honkai Star Rail / HSR → daily, reset_time: "04:00", category: game
- Twisted Wonderland / TWST → daily, reset_time: "14:00", category: game  
- MapleStory daily → daily, reset_time: "00:00", category: game
- MapleStory weekly boss → weekly, reset_day: 1, reset_time: "00:00", category: game
- My Hero Ultra Rumble / MHUR → daily, reset_time: "00:00", category: game
- Memory of Chaos / MoC → biweekly, reset_time: "04:00", anchor_date: "2024-01-01"
- Apocalyptic Shadow → biweekly, reset_time: "04:00", anchor_date: "2024-01-15"
- Pure Fiction → biweekly, reset_time: "04:00", anchor_date: "2024-01-08"

THAI KEYWORDS:
- ทุกวัน/รายวัน → daily
- ทุกอาทิตย์/รายสัปดาห์ → weekly
- สองอาทิตย์ → biweekly
- งาน/ประชุม/ส่ง → work
- เรียน/การบ้าน/สอบ → school
- เกม/รีเซ็ต/บอส → game
- ด่วน/เร่งด่วน → is_urgent: 1
- สำคัญ/จำเป็น → is_priority: 1
- วันจันทร์=1, อังคาร=2, พุธ=3, พฤหัส=4, ศุกร์=5, เสาร์=6, อาทิตย์=0

Always prefer the user's language in the "reply" field.
`.trim();

// ─── Call Gemini ──────────────────────────────────────────────
interface GeminiOptions {
  context?: string; // extra context like spending summary
}

export async function callGemini(
  userMessage: string,
  options: GeminiOptions = {}
): Promise<GeminiResponse> {
  const key = getGeminiKey();
  if (!key) throw new Error("NO_KEY");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`;

  const systemWithContext = options.context
    ? `${SYSTEM_PROMPT}\n\nCONTEXT: ${options.context}`
    : SYSTEM_PROMPT;

  const body = {
    system_instruction: { parts: [{ text: systemWithContext }] },
    contents: [{ role: "user", parts: [{ text: userMessage }] }],
    generationConfig: {
      temperature: 0.2,      // low = more consistent JSON
      maxOutputTokens: 600,
      responseMimeType: "application/json",
    },
  };

  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 8000); // 8s timeout

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(tid);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const msg = (err as any)?.error?.message ?? res.statusText;
      throw new Error(`GEMINI_ERROR: ${msg}`);
    }

    const data = await res.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

    // Strip possible markdown fences just in case
    const clean = raw.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
    return JSON.parse(clean) as GeminiResponse;
  } catch (e: any) {
    clearTimeout(tid);
    if (e.name === "AbortError") throw new Error("TIMEOUT");
    throw e;
  }
}

// ─── Response types ───────────────────────────────────────────
export interface GeminiTaskResponse {
  domain: "task";
  intent: "add" | "delete" | "edit_time" | "edit_priority";
  reply: string;
  tasks: any[];
  targetTaskName?: string;
  newTime?: string;
  newPriority?: boolean;
}

export interface GeminiFinanceResponse {
  domain: "finance";
  intent: "log_expense" | "delete_expense" | "edit_expense" | "query_spending" | "log_income";
  reply: string;
  amount?: number;
  category?: string;
  note?: string;
  keyword?: string;
  newAmount?: number;
  incomeAmount?: number;
  incomeNote?: string;
  querySummary?: boolean;
}

export interface GeminiChatResponse {
  domain: "chat";
  intent: "chat";
  reply: string;
}

export type GeminiResponse =
  | GeminiTaskResponse
  | GeminiFinanceResponse
  | GeminiChatResponse;

// ─── Main entry point ─────────────────────────────────────────
// Returns { source: "gemini" | "local", response }
// Callers don't need to know which backend was used.

export interface AIServiceResult {
  source: "gemini" | "local";
  response: GeminiResponse;
}

export async function processMessage(
  userMessage: string,
  options: GeminiOptions = {}
): Promise<AIServiceResult> {
  const key = getGeminiKey();
  const online = key ? await isOnline() : false;

  if (online && key) {
    try {
      const response = await callGemini(userMessage, options);
      return { source: "gemini", response };
    } catch (e: any) {
      console.warn("[geminiService] Gemini failed, falling back to local:", e.message);
      // Fall through to local
    }
  }

  // ── Offline / no key / Gemini failed → local fallback ────────
  const localResult = localParse(userMessage);
  return { source: "local", response: localResult };
}

// ─── Enhanced local parser (offline fallback) ─────────────────
// Much smarter than the old aiParser.ts:
//   • Thai keyword detection
//   • Finance intent detection  
//   • Better game preset matching
//   • Fuzzy time extraction (โมง, นาฬิกา, etc.)

function localParse(text: string): GeminiResponse {
  // ── Finance detection ─────────────────────────────────────────
  const isFinance =
    /ใช้ไป|ใช้จ่าย|จ่าย|ซื้อ|กิน.*บาท|บาท|฿|expense|spent|paid|spending|สรุป.*เงิน|ยอดเงิน|รับเงิน|เงินเดือน|income|รายได้/i.test(text) &&
    !/รีเซ็ต|reset|daily|game|เกม|task|งาน.*ส่ง|การบ้าน/i.test(text);

  if (isFinance) return localParseFinance(text);

  // ── Task detection ────────────────────────────────────────────
  return localParseTask(text);
}

function localParseFinance(text: string): GeminiFinanceResponse {
  const lower = text.toLowerCase();

  // ── Query intent ───────────────────────────────────────────
  if (/ใช้ไป|ใช้จ่าย|สรุป|เดือนนี้|วันนี้.*เท่า|ยอด|ค่าใช้จ่าย.*เดือน|summary|spending|how much|total/i.test(text)) {
    return {
      domain: "finance", intent: "query_spending",
      reply: "กำลังดูสรุปการใช้จ่าย...", querySummary: true,
    };
  }

  // ── Income ─────────────────────────────────────────────────
  if (/รับเงิน|ได้เงิน|เงินเดือน|โบนัส|bonus|income|salary|รายได้|ค่าจ้าง|ค่าตอบแทน/i.test(text)) {
    const amt = extractAmount(text);
    const incomeNote = text
      .replace(/(\d[\d,]*(?:\.\d+)?)\s*(?:บาท|baht|฿|thb)?/gi, "")
      .replace(/รับเงิน|ได้เงิน|เงินเดือน|โบนัส|bonus|income|salary|รายได้|ค่าจ้าง|ค่าตอบแทน/gi, "")
      .replace(/\s+/g, " ").trim() || "income";
    return {
      domain: "finance", intent: "log_income",
      reply: amt ? `💰 บันทึกรายรับ ฿${amt.toLocaleString()} แล้ว ✅` : "ระบุจำนวนเงินที่ได้รับด้วยนะ เช่น \"รับเงินเดือน 15000\"",
      incomeAmount: amt ?? undefined,
      incomeNote,
    };
  }

  // ── Delete ─────────────────────────────────────────────────
  if (/ลบรายการ|ลบค่า|ยกเลิกรายการ|delete.*expense|remove.*expense/i.test(text)) {
    const keyword = text
      .replace(/ลบรายการ|ลบค่า|ยกเลิกรายการ|delete.*expense|remove.*expense/gi, "")
      .replace(/(\d[\d,]*)\s*(?:บาท|baht|฿)?/gi, "")
      .replace(/\s+/g, " ").trim();
    return {
      domain: "finance", intent: "delete_expense",
      reply: keyword ? `🗑️ ลบรายการ "${keyword}" แล้ว ✅` : "ลบรายการไหนดี? บอกชื่อรายการด้วยนะ",
      keyword,
    };
  }

  // ── Log expense (default) ───────────────────────────────────
  const amt = extractAmount(text);
  const category = extractExpenseCategory(lower);

  // Extract a clean note: strip amount, strip leading verb, keep the meaningful noun
  const note = text
    .replace(/(\d[\d,]*(?:\.\d+)?)\s*(?:บาท|baht|฿|thb)/gi, "")  // "80 บาท"
    .replace(/(?:฿)\s*\d[\d,]*/g, "")                                 // "฿80"
    .replace(/\b\d{2,}[\d,]*(?:\.\d+)?\b/g, "")                    // bare number
    .replace(/^(?:จ่าย|ซื้อ|ใช้|กิน|โอน|paid?|buy|bought|spent?)\s*/i, "")
    .replace(/\s+/g, " ").trim() || category;

  return {
    domain: "finance",
    intent: "log_expense",
    reply: amt
      ? `💸 บันทึก ${note} ฿${amt.toLocaleString()} หมวด ${category} ✅`
      : `ไม่พบจำนวนเงิน ลองพิมพ์ใหม่นะ เช่น "กินข้าว 80" หรือ "กาแฟ 45 บาท"`,
    amount: amt ?? undefined,
    category,
    note,
  };
}

function localParseTask(text: string): GeminiTaskResponse {
  // Use existing smartParse as the core engine for tasks
  const result: AIResult = smartParse(text);

  if (result.intent !== "add") {
    return {
      domain: "task",
      intent: result.intent as any,
      reply: result.reply,
      tasks: [],
      targetTaskName: result.targetTaskName,
      newTime: result.newTime,
      newPriority: result.newPriority,
    };
  }

  return {
    domain: "task",
    intent: "add",
    reply: result.reply,
    tasks: result.tasks,
  };
}

// ─── Local helpers ────────────────────────────────────────────
function extractAmount(text: string): number | null {
  // Priority order: explicit unit first, then verb+amount, then noun+amount, then bare number
  const withUnit = text.match(/(\d[\d,]*(?:\.\d+)?)\s*(?:บาท|baht|thb)/i)
    || text.match(/(?:฿)\s*(\d[\d,]*(?:\.\d+)?)/);
  if (withUnit) { const v = parseFloat(withUnit[1].replace(/,/g,"")); if(v>0) return v; }

  const withVerb = text.match(/(?:จ่าย|ซื้อ|ใช้|กิน|โอน|paid?|buy|bought|spent?)\s*(?:ไป\s*)?(\d[\d,]*(?:\.\d+)?)/i);
  if (withVerb) { const v = parseFloat(withVerb[1].replace(/,/g,"")); if(v>0) return v; }

  // "ค่ากาแฟ 45" or "กาแฟ 45" — Thai/word chars followed by space then number
  const nounAmt = text.match(/[\u0E00-\u0E7F\w]+\s+(\d{2,}[\d,]*(?:\.\d+)?)/);
  if (nounAmt) { const v = parseFloat(nounAmt[1].replace(/,/g,"")); if(v>0) return v; }

  // last resort: any bare number ≥2 digits
  const bare = text.match(/\b(\d{2,}[\d,]*(?:\.\d+)?)\b/);
  if (bare) { const v = parseFloat(bare[1].replace(/,/g,"")); if(v>0) return v; }

  return null;
}

function extractExpenseCategory(lower: string): string {
  if (/กาแฟ|coffee|cafe|ชา|นม|ชาไข่มุก|บับเบิ้ล/.test(lower)) return "food"; // coffee before general food
  if (/ข้าว|อาหาร|กิน|ร้าน|ขนม|food|eat|lunch|dinner|breakfast|สตาร์บัค|starbuck/.test(lower)) return "food";
  if (/รถ|taxi|grab|bts|mrt|bus|เดินทาง|น้ำมัน|transport|uber|แท็กซี่|วิน/.test(lower)) return "transport";
  if (/หนัง|movie|netflix|spotify|youtube|concert|entertainment|บันเทิง|เกมส์/.test(lower)) return "entertainment";
  if (/shopping|mall|lazada|shopee|เสื้อผ้า|รองเท้า|เสื้อ|กางเกง|กระเป๋า/.test(lower)) return "shopping";
  if (/ยา|หมอ|โรงพยาบาล|clinic|health|hospital|pharmacy|ร้านยา/.test(lower)) return "health";
  if (/หนังสือ|course|เรียน|tutor|education|คอร์ส|ติว/.test(lower)) return "education";
  if (/ค่าน้ำ|ค่าไฟ|internet|wifi|phone|bill|ประกัน|ค่าเช่า|rent|ค่าหอ/.test(lower)) return "bills";
  if (/gacha|pull|recharge|เติมเงินเกม|gems|crystals|primogem|stellar jade|jades?|jade|เติมเกม/.test(lower)) return "game";
  if (/ของหวาน|เค้ก|ไอศกรีม|ขนมหวาน|dessert|icecream/.test(lower)) return "food";
  return "other";
}