// ─── What the app remembers so it does not have to ask again ──────────────────
//
// A daily-request cap is a brake, not a design. The design question is why a
// request happens at all, and the honest answer for most of them is that the
// app forgets everything the moment a reply arrives. Typing the same sentence
// about the same game next week costs exactly what it cost the first time.
//
// So the goal here is not to send smaller requests. It is for the number of
// requests to FALL AS THE APP IS USED, and to keep falling, until the only
// things that still leave the machine are the ones that genuinely could not be
// answered locally.
//
// Four pieces, all device-local, none of it ever leaves:
//
//   1. TELEMETRY   what actually escaped, so improvements can be aimed rather
//                  than guessed at. This is first on purpose: nothing else here
//                  can be judged without it.
//   2. CACHE       the same sentence twice is one answer, not two. Only for
//                  intents whose answer depends on the sentence alone.
//   3. PRESETS     confirmed once, known forever. This is the piece that
//                  generalises, because it matches the SUBJECT rather than the
//                  wording, so a game learned from one phrasing is recognised in
//                  every later phrasing too.
//   4. MERCHANTS   a shop categorised once stays categorised.

const K_LOG      = "gamesched_ai_log_v1";
const K_CACHE    = "gamesched_ai_cache_v1";
const K_PRESETS  = "gamesched_ai_presets_v1";
const K_MERCHANT = "gamesched_ai_merchants_v1";

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota */ }
}

/** Whitespace and case only. Digits are left alone: "กาแฟ 60" and "กาแฟ 70"
 *  are different sentences and must never share an answer. */
export function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

// ─── 1. Telemetry ─────────────────────────────────────────────────────────────

export interface CallRecord {
  at: number;
  text: string;
  domain: string;
  intent: string;
  /** What the offline parser scored it before giving up. */
  localConfidence: number;
  input: number;
  output: number;
}

const LOG_LIMIT = 300;

export function recordCall(rec: Omit<CallRecord, "at">) {
  const log = read<CallRecord[]>(K_LOG, []);
  log.push({ ...rec, at: Date.now() });
  write(K_LOG, log.slice(-LOG_LIMIT));
}

export function getCallLog(): CallRecord[] {
  return read<CallRecord[]>(K_LOG, []);
}

export function clearCallLog() {
  write(K_LOG, []);
}

export interface EscapeSummary {
  /** Shape of the sentence with numbers blanked, so near-identical phrasings
   *  group together and a real pattern becomes visible. */
  pattern: string;
  count: number;
  tokens: number;
  example: string;
  domain: string;
  intent: string;
}

/** Which kinds of sentence keep escaping to the model, heaviest first. Reading
 *  this is how you decide what to teach the offline parser next. */
export function summariseEscapes(days = 7): EscapeSummary[] {
  const since = Date.now() - days * 86400_000;
  const groups = new Map<string, EscapeSummary>();

  for (const r of getCallLog()) {
    if (r.at < since) continue;
    const pattern = normalize(r.text).replace(/\d+/g, "#");
    const g = groups.get(pattern);
    if (g) {
      g.count += 1;
      g.tokens += r.input + r.output;
    } else {
      groups.set(pattern, {
        pattern, count: 1, tokens: r.input + r.output,
        example: r.text, domain: r.domain, intent: r.intent,
      });
    }
  }
  return [...groups.values()].sort((a, b) => b.tokens - a.tokens);
}

// ─── 2. Response cache ────────────────────────────────────────────────────────

// Only intents whose answer is a pure function of the sentence. A delete depends
// on which tasks exist right now, and a spending question depends on the
// database, so both must never be served from a cache — a stale answer there is
// worse than a slow one.
const CACHEABLE = new Set(["add", "log_expense", "log_income"]);

interface CacheEntry { at: number; hits: number; response: any }

const CACHE_LIMIT = 200;
const CACHE_TTL_MS = 30 * 86400_000;

export function isCacheable(domain: string, intent: string): boolean {
  if (domain !== "task" && domain !== "finance") return false;
  return CACHEABLE.has(intent);
}

export function cacheLookup(text: string): any | null {
  const store = read<Record<string, CacheEntry>>(K_CACHE, {});
  const hit = store[normalize(text)];
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) return null;
  hit.hits += 1;
  write(K_CACHE, store);
  return hit.response;
}

export function cacheStore(text: string, response: any) {
  if (!isCacheable(response?.domain, response?.intent)) return;
  const store = read<Record<string, CacheEntry>>(K_CACHE, {});
  store[normalize(text)] = { at: Date.now(), hits: 0, response };

  // Oldest out first when it grows past the limit.
  const keys = Object.keys(store);
  if (keys.length > CACHE_LIMIT) {
    keys
      .sort((a, b) => store[a].at - store[b].at)
      .slice(0, keys.length - CACHE_LIMIT)
      .forEach(k => delete store[k]);
  }
  write(K_CACHE, store);
}

export function cacheSize(): number {
  return Object.keys(read<Record<string, CacheEntry>>(K_CACHE, {})).length;
}

// ─── 3. Learned presets ───────────────────────────────────────────────────────
//
// The piece that actually bends the curve. A literal cache only helps when the
// exact same sentence is typed again, which is rare. This keys on the SUBJECT,
// so once "Wuthering Waves" has been confirmed as a 04:00 daily, every later
// phrasing — with or without the time, in Thai or English — is recognised
// offline and never reaches the model again.

export interface LearnedPreset {
  key: string;              // lowercase phrase to match inside the input
  task: Record<string, any>;
  learnedAt: number;
  uses: number;
}

/** Strip the words people append to a game name so the key matches the bare
 *  subject. "Wuthering Waves Daily" keyed as "wuthering waves daily" would
 *  never match someone typing "Wuthering Waves รีเซ็ตตีสี่". */
function presetKeyFrom(name: string): string | null {
  const key = name
    .toLowerCase()
    .replace(/\b(daily|weekly|monthly|reset|quests?|missions?|boss)\b/g, "")
    .replace(/(รายวัน|รายสัปดาห์|รีเซ็ต|เควส|ภารกิจ|บอส)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // Too short and it starts matching inside unrelated words.
  return key.length >= 4 ? key : null;
}

export function learnPreset(task: Record<string, any>) {
  if (!task?.name) return;
  const key = presetKeyFrom(String(task.name));
  if (!key) return;

  const all = read<LearnedPreset[]>(K_PRESETS, []);
  const existing = all.find(p => p.key === key);
  if (existing) {
    existing.task = task;
    existing.uses += 1;
    existing.learnedAt = Date.now();
  } else {
    all.push({ key, task, learnedAt: Date.now(), uses: 1 });
  }
  write(K_PRESETS, all.slice(-100));
}

export function getLearnedPresets(): LearnedPreset[] {
  return read<LearnedPreset[]>(K_PRESETS, []);
}

export function forgetPreset(key: string) {
  write(K_PRESETS, getLearnedPresets().filter(p => p.key !== key));
}

/** Longest key wins, so "genshin impact" beats a stray "genshin". */
export function matchLearnedPreset(input: string): LearnedPreset | null {
  const lower = normalize(input);
  let best: LearnedPreset | null = null;
  for (const p of getLearnedPresets()) {
    if (lower.includes(p.key) && (!best || p.key.length > best.key.length)) best = p;
  }
  return best;
}

// ─── 4. Merchant memory ───────────────────────────────────────────────────────
//
// Slips cannot be cached — every image is different. But the model does not
// need to be asked which category "7-Eleven" belongs to more than once.

export function learnMerchant(merchant: string, categoryKey: string) {
  if (!merchant || !categoryKey) return;
  const store = read<Record<string, string>>(K_MERCHANT, {});
  store[normalize(merchant)] = categoryKey;
  write(K_MERCHANT, store);
}

export function recallMerchant(merchant: string): string | null {
  if (!merchant) return null;
  const store = read<Record<string, string>>(K_MERCHANT, {});
  const exact = store[normalize(merchant)];
  if (exact) return exact;
  // Slips rarely print a shop name identically twice, so a contained match
  // counts: "7-ELEVEN สาขาสันทราย" should still find "7-eleven".
  const needle = normalize(merchant);
  for (const [name, cat] of Object.entries(store)) {
    if (needle.includes(name) || name.includes(needle)) return cat;
  }
  return null;
}

export function merchantCount(): number {
  return Object.keys(read<Record<string, string>>(K_MERCHANT, {})).length;
}