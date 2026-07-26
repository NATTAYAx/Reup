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
// The image is never stored. A Thai slip carries an account number and a full
// name, and neither belongs in a database that will one day sync to a phone.
// The reference number is worth keeping: short, opaque, and it is what makes
// the same slip impossible to record twice.

import {
  PROVIDERS, getProviderId, getApiKey, getModel, getBaseUrl,
  isOverDailyCap, recordUsage, type TokenUsage,
} from "./aiProviders";

export interface ScannedItem {
  amount: number | null;
  /** YYYY-MM-DD, already converted out of the Buddhist calendar. */
  date: string | null;
  /** Shop, biller or item description — whatever names the spending. */
  merchant: string | null;
  /** Bank reference when the image has one. Lists usually do not. */
  reference: string | null;
  /** One of the user's own category keys. */
  category: string | null;
  kind: "payment" | "transfer" | "topup" | null;
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
// obvious version of it.
const SYSTEM = `
You extract financial transactions from an image. It may be a bank transfer
slip, a bill payment receipt, a shopping app order list, a wallet history, or a
screenshot of any of those.

Reply with ONE JSON object and nothing else. No markdown fences.

{
  "source": "slip" | "list" | "unknown",
  "items": [
    {
      "amount": number or null,
      "date": "YYYY-MM-DD" or null,
      "merchant": string or null,
      "reference": string or null,
      "category": string or null,
      "kind": "payment" | "transfer" | "topup" | null
    }
  ]
}

HOW MANY ITEMS
- A slip or receipt: exactly one item.
- A list of transactions: one item per visible row. Do not merge them, do not
  summarise, and do not invent rows that are cut off at the edge of the image.
- Keep "merchant" SHORT: at most about 40 characters. Trim marketing text off a
  product name and keep the recognisable part. A long list of full product
  titles does not fit in one reply, and a reply cut off mid-word is useless.

AMOUNT
- Labels: จำนวน, จำนวนเงิน, ยอดเงิน, ยอดชำระ, Amount, Total, or a bare figure
  on a list row.
- NEVER take ค่าธรรมเนียม or Fee. It is a separate line, usually 0.00.
- Strip commas and the word บาท: "2,761.78 บาท" is 2761.78.
- In a shopping app a leading "+" is that app's own styling, not income. Those
  rows are still purchases.

DATE — Thai apps write dates for people, not parsers:
- Years may be Buddhist and either FOUR digits ("2569") or TWO ("69"). Expand a
  two-digit year to 25xx first, then subtract 543 in both cases.
- A date already written as 2026 is Gregorian. Leave it alone.
- Thai month abbreviations:
  ม.ค.=01 ก.พ.=02 มี.ค.=03 เม.ย.=04 พ.ค.=05 มิ.ย.=06
  ก.ค.=07 ส.ค.=08 ก.ย.=09 ต.ค.=10 พ.ย.=11 ธ.ค.=12
- "23 ก.ค. 69" and "01 ก.ค. 2569" are both 2026 dates.
- On a list, each row usually carries its own date. Use the row's.

MERCHANT
- The RECEIVING side or the thing bought. Never the sender: that is the person
  holding the phone.
- A biller name ("Credit Repayment"), a shop, or the product name on a list row.

REFERENCE
- Labels: เลขที่รายการ, รหัสอ้างอิง, Reference No, Transaction ID.
- Some slips carry several. Prefer the LONGEST one, it is the most specific.
- Lists normally have none. Use null rather than inventing one — it is used to
  detect duplicates, so a made-up value is worse than none.

KIND
- "topup" when the slip says เติมเงิน or the destination is the sender's own
  wallet. Money moved, nothing was bought yet.
- "transfer" for person-to-person.
- "payment" for a purchase or a bill.

If a field is not legible, use null. Never guess a number.
Pick categories only from the list provided; use null when nothing fits.
`.trim();

/** Buddhist years, two-digit years and nonsense all end here.
 *  A shape check alone is not enough: "2569-07-23" is perfectly well-formed
 *  and 543 years wrong, and it would sail straight into the form. */
function normaliseDate(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const m = /^(\d{2,4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!m) return null;

  let year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  if (year < 100) year += 2500;    // "69" -> 2569
  if (year > 2400) year -= 543;    // Buddhist -> Gregorian

  // A record of something that already happened, entered soon after. Outside
  // that window the reading is not trustworthy enough to save.
  const nowYear = new Date().getFullYear();
  if (year < nowYear - 2 || year > nowYear + 1) return null;

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

/** Models return "2,761.78", "฿285" and "285.00 บาท". All of them are numbers. */
function normaliseAmount(raw: unknown): number | null {
  let n: number;
  if (typeof raw === "number") n = raw;
  else if (typeof raw === "string") {
    n = Number(raw.replace(/[,\s฿]/g, "").replace(/บาท/g, ""));
  } else return null;
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

export async function scanImage(
  file: File,
  categories: { key: string; label: string }[],
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
    `Read every transaction in this image. Today is ${new Date().toISOString().slice(0, 10)}.\n` +
    `Category keys to choose from: ` +
    categories.map(c => `${c.key} (${c.label})`).join(", ");

  const ctrl = new AbortController();
  // Generous: the upload is most of it, and a long list takes longer to write.
  const tid = setTimeout(() => ctrl.abort(), 45000);

  try {
    const reply = await provider.send(
      {
        system: SYSTEM,
        history: [],
        message,
        image,
        // Eight rows of Thai product names overran 1200 and the reply came back
        // cut off mid-word, which made the whole JSON unparseable even though
        // most of it had arrived. Thai costs roughly twice the tokens per
        // character of English, so the ceiling has to allow for that.
        maxOutputTokens: 3000,
        model: getModel(providerId),
        apiKey,
        baseUrl: provider.configurableBaseUrl ? getBaseUrl(providerId) : undefined,
      },
      ctrl.signal,
    );
    clearTimeout(tid);
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
        date: normaliseDate(it?.date),
        merchant: typeof it?.merchant === "string" ? it.merchant.slice(0, 80) : null,
        reference: typeof it?.reference === "string" && it.reference.trim()
          ? it.reference.trim().slice(0, 60)
          : null,
        category: typeof it?.category === "string" && known.has(it.category) ? it.category : null,
        kind: ["payment", "transfer", "topup"].includes(it?.kind) ? it.kind : null,
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
    clearTimeout(tid);
    if (e.name === "AbortError") throw new Error("TIMEOUT");
    throw e;
  }
}