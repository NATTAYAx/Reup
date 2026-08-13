import { Task, isPaused } from "../types";
import { getNextReset } from "./countdown";
import { recordCycleRollover } from "./database";

// ─── cycles.ts — what happens after a missed cycle ────────────────────────────
//
// The usual answer is a streak counter, and the usual result is that a run of
// forty days becomes a zero over one bad Tuesday. The pattern that follows is
// well documented: the counter shames the slip, and the app is gone within the
// week. Meta-analysis of mental health apps found attrition was lower in the
// ones WITHOUT gamification, alongside reminders and human contact as the things
// that actually kept people in. So there is no counter here, nothing turns red,
// and a missed cycle is never mentioned to anyone.
//
// What happens instead comes from behavioural activation, where the move for a
// task someone is not managing is not to push harder on it but to make it
// smaller — a graded task assignment, in which an avoided activity is broken
// down and rebuilt gradually rather than attempted whole. The rule is the one
// thing the streak literature does converge on: never miss twice. One miss is
// life. Two in a row is the app asking for the wrong thing.
//
// So: miss once, absolutely nothing happens. Miss twice in a row, and if the
// task has a smallest version written down, that quietly becomes what is asked
// for until it is done once. Then it goes back to normal on its own.
//
// WHY THERE IS NEW STATE FOR THIS
// completed_until is a single overwritten value; the database keeps no history,
// so "was the last cycle completed" is not answerable from what exists. Two
// columns is the smallest thing that answers it, and neither is a score:
//   cycle_checked_until — the reset boundary already accounted for
//   missed_streak       — consecutive missed cycles, only ever 0, 1 or 2+
//
// Nothing displays missed_streak. It exists to decide one thing and is reset by
// a single completion.

/** Below this, nothing has changed and nothing is shown. */
export const EASE_AFTER = 2;

/** Repeating kinds only. A one-off cannot be missed twice; it is just late, and
 *  making a deadline smaller because it passed would be a lie about the world. */
const REPEATING = new Set(["daily", "weekly", "biweekly", "custom_days"]);

export function isEased(task: Task): boolean {
  return (task.missed_streak ?? 0) >= EASE_AFTER && !!task.min_step?.trim();
}

/**
 * Walk each task's boundary forward and record whether the cycle that just
 * ended was completed. Runs when tasks load, not on the render tick — a
 * boundary passes once per cycle, so this writes to the database roughly never.
 *
 * Mutates the array in place and returns whether anything changed, so the
 * caller can avoid a re-render when nothing did (which is almost always).
 */
export async function reconcileCycles(tasks: Task[]): Promise<boolean> {
  let changed = false;

  for (const task of tasks) {
    if (!REPEATING.has(task.reset_type)) continue;
    // A task deliberately set aside was not missed. getAllTasks already keeps
    // these out, so this is belt and braces — but it is the guard that decides
    // whether pausing has a cost, and that is worth stating where the counting
    // happens rather than trusting a filter two files away.
    if (isPaused(task)) continue;

    const next = getNextReset(task);
    if (!next) continue;
    const nextIso = next.toISOString();

    // First sighting: adopt the current boundary without judging the past. A
    // task added today has not missed anything, and a database that predates
    // this file should not be retroactively marked as having failed.
    if (!task.cycle_checked_until) {
      task.cycle_checked_until = nextIso;
      await recordCycleRollover(task.id, nextIso, task.missed_streak ?? 0);
      changed = true;
      continue;
    }

    if (nextIso <= task.cycle_checked_until) continue; // still inside the cycle

    // A boundary passed. completed_until is set to the reset time when a task
    // is ticked, so a value at or past the boundary we were watching means the
    // cycle was completed before it ended.
    const done = !!task.completed_until && task.completed_until >= task.cycle_checked_until;
    const streak = done ? 0 : Math.min((task.missed_streak ?? 0) + 1, 99);

    task.cycle_checked_until = nextIso;
    task.missed_streak = streak;
    await recordCycleRollover(task.id, nextIso, streak);
    changed = true;
  }

  return changed;
}

/** Completing anything clears the slate immediately — the easing is not a
 *  punishment to be worked off. */
export function clearMissedStreak(task: Task) {
  task.missed_streak = 0;
}