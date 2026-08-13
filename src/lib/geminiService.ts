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
import { getAppTimeZone, offsetLabel } from "./tz";
import { cacheLookup, cacheStore, recordCall } from "./aiMemory";
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

// ─── System prompt, assembled per message ─────────────────────────────────────
//
// It used to be one 944-token block sent with every single request, carrying the
// full task JSON schema, the full finance JSON schema, the game reset presets
// and a Thai keyword table — even when the message was "กาแฟ 60".
//
// Splitting it costs nothing in accuracy, because the offline parser has
// already worked out which half the message belongs to before a request is
// built. A finance message no longer pays for the game presets, and a task
// message no longer pays for the finance schema.
//
// Worth knowing: Thai text costs roughly twice as many tokens per character as
// English on these tokenizers, so a Thai-heavy prompt is more expensive than its
// length suggests. That is the reason this was worth splitting at all.

const PROMPT_BASE = `
You are a smart assistant for a personal task and finance tracker app.

The user is Thai, so they may write in Thai, English, or mix both (Thaiglish).

Today's timezone is ${getAppTimeZone()} (${offsetLabel(getAppTimeZone())}).



ALWAYS respond with a single JSON object. No markdown fences. No extra text.











For UNKNOWN / CONVERSATION return:

{

  "domain": "chat",

  "intent": "chat",

  "reply": "<friendly reply in the same language>"

}











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

const PROMPT_TASK = `
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
`.trim();

const PROMPT_OPERATIONS = `
PREFERRED FORMAT — a list of operations. Use this whenever the request maps to
one of the verbs below. One message may contain several; return them in the
order they should run.

{
  "domain": "task" | "finance",
  "reply": "<one short friendly sentence>",
  "operations": [ { "kind": "...", ... } ]
}

TASK VERBS. Every one except create_task takes "id", copied EXACTLY from the id
shown beside the task in CONTEXT. Never invent an id, and never send a name
instead — if no task in CONTEXT matches, return an empty operations list and ask
which one in "reply".

  {"kind":"create_task","task":{ ...the task object described above... }}
  {"kind":"update_task","id":N,"task":{ only the fields that change }}
      editable: name, description, notes, category, reset_type, reset_time,
      reset_day, reset_interval_days, anchor_date, event_start, event_end,
      specific_date, is_priority, is_urgent, min_step, time_zone, intent
  {"kind":"delete_task","id":N}
  {"kind":"restore_task","id":N}
  {"kind":"complete_task","id":N}          // "เล่นแล้ว" / "ทำเสร็จแล้ว" / "done"
  {"kind":"uncomplete_task","id":N}        // "ยังไม่ได้ทำ" / "ยกเลิกติ๊ก"
  {"kind":"pause_task","id":N,"until":"YYYY-MM-DDTHH:MM:SSZ" or omit for no end date}
  {"kind":"resume_task","id":N}
  {"kind":"set_priority","id":N,"value":true|false}
  {"kind":"set_urgent","id":N,"value":true|false}

MONEY VERBS. Expenses have no id, so they are found by "keyword" — a word from
the entry's own note, taken from what the user said or from the previous turn.

  {"kind":"log_expense","amount":N,"category":"<key from CONTEXT>","note":"..."}
  {"kind":"edit_expense","keyword":"...","amount":N}
  {"kind":"delete_expense","keyword":"..."}
  {"kind":"log_income","amount":N,"source":"...","date":"YYYY-MM-DD" or omit}

WHEN MORE THAN ONE TASK COULD BE MEANT, ASK. DO NOT PICK.

Names overlap. A user may have "Honkai Star Rail" and "Honkai Impact 3rd" at the
same time, and "เล่น Honkai แล้ว" then names neither of them. Choosing the
likelier one is wrong even when it happens to be right, because marking the wrong
task done is silent — nothing looks broken, the mistake is only found later, and
by then the reason is gone.

So: if two or more tasks in CONTEXT are a plausible match for what the user said,
return "operations": [] and use "reply" to ask which, listing the candidates by
their full names. One matching task means act. Zero means say so. Only exactly
one match is enough to proceed.

This applies to every id-taking verb, and most sharply to the destructive ones.

Answering a question rather than changing something ("เดือนนี้ใช้ไปเท่าไหร่")
means an empty operations list and the answer in "reply".
`.trim();

const PROMPT_FINANCE = `
For FINANCE operations return:

{

  "domain": "finance",

  "intent": "log_expense" | "delete_expense" | "edit_expense" | "query_spending" | "log_income",

  "reply": "<friendly reply>",

  "amount": number or null,

  "category": "<one of the category keys listed in CONTEXT>" or null,   // the set is user-editable, never assume the nine defaults

  "note": "..." or null,

  "keyword": "..." or null,   // for delete_expense / edit_expense this names the entry, copied from the user's words or the previous turn. The field is called "keyword" — NOT "targetExpenseName".

  "newAmount": number or null,

  "incomeAmount": number or null,

  "incomeNote": "..." or null,

  "querySummary": true or false

}
`.trim();

/** Only the halves this message can possibly need. */
function buildSystemPrompt(kind: ContextKind): string {
  const parts = [PROMPT_BASE];
  if (kind !== "finance") parts.push(PROMPT_TASK);
  if (kind !== "task") parts.push(PROMPT_FINANCE);
  // Last, so it is the most recent instruction in the prompt and reads as the
  // preferred answer rather than as one option among several.
  parts.push(PROMPT_OPERATIONS);
  return parts.join("\n\n");
}


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
  /** Which halves of the system prompt this message needs. Set by
   *  processMessage from the offline parser's own classification. */
  kind?: ContextKind;
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
export 
/**
 * Get an object out of whatever the model actually sent.
 *
 * THIS IS WHERE PROVIDER SUPPORT IS REALLY DECIDED.
 *
 * The three HTTP shapes in the world are already handled in lib/aiProviders —
 * Gemini, Anthropic, and the OpenAI format that OpenRouter, Groq, Together,
 * DeepSeek, Mistral, LM Studio and Ollama all speak too. Adding another vendor
 * is rarely the problem. What varies is how CLEANLY the answer comes back.
 *
 * Gemini and OpenAI can be told to emit nothing but JSON. Anthropic has no such
 * switch, and neither do most models served locally through Ollama or LM Studio.
 * Those will happily write "Sure! Here's the JSON:" in front of it, or add a
 * closing remark after it, or wrap it in a fence.
 *
 * The old line stripped fences and called JSON.parse. One stray sentence and it
 * threw, the catch swallowed it, and the app quietly fell back to the offline
 * parser — so a self-hosted model would have looked simply broken, with the
 * reason never surfacing anywhere.
 *
 * So this tries three times, from strictest to most forgiving, and only gives up
 * when there is no balanced object anywhere in the text.
 */
function parseModelJson(raw: string): any {
  const text = (raw ?? "").trim();
  if (!text) throw new Error("EMPTY_RESPONSE");

  // 1. Exactly what was asked for.
  try { return JSON.parse(text); } catch { /* keep going */ }

  // 2. Fenced, which is the common case for models without a JSON mode.
  const fenced = text.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  try { return JSON.parse(fenced); } catch { /* keep going */ }

  // 3. Buried in prose. Scan for the first balanced {...}, counting braces and
  //    ignoring any that sit inside a string, so a brace in a Thai reply cannot
  //    end the object early.
  const src = fenced;
  const start = src.indexOf("{");
  if (start !== -1) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < src.length; i++) {
      const c = src[i];
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(src.slice(start, i + 1)); } catch { break; }
        }
      }
    }
  }

  throw new Error("BAD_JSON");
}

// ─── Normalising what comes back ──────────────────────────────────────────────
//
// The schema in the system prompt asks for domain "finance" and intent
// "edit_expense". Fourteen consecutive real calls, read out of the usage log,
// came back as:
//
//   domain: finance  intent: edit_expense    ← as asked
//   domain: spending intent: edit_amount
//   domain: spending intent: edit
//   domain: expense  intent: edit_amount
//
// Same sentence, same prompt, four different vocabularies. And the code checked
// `response.domain === "finance"`, so three of those four missed the finance
// branch entirely, missed the task branch too, and came out the far end as "I
// didn't follow that one" — while the model had understood perfectly and even
// written a confident Thai sentence saying the edit was done.
//
// Chasing this one field name at a time does not converge; there was already a
// patch for `targetExpenseName` and the very next call invented
// `targetSpendingName`. A generative model is not a wire protocol. It gets the
// MEANING right far more reliably than it gets the SPELLING right, so the
// spelling has to be repaired at the door, once, rather than guarded against at
// every branch downstream.
//
// Unknown values are left exactly as they are. Nothing here invents an intent
// that was not there — it only renames ones that were.

const DOMAIN_ALIASES: Record<string, string> = {
  spending: "finance", expense: "finance", expenses: "finance", money: "finance",
  budget: "finance", income: "finance", financial: "finance", cost: "finance",
  tasks: "task", todo: "task", todos: "task", schedule: "task",
  reminder: "task", reminders: "task", game: "task",
  conversation: "chat", general: "chat", other: "chat",
};

const FINANCE_INTENT_ALIASES: Record<string, string> = {
  edit: "edit_expense", update: "edit_expense", modify: "edit_expense",
  edit_amount: "edit_expense", change_amount: "edit_expense",
  update_expense: "edit_expense", update_amount: "edit_expense",
  edit_spending: "edit_expense", change: "edit_expense",
  delete: "delete_expense", remove: "delete_expense",
  remove_expense: "delete_expense", delete_spending: "delete_expense",
  add: "log_expense", add_expense: "log_expense", log: "log_expense",
  spend: "log_expense", record_expense: "log_expense", new_expense: "log_expense",
  add_income: "log_income", record_income: "log_income", earn: "log_income",
  query: "query_spending", summary: "query_spending", ask: "query_spending",
  report: "query_spending", check: "query_spending", total: "query_spending",
};

/** Any field whose name reads like "the thing being referred to". */
const KEYWORD_ALIASES = [
  "keyword", "targetExpenseName", "targetSpendingName", "targetName",
  "expenseName", "spendingName", "itemName", "target", "name", "item", "note",
];

/** Exposed for tests only. */
export const __normalizeForTest = (raw: any) => normalizeResponse(raw);

/**
 * Turn the old single-intent answer into an operations list.
 *
 * The model is asked for operations, and it will still sometimes answer in the
 * older shape — the examples for tasks and expenses are right there in the same
 * prompt, and a generative model reaches for whichever pattern feels closest.
 * Rejecting those answers would throw away replies that are perfectly correct,
 * so they are translated instead, once, here.
 *
 * The reverse also matters: nothing downstream has to know which shape arrived.
 */
function legacyToOperations(r: any): any[] | null {
  const ops: any[] = [];

  if (r.domain === "task") {
    if (r.intent === "add" && Array.isArray(r.tasks)) {
      for (const task of r.tasks) ops.push({ kind: "create_task", task });
    }
    // The name-based verbs cannot be translated: they address a row by text and
    // the executor addresses it by id. Left alone so the old path still handles
    // them, rather than converted into an operation with no id.
  }

  if (r.domain === "finance") {
    const kw = r.keyword?.trim?.();
    if (r.intent === "log_expense" && typeof r.amount === "number") {
      ops.push({ kind: "log_expense", amount: r.amount, category: r.category, note: r.note });
    } else if (r.intent === "log_income" && typeof r.amount === "number") {
      ops.push({ kind: "log_income", amount: r.amount, source: r.source ?? r.note, date: r.date });
    } else if (r.intent === "edit_expense" && kw) {
      ops.push({ kind: "edit_expense", keyword: kw, amount: r.newAmount ?? r.amount });
    } else if (r.intent === "delete_expense" && kw) {
      ops.push({ kind: "delete_expense", keyword: kw });
    }
  }

  return ops.length ? ops : null;
}

function normalizeResponse(raw: any): any {
  if (!raw || typeof raw !== "object") return raw;
  const r = { ...raw };

  const lower = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : "");

  const d = lower(r.domain);
  if (d && DOMAIN_ALIASES[d]) r.domain = DOMAIN_ALIASES[d];
  else if (d) r.domain = d;

  if (r.domain === "finance") {
    const i = lower(r.intent);
    if (i && FINANCE_INTENT_ALIASES[i]) r.intent = FINANCE_INTENT_ALIASES[i];
    else if (i) r.intent = i;

    // Whichever spelling carried the subject this time, put it where the app
    // reads it. First non-empty wins; `note` is last because on a log_expense
    // it is the description rather than a reference to an existing row.
    if (!r.keyword) {
      for (const alias of KEYWORD_ALIASES) {
        const v = r[alias];
        if (typeof v === "string" && v.trim()) { r.keyword = v.trim(); break; }
      }
    }

    // Same treatment for the new figure.
    if (r.newAmount == null) {
      for (const alias of ["newAmount", "amount", "value", "newValue", "newPrice"]) {
        const v = r[alias];
        if (typeof v === "number" && isFinite(v)) { r.newAmount = v; break; }
      }
    }
  }
  // Only ever an array from here on, so callers stop having to check.
  if (r.operations && !Array.isArray(r.operations)) delete r.operations;
  if (!r.operations) {
    const converted = legacyToOperations(r);
    if (converted) r.operations = converted;
  }
  if (Array.isArray(r.operations)) {
    // Drop anything the executor has no verb for rather than carrying an
    // invented one all the way to a switch statement's default branch.
    r.operations = r.operations.filter(
      (op: any) => op && typeof op === "object" && typeof op.kind === "string",
    );
  }

  return r;
}
async function callGemini(
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

  const base = buildSystemPrompt(options.kind ?? "both");
  const system = options.context ? `${base}\n\nCONTEXT: ${options.context}` : base;

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

    return normalizeResponse(parseModelJson(reply.text)) as GeminiResponse;
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
  /** Which row is meant, for delete_expense and edit_expense. */
  keyword?: string;
  /**
   * The same thing under the name the model keeps inventing.
   *
   * The task schema in this same system prompt calls its equivalent field
   * `targetTaskName`, and Gemini generalises: asked to edit an expense it
   * returns `targetExpenseName` and leaves `keyword` out entirely. Reading only
   * `keyword` meant a perfectly good answer — the row was correctly identified
   * as "ค่าเน็ต" — was thrown away and the user was asked which entry they
   * meant, right after telling us.
   *
   * A prompt cannot be enforced, only requested. So the schema still asks for
   * `keyword` and the reader accepts either.
   */
  targetExpenseName?: string;
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
  source: "gemini" | "local" | "cache";
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
    // THE LOG USED TO ONLY RECORD FAILURES.
    //
    // recordCall lived solely on the Gemini path, so every row in it was, by
    // definition, a message that had already scored below the floor. Reading
    // that log and concluding the confidence score "does not discriminate" is
    // reading a pile of failed exams and concluding the exam measures nothing.
    //
    // Two questions could not be answered at all from it, and both matter more
    // than any individual parsing case:
    //
    //   What fraction escapes? If nine in ten stay local, sharpening the parser
    //   buys almost nothing and the effort belongs elsewhere.
    //
    //   What is CONFIDENTLY WRONG? A message scoring 0.9+ and misread never
    //   reaches a model, never appears here, and nobody finds out. That is the
    //   worst failure this app can have and it was the one thing invisible.
    //
    // Both sides are recorded now, so the log is a measurement rather than a
    // complaints box.
    recordCall({
      text: userMessage,
      domain: (local.response as any)?.domain ?? "?",
      intent: (local.response as any)?.intent ?? "?",
      localConfidence: local.confidence,
      input: 0,
      output: 0,
    });
    return { source: "local", response: local.response };
  }

  // Before spending a request: has this exact sentence already been answered?
  // Only intents whose answer depends on the sentence alone are ever stored,
  // so a cache hit here cannot be stale in a way that matters.
  const cached = cacheLookup(userMessage);
  if (cached) {
    return { source: "cache", response: cached };
  }

  const key = getGeminiKey();
  // navigator.onLine only tells us whether a network adapter exists, so it can
  // say yes on a dead connection. It is worth checking anyway because when it
  // says no, it is right, and we skip an 8 second timeout.
  if (key && navigator.onLine) {
    try {
      const d = local.response.domain;
      // "chat" means the offline parser did not recognise it, which is exactly
      // when the model needs both halves.
      const kind: ContextKind = d === "finance" ? "finance" : d === "task" ? "task" : "both";

      let context = options.context;
      if (!context && options.buildContext) {
        context = await options.buildContext(kind);
      }
      const response = await callGemini(userMessage, { ...options, context, kind });

      // Everything that got out is written down, so next week it is possible to
      // see WHICH sentences keep escaping instead of only how many did.
      recordCall({
        text: userMessage,
        domain: (response as any)?.domain ?? "?",
        intent: (response as any)?.intent ?? "?",
        localConfidence: local.confidence,
        input: lastUsage?.input ?? 0,
        output: lastUsage?.output ?? 0,
      });
      cacheStore(userMessage, response);

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