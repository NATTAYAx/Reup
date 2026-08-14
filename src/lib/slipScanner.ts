// ─── Reading money out of a picture ───────────────────────────────────────────
//
// This started as "read a bank slip" and that framing was too narrow in two
// ways that only showed up once real images were tried:
//
//   1. EVERY BANK PRINTS A DIFFERENT SLIP. K PLUS writes a two-digit Buddhist
//      year ("23 ก.ค. 69") and one reference. Krungthai writes a four-digit one
//      ("01 ก.ค. 2569") and THREE references, and puts commas in the amount.
//      Writing a rule per bank is a losing game, so nothing here is
//      bank-specific: the prompt describes the SHAPES these fields take and
//      lets the model match them.
//
//   2. NOT EVERY PICTURE IS A SLIP. A Shopee installment list is a screenshot
//      with eight purchases on it and no reference numbers anywhere. That is a
//      perfectly reasonable thing to want to record, and a reader that returns
//      one transaction cannot express it.
//
// So this returns a LIST. A slip yields one item, a list screenshot yields as
// many as it shows, and the caller decides which to keep. One request either
// way, which is also the cheapest way to enter eight purchases.
//
// The image is never stored. A slip carries an account number and a full name,
// and neither belongs in a database that will one day sync to a phone. The
// reference number is worth keeping: short, opaque, and it is what makes the
// same slip impossible to record twice.
//
//   3. IT WAS ONLY EVER GOING TO WORK IN ONE COUNTRY. The reading was never the
//      Thai part — the model reads Japanese, German and Arabic receipts without
//      being asked. What was Thai was the code AFTER the reading, which assumed
//      the answer had come from Thailand: it subtracted 543 from any year over
//      2400, expanded any two-digit year to 25xx, and stripped commas out of
//      every amount. So "1.234,56" on a German receipt was saved as 1.23 —
//      wrong by a factor of a thousand, with no error, no log line, and nothing
//      on screen to notice.
//
// The rule that came out of that: THE MODEL INTERPRETS, THIS FILE VALIDATES.
// Interpreting needs to know which country the paper came from, which JS has no
// way to know and the model can see. So the model is asked for canonical values
// and this file only checks that what came back has a plausible shape, refusing
// anything it cannot verify rather than guessing at it.

import { todayLocal } from "./dateUtil";
import { isValidCurrency } from "./money";
import { isTransient } from "./aiProviders";
import {
  PROVIDERS, getProviderId, getApiKey, getModel, getBaseUrl,
  isOverDailyCap, recordUsage, type TokenUsage,
} from "./aiProviders";

export interface ScannedItem {
  /** Always positive. Which way the money went is `direction`, not a sign. */
  amount: number | null;
  /**
   * ISO 4217 as printed on the image, which may not be the app's own currency —
   * the whole point of scanning a receipt from a trip.
   *
   * The ordering the prompt asks for is worth restating here, because getting
   * it backwards is subtle and the result is silent. WHAT IS PRINTED WINS. The
   * country only narrows an ambiguous symbol among the currencies that symbol
   * can mean; it never overrules one. An earlier version of the rule said to
   * prefer the bank and country over the symbol, which reads sensibly and turns
   * a Krungthai slip showing "$10000.00" into ten thousand baht — the model
   * followed the instruction exactly and the instruction was wrong.
   *
   * Null when nothing settles it, which is a real answer and not a failure.
   */
  currency: string | null;
  /** YYYY-MM-DD, Gregorian, whatever calendar the image was printed in. */
  date: string | null;
  /** Shop, biller or item description — whatever names the spending. */
  merchant: string | null;
  /** Bank reference when the image has one. Lists usually do not. */
  reference: string | null;
  /** One of the user's own category keys. */
  category: string | null;
  /**
   * Which way the money moved.
   *
   * Every wallet history on earth — Alipay, GCash, PayPay, Venmo, M-Pesa, a
   * bank statement — mixes money received with money spent in one list. Without
   * this field every row became an expense, so scanning a month of transfers
   * filed the money friends paid back as spending. Refunds and chargebacks are
   * "in" too, and used to be dropped silently by a `> 0` test.
   */
  direction: "out" | "in";
  /**
   * "bill_due" is a claim about the FUTURE and the only kind here that is not
   * evidence of anything. An unpaid electricity bill says ฿1,240 is owed on the
   * 25th; recording that as spending today is simply false. This app has a
   * better home for it than a finance app would — a task with a due date — so
   * the distinction is worth carrying rather than flattening.
   */
  kind: "payment" | "transfer" | "topup" | "bill_due" | null;
}

export interface ScanResult {
  items: ScannedItem[];
  /** True when the reply was cut short and only the complete rows were kept,
   *  so the caller can say that some rows may be missing. */
  truncated: boolean;
  /** What sort of image this turned out to be, for the wording of the summary. */
  source: "slip" | "list" | "unknown";
  usage: TokenUsage | null;
}

const MAX_EDGE = 1400;

/** Last raw model reply, so a failure can be explained instead of shrugged at.
 *  Never persisted. */
let lastRawReply = "";
export function getLastRawReply(): string {
  return lastRawReply;
}

/**
 * Downscale before sending. Images are the most expensive thing that can go in
 * a request — an untouched phone photo is roughly twelve times the tokens of
 * this — and slips are large text on a plain background, so detail beyond this
 * buys nothing. A list screenshot needs more height than a slip, hence 1400
 * rather than the 1000 a single slip would manage with.
 */
export async function prepareImage(file: File): Promise<{ mime: string; base64: string }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is unavailable");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
  return { mime: "image/jpeg", base64: dataUrl.slice(dataUrl.indexOf(",") + 1) };
}

// Written against real images: a K PLUS slip, a Krungthai bill payment and a
// Shopee installment list. Each rule below exists because one of them broke the
// obvious version of it. The Thai specifics are kept — they are still true and
// still useful — but they are now examples of a shape rather than the only
// shape there is.
//
// TWO THINGS LEARNED THE HARD WAY ABOUT EDITING THIS PROMPT.
//
// The skeleton is the contract. Sections describing "currency" and "direction"
// were added below while the JSON block above still listed six fields, so the
// model was handed a shape with six slots and prose demanding eight. In a
// response-format-json request that does not fail cleanly; it stalls, pads, or
// answers something that will not parse, and the app reports a timeout. Adding
// a rule means editing the skeleton in the same commit, every time.
//
// And length is not free. The same edit took this from 3,700 characters to
// 7,000 — sent on every scan, paid for in tokens and in latency, for rules
// mostly about countries this user will never buy anything in. Rewritten to
// cover more while being shorter than it started. Terse survives; verbose
// quietly makes every scan slower.
const SYSTEM = `
You extract financial transactions from an image: a transfer slip, a receipt, a
bill, a shopping order list, a wallet history or a statement screenshot.

Reply with ONE JSON object and nothing else. No markdown fences. EVERY field
listed here must appear on EVERY item.

{
  "source": "slip" | "list" | "unknown",
  "items": [
    {
      "amount": number or null,
      "currency": "ISO 4217 code" or null,
      "date": "YYYY-MM-DD" or null,
      "direction": "out" | "in",
      "merchant": string or null,
      "reference": string or null,
      "category": string or null,
      "kind": "payment" | "transfer" | "topup" | "bill_due" | null
    }
  ]
}

HOW MANY ITEMS
- A slip or receipt: exactly one. A list: one per visible row, not merged, not
  summarised, and none invented for a row cut off at the edge.
- Keep "merchant" under about 40 characters. A long list otherwise runs past the
  reply limit and gets cut mid-word, which makes none of it readable.

AMOUNT — a plain JSON number. Never a string, never a symbol, never a grouping
mark, always a dot for decimals. Convert non-Western digits (٤٥٦, ๔๕๖).
- YOU do the conversion. "2,761.78", "1.234,56", "1'234.56" and "1,23,456.78"
  are all printed by real banks and mean different things, and only you can see
  which country printed this one.
- Take what LEFT THE ACCOUNT: on a transfer, excluding any separately listed fee
  (ค่าธรรมเนียม, Fee, 手数料); on a shop receipt, the grand total including tax and
  service charge, never the subtotal and never a per-item line.
- On a statement take the transaction column, NEVER the running balance.
- A card payment abroad shows two amounts. Take the one charged to the account.
- Smudged, cropped or ambiguous: null. A wrong number that looks right is worse
  than a blank someone fills in.

CURRENCY — ISO 4217 uppercase, in this order:
1. A code printed on the image ("USD", "THB") is the answer. Nothing overrides it.
2. A symbol that can only mean one currency — ฿ € ₩ ₹ ₺ ₫ ₱ — is the answer.
3. An ambiguous symbol — $ ¥ kr £ R P — is narrowed using the language, bank and
   country, BUT ONLY AMONG THE CURRENCIES THAT SYMBOL CAN MEAN. A Thai bank
   printing "$" is some dollar, most likely USD. It is never THB, because baht
   is not written "$". The country picks between candidates; it never overrules
   what is printed.
4. Nothing printed at all: the country's own currency.
5. Still unsettled: null.

DIRECTION — "out" when money left the account, "in" when it arrived. Purchases,
bills and sent transfers are out. Refunds, reversals, salary, received transfers
and negative statement rows are in. The amount stays POSITIVE either way. A
leading "+" in a shopping app is that app's styling, not income: still "out".

DATE — "YYYY-MM-DD", GREGORIAN, converted by you from any calendar.
- Buddhist: subtract 543, whether written "2569" or "69".
- Taiwan: add 1911, so "115" is 2026. Japanese: 令和8 or R8 is 2026. Hijri:
  convert to the Gregorian day it falls on.
- A year already written as 2026 is Gregorian. Leave it alone.
- Thai months: ม.ค.=01 ก.พ.=02 มี.ค.=03 เม.ย.=04 พ.ค.=05 มิ.ย.=06 ก.ค.=07
  ส.ค.=08 ก.ย.=09 ต.ค.=10 พ.ย.=11 ธ.ค.=12. Month names in any language likewise.
- "03/04/2026" is day-first nearly everywhere and month-first in the United
  States. Let the language on the image decide.
- A relative word — "today", "วันนี้", "yesterday" — resolves against the date
  given in the user message.
- On a list, each row carries its own date.

MERCHANT — the receiving side, or the thing bought. Never the sender: that is
the person holding the phone.

REFERENCE — เลขที่รายการ, รหัสอ้างอิง, Reference No, Transaction ID. If there are
several, the longest. Lists usually have none, so use null rather than inventing
one: this is what detects a slip recorded twice.

KIND
- "bill_due": an invoice or unpaid bill, showing an amount due and a due date
  with no confirmation, reference or paid stamp. Not a record of spending.
- "topup": money moved into the sender's own wallet. Nothing bought yet.
- "transfer": person to person. "payment": a purchase or a bill already paid.

Any field not legible: null. Never guess a number. Categories only from the list
in the user message, and null when none fits.
`.trim();

/**
 * A last line of defence, not a converter. The model is told to hand back a
 * Gregorian date; this checks that it did, and rejects anything it cannot
 * confirm — "2569-07-23" is perfectly well-formed and 543 years wrong, and it
 * would otherwise sail straight into the form.
 *
 * A TWO-DIGIT YEAR IS THE INTERESTING CASE. It used to be expanded to 25xx and
 * then have 543 subtracted, which is correct in Thailand and nowhere else: "69"
 * on a Thai slip is 2026, but "26" on the receipts most of the world prints is
 * also 2026, and the old rule turned it into 1983 and threw the row away.
 *
 * So both readings are tried and the one that lands in the plausible window
 * wins. No rule about which country the paper came from is needed, because only
 * one of the two answers can be a date within a few months of today.
 */
function normaliseDate(raw: unknown, now = new Date()): string | null {
  if (typeof raw !== "string") return null;
  const m = /^(\d{1,4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!m) return null;

  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const raw_y = Number(m[1]);
  // A record of something that already happened, entered soon after. Outside
  // that window the reading is not trustworthy enough to save.
  const nowYear = now.getFullYear();
  const plausible = (y: number) => y >= nowYear - 2 && y <= nowYear + 1;

  const candidates: number[] = raw_y < 100
    ? [2000 + raw_y, 2500 + raw_y - 543]           // "26" -> 2026, "69" -> 2026
    : raw_y >= 2400 && raw_y <= 2600
      ? [raw_y - 543, raw_y]                        // Buddhist, bounded
      : [raw_y];

  const year = candidates.find(plausible);
  if (year === undefined) return null;

  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Pull whole item objects out of a reply that stopped mid-sentence.
 *
 * The items are flat objects, so every complete one is a run of text between a
 * brace and the matching brace with no nesting in between. Anything after the
 * cut is ignored. This is deliberately forgiving: the alternative is throwing
 * away a correct reading of most of a list because the last row was clipped.
 */
function salvageItems(text: string): any[] {
  const out: any[] = [];
  for (const match of text.matchAll(/\{[^{}]*\}/g)) {
    try {
      const obj = JSON.parse(match[0]);
      if (obj && typeof obj === "object" && "amount" in obj) out.push(obj);
    } catch { /* a clipped object, skip it */ }
  }
  return out;
}

/**
 * A number, or nothing. This deliberately does LESS than it used to.
 *
 * It used to try to rescue a string by deleting commas, spaces and ฿. That
 * works for "2,761.78 บาท" and destroys "1.234,56", which is how a great deal
 * of the world writes one thousand two hundred and thirty-four — the comma is
 * the decimal point there, and the old code deleted it and returned 1.23.
 *
 * There is no way to tell those two apart from the characters alone. The model
 * can, because it can see the receipt, so it is asked for a number. A string
 * that arrives anyway is only accepted in the one shape that cannot be
 * misread: digits, optionally a dot, at most two more digits. Anything else is
 * null, and null becomes an empty box in the review list.
 *
 * The sign is dropped on purpose. A negative on a statement is a refund, which
 * is a DIRECTION, and a minus quietly lost in a total is a bug that hides.
 */
function normaliseAmount(raw: unknown): number | null {
  let n: number;
  if (typeof raw === "number") n = raw;
  else if (typeof raw === "string") {
    const clean = raw.trim();
    if (!/^-?\d+(\.\d{1,2})?$/.test(clean)) return null;
    n = Number(clean);
  } else return null;
  n = Math.abs(n);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

/** ISO 4217 or nothing. A three-letter code the runtime does not recognise is
 *  a misread, not a currency. */
function normaliseCurrency(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  return isValidCurrency(code) ? code : null;
}

/** Exposed for scripts/eval-slip.ts, which runs these against three dozen real
 *  shapes without touching the network. Not used elsewhere. */
export const __test = { normaliseAmount, normaliseDate, normaliseCurrency };

export async function scanImage(
  file: File,
  categories: { key: string; label: string }[],
  /** Called with 2 when the first attempt timed out, so the screen can say so
   *  rather than appearing to hang for a minute and a half. */
  onAttempt?: (n: number) => void,
): Promise<ScanResult> {
  const providerId = getProviderId();
  const provider = PROVIDERS[providerId];
  const apiKey = getApiKey(providerId);
  if (!apiKey) throw new Error("NO_KEY");
  // The same ceiling that guards the chat guards this, and it matters more
  // here: an image request is the most expensive kind there is.
  if (isOverDailyCap()) throw new Error("DAILY_CAP");

  const image = await prepareImage(file);
  const message =
    // The app's own day, not UTC. toISOString() is one date behind for the
    // first seven hours of every Bangkok morning, and this is the date the
    // model leans on to decide the year of a receipt that omits it.
    `Read every transaction in this image. Today is ${todayLocal()}.\n` +
    `Category keys to choose from: ` +
    categories.map(c => `${c.key} (${c.label})`).join(", ");

  /**
   * One automatic second attempt, and only for a timeout.
   *
   * Two of the failures here are not about this image. A timeout is one: the
   * same picture times out, times out, and then works, because the model took a
   * different amount of time to answer an identical question. "This model is
   * currently experiencing high demand" is the other — a 503 that says outright
   * that it is temporary. A person can see both and press the button again;
   * making them do it is charging them for a coin flip.
   *
   * Everything else — no key, over the cap, prose instead of JSON — fails the
   * same way twice, so none of it is retried.
   *
   * The two waits are deliberately different lengths. The first is a cheap
   * probe: with reasoning switched off below, a slip that is going to work
   * comes back in a few seconds, so 30 is already generous and giving up early
   * costs almost nothing. The second is the last chance, so it gets more
   * patience than the original single attempt had — there is nothing after it,
   * and a genuinely slow answer at 40 seconds should be kept rather than thrown
   * away for the sake of a tidy number.
   */
  const attempt = async (ms: number): Promise<any> => {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), ms);
    try {
      return await provider.send(
        {
          system: SYSTEM,
          history: [],
          message,
          image,
          // Eight rows of Thai product names overran 1200 and the reply came
          // back cut off mid-word, which made the whole JSON unparseable even
          // though most of it had arrived. Thai costs roughly twice the tokens
          // per character of English, so the ceiling has to allow for that.
          maxOutputTokens: 3000,
          model: getModel(providerId),
          apiKey,
          baseUrl: provider.configurableBaseUrl ? getBaseUrl(providerId) : undefined,
          // Reading a form is not a reasoning task. See ProviderRequest.
          thinkingBudget: 0,
        },
        ctrl.signal,
      );
    } finally {
      clearTimeout(tid);
    }
  };

  try {
    let reply;
    try {
      reply = await attempt(30000);
    } catch (e: any) {
      const timedOut = e?.name === "AbortError";
      if (!timedOut && !isTransient(e)) throw e;
      onAttempt?.(2);
      // A queue that just said it was full will say so again if asked in the
      // same instant. A timeout needs no pause: the wait already happened.
      if (!timedOut) await new Promise(r => setTimeout(r, 2000));
      reply = await attempt(50000);
    }
    recordUsage(reply.usage);

    const clean = reply.text.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
    lastRawReply = clean.slice(0, 400);

    let parsed: any;
    try {
      parsed = JSON.parse(clean);
    } catch {
      // A truncated reply still holds complete rows before the cut. Losing six
      // good ones because the seventh was clipped is the wrong trade, so they
      // are salvaged rather than discarded.
      const salvaged = salvageItems(clean);
      if (salvaged.length === 0) throw new Error("BAD_JSON");
      parsed = { source: "list", items: salvaged, truncated: true };
    }

    const known = new Set(categories.map(c => c.key));
    const rawItems: any[] = Array.isArray(parsed?.items)
      ? parsed.items
      // Tolerate a model that answers with a bare object for a single slip.
      : parsed && typeof parsed === "object" && "amount" in parsed ? [parsed] : [];

    const items: ScannedItem[] = rawItems
      .map((it): ScannedItem => ({
        amount: normaliseAmount(it?.amount),
        currency: normaliseCurrency(it?.currency),
        date: normaliseDate(it?.date),
        merchant: typeof it?.merchant === "string" ? it.merchant.slice(0, 80) : null,
        reference: typeof it?.reference === "string" && it.reference.trim()
          ? it.reference.trim().slice(0, 60)
          : null,
        category: typeof it?.category === "string" && known.has(it.category) ? it.category : null,
        // Out unless the model says otherwise. Most images are spending, and a
        // row wrongly marked "in" is invisible — it lands in income where
        // nobody is looking for it.
        direction: it?.direction === "in" ? "in" : "out",
        kind: ["payment", "transfer", "topup", "bill_due"].includes(it?.kind) ? it.kind : null,
      }))
      // A row with no amount is not a transaction, it is a misread.
      .filter(it => it.amount !== null);

    return {
      items,
      truncated: parsed?.truncated === true,
      source: ["slip", "list"].includes(parsed?.source) ? parsed.source : "unknown",
      usage: reply.usage,
    };
  } catch (e: any) {
    if (e?.name === "AbortError") throw new Error("TIMEOUT");
    throw e;
  }
}