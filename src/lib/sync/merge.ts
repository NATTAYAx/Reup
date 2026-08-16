// ─── sync/merge.ts — deciding which version of a row survives ────────────────
//
// The only function in the sync engine that has to be exactly right, and the
// only one that can be proved so, because it does no I/O: two records in, one
// record out.
//
// Everything around it — HTTP, OAuth, encryption, SQLite — can be tested by
// running it. This cannot, because its failures are silent. A merge that is
// subtly wrong does not throw; it quietly resurrects a deleted row, or drops an
// edit, on one device, weeks later, with nothing on screen to say so.
//
// ─── THE THREE PROPERTIES THAT MATTER ───────────────────────────────────────
//
// Devices do not see changes in the same order. A phone that was off for a week
// reads Tuesday's edit before Monday's. So the result must not depend on order:
//
//   idempotent    merge(a, a) = a
//   commutative   merge(a, b) = merge(b, a)
//   associative   merge(merge(a,b),c) = merge(a,merge(b,c))
//
// Together those mean any two devices holding the same SET of changes hold
// identical rows, whatever route they took. That is the actual guarantee, and
// the suite checks it by brute force rather than by example.
//
// ─── THE STRUCTURE, AND WHY IT IS TWO REGISTERS AND NOT ONE ─────────────────
//
// A row is treated as two independent things, merged separately, which never
// consult each other:
//
//   BASE        everything except the completion fields. Last writer wins.
//   COMPLETION  completed_until and its two dependants. Furthest along wins.
//
// The first draft merged them as one — pick a winner, then let the loser's
// completion override it — and the property suite failed on associativity on
// its first run. The reason is worth writing down, because it is not obvious
// and it is the sort of thing that otherwise ships.
//
// Overriding produces a HYBRID row that existed on neither device. Feed that
// hybrid into the next merge and it is compared on content it never had, so
// (a·b)·c and a·(b·c) can land on different answers. In practice that is two
// devices that quietly stop agreeing, forever, with no error anywhere.
//
// Keeping the registers independent fixes it structurally rather than by
// patching cases. Each is a maximum over its own total order, and a maximum is
// associative and commutative for free. Nothing about completion can influence
// who wins the base, and nothing about the base can influence completion, so no
// hybrid is ever compared against anything.
//
// ─── LAST WRITER WINS, AND WHAT IT COSTS ────────────────────────────────────
//
// The base is whole-row. Edit the name on the phone and the time on the laptop
// inside one sync window and one is lost entirely, not merged field by field.
//
// That is a real loss and it is chosen. Field-level merge means every field
// carries its own clock, which roughly triples what goes on the wire and adds a
// class of bug much harder to reason about. For one person with two devices the
// collision it protects against happens approximately never, and its cost is
// paid on every row forever.
//
// ─── WHY COMPLETION IS THE EXCEPTION, AND WHY IT IS A GROUP ─────────────────
//
// Ticking a task done is the one write that will genuinely happen on both
// devices, because that is what the notification is for. Under plain LWW it
// fails in the worst direction: tick it done on the phone, the laptop's older
// row wins, and the task comes back undone. The app has just lied about the one
// thing it is for.
//
// Completion only moves forward inside a cycle, so "furthest along" is the
// right rule rather than "written last".
//
// It cannot be one field, though. `missed_streak` resets to 0 on completion and
// `cycle_checked_until` moves with it, so choosing each field independently can
// produce a row that existed nowhere: completed, yet carrying the missed streak
// from before it was completed. The three move as a unit.

import type { ChangeRecord } from "./protocol";

/** Fields that move together, chosen by whichever side is further along in `by`. */
interface FieldGroup {
  by: string;
  fields: string[];
}

const GROUPS: Record<string, FieldGroup[]> = {
  tasks: [
    {
      by: "completed_until",
      fields: ["completed_until", "cycle_checked_until", "missed_streak"],
    },
  ],
};

function groupsFor(table: string): FieldGroup[] {
  return GROUPS[table] ?? [];
}

/** Every field name claimed by a group, so the base ordering can skip them. */
function groupedKeys(table: string): Set<string> {
  const s = new Set<string>();
  for (const g of groupsFor(table)) for (const f of g.fields) s.add(f);
  return s;
}

// ── ordering primitives ──────────────────────────────────────────────────────

/**
 * Rank for ordering values of different types. Only has to be identical in both
 * implementations, not meaningful.
 */
function typeRank(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "boolean") return 1;
  if (typeof v === "number") return 2;
  return 3;
}

/** Null sorts before everything: "never completed" is behind any completion. */
function valueGreater(a: unknown, b: unknown): boolean {
  const ar = typeRank(a);
  const br = typeRank(b);
  if (ar !== br) return ar > br;
  if (ar === 0) return false;
  if (ar === 1) return a === true && b === false;
  if (ar === 2) return (a as number) > (b as number);
  return String(a) > String(b);
}

function valueEqual(a: unknown, b: unknown): boolean {
  return !valueGreater(a, b) && !valueGreater(b, a);
}

/**
 * Deterministic order over two field maps, key by key, skipping `skip`.
 *
 * Compared as values rather than as serialised JSON on purpose. Two languages
 * do not agree on how to print a float — 1200 versus 1200.0 — so comparing
 * strings would make TypeScript and Kotlin pick different winners for rows that
 * are otherwise identical, which is exactly the disagreement this ordering
 * exists to rule out.
 */
function fieldsGreater(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  skip: Set<string>,
): boolean {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((k) => !skip.has(k))
    .sort();
  for (const k of keys) {
    const av = a[k] ?? null;
    const bv = b[k] ?? null;
    if (valueEqual(av, bv)) continue;
    return valueGreater(av, bv);
  }
  return false;
}

/**
 * Total order over the BASE of a row. True when `a` wins.
 *
 * Deliberately TOTAL, not "is a newer". A partial order lets two devices
 * disagree about which version wins and stay that way — both believing they are
 * in sync while holding different rows.
 *
 * The content tier was not in the first draft, and the suite failed on its first
 * run because of it: two records with the same timestamp AND the same origin but
 * different contents made merge() non-commutative, since neither side won and
 * the answer depended on argument position. That happens whenever one device
 * writes a row twice inside a millisecond, which is not rare over months — just
 * rare enough never to be found by hand.
 *
 * Comparing contents is arbitrary as a choice of winner. It does not need to be
 * a good choice; it needs to be the SAME choice everywhere, every time.
 */
function baseGreater(a: ChangeRecord, b: ChangeRecord): boolean {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt;
  if (a.origin !== b.origin) return a.origin > b.origin;
  if (a.deleted !== b.deleted) return a.deleted;
  return fieldsGreater(a.fields, b.fields, groupedKeys(a.table));
}

/**
 * Total order over one field group, using nothing but the group's own values.
 *
 * `by` decides it — that is the meaning of the group. The remaining fields are
 * only there to break a tie, in sorted order so both languages walk them the
 * same way. If every field matches, the two groups are identical and the answer
 * does not matter.
 */
function groupGreater(a: ChangeRecord, b: ChangeRecord, g: FieldGroup): boolean {
  const av = a.fields[g.by] ?? null;
  const bv = b.fields[g.by] ?? null;
  if (!valueEqual(av, bv)) return valueGreater(av, bv);
  for (const f of [...g.fields].sort()) {
    if (f === g.by) continue;
    const x = a.fields[f] ?? null;
    const y = b.fields[f] ?? null;
    if (!valueEqual(x, y)) return valueGreater(x, y);
  }
  return false;
}

// ── the merge ────────────────────────────────────────────────────────────────

export function sameRow(a: ChangeRecord, b: ChangeRecord): boolean {
  return a.table === b.table && a.uid === b.uid;
}

export function merge(a: ChangeRecord, b: ChangeRecord): ChangeRecord {
  if (!sameRow(a, b)) {
    throw new Error(`merge across rows: ${a.table}/${a.uid} vs ${b.table}/${b.uid}`);
  }

  const base = baseGreater(a, b) ? a : b;
  const grouped = groupedKeys(a.table);

  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(base.fields)) {
    if (!grouped.has(k)) fields[k] = v;
  }

  // Each group is its own register, ordered ONLY by its own contents.
  //
  // An earlier version broke the tie by falling back to the base order, which
  // looks harmless and is not: the merged row keeps the base winner's identity,
  // so where its completion came from is no longer recoverable. Merge a third
  // record in and the tie is broken against a base that has nothing to do with
  // the completion being compared, which is how (a·b)·c and a·(b·c) drift
  // apart. The suite failed on exactly that, twice, before this was structural.
  for (const g of groupsFor(a.table)) {
    const from = groupGreater(a, b, g) ? a : b;
    for (const f of g.fields) fields[f] = from.fields[f] ?? null;
  }

  return {
    table: base.table,
    uid: base.uid,
    updatedAt: base.updatedAt,
    deleted: base.deleted,
    origin: base.origin,
    fields,
  };
}

/**
 * Fold a stream of changes into one row per uid.
 *
 * The whole apply path is this plus a write, which is why the properties above
 * are enough: if merge converges, so does everything built on it.
 */
export function mergeAll(records: Iterable<ChangeRecord>): Map<string, ChangeRecord> {
  const out = new Map<string, ChangeRecord>();
  for (const r of records) {
    const key = `${r.table}\u0000${r.uid}`;
    const prev = out.get(key);
    out.set(key, prev ? merge(prev, r) : r);
  }
  return out;
}