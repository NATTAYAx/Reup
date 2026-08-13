/**
 * Offline scorecard for the local parser. Run it with:
 *
 *   pnpm eval
 *
 * WHY THIS EXISTS
 *
 * The usage log answers the same questions, but only after days of real use, and
 * only about sentences that happen to get typed. This answers them in a second,
 * about sentences chosen to include the awkward ones.
 *
 * THE NUMBER THAT MATTERS IS "CONFIDENTLY WRONG"
 *
 * A message scoring at or above the floor is answered on the device and never
 * reaches a model. When that answer is right, it is the best case there is:
 * instant, free, and nothing leaves the machine. When it is wrong, it is the
 * worst case there is — no error, no log line, and no way to find out. Today
 * "เล่น Honkai แล้ว" scored 0.97 and offered to create a duplicate task, and it
 * took a person noticing to catch it.
 *
 * A deferral is never a failure here. Handing a sentence to a model that has
 * words for it is the system working. Only a confident wrong answer counts
 * against the parser.
 */
// The parser reaches for localStorage on the way through (presets, history).
// Node has none, so it gets a bucket that lives for the length of the run —
// which is also what makes the score reproducible: every run starts blank,
// with no learned presets left over from the last one.
const bucket: Record<string, string> = {};
(globalThis as any).localStorage = (globalThis as any).sessionStorage = {
  getItem: (k: string) => (k in bucket ? bucket[k] : null),
  setItem: (k: string, v: string) => { bucket[k] = v; },
  removeItem: (k: string) => { delete bucket[k]; },
  key: (i: number) => Object.keys(bucket)[i] ?? null,
  get length() { return Object.keys(bucket).length; },
};

import { smartParse } from "../src/lib/smartAI";

// Must match LOCAL_CONFIDENCE_FLOOR in lib/geminiService.
const FLOOR = 0.9;

type Expect = "add" | "delete" | "edit_time" | "edit_name" | "edit_priority" | "defer";

/** `defer` means: the parser has no verb for this and must hand it over. */
const CASES: [string, Expect][] = [
  // ── adding, the case the parser exists for ──
  ["เพิ่มงาน Honkai Star Rail", "add"],
  ["เพิ่มงาน MHUR รายวัน", "add"],
  ["เพิ่มงาน ซักผ้า", "add"],
  ["เพิ่มงาน ประชุมทีม พฤหัส บ่ายสอง", "add"],
  ['เพิ่มงาน "ต" ให้หน่อย deadline เมื่อวาน บ่ายสามครึ่ง', "add"],
  ["ส่งการบ้านพรุ่งนี้ สำคัญ", "add"],
  ["กินยาทุกวัน 8 โมง", "add"],
  ["add task gym every monday", "add"],

  // ── the other verbs it does know ──
  ["ลบงาน ซักผ้า", "delete"],
  ['ลบงานชื่อ "ต" ให้หน่อย', "delete"],
  ["เปลี่ยนเวลา Honkai เป็นตีห้า", "edit_time"],
  ['delete "gym"', "delete"],

  // ── outside its vocabulary: must defer, never guess ──
  ["เล่น Honkai แล้ว", "defer"],
  ["Honkai เสร็จแล้ว", "defer"],
  ["ติ๊ก MHUR", "defer"],
  ["ยังไม่ได้ทำ Honkai", "defer"],
  ["พัก Honkai ไว้ก่อน", "defer"],
  ["เอา Honkai กลับมา", "defer"],
  ["ได้เงินค่าแปล 3000", "defer"],
  ["เงินเดือนเข้า 15000", "defer"],
  ["กู้คืนงานที่ลบไป", "defer"],
  ["ตั้ง Honkai เป็นด่วน", "defer"],
  ["ติ๊ก Honkai แล้วบันทึกกาแฟ 60", "defer"],
  ["mark Honkai done", "defer"],
  ["เดือนนี้ใช้ไปเท่าไหร่", "defer"],
  ["งานไหนใกล้ครบกำหนดบ้าง", "defer"],
];

let local = 0, deferred = 0, confidentlyWrong = 0;
const wrong: string[] = [];

for (const [text, expect] of CASES) {
  const r: any = smartParse(text);
  const kept = r.confidence >= FLOOR;
  if (kept) {
    local++;
    const ok = expect !== "defer" && r.intent === expect;
    if (!ok) {
      confidentlyWrong++;
      wrong.push(`  ${text}\n     answered "${r.intent}" at ${r.confidence.toFixed(2)} — expected ${expect}`);
    }
  } else {
    deferred++;
  }
}

// The split between "on device" and "handed over" is NOT a real-world rate.
// This corpus is weighted towards the awkward sentences on purpose, because
// those are the ones worth watching. What the real ratio is comes from the usage
// log, which now records both sides.
const pct = (n: number) => `${((n / CASES.length) * 100).toFixed(0)}%`;
console.log(`\ncases            ${CASES.length}`);
console.log(`answered on device ${local} (${pct(local)})   — instant, free, nothing sent`);
console.log(`handed to model    ${deferred} (${pct(deferred)})   — working as intended`);
console.log(`CONFIDENTLY WRONG  ${confidentlyWrong} (${pct(confidentlyWrong)})   — the only real failure`);
if (wrong.length) console.log("\n" + wrong.join("\n"));
console.log(confidentlyWrong === 0 ? "\nclean\n" : "\nfix these before adding any new phrases\n");
// Non-zero on failure so this can sit in front of a build later. Reached through
// globalThis because the script is compiled without Node's type definitions —
// tsc is the only compiler guaranteed to be installed here, and asking for
// @types/node as well would be a dependency added for one line.
(globalThis as any).process?.exit(confidentlyWrong === 0 ? 0 : 1);