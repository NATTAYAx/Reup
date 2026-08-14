/**
 * Offline scorecard for the slip reader's normalisers. Run with:
 *
 *   pnpm eval
 *
 * WHAT THIS CAN AND CANNOT TEST
 *
 * It does not test the reading. Whether a model can make out a faded thermal
 * receipt is not answerable without images and a network, and it is not where
 * the failures were anyway.
 *
 * It tests the layer AFTER the reading — the one that used to quietly assume
 * every receipt in the world was printed in Thailand. That layer is pure
 * functions over strings, so three dozen real-world shapes can be checked in a
 * second, for free, with nothing sent anywhere.
 *
 * THE CLAIM THIS IS FOR
 *
 * Two hundred countries cannot be tested and it is a mistake to try. The
 * property worth defending is not coverage, it is this: THE APP NEVER SILENTLY
 * INVENTS A NUMBER. Anything it cannot verify comes back null, and null is an
 * empty box in the review list that a person fills in.
 *
 * That is a promise which means something to someone in a country whose
 * receipts nobody here has ever seen, and unlike "works everywhere" it can
 * actually be shown to be true.
 *
 * WHAT WAS ACTUALLY WRONG, WHICH IS WHY THESE CASES EXIST
 *
 *   "1.234,56"  -> 1.23    German, Brazilian, Indonesian. Wrong by a thousand,
 *                          no error, no log line. This is the one that matters:
 *                          not a crash, a plausible number in a ledger.
 *   "1 234,56"  -> 123456  French, Nordic. Wrong by a hundred.
 *   "$1,234.56" -> null    Only ฿ was ever stripped, so the row vanished.
 *   "26-08-13"  -> null    A two-digit year, which almost every country writes
 *                          and Thailand does not. Killed by the +2500 rule.
 */
const bucket: Record<string, string> = {};
(globalThis as any).localStorage = (globalThis as any).sessionStorage = {
  getItem: (k: string) => (k in bucket ? bucket[k] : null),
  setItem: (k: string, v: string) => { bucket[k] = v; },
  removeItem: (k: string) => { delete bucket[k]; },
  key: (i: number) => Object.keys(bucket)[i] ?? null,
  get length() { return Object.keys(bucket).length; },
};

import { __test } from "../src/lib/slipScanner";
const { normaliseAmount, normaliseDate, normaliseCurrency } = __test;

// Pinned so the date window does not move under the corpus overnight.
const TODAY = new Date("2026-08-13T00:00:00Z");

type Case<I, O> = [I, O, string];
let failed = 0;
const report: string[] = [];

function run<I, O>(label: string, cases: Case<I, O>[], fn: (i: I) => O) {
  const bad: string[] = [];
  for (const [input, want, why] of cases) {
    const got = fn(input);
    if (got !== want) bad.push(`  ${JSON.stringify(input)} -> ${JSON.stringify(got)}, expected ${JSON.stringify(want)}   (${why})`);
  }
  failed += bad.length;
  report.push(`${label.padEnd(10)} ${cases.length - bad.length}/${cases.length}`);
  if (bad.length) report.push(bad.join("\n"));
}

// ── AMOUNT ────────────────────────────────────────────────────────────────────
// A number always wins; a string is only accepted in the one shape that cannot
// be read two ways. Everything else is null ON PURPOSE — the model is asked to
// do the conversion because it can see which country the paper came from.
run("amount", [
  [2761.78, 2761.78, "the ordinary case, a plain number"],
  [5340, 5340, "yen, no decimal places"],
  [-49.99, 49.99, "a refund keeps its size; the sign becomes a direction"],
  [0, null, "a zero is not a transaction"],
  ["2761.78", 2761.78, "unambiguous string, accepted"],
  ["45", 45, "unambiguous string, accepted"],
  ["2,761.78", null, "grouped: could be 2761.78 or 2.76178, refuse"],
  ["1.234,56", null, "German/Brazilian: the comma IS the decimal point"],
  ["1 234,56", null, "French/Nordic thin space"],
  ["1'234.56", null, "Swiss apostrophe grouping"],
  ["1,23,456.78", null, "Indian lakh grouping"],
  ["$1,234.56", null, "carries a symbol"],
  ["¥5,340", null, "carries a symbol"],
  ["285.00 บาท", null, "carries a word"],
  ["١٢٣٤", null, "Arabic-Indic digits"],
  ["๔๕๖", null, "Thai digits"],
  ["", null, "empty"],
  [null, null, "missing field"],
  [undefined, null, "missing field"],
  ["abc", null, "prose"],
], normaliseAmount as (i: unknown) => number | null);

// ── DATE ──────────────────────────────────────────────────────────────────────
// The model is told to hand back Gregorian. This only checks that it did, and
// rescues the one shape that is genuinely ambiguous: a two-digit year, which
// means 20xx in most of the world and 25xx in Thailand.
run("date", [
  ["2026-08-13", "2026-08-13", "already Gregorian, untouched"],
  ["2569-07-23", "2026-07-23", "four-digit Buddhist year"],
  ["69-07-23", "2026-07-23", "two-digit Buddhist year, Thai slips"],
  ["26-08-13", "2026-08-13", "two-digit Gregorian year, the rest of the world"],
  ["25-12-31", "2025-12-31", "last year, still inside the window"],
  ["2025-12-31", "2025-12-31", "last year, four digits"],
  ["2027-01-05", "2027-01-05", "just ahead, a bill dated forward"],
  ["1983-07-23", null, "outside the window, refuse rather than save"],
  ["2030-01-01", null, "too far ahead to be a receipt"],
  ["115-08-13", null, "unconverted Taiwanese year, refuse"],
  ["1447-02-01", null, "unconverted Hijri year, refuse"],
  ["2026-13-01", null, "no thirteenth month"],
  ["2026-00-10", null, "no zeroth month"],
  ["2026-02-32", null, "no thirty-second day"],
  ["13/08/2026", null, "not the requested shape"],
  ["", null, "empty"],
  [null, null, "missing field"],
], (i: unknown) => normaliseDate(i, TODAY));

// ── CURRENCY ──────────────────────────────────────────────────────────────────
run("currency", [
  ["THB", "THB", "the usual one"],
  ["jpy", "JPY", "lowercase from the model"],
  [" eur ", "EUR", "stray whitespace"],
  ["XYZ", null, "not a currency the runtime knows"],
  ["฿", null, "a symbol is not a code, and could not be one: ¥ is two currencies"],
  ["baht", null, "a word is not a code"],
  ["", null, "empty"],
  [null, null, "missing field, which is allowed — null means 'the image did not say'"],
], normaliseCurrency as (i: unknown) => string | null);

console.log("\n" + report.join("\n"));
console.log(failed === 0 ? "\nclean\n" : `\n${failed} failing — fix before adding a country\n`);
(globalThis as any).process?.exit(failed === 0 ? 0 : 1);