import { Task } from "../types";
import { personalToday } from "./dateUtil";

// ─── weekNote.ts — the only thing that reads the intent bit ───────────────────
//
// One sentence, at most once a week, and only in one situation: every task the
// person answered for is marked "must" and not one is marked "want".
//
// WHAT THIS IS NOT, AND WHY
//
// It is not a score, a ratio, a percentage or a chart. A chart of someone's
// worst month is an object to ruminate on, not information to act on, and the
// evidence on repeated self-measurement is that a meaningful number of people
// end up worrying about the readings or checking them compulsively — while the
// same reviews find mood monitoring does not reliably move symptoms either way.
// So the app collects one bit and says one sentence, or says nothing.
//
// It does not fire on an empty week. Someone who answered nothing has told us
// nothing, and inventing a message out of silence is how an app starts sounding
// like it is keeping an eye on you.
//
// It does not fire on a bad week either — that is the same thing as an empty
// one. It needs at least three answered tasks before it will speak at all, so a
// quiet week stays quiet.
//
// And it never says "you should". It states what the week looks like and stops,
// because the sentence is meant to be noticed and then ignored if it is wrong.

const K_LAST_SHOWN = "gamesched_weeknote_shown";

/** Enough answers that the pattern means something rather than being one tap. */
const MIN_ANSWERED = 3;

/** Monday-based week key, so the note lands once per week rather than rolling. */
function weekKey(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = (dt.getUTCDay() + 6) % 7; // Monday = 0
  dt.setUTCDate(dt.getUTCDate() - dow);
  return dt.toISOString().slice(0, 10);
}

/**
 * Returns true if the "nothing this week was something you wanted" sentence
 * should be shown right now. Reads only the intent bit and the calendar.
 */
export function shouldShowWeekNote(tasks: Task[]): boolean {
  const answered = tasks.filter(t => t.is_active && (t.intent === "want" || t.intent === "must"));
  if (answered.length < MIN_ANSWERED) return false;
  if (answered.some(t => t.intent === "want")) return false;

  try {
    return localStorage.getItem(K_LAST_SHOWN) !== weekKey(personalToday());
  } catch {
    return false;
  }
}

/** Called when it has been shown or dismissed — either way it is done for the
 *  week. Dismissing is not treated differently from reading; nagging a second
 *  time is exactly how a sentence like this stops being read at all. */
export function markWeekNoteShown() {
  try { localStorage.setItem(K_LAST_SHOWN, weekKey(personalToday())); } catch { /* full */ }
}