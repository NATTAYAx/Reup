/**
 * Generates shared/sync-vectors.json and proves merge() converges. Run it with:
 *
 *   pnpm gen:sync-vectors
 *
 * WHY THIS EXISTS
 *
 * Two jobs that are really one.
 *
 *   1. Check that merge() converges, by brute force rather than by example.
 *   2. Write down what it decided, so the Kotlin port has to decide the same.
 *
 * The second is the reason the file is committed. The reset engine got this
 * treatment already and it paid immediately: 3,440 recorded cases caught 264
 * that were wrong by exactly seven hours, which no hand-written test would have
 * found because nobody would have thought to write it.
 *
 * A lesson from that file carried over here. Its first version baked in the
 * clock settings of the machine that produced it, because the timezone was
 * implicit. So every case below is fully explicit, and nothing in this
 * generator reads the wall clock or the local zone.
 *
 * WHAT "CLEAN" MEANS AND WHAT IT DOES NOT
 *
 * The counts are the size of the search, not a score. The only line that
 * matters is the last one. Anything other than `clean` means two devices can
 * end up holding different rows while both believe they are in sync, which is
 * the single failure the whole sync design exists to prevent — and it has no
 * symptom until weeks later, on one device, with nothing in any log.
 *
 * It has already earned its place. The first two runs failed, on commutativity
 * and then on associativity, and both were real defects in the design rather
 * than typos. See the comments in merge.ts for what they were.
 *
 * WHY NODE IS REACHED THROUGH `declare` AND NOT AN IMPORT
 *
 * The project has no @types/node, and adding it for one script is a dependency
 * the app itself never uses. eval-parser.ts already solved this the same way.
 * The emitted file is CommonJS under node_modules/.cache, where `require` is
 * available and Node does not apply the root package.json's "type": "module".
 */

import { merge, mergeAll } from "../src/lib/sync/merge";
import type { ChangeRecord } from "../src/lib/sync/protocol";

declare const require: (m: string) => {
  writeFileSync(p: string, d: string): void;
  mkdirSync(p: string, o: { recursive: boolean }): void;
};
declare const process: { argv: string[]; exit(code: number): void };

// ── the matrix ───────────────────────────────────────────────────────────────
//
// Small, but every axis that changes the answer is in it, and it is combined
// exhaustively. Adding a value multiplies the cases, which is the point: nobody
// has to guess which combinations are interesting.

const TIMES = [
  "2026-08-14T09:00:00.000Z",
  "2026-08-14T09:00:00.001Z", // one millisecond apart
  "2026-08-14T09:00:00.000Z", // deliberate duplicate, to force ties
  "2026-08-15T00:00:00.000Z",
];
const ORIGINS = ["dev-aaa", "dev-bbb"];
const DELETED = [false, true];
const COMPLETED = [null, "2026-08-14T04:00:00.000Z", "2026-08-15T04:00:00.000Z"];
const STREAKS = [0, 2];

function taskRecord(
  updatedAt: string,
  origin: string,
  deleted: boolean,
  completedUntil: string | null,
  missedStreak: number,
  name: string,
): ChangeRecord {
  return {
    table: "tasks",
    uid: "11111111-1111-4111-8111-111111111111",
    updatedAt,
    deleted,
    origin,
    fields: {
      name,
      category: "game",
      reset_type: "daily",
      reset_time: "04:00",
      is_active: 1,
      completed_until: completedUntil,
      cycle_checked_until: completedUntil,
      missed_streak: missedStreak,
    },
  };
}

/** A table with no field groups, to prove plain LWW is untouched by the above. */
function expenseRecord(updatedAt: string, origin: string, amount: number): ChangeRecord {
  return {
    table: "expenses",
    uid: "22222222-2222-4222-8222-222222222222",
    updatedAt,
    deleted: false,
    origin,
    fields: { amount, category: "food", note: "", date: "2026-08-14", currency: "THB" },
  };
}

const universe: ChangeRecord[] = [];
let tag = 0;
for (const t of TIMES)
  for (const o of ORIGINS)
    for (const d of DELETED)
      for (const c of COMPLETED)
        for (const s of STREAKS)
          universe.push(taskRecord(t, o, d, c, s, `task-${tag++}`));
for (const t of TIMES)
  for (const o of ORIGINS)
    for (const amt of [50, 1200]) universe.push(expenseRecord(t, o, amt));

// ── the properties ───────────────────────────────────────────────────────────

const eq = (a: ChangeRecord, b: ChangeRecord) => JSON.stringify(a) === JSON.stringify(b);
const failures: string[] = [];
const note = (m: string) => {
  if (failures.length < 10) failures.push(m);
};

let idem = 0;
for (const a of universe) {
  if (!eq(merge(a, a), a)) note(`idempotence: ${String(a.fields.name ?? a.uid)} @ ${a.updatedAt}`);
  idem++;
}

let comm = 0;
const pairs: [ChangeRecord, ChangeRecord][] = [];
for (const a of universe)
  for (const b of universe) {
    if (a.table !== b.table) continue;
    if (!eq(merge(a, b), merge(b, a)))
      note(`commutativity: ${a.updatedAt}/${a.origin} vs ${b.updatedAt}/${b.origin}`);
    comm++;
    if (pairs.length < 400) pairs.push([a, b]);
  }

// Every triple of the full universe would be ~1.5M merges; a fixed stride keeps
// it a couple of seconds while still crossing every axis.
let assoc = 0;
for (let i = 0; i < universe.length; i += 1)
  for (let j = 0; j < universe.length; j += 3)
    for (let k = 0; k < universe.length; k += 7) {
      const [a, b, c] = [universe[i], universe[j], universe[k]];
      if (a.table !== b.table || b.table !== c.table) continue;
      if (!eq(merge(merge(a, b), c), merge(a, merge(b, c))))
        note(`associativity: ${a.updatedAt} ${b.updatedAt} ${c.updatedAt}`);
      assoc++;
    }

// The property that matters most in practice, stated directly: two devices that
// receive the same changes in different orders end up identical.
let order = 0;
for (let i = 0; i < universe.length; i += 2) {
  const window = universe.slice(i, i + 5).filter((r) => r.table === universe[i].table);
  if (window.length < 2) continue;
  const forward = mergeAll(window);
  const backward = mergeAll([...window].reverse());
  for (const [key, v] of forward) {
    const other = backward.get(key);
    if (!other || !eq(v, other)) note(`order independence at index ${i}`);
  }
  order++;
}

// ── report first, file second ────────────────────────────────────────────────
//
// Deliberately in this order. Writing a vector file from a merge that does not
// converge would hand the Kotlin port a spec that is wrong, and it would pass
// against it, which is worse than having no file at all.

console.log(`records in universe   ${universe.length}`);
console.log(`idempotence checks    ${idem}`);
console.log(`commutativity checks  ${comm}`);
console.log(`associativity checks  ${assoc}`);
console.log(`order-independence    ${order}`);
console.log("");

if (failures.length) {
  console.log("FAILED — no vector file written");
  for (const f of failures) console.log("  " + f);
  process.exit(1);
}

const out = process.argv[2] ?? "../reup-shared/sync-vectors.json";
const cases = pairs.map(([a, b], i) => ({
  id: `merge-${String(i).padStart(4, "0")}`,
  a,
  b,
  expected: merge(a, b),
}));

const fs = require("node:fs");
const dir = out.replace(/[\\/][^\\/]*$/, "");
if (dir && dir !== out) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(out, JSON.stringify({ version: 1, generatedBy: "gen-sync-vectors.ts", cases }, null, 2));

console.log(`vectors written       ${cases.length} → ${out}`);
console.log("clean");