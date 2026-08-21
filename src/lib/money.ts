// ─── money.ts — the one place that knows what a number means ──────────────────
//
// Before this file, "฿" was written into the app fourteen different times: twice
// as a fmt() helper (in FinanceView and UnifiedAIChat, formatted DIFFERENTLY —
// one truncated decimals and the other did not), five times as a bare character
// in JSX, four times inside translated placeholder text like "Amount (฿) *", and
// the rest inside strings the assistant builds. Fourteen spellings of one fact,
// none of them findable by searching for the others.
//
// ── Why a stored row carries its own currency ─────────────────────────────────
//
// The setting below changes what NEW entries are recorded in. It does not, and
// must not, change anything already saved.
//
// Converting stored rows is the obvious feature and it is wrong in four separate
// ways. A conversion needs a rate, and a rate has a date, so a March expense
// converted at today's rate is a different number every month — a record that
// changes its answer depending on when it is read is not a record. The receipt
// in your hand says 1,200 baht; if the app says ¥5,340 nothing can be checked
// against anything. Rounding is lossy and one-way, so a "convert my history"
// button quietly destroys the original. And a rate has to be fetched, which
// means an app that cannot show last month's spending on a plane.
//
// So: amount and currency are stored together and are immutable. Conversion, if
// it is ever built, is a VIEW — computed on demand, labelled with its rate and
// date, never written back.
//
// ── Why this does not follow the system, when the timezone does ───────────────
//
// tz.ts can store the word "system" and mean "whatever this machine says", so
// carrying the laptop to Tokyo moves the app without anyone editing a setting.
// That is right for time and wrong for money. Currency is not a fact about where
// the computer is, it is a fact about what is in your wallet. If it followed the
// machine, the day Windows resets its region every new expense would start being
// recorded in a different unit with nobody having touched anything.
//
// So the system is asked ONCE, on first run, and the answer is then stored as a
// literal. Two settings that look identical in the UI, deliberately opposite
// underneath.

import { getLang } from "./i18n";
import { putSetting } from "./userSettings";
import { CURRENCY_FALLBACK } from "./moneyDraft";
import { onDataChanged } from "./dataChanged";

const CURRENCY_KEY = "gamesched_currency";
// Shared with the phone rather than declared here, because "what to count in
// when nothing has said otherwise" is a question both devices answer and two
// copies of the answer could disagree without anything failing. See moneyDraft.
const FALLBACK = CURRENCY_FALLBACK;

/**
 * The ones worth putting in a list. Any valid ISO 4217 code works — this is the
 * shortlist that gets shown, not a whitelist that gets enforced, because a
 * currency missing from a hardcoded list is a person who cannot use the app.
 */
export const COMMON_CURRENCIES: { code: string; name: string; region?: string }[] = [
  { code: "THB", name: "Thai baht", region: "TH" },
  { code: "USD", name: "US dollar", region: "US" },
  { code: "EUR", name: "Euro", region: "EU" },
  { code: "GBP", name: "Pound sterling", region: "GB" },
  { code: "JPY", name: "Japanese yen", region: "JP" },
  { code: "CNY", name: "Chinese yuan", region: "CN" },
  { code: "KRW", name: "South Korean won", region: "KR" },
  { code: "TWD", name: "New Taiwan dollar", region: "TW" },
  { code: "HKD", name: "Hong Kong dollar", region: "HK" },
  { code: "SGD", name: "Singapore dollar", region: "SG" },
  { code: "MYR", name: "Malaysian ringgit", region: "MY" },
  { code: "IDR", name: "Indonesian rupiah", region: "ID" },
  { code: "PHP", name: "Philippine peso", region: "PH" },
  { code: "VND", name: "Vietnamese dong", region: "VN" },
  { code: "INR", name: "Indian rupee", region: "IN" },
  { code: "AUD", name: "Australian dollar", region: "AU" },
  { code: "NZD", name: "New Zealand dollar", region: "NZ" },
  { code: "CAD", name: "Canadian dollar", region: "CA" },
  { code: "CHF", name: "Swiss franc", region: "CH" },
  { code: "SEK", name: "Swedish krona", region: "SE" },
  { code: "NOK", name: "Norwegian krone", region: "NO" },
  { code: "DKK", name: "Danish krone", region: "DK" },
  { code: "PLN", name: "Polish złoty", region: "PL" },
  { code: "CZK", name: "Czech koruna", region: "CZ" },
  { code: "TRY", name: "Turkish lira", region: "TR" },
  { code: "RUB", name: "Russian ruble", region: "RU" },
  { code: "BRL", name: "Brazilian real", region: "BR" },
  { code: "MXN", name: "Mexican peso", region: "MX" },
  { code: "ARS", name: "Argentine peso", region: "AR" },
  { code: "ZAR", name: "South African rand", region: "ZA" },
  { code: "NGN", name: "Nigerian naira", region: "NG" },
  { code: "KES", name: "Kenyan shilling", region: "KE" },
  { code: "EGP", name: "Egyptian pound", region: "EG" },
  { code: "AED", name: "UAE dirham", region: "AE" },
  { code: "SAR", name: "Saudi riyal", region: "SA" },
  { code: "ILS", name: "Israeli shekel", region: "IL" },
  { code: "PKR", name: "Pakistani rupee", region: "PK" },
  { code: "BDT", name: "Bangladeshi taka", region: "BD" },
  { code: "LKR", name: "Sri Lankan rupee", region: "LK" },
  { code: "MMK", name: "Myanmar kyat", region: "MM" },
  { code: "KHR", name: "Cambodian riel", region: "KH" },
  { code: "LAK", name: "Lao kip", region: "LA" },
];

/**
 * The human name for a code, or the code itself.
 *
 * Three-letter codes are unscannable in a list: MYR, MMK and MXN are the same
 * shape and differ by one letter in the middle. Whatever shows a currency to
 * choose from has to show this beside it, so it lives here rather than being
 * looked up inline in each of them.
 */
export function currencyName(code: string): string {
  return COMMON_CURRENCIES.find(c => c.code === code)?.name ?? code;
}

/**
 * Real ISO 4217, not merely three letters.
 *
 * Intl.NumberFormat accepts any well-formed code and happily formats "XYZ", so
 * a constructor that does not throw proves nothing. Intl.supportedValuesOf is
 * the actual list and is present in every Chromium since 99, which is well
 * below anything WebView2 ships. The older check stays as a fallback so a
 * runtime without it degrades to permissive rather than to broken.
 */
let _known: Set<string> | null | undefined;
export function isValidCurrency(code: string): boolean {
  if (!/^[A-Z]{3}$/.test(code)) return false;
  if (_known === undefined) {
    try {
      _known = new Set((Intl as any).supportedValuesOf("currency") as string[]);
    } catch {
      _known = null;
    }
  }
  if (_known) return _known.has(code);
  try {
    new Intl.NumberFormat("en", { style: "currency", currency: code });
    return true;
  } catch {
    return false;
  }
}

/**
 * A first guess from the operating system, used once and then never again.
 *
 * Intl has no "what currency is this machine" question, so the region is read
 * off the locale and looked up. A miss falls back to baht rather than to
 * nothing, because a wrong default that is one tap from right beats an empty
 * setting that blocks the first expense.
 */
/** Where the machine physically is, which is a better question than what
 *  language it is set to. Asia/Bangkok is Thailand whether Windows is running
 *  in Thai or in English. */
const TZ_REGION: Record<string, string> = {
  Bangkok: "TH", Tokyo: "JP", Seoul: "KR", Taipei: "TW", Shanghai: "CN",
  Chongqing: "CN", Urumqi: "CN", Hong_Kong: "HK", Macau: "HK", Singapore: "SG",
  Kuala_Lumpur: "MY", Kuching: "MY", Jakarta: "ID", Makassar: "ID", Jayapura: "ID",
  Pontianak: "ID", Manila: "PH", Ho_Chi_Minh: "VN", Saigon: "VN", Phnom_Penh: "KH",
  Vientiane: "LA", Yangon: "MM", Kolkata: "IN", Calcutta: "IN", Colombo: "LK",
  Dhaka: "BD", Karachi: "PK", Dubai: "AE", Riyadh: "SA", Jerusalem: "IL",
  Tel_Aviv: "IL", Istanbul: "TR", Moscow: "RU", Cairo: "EG", Lagos: "NG",
  Nairobi: "KE", Johannesburg: "ZA", London: "GB", Dublin: "IE", Zurich: "CH",
  Stockholm: "SE", Oslo: "NO", Copenhagen: "DK", Warsaw: "PL", Prague: "CZ",
  Sydney: "AU", Melbourne: "AU", Brisbane: "AU", Perth: "AU", Auckland: "NZ",
  Toronto: "CA", Vancouver: "CA", Montreal: "CA", Mexico_City: "MX",
  Sao_Paulo: "BR", Buenos_Aires: "AR",
};

/**
 * A first guess from the machine, used once and then never again.
 *
 * The timezone is asked FIRST and the locale only after. Reading the locale
 * alone gets this wrong for a very ordinary person: a developer in Thailand
 * running Windows in English resolves to en-US, so the app opened in dollars
 * and every figure on screen wore a $ until they found the setting. Where the
 * computer is answers "what is in the wallet" far better than what language it
 * displays menus in.
 *
 * A miss falls back to baht rather than to nothing, because a wrong default one
 * tap from right beats an empty setting that blocks the first expense.
 */
export function systemCurrencyGuess(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const city = zone?.split("/").pop();
    const region = city ? TZ_REGION[city] : undefined;
    if (region) {
      const hit = COMMON_CURRENCIES.find(c => c.region === region);
      if (hit) return hit.code;
    }
  } catch { /* no Intl.DateTimeFormat, which would be remarkable */ }
  try {
    const loc = new Intl.Locale(Intl.DateTimeFormat().resolvedOptions().locale);
    const region = (loc as any).region as string | undefined;
    if (region) {
      const hit = COMMON_CURRENCIES.find(c => c.region === region);
      if (hit) return hit.code;
    }
  } catch { /* old runtime, no Intl.Locale */ }
  return FALLBACK;
}

let _currency: string | null = null;

// The one memo in this file, and therefore the one thing a setting arriving
// from another device would not have reached. getQuietHours and getLang both
// read the cache on every call, so they need nothing; this one would have kept
// showing the currency this machine guessed from its locale on first run, for
// as long as the window stayed open, while every number under it was already
// being filtered by the one that arrived.
onDataChanged((tables) => {
  if (tables.has("user_settings")) _currency = null;
});

export function getCurrency(): string {
  if (_currency) return _currency;
  try {
    const stored = localStorage.getItem(CURRENCY_KEY);
    if (stored && isValidCurrency(stored)) return (_currency = stored);
    // First run. Guess once, then WRITE IT DOWN, so that the answer stops
    // depending on the machine from this moment on.
    const guess = systemCurrencyGuess();
    localStorage.setItem(CURRENCY_KEY, guess);
    return (_currency = guess);
  } catch {
    return (_currency = FALLBACK);
  }
}

export function setCurrency(code: string): void {
  if (!isValidCurrency(code)) return;
  _currency = code;
  // Through the mirror rather than straight to localStorage, so the other
  // device hears about it. See userSettings.ts.
  putSetting(CURRENCY_KEY, code);
}

function localeTag(): string {
  return getLang() === "th" ? "th-TH" : "en-US";
}

// Building an Intl.NumberFormat costs far more than using one, and these are
// called once per row in a list that scrolls. Cached per currency, same as the
// offset cache in tz.ts.
const _fmtCache = new Map<string, Intl.NumberFormat>();

function formatter(currency: string): Intl.NumberFormat {
  const key = localeTag() + "|" + currency;
  let f = _fmtCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(localeTag(), {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
      // A whole number shows no decimals and 2,761.78 shows both, rather than
      // forcing ".00" onto every row in a dense list or truncating the 78
      // satang off a scanned slip. The old FinanceView helper did the second of
      // those and the chat helper did neither, so the same expense was written
      // two ways on two screens.
      minimumFractionDigits: 0,
    });
    _fmtCache.set(key, f);
  }
  return f;
}

/**
 * The only way money should ever be turned into text.
 *
 * Intl knows what a hand-rolled template string cannot: yen and won have no
 * decimal places while dinars have three, the Swedish krona is written after
 * the number and the euro after it with a space in French, and Indian grouping
 * is 1,23,456 rather than 123,456.
 */
export function formatMoney(amount: number, currency?: string): string {
  const code = currency || getCurrency();
  try {
    return formatter(code).format(amount);
  } catch {
    return `${code} ${amount.toLocaleString()}`;
  }
}

/**
 * Just the symbol, for the places where it sits OUTSIDE a number input.
 *
 * Those are not decoration: putting the symbol inside the field would mean a
 * `<input type="number">` whose value is not a number, which silently clears
 * itself. Some currencies have no symbol of their own and Intl returns the code
 * — which is the right answer, not a failure.
 */
export function currencySymbol(currency?: string): string {
  const code = currency || getCurrency();
  try {
    const part = formatter(code).formatToParts(0).find(p => p.type === "currency");
    return part?.value ?? code;
  } catch {
    return code;
  }
}

/** How many decimal places this currency actually has. */
export function currencyDigits(currency?: string): number {
  const code = currency || getCurrency();
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: code })
      .resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/**
 * Totals for rows that may not share a currency.
 *
 * Adding ฿1,200 to ¥5,340 produces a number that is true of nothing. Two honest
 * totals side by side — "฿12,340 · ¥28,600" — say strictly more than one
 * invented one, and in the ordinary case where everything is in one currency it
 * renders exactly as a single total did before.
 *
 * The realistic case for this is not emigration, it is a two-week trip.
 */
export function sumByCurrency(
  rows: { amount: number; currency?: string | null }[],
): Map<string, number> {
  const out = new Map<string, number>();
  const fallback = getCurrency();
  for (const r of rows) {
    const code = r.currency || fallback;
    out.set(code, (out.get(code) ?? 0) + r.amount);
  }
  return out;
}

/** The same map rendered, largest first so the currency you mostly live in leads. */
export function formatTotals(totals: Map<string, number>): string {
  if (totals.size === 0) return formatMoney(0);
  return [...totals.entries()]
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .map(([code, sum]) => formatMoney(sum, code))
    .join(" · ");
}