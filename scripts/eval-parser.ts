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
 *
 * WHY IT CHECKS THE WHOLE ANSWER NOW, AND NOT JUST THE VERB
 *
 * It used to compare one field: the intent. Every case below passed, and the
 * parser was meanwhile answering "add task gym every monday" with a ONE-OFF
 * dated to the next Monday — a recurring task that fires once and never comes
 * back, saved at 0.95 with a green tick. The verb was right. Everything a
 * person would have cared about was wrong, and the scorecard could not see it,
 * because it was not looking at any of it.
 *
 * So an expectation is now the shape of the answer, and any field named in it
 * has to match. Fields left out are not checked, which keeps a case about
 * recurrence from breaking when something unrelated to it changes.
 *
 * THE INVARIANTS AT THE BOTTOM ARE THE PART THAT SCALES
 *
 * Cases catch the sentences someone thought to write down. The invariants catch
 * a whole shape of mistake across all of them at once — a time left sitting in
 * a task's own name, a cycle word overruled by a date. Those two are here
 * because both actually happened, and neither was visible in any single case.
 *
 * WHEN THIS FINDS SOMETHING
 *
 * Add the sentence as a case before fixing the code. A fix with no case holding
 * it stays fixed until the next person edits nearby, and one of the two bugs
 * this file was rewritten for had already been fixed once — in a file that
 * nothing imports.
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

type Intent = "add" | "delete" | "edit_time" | "edit_name" | "edit_priority";

/**
 * What a right answer looks like. Only the fields written down are compared.
 *
 * `day` is 0 for Sunday through 6 for Saturday, matching reset_day in the
 * schema. `date` is only worth stating for fixed calendar dates — anything
 * relative to today would need the corpus rewritten every morning.
 */
interface Expect {
  intent: Intent;
  type?: string;          // reset_type
  cat?: string;           // category
  time?: string | null;   // reset_time, "HH:MM"
  day?: number | null;    // reset_day
  name?: string;
  priority?: boolean;     // is_priority
  urgent?: boolean;       // is_urgent
}

/** `defer` means: the parser has no verb for this and must hand it over. */
type Case = [string, Expect | "defer"];

const CASES: Case[] = [
  // ── adding, the case the parser exists for ──
  ["เพิ่มงาน Honkai Star Rail", { intent: "add", type: "daily", cat: "game", time: "04:00" }],
  ["เพิ่มงาน MHUR รายวัน", { intent: "add", type: "daily", cat: "game" }],
  ["เพิ่มงาน ซักผ้า", { intent: "add", cat: "personal" }],
  ["เพิ่มงาน ประชุมทีม พฤหัส บ่ายสอง", { intent: "add", type: "specific_date", cat: "work", time: "14:00", name: "ประชุมทีม" }],
  ['เพิ่มงาน "ต" ให้หน่อย deadline เมื่อวาน บ่ายสามครึ่ง', { intent: "add", time: "15:30", name: "ต" }],
  ["ส่งการบ้านพรุ่งนี้ สำคัญ", { intent: "add", type: "specific_date", cat: "school", priority: true }],
  ["กินยาทุกวัน 8 โมง", { intent: "add", type: "daily", cat: "personal", time: "08:00" }],
  ["add task gym every monday", { intent: "add", type: "weekly", day: 1, name: "Gym" }],

  // ── the other verbs it does know ──
  ["ลบงาน ซักผ้า", { intent: "delete" }],
  ['ลบงานชื่อ "ต" ให้หน่อย', { intent: "delete" }],
  ["เปลี่ยนเวลา Honkai เป็นตีห้า", { intent: "edit_time" }],
  ['delete "gym"', { intent: "delete" }],

  // ── RECURRENCE BEATS A DATE ──
  //
  // Every one of these named a day AND said how often. The day short-circuited
  // the check for how often, so all of them became one-offs: fired once, never
  // came back, and nothing on screen said so. They are the reason this file
  // stopped comparing intents.
  ["Guild raid lockout Game weekly, Monday 05:00 Important",
    { intent: "add", type: "weekly", cat: "game", time: "05:00", day: 1, name: "Guild Raid Lockout", priority: true }],
  ["gym every monday 6pm", { intent: "add", type: "weekly", day: 1, time: "18:00", name: "Gym" }],
  ["reset boss weekly monday 05:00", { intent: "add", type: "weekly", day: 1, time: "05:00", cat: "game" }],
  ["ทำความสะอาด ทุกวันจันทร์ 9 โมง",
    { intent: "add", type: "weekly", day: 1, time: "09:00", cat: "personal", name: "ทำความสะอาด" }],

  // ทุกอาทิตย์ is every WEEK and contains อาทิตย์, which is SUNDAY. Nothing owned
  // those characters, so both matchers read them and the weekday matcher won:
  // this sentence produced a one-off dated to the next Sunday, with Monday —
  // the day actually written — thrown away.
  ["ประชุมทีม ทุกอาทิตย์ วันจันทร์ 9 โมง",
    { intent: "add", type: "weekly", day: 1, time: "09:00", cat: "work", name: "ประชุมทีม" }],
  ["ซักผ้า ทุกสัปดาห์ 10 โมง", { intent: "add", type: "weekly", day: null, time: "10:00" }],

  // "biweekly" contains "weekly", and the weekly test ran first.
  ["boss biweekly 04:00", { intent: "add", type: "biweekly", cat: "game", time: "04:00" }],

  // A NAMED CATEGORY BEATS A GUESS FROM HOW OFTEN
  //
  // "daily" and "weekly" sat inside the test for Game, so a medication filed
  // itself under Game and the word Personal, written out in full, was read by
  // nothing and left in the task's own name.
  ["Blood pressure meds Personal daily 09:00 Critical",
    { intent: "add", type: "daily", cat: "personal", time: "09:00", name: "Blood Pressure Meds", urgent: true }],

  // A weekday hiding inside an ordinary word. The old day table tested
  // includes("mon"), so this one was dated to next Monday.
  ["monitor server every day 3am", { intent: "add", type: "daily", time: "03:00", name: "Monitor Server" }],

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

/**
 * Rules that hold for every answer, whatever the sentence was.
 *
 * These are the ones no single case would have caught, because the mistake was
 * spread across all of them: a time or a weekday left inside the task's own
 * name looks like a small cosmetic slip one case at a time, and turns out to be
 * one missing line shared by every sentence in the corpus.
 */
const INVARIANTS: [string, (input: string, task: any, res: any) => boolean][] = [
  ["name still contains a clock time", (_i, t) => !/\d{1,2}:\d{2}/.test(t.name)],
  ["name still contains a weekday", (_i, t) =>
    !/\b(sun|mon|tues?|wednes|thurs?|fri|satur)day\b/i.test(t.name) &&
    !/วัน(จันทร์|อังคาร|พุธ|พฤหัส|ศุกร์|เสาร์|อาทิตย์)/.test(t.name)],
  ["name still contains a category label", (_i, t) => !/\b(personal|school|work|game)\b/i.test(t.name)],
  // A preset keeps its own name: MapleStory Daily is what the game calls it,
  // not a frequency the parser failed to strip.
  ["name still contains a cycle word", (_i, t, r) =>
    r.details?.some((d: any) => d.field === "game preset") ||
    !/\b(daily|weekly|biweekly|monthly)\b/i.test(t.name)],
  ["name still contains a separator", (_i, t) => !/[,|;]/.test(t.name)],
  // The one that started all of this.
  ["a cycle word was written but the task is a one-off", (i, t) =>
    !(/\b(daily|weekly|biweekly|monthly)\b|ทุกวัน|ทุกสัปดาห์|ทุกอาทิตย์|รายวัน|รายสัปดาห์/i.test(i)
      && (t.reset_type === "specific_date" || t.reset_type === "one_time"))],
  ["weekly, but no day and none was named", (i, t) =>
    !(t.reset_type === "weekly" && t.reset_day == null
      && /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(i))],
];

let local = 0, deferred = 0, confidentlyWrong = 0;
const wrong: string[] = [];
// Cases the parser got wrong but scored too low to act on. Not a failure: the
// model answers those. Worth printing anyway, because a mistake here is a
// mistake that will start counting the day something nudges the score up.
const quietlyWrong: string[] = [];

for (const [text, expect] of CASES) {
  const r: any = smartParse(text);
  const kept = r.confidence >= FLOOR;
  if (kept) local++; else deferred++;

  const at = ` at ${r.confidence.toFixed(2)}`;
  if (expect === "defer") {
    if (kept) {
      confidentlyWrong++;
      wrong.push(`  ${text}\n     answered "${r.intent}"${at} — should have been handed over`);
    }
    continue;
  }

  const bad: string[] = [];
  if (r.intent !== expect.intent) bad.push(`intent ${r.intent} ≠ ${expect.intent}`);

  const t = r.tasks?.[0];
  if (expect.intent === "add" && !t) {
    bad.push("no task produced");
  } else if (t) {
    const check = (label: string, got: unknown, want: unknown) => {
      if (want !== undefined && got !== want) bad.push(`${label} ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`);
    };
    check("type", t.reset_type, expect.type);
    check("category", t.category, expect.cat);
    check("time", t.reset_time, expect.time);
    check("day", t.reset_day, expect.day);
    check("name", t.name, expect.name);
    check("priority", !!t.is_priority, expect.priority);
    check("urgent", !!t.is_urgent, expect.urgent);

    for (const [label, holds] of INVARIANTS) {
      if (!holds(text, t, r)) bad.push(label);
    }
  }

  if (bad.length) {
    const line = `  ${text}${at}\n     ${bad.join("\n     ")}`;
    if (kept) { confidentlyWrong++; wrong.push(line); } else quietlyWrong.push(line);
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
if (quietlyWrong.length) {
  console.log(`\nwrong but handed over  ${quietlyWrong.length}   — not a failure, the model answers these`);
  console.log(quietlyWrong.join("\n"));
}
console.log(confidentlyWrong === 0 ? "\nclean\n" : "\nfix these before adding any new phrases\n");
// Non-zero on failure so this can sit in front of a build later. Reached through
// globalThis because the script is compiled without Node's type definitions —
// tsc is the only compiler guaranteed to be installed here, and asking for
// @types/node as well would be a dependency added for one line.
(globalThis as any).process?.exit(confidentlyWrong === 0 ? 0 : 1);