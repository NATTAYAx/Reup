// ─── tombstones.ts — what "deleted" means once two devices are involved ──────
//
// A row that simply vanishes tells another device nothing. It cannot tell the
// difference between "this was deleted" and "I have never heard of this", so it
// takes the second reading, pushes its own copy back, and the row returns from
// the dead with no error raised anywhere. That is why every delete here leaves
// something behind.
//
// These rules were written in src/lib/schema.ts, alongside a raw import of
// shared/schema.sql that does not exist in this repo — so the file could not be
// imported without breaking the build, and nothing imported it. The rules sat
// there being correct and never running, while database.ts ran DELETE. Moved
// out on their own, they have no such dependency.
//
// WHO WRITES `updated_at` HERE: NOBODY
// ------------------------------------
// Not one statement in this file sets `updated_at`. It looks like an omission
// and it is the whole point. `syncMeta` puts an update trigger on every synced
// table that stamps the row from `sync_clock`, a clock that only ever moves
// forward, and the trigger stands aside only for a statement that sets the
// column itself. A delete that stamped its own time would be a second clock
// writing into a column that is compared as a string — which is the bug that
// cost a day the last time it happened.

import type Database from "@tauri-apps/plugin-sql";

/** How long a deleted task stays recoverable from the bin. */
export const TRASH_TTL_DAYS = 30;

/** How long a tombstone stays before the row is genuinely removed. */
export const TOMBSTONE_TTL_DAYS = 365;

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

/**
 * Gone for good, now rather than in thirty days.
 *
 * Keeps `uid` — it is what tells another device this row is dead rather than
 * unheard-of — and clears the rest, because a tombstone should not still be
 * carrying a task name around in every backup and every sync batch.
 */
export const PURGE_TASK_SQL = `
  UPDATE tasks
     SET deleted = 1,
         is_active = 0,
         name = '',
         description = '',
         notes = '',
         min_step = NULL
   WHERE id = ? AND deleted_at IS NOT NULL AND deleted = 0
`;

/**
 * Emptying the bin on a timer.
 *
 * This one does NOT need to be announced to other devices, and that is worth
 * being explicit about: every device computes it from the same `deleted_at`, so
 * they all reach the same answer independently, whenever each of them happens
 * to run it. Deriving beats synchronising when the derivation is deterministic.
 */
export async function sweepTrash(db: Database): Promise<void> {
  try {
    await db.execute(
      `UPDATE tasks
          SET deleted = 1, is_active = 0,
              name = '', description = '', notes = '', min_step = NULL
        WHERE deleted_at IS NOT NULL AND deleted_at < ? AND deleted = 0`,
      [daysAgoIso(TRASH_TTL_DAYS)],
    );
  } catch (err) {
    console.error("[db] could not sweep trash:", err);
  }
}

/**
 * The only place a row is genuinely removed.
 *
 * Runs against `updated_at`, not `deleted_at`: the question is "how long since
 * anyone touched this", and a tombstone that keeps being re-sent by a device
 * that has not caught up is still in use.
 *
 * A year is not caution for its own sake. A tombstone dropped while another
 * device still holds the live row is exactly how a deleted row comes back, and
 * the phone in a drawer for a month is a normal thing rather than a strange one.
 */
export async function sweepTombstones(db: Database, tables: string[]): Promise<void> {
  const cutoff = daysAgoIso(TOMBSTONE_TTL_DAYS);
  for (const t of tables) {
    try {
      await db.execute(`DELETE FROM ${t} WHERE deleted = 1 AND updated_at < ?`, [cutoff]);
    } catch (err) {
      console.error(`[db] could not sweep tombstones in ${t}:`, err);
    }
  }
}