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
import {
  PROVIDERS, getProviderId, getApiKey, setApiKey, getModel, getBaseUrl,
  isOverDailyCap, recordUsage, type TokenUsage,
} from "./aiProviders";

export type { TokenUsage } from "./aiProviders";

// ─── Key storage ─────────────────────────────────────────────
// Thin wrappers kept so existing callers do not change. The store itself is
// per-provider and lives in aiProviders.ts.

export function getGeminiKey(): string {
  return getApiKey();
}
export function setGeminiKey(key: string) {
  setApiKey(key);
}
export function clearGeminiKey() {
  setApiKey("");
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
      "reset_time": "HH:MM" or null,   // null = all day (due 23:59). Set it whenever the user names a time, INCLUDING for specific_date.
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

USING THE CONTEXT BLOCK:
The context you are given lists the user's CURRENT tasks and spending. Use it.
- For delete / edit_time / edit_priority, "targetTaskName" MUST be copied
  EXACTLY as it appears in the task list, character for character. The app
  matches on that string, so a paraphrase silently deletes nothing.
- If the user names something loosely ("เดลี่", "ตัวรีเซ็ตตีสี่", "the maple one"),
  resolve it against the list yourself and return the exact name.
- If nothing in the list plausibly matches, do NOT guess. Return domain "chat"
  and ask which one they mean, listing the closest names.
- Never invent a task that is not in the list.

Always prefer the user's language in the "reply" field.
`.trim();

// ─── Call Gemini ──────────────────────────────────────────────
export interface ChatTurn {
  role: "user" | "ai";
  text: string;
}

/** Which slice of the app's state the model needs to answer this message. */
export type ContextKind = "task" | "finance" | "both";

interface GeminiOptions {
  context?: string; // extra context like spending summary
  /** Recent turns, oldest first. Without these the model sees each message in
   *  isolation, so "อันนั้นแหละ เปลี่ยนเป็นสามทุ่ม" has no antecedent and the
   *  app has to guess at follow-ups with its own regexes instead. */
  history?: ChatTurn[];
  /** Called ONLY when a request is actually going to be sent, and told which
   *  half of the app the message is about. Two reasons it is a callback rather
   *  than a string:
   *
   *  1. Building it costs four database queries. Passing a ready-made string
   *     meant paying for them on every message, including the majority that
   *     the offline parser answers on its own without any request at all.
   *  2. A message about coffee does not need the task list expanded, and a
   *     message about a game reset does not need the spending breakdown. The
   *     kind comes from the offline parser's own classification, which is a
   *     thousand lines of real parsing rather than a keyword regex — the thing
   *     that used to gate this and left the model blind. */
  buildContext?: (kind: ContextKind) => Promise<string | undefined>;
  /** Skip the local-first shortcut and always ask the model. For a "try again
   *  with the real AI" button when the offline parser got it wrong. */
  forceRemote?: boolean;
}

/** Usage from the most recent remote call, or null if none was reported. */
let lastUsage: TokenUsage | null = null;

/**
 * One request to whichever provider the user configured.
 *
 * The name is kept for the callers that already import it, but nothing about
 * Gemini lives in here any more — the wire format, the endpoint and the model
 * all come from src/lib/aiProviders.ts. Swapping to an OpenAI key, an Anthropic
 * key, or a model running locally through Ollama changes a dropdown, not code.
 */
export async function callGemini(
  userMessage: string,
  options: GeminiOptions = {}
): Promise<GeminiResponse> {
  const providerId = getProviderId();
  const provider = PROVIDERS[providerId];
  const key = getApiKey(providerId);
  if (!key) throw new Error("NO_KEY");

  // A ceiling that holds no matter how the provider bills. Without it a stuck
  // retry loop or a long afternoon of chatting is only discovered on the bill.
  if (isOverDailyCap()) throw new Error("DAILY_CAP");

  const system = options.context
    ? `${SYSTEM_PROMPT}\n\nCONTEXT: ${options.context}`
    : SYSTEM_PROMPT;

  // Four turns is enough to resolve "that one" and "change it to nine". Replies
  // are clipped harder than questions because they are mostly confirmations
  // whose tail carries nothing worth paying for. This is also what keeps the
  // request a FIXED size: a five-message chat and a five-hundred-message chat
  // send exactly the same number of tokens.
  const history = (options.history ?? []).slice(-4).map(turn => ({
    role: turn.role,
    text: turn.text.slice(0, turn.role === "user" ? 300 : 160),
  }));

  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 12000);

  try {
    const reply = await provider.send(
      {
        system,
        history,
        message: userMessage,
        maxOutputTokens: 600,
        model: getModel(providerId),
        apiKey: key,
        baseUrl: provider.configurableBaseUrl ? getBaseUrl(providerId) : undefined,
      },
      ctrl.signal,
    );
    clearTimeout(tid);

    lastUsage = reply.usage;
    recordUsage(reply.usage);
    if (reply.usage) {
      console.info(`[ai:${providerId}] in ${reply.usage.input} / out ${reply.usage.output} tokens`);
    }

    // Providers without a JSON mode wrap their answer in a markdown fence.
    const clean = reply.text.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
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
  /** Present only when the request actually went to Gemini. */
  usage?: TokenUsage | null;
}

/**
 * Confidence at or above this and the offline parser answers on its own.
 *
 * Why local-first instead of Gemini-first, which is what this used to do:
 *
 *   Quota. The Gemini free tier rations REQUESTS PER DAY, not tokens. Every
 *   sentence that went to the model burned one of a small daily allowance,
 *   including "เพิ่มงาน HSR รีเซ็ตตีสี่ทุกวัน" which the local parser has
 *   handled perfectly since before Gemini was wired in at all.
 *
 *   Speed. The local path answers in a millisecond. The remote path costs a
 *   network round trip, and up to 8 seconds when the network is unhappy.
 *
 *   Offline. The result is identical with the network unplugged.
 *
 * The bar is set high on purpose. smartParse reports 0.95+ when it recognises a
 * known game preset and 0.9 when an edit has both a target and a new time, but
 * only 0.85 for a delete, because matching a task by name is exactly where a
 * model with real context does better. So deletes and anything vaguer still go
 * to Gemini.
 */
const LOCAL_CONFIDENCE_FLOOR = 0.9;

export async function processMessage(
  userMessage: string,
  options: GeminiOptions = {}
): Promise<AIServiceResult> {
  const local = localParse(userMessage);

  if (!options.forceRemote && local.confidence >= LOCAL_CONFIDENCE_FLOOR) {
    return { source: "local", response: local.response };
  }

  const key = getGeminiKey();
  // navigator.onLine only tells us whether a network adapter exists, so it can
  // say yes on a dead connection. It is worth checking anyway because when it
  // says no, it is right, and we skip an 8 second timeout.
  if (key && navigator.onLine) {
    try {
      let context = options.context;
      if (!context && options.buildContext) {
        const d = local.response.domain;
        // "chat" means the offline parser did not recognise it, which is exactly
        // when the model needs the whole picture.
        const kind: ContextKind = d === "finance" ? "finance" : d === "task" ? "task" : "both";
        context = await options.buildContext(kind);
      }
      const response = await callGemini(userMessage, { ...options, context });
      return { source: "gemini", response, usage: lastUsage };
    } catch (e: any) {
      console.warn("[geminiService] Gemini failed, falling back to local:", e.message);
    }
  }

  return { source: "local", response: local.response };
}

// ─── Enhanced local parser (offline fallback) ─────────────────
// Much smarter than the old aiParser.ts:
//   • Thai keyword detection
//   • Finance intent detection  
//   • Better game preset matching
//   • Fuzzy time extraction (โมง, นาฬิกา, etc.)

interface LocalResult {
  response: GeminiResponse;
  /** 0-1. Drives whether this answer is good enough to skip the API entirely. */
  confidence: number;
}

/** How much to trust a locally-parsed finance action, judged on what it
 *  actually managed to extract rather than on the wording of the input. */
function financeConfidence(r: GeminiFinanceResponse): number {
  switch (r.intent) {
    case "query_spending":
      return 0.95; // reads numbers out of the DB, there is nothing to misparse
    case "log_expense":
      return r.amount && r.amount > 0 ? 0.92 : 0.2;
    case "log_income":
      return r.incomeAmount && r.incomeAmount > 0 ? 0.92 : 0.2;
    case "delete_expense":
    case "edit_expense":
      return r.keyword ? 0.6 : 0.2; // matching by keyword is worth a model
    default:
      return 0.3;
  }
}

function localParse(text: string): LocalResult {
  // ── Finance detection ─────────────────────────────────────────
  const isFinance =
    /ใช้ไป|ใช้จ่าย|จ่าย|ซื้อ|กิน.*บาท|บาท|฿|expense|spent|paid|spending|สรุป.*เงิน|ยอดเงิน|รับเงิน|เงินเดือน|income|รายได้/i.test(text) &&
    !/รีเซ็ต|reset|daily|game|เกม|task|งาน.*ส่ง|การบ้าน/i.test(text);

  if (isFinance) {
    const response = localParseFinance(text);
    return { response, confidence: financeConfidence(response) };
  }

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

function localParseTask(text: string): LocalResult {
  // Use existing smartParse as the core engine for tasks. It already scores its
  // own certainty, so that score is carried straight through instead of being
  // recomputed here from the outside.
  const result: AIResult = smartParse(text);

  if (result.intent !== "add") {
    return {
      confidence: result.confidence ?? 0.3,
      response: {
        domain: "task",
        intent: result.intent as any,
        reply: result.reply,
        tasks: [],
        targetTaskName: result.targetTaskName,
        newTime: result.newTime,
        newPriority: result.newPriority,
      },
    };
  }

  return {
    confidence: result.confidence ?? 0.3,
    response: {
      domain: "task",
      intent: "add",
      reply: result.reply,
      tasks: result.tasks,
    },
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