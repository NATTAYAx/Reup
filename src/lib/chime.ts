// ─── chime.ts — whether a reminder may make a sound ──────────────────────────
//
// A leaf module, read in two windows: the settings screen writes it, the
// notification overlay reads it. Same origin, so the same localStorage, and it
// imports nothing so check-sync can read it under plain node.
//
// ─── WHY THIS IS A SECOND SWITCH AND NOT THE FIRST ONE RELABELLED ────────────
//
// The switch above it in the settings turns notifications off entirely: no
// card, no sound, nothing in the log. That is the right tool for "I do not want
// to hear about tasks at all" and the wrong one for "I am in the room and the
// chime makes me jump". The second wants the card without the noise.
//
// The first switch was labelled "ปิดเสียง" in Thai, which said sound and did
// everything. That label was half of why "is this a bug?" had no answer: the
// obvious control for the sound was the one that removed the reminder.
//
// This is the desktop's version of what the phone has done from the start. Its
// notification channel has no sound at all and vibrates instead, which is why
// a sound in this house at midnight can only have come from this machine.
//
// ─── WHY IT DOES NOT TRAVEL ──────────────────────────────────────────────────
//
// It describes this machine's speakers, not the person. The phone has no
// sound to switch off. It is deliberately absent from SYNCED_SETTING_KEYS, and
// check-sync says so out loud, for the same reason the mute switch stays
// local: a mute that travelled would silence the one device that was working.

/** The key, exported so the registry and the checker can name it. */
export const CHIME_KEY = "gamesched_notif_chime_v1";

/**
 * On unless somebody turned it off.
 *
 * Absent means on, so every install that predates the switch keeps the sound
 * it had. And anything unreadable is on as well: the failure that silences a
 * reminder nobody asked to silence is the worse of the two to pick.
 */
export function chimeOn(): boolean {
  try {
    return localStorage.getItem(CHIME_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setChimeOn(on: boolean): void {
  try {
    localStorage.setItem(CHIME_KEY, on ? "on" : "off");
  } catch {
    /* quota — the switch reads as on, which is where it started */
  }
}

// ─── who may ring through quiet hours ────────────────────────────────────────
//
// Quiet hours are an instruction the person gave, standing and on purpose. The
// phone and the desktop both follow the pattern every phone platform settled
// on: during them a reminder still arrives, on time, and waits in the list -
// nothing is dropped - but it does not make a sound. Exceptions exist, and the
// person chooses them in advance, one thing at a time.
//
// Here the thing is a task, and the choice is tasks.ring_in_quiet. Two
// instructions from the same person, one general ("quiet at night") and one
// specific ("this one may wake me"), and the specific one wins.
//
// Even then, only the last call rings. A task due at 02:00 gets four hours of
// notice, and the notice that opens at 22:00 is not worth a sound in the middle
// of somebody's night - the one ten minutes before it is. That is what an alarm
// clock does: it rings at the time, not four hours early to say the time is
// coming.

/** Whether a task asked to be let through. Reads the column the way SQLite,
 *  the forms and a synced row each hand it over. */
export function ringsThroughQuiet(v: unknown): boolean {
  return v === true || v === 1 || v === "1";
}

/**
 * Whether quiet hours take this reminder's sound.
 *
 * @param inQuiet    the moment it fires falls inside quiet hours
 * @param ringInQuiet the task's ring_in_quiet, in whatever shape it arrived
 * @param lastCall   this is the last warning before the deadline - the
 *                   ten-minute one, or the only one when the notice window is
 *                   that short anyway
 */
export function quietTakesSound(inQuiet: boolean, ringInQuiet: unknown, lastCall: boolean): boolean {
  if (!inQuiet) return false;
  return !(ringsThroughQuiet(ringInQuiet) && lastCall);
}