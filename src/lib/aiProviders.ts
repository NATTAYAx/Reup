// ─── AI providers ─────────────────────────────────────────────────────────────
//
// The app used to talk to Gemini and only Gemini: its URL, its request shape,
// its response shape and its model name were all written straight into the
// service. Anyone holding an OpenAI or Anthropic key could install the app and
// find the assistant simply did not work, with no way to tell why.
//
// The contract is narrow enough that this is not a big abstraction. Every
// provider is handed the same four things — a system prompt, some prior turns,
// one user message, a token ceiling — and has to return the same two: the raw
// text of the reply, and what it charged.
//
// Adding one is writing a single object. Nothing above this file changes.

export type ProviderId = "gemini" | "openai" | "anthropic";

export interface TokenUsage {
  input: number;
  output: number;
}

export interface ProviderTurn {
  role: "user" | "ai";
  text: string;
}

/** An image sent alongside the message, for reading a payment slip. */
export interface ProviderImage {
  /** e.g. "image/jpeg" */
  mime: string;
  /** base64 WITHOUT the data: prefix */
  base64: string;
}

export interface ProviderRequest {
  system: string;
  /** Optional. All three providers accept images, each in its own shape. */
  image?: ProviderImage;
  history: ProviderTurn[];
  message: string;
  maxOutputTokens: number;
  model: string;
  apiKey: string;
  /** Only meaningful for OpenAI-compatible endpoints. */
  baseUrl?: string;
}

export interface ProviderReply {
  /** Raw text. May still be wrapped in a markdown fence; the caller strips it. */
  text: string;
  usage: TokenUsage | null;
}

export interface Provider {
  id: ProviderId;
  label: string;
  defaultModel: string;
  /** Where the user goes to get a key, shown next to the key field. */
  keyUrl: string;
  /** True when the endpoint itself is configurable, which is how one adapter
   *  also covers OpenRouter, Groq, Together, LM Studio and Ollama. */
  configurableBaseUrl: boolean;
  defaultBaseUrl?: string;
  send: (req: ProviderRequest, signal: AbortSignal) => Promise<ProviderReply>;
}

async function readError(res: Response): Promise<string> {
  const body = await res.json().catch(() => ({} as any));
  return (
    (body as any)?.error?.message ??
    (body as any)?.message ??
    res.statusText ??
    `HTTP ${res.status}`
  );
}

// ── Gemini ────────────────────────────────────────────────────────────────────
const gemini: Provider = {
  id: "gemini",
  label: "Google Gemini",
  defaultModel: "gemini-2.5-flash",
  keyUrl: "https://aistudio.google.com/apikey",
  configurableBaseUrl: false,
  async send(req, signal) {
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${req.model}:generateContent?key=${req.apiKey}`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        system_instruction: { parts: [{ text: req.system }] },
        contents: [
          ...req.history.map(t => ({
            role: t.role === "user" ? "user" : "model",
            parts: [{ text: t.text }],
          })),
          {
            role: "user",
            parts: req.image
              ? [
                  { inline_data: { mime_type: req.image.mime, data: req.image.base64 } },
                  { text: req.message },
                ]
              : [{ text: req.message }],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: req.maxOutputTokens,
          responseMimeType: "application/json",
        },
      }),
    });

    if (!res.ok) throw new Error(`AI_ERROR: ${await readError(res)}`);
    const data = await res.json();
    const um = data?.usageMetadata;
    return {
      text: data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "",
      usage: um
        ? { input: um.promptTokenCount ?? 0, output: um.candidatesTokenCount ?? 0 }
        : null,
    };
  },
};

// ── OpenAI-compatible ─────────────────────────────────────────────────────────
// Deliberately the widest adapter. The same wire format is spoken by OpenAI,
// OpenRouter, Groq, Together, DeepSeek, LM Studio and Ollama, so pointing the
// base URL somewhere else is all it takes to run this app against a model on
// the user's own machine, at zero cost and with nothing leaving the device.
const openai: Provider = {
  id: "openai",
  label: "OpenAI-compatible",
  defaultModel: "gpt-4o-mini",
  keyUrl: "https://platform.openai.com/api-keys",
  configurableBaseUrl: true,
  defaultBaseUrl: "https://api.openai.com/v1",
  async send(req, signal) {
    const base = (req.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");

    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${req.apiKey}`,
      },
      signal,
      body: JSON.stringify({
        model: req.model,
        temperature: 0.2,
        max_tokens: req.maxOutputTokens,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: req.system },
          ...req.history.map(t => ({
            role: t.role === "user" ? "user" : "assistant",
            content: t.text,
          })),
          {
            role: "user",
            content: req.image
              ? [
                  { type: "text", text: req.message },
                  {
                    type: "image_url",
                    image_url: { url: `data:${req.image.mime};base64,${req.image.base64}` },
                  },
                ]
              : req.message,
          },
        ],
      }),
    });

    if (!res.ok) throw new Error(`AI_ERROR: ${await readError(res)}`);
    const data = await res.json();
    const u = data?.usage;
    return {
      text: data?.choices?.[0]?.message?.content ?? "",
      usage: u
        ? { input: u.prompt_tokens ?? 0, output: u.completion_tokens ?? 0 }
        : null,
    };
  },
};

// ── Anthropic ─────────────────────────────────────────────────────────────────
const anthropic: Provider = {
  id: "anthropic",
  label: "Anthropic Claude",
  defaultModel: "claude-haiku-4-5-20251001",
  keyUrl: "https://console.anthropic.com/settings/keys",
  configurableBaseUrl: false,
  async send(req, signal) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": req.apiKey,
        "anthropic-version": "2023-06-01",
        // Without this the API refuses requests that carry a browser Origin,
        // and a Tauri webview is a browser as far as it is concerned.
        "anthropic-dangerous-direct-browser-access": "true",
      },
      signal,
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxOutputTokens,
        temperature: 0.2,
        system: req.system,
        messages: [
          ...req.history.map(t => ({
            role: t.role === "user" ? "user" : "assistant",
            content: t.text,
          })),
          {
            role: "user",
            content: req.image
              ? [
                  {
                    type: "image",
                    source: { type: "base64", media_type: req.image.mime, data: req.image.base64 },
                  },
                  { type: "text", text: req.message },
                ]
              : req.message,
          },
        ],
      }),
    });

    if (!res.ok) throw new Error(`AI_ERROR: ${await readError(res)}`);
    const data = await res.json();
    const u = data?.usage;
    const text = Array.isArray(data?.content)
      ? data.content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("")
      : "";
    return {
      text,
      usage: u ? { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0 } : null,
    };
  },
};

export const PROVIDERS: Record<ProviderId, Provider> = { gemini, openai, anthropic };

// ─── Stored settings ──────────────────────────────────────────────────────────
// Keys stay on the device. They are never sent anywhere except the provider the
// user chose, and never bundled into the app: a desktop binary is a file in
// someone else's hands, and any key inside it can be read out of it in minutes.

const K_PROVIDER = "gamesched_ai_provider";
const K_MODEL    = "gamesched_ai_model";
const K_BASEURL  = "gamesched_ai_baseurl";
/** Per-provider so switching back and forth does not lose the other key. */
const keyStoreName = (id: ProviderId) => `gamesched_ai_key_${id}`;
/** The original single-provider key, migrated on first read. */
const LEGACY_GEMINI_KEY = "gamesched_gemini_key";

export function getProviderId(): ProviderId {
  const v = localStorage.getItem(K_PROVIDER);
  return v === "openai" || v === "anthropic" ? v : "gemini";
}
export function setProviderId(id: ProviderId) {
  localStorage.setItem(K_PROVIDER, id);
}

export function getApiKey(id: ProviderId = getProviderId()): string {
  const stored = localStorage.getItem(keyStoreName(id));
  if (stored) return stored;
  if (id === "gemini") {
    const legacy = localStorage.getItem(LEGACY_GEMINI_KEY);
    if (legacy) {
      localStorage.setItem(keyStoreName("gemini"), legacy);
      return legacy;
    }
  }
  return "";
}
export function setApiKey(key: string, id: ProviderId = getProviderId()) {
  localStorage.setItem(keyStoreName(id), key.trim());
  if (id === "gemini") localStorage.setItem(LEGACY_GEMINI_KEY, key.trim());
}

export function getModel(id: ProviderId = getProviderId()): string {
  return localStorage.getItem(K_MODEL) || PROVIDERS[id].defaultModel;
}
export function setModel(model: string) {
  localStorage.setItem(K_MODEL, model.trim());
}

export function getBaseUrl(id: ProviderId = getProviderId()): string {
  return localStorage.getItem(K_BASEURL) || PROVIDERS[id].defaultBaseUrl || "";
}
export function setBaseUrl(url: string) {
  localStorage.setItem(K_BASEURL, url.trim());
}

// ─── Daily budget ─────────────────────────────────────────────────────────────
// A ceiling that exists whether the provider bills by request or by token, so
// a runaway loop or a long afternoon of chatting cannot quietly turn into a
// bill. It is also the only honest way to answer "how much is this costing me":
// the counter is the real number the provider reported, not an estimate.

const K_BUDGET = "gamesched_ai_budget_v1";

export interface DailyUsage {
  date: string;      // YYYY-MM-DD, local
  requests: number;
  input: number;
  output: number;
}

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function getUsageToday(): DailyUsage {
  const blank: DailyUsage = { date: todayKey(), requests: 0, input: 0, output: 0 };
  try {
    const raw = localStorage.getItem(K_BUDGET);
    if (!raw) return blank;
    const parsed = JSON.parse(raw) as DailyUsage;
    return parsed.date === blank.date ? parsed : blank; // a new day starts clean
  } catch {
    return blank;
  }
}

export function recordUsage(usage: TokenUsage | null) {
  const cur = getUsageToday();
  const next: DailyUsage = {
    date: cur.date,
    requests: cur.requests + 1,
    input: cur.input + (usage?.input ?? 0),
    output: cur.output + (usage?.output ?? 0),
  };
  try { localStorage.setItem(K_BUDGET, JSON.stringify(next)); } catch { /* full */ }
}

const K_MAX_REQ = "gamesched_ai_max_requests";

/** 0 means no ceiling. */
export function getDailyRequestCap(): number {
  const n = parseInt(localStorage.getItem(K_MAX_REQ) ?? "0", 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
export function setDailyRequestCap(n: number) {
  localStorage.setItem(K_MAX_REQ, String(Math.max(0, Math.floor(n))));
}

export function isOverDailyCap(): boolean {
  const cap = getDailyRequestCap();
  return cap > 0 && getUsageToday().requests >= cap;
}