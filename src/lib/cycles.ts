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

// ─── asking for the smallest version, once, at the moment it is relevant ─────
//
// isEased has always been an AND of two things, and only one of them was ever
// filled in by anybody. Every task that has been missed twice and has no
// smallest version written down falls through it silently and gets the full ask
// on the worst day for it.
//
// That is not a gap in the rule, it is a gap in when the question was asked.
// Nothing has ever asked for min_step except the create and edit forms, which
// means it gets filled in only by somebody who, while making a task, thinks
// ahead to a day when they will not manage it. That is a specific state to be
// in and not a common one. The task typed at three in the morning on half a
// tank is the one with no smallest version, and it is the same task that will
// be missed twice first.
//
// So the question moves to where it is relevant: after two, on the card itself,
// once.
//
// WHY IT MUST NOT MENTION THE MISSES
//
// The point of the ask is to lower a demand, not to report a record. A card
// that says "you have missed this twice, want to make it smaller?" has said the
// first half out loud, and the first half is the part that costs something to
// read. Nothing in this app counts misses on screen and this does not start.
//
// WHY DECLINING IS REMEMBERED, AND WHERE
//
// Asked twice is nagging, and a prompt that reappears every time the card is
// drawn is a prompt that gets scrolled past on purpose — at which point it is
// furniture rather than an offer.
//
// Kept in localStorage rather than a column because it is not a fact about the
// task, it is a fact about a conversation that happened on a screen. It does
// not sync for the same reason: the phone has no version of this ask, so there
// is nothing there for it to be consistent with. A machine that forgets and
// asks once more some day is an acceptable cost; a schema change is not.

const K_DECLINED = "gamesched_ease_declined_v1";

/** Whichever id is stable. uid crosses devices; the row id does not. */
function keyOf(task: Task): string {
  const uid = (task as unknown as { uid?: string }).uid;
  return uid && uid.trim() ? uid : `id:${task.id}`;
}

function declinedSet(): Set<string> {
  try {
    const raw = localStorage.getItem(K_DECLINED);
    const v: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(v) ? v.filter(x => typeof x === "string") : []);
  } catch {
    // Unreadable is the same as empty here. The worst that costs is one more
    // offer, which is a far better failure than a card that throws while
    // drawing itself.
    return new Set();
  }
}

/** Never offer this one again on this machine. */
export function declineEase(task: Task): void {
  try {
    const set = declinedSet();
    set.add(keyOf(task));
    localStorage.setItem(K_DECLINED, JSON.stringify([...set]));
  } catch { /* full */ }
}

/**
 * Whether this card should offer to make the ask smaller.
 *
 * Repeating kinds only, for the reason REPEATING already gives: a one-off that
 * has gone past is late, and shrinking a deadline because it passed is a lie
 * about the world rather than a kindness.
 */
export function needsMinStep(task: Task): boolean {
  if (!REPEATING.has(task.reset_type)) return false;
  if ((task.missed_streak ?? 0) < EASE_AFTER) return false;
  if (task.min_step?.trim()) return false;
  return !declinedSet().has(keyOf(task));
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