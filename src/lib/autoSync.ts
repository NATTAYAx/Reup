// ─── autoSync.ts — the button, pressed by nobody ─────────────────────────────
//
// Until now a sync only happened when someone pressed a button, on both
// devices. That makes two databases that agree only as often as somebody
// remembers to make them agree — which is the same failure mode as any feature
// that depends on remembering, and this app's own notes say those do not work
// for the person using it.
//
// WHY THIS COULD NOT BE WRITTEN EARLIER
//
// It was deliberately left out while completion was decided by "furthest
// along", because under that rule taking a tick back could not travel: the
// other device handed the old tick straight back on the next run. A timer on
// top of that would not have been a convenience, it would have been the bug
// happening by itself, faster, with nobody pressing anything to blame. The
// merge rule had to be able to express undo first. It can now.
//
// WHY IT IS SILENT
//
// Nothing here reports success. A sync that worked is the absence of news, and
// a toast every few minutes saying two databases still agree is a notification
// that teaches people to ignore notifications — which is expensive in an app
// whose one job is to be worth reading. Failures are not announced either: the
// settings card already shows the last outcome, and a person who is not looking
// at the sync card cannot act on a sync problem anyway. The one thing a
// failure changes here is how soon the next attempt happens.

import { getDb } from "./database";
import { syncNow } from "./sync/config";
import { TauriHttpTransport } from "./sync/transport";
import { driveTokenSource } from "./sync/googleAuth";

/**
 * How long between attempts when everything is working.
 *
 * Five minutes rather than thirty seconds because nothing here is urgent: the
 * desktop is the device that is already in front of the person, and the row it
 * is waiting for was written on a phone that has to be opened before it can
 * send anything anyway. Five minutes rather than an hour because the whole
 * complaint that started this was having to press a button to see a tick made
 * two rooms away.
 */
const EVERY_MS = 5 * 60_000;

/**
 * And how often to ask whether there is anything OF OUR OWN waiting to go.
 *
 * Five minutes is a fine gap for hearing about somebody else's change and a
 * terrible one for announcing your own. Without this, ticking something here
 * sat in the outbox until the next five minute boundary — an average of two and
 * a half minutes before the other device could even see it, which is exactly
 * the delay this was reported as.
 *
 * The check is a COUNT against a local table, not a request. Nothing touches
 * the network unless the queue actually has something in it, so asking this
 * often costs a query every two seconds against a table that is usually empty
 * — cheaper than the render this app already does every second.
 */
const OUTGOING_CHECK_MS = 2_000;

/**
 * How often to ask the folder while this window has focus.
 *
 * Not five seconds: unlike the queue check this one is a real request, and a
 * desktop left open all day would make seventeen thousand of them. Ten is close
 * enough to feel immediate for someone who has just put a phone down, and small
 * enough that the cost is bounded by how long a person actually sits here.
 */
const WATCHED_MS = 10_000;

/**
 * And after a failure.
 *
 * A flat retry is what turns "the wifi is off" into a request every five
 * minutes for the rest of the day, and "the token was revoked" into the same
 * rejected call for ever. Doubling up to an hour keeps a broken connection
 * cheap, and any success puts it straight back to the normal rhythm.
 */
const BACKOFF_START_MS = 60_000;
const BACKOFF_MAX_MS = 60 * 60_000;

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let backoffMs = 0;

/**
 * One attempt.
 *
 * Exported because pressing the button should also count as the most recent
 * attempt: a person who has just synced by hand should not have an automatic
 * one land a second later.
 *
 * Returns nothing and throws nothing. A caller that wants to know the outcome
 * has the sync card for it.
 */
export async function attemptSync(): Promise<void> {
  // Not a nicety. Two overlapping runs would both reserve a sequence number and
  // both write, and the engine's guarantees are written for one run at a time.
  if (running) return;
  running = true;
  try {
    const db = await getDb();
    const http = new TauriHttpTransport();
    // Undefined for WebDAV, and for Drive when nobody has signed in here, which
    // syncNow reads as "not set up" and returns null for. Not being set up is
    // not a failure, so it must not trigger the backoff.
    const report = await syncNow(db, http, await driveTokenSource(db, http));
    backoffMs = report === null ? backoffMs : 0;
  } catch {
    backoffMs = backoffMs === 0 ? BACKOFF_START_MS : Math.min(backoffMs * 2, BACKOFF_MAX_MS);
  } finally {
    running = false;
  }
}

/** Whether this device is holding anything it has not sent. */
async function hasOutgoing(): Promise<boolean> {
  try {
    const db = await getDb();
    const rows = await db.select<{ n: number }[]>("SELECT COUNT(*) AS n FROM sync_outbox");
    return (rows[0]?.n ?? 0) > 0;
  } catch {
    // A database that cannot be read is not a reason to sync, and the periodic
    // run will report the real problem soon enough.
    return false;
  }
}

let sinceFullMs = 0;

/**
 * One clock, two rhythms: a short tick that mostly does nothing, and a full
 * attempt when either enough time has passed or there is news to announce.
 *
 * WHY THE QUEUE CHECK IS INSIDE THE BACKOFF AND NOT BESIDE IT
 *
 * The obvious spelling is "sync if it is due, OR if something is queued", which
 * quietly means the backoff only applies when there is nothing to send — the
 * one case that does not need it. Every failure that matters happens with rows
 * waiting, and there that version would retry every five seconds for as long as
 * the failure lasted. Against Google that is not a retry, it is asking to be
 * rate limited, and a 429 used to be read one layer down as a dead grant.
 *
 * So the queue decides how SOON the next attempt may be, not whether the
 * backoff counts: five seconds when healthy, and the backoff when not.
 */
function schedule(delay: number): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    void (async () => {
      sinceFullMs += delay;
      // A window somebody is looking at is worth asking for far more often
      // than one buried behind a browser. Same reasoning as the phone only
      // polling while its screen is on: attention is the licence.
      const wait = backoffMs || (document.hasFocus() ? WATCHED_MS : EVERY_MS);
      if (sinceFullMs >= wait || (backoffMs === 0 && (await hasOutgoing()))) {
        sinceFullMs = 0;
        await attemptSync();
      }
      schedule(OUTGOING_CHECK_MS);
    })();
  }, delay);
}

/**
 * Start the loop. Returns the stop, so an effect can hand it back to React.
 *
 * The first attempt is delayed rather than immediate. Opening the app already
 * has a database to migrate, a window to draw and a queue of alarms to work
 * out, and adding a network call to that list buys nothing: nobody has read the
 * list yet.
 *
 * A window regaining focus is worth an attempt of its own, because the gap
 * between putting the phone down and coming back to the desk is exactly the gap
 * this is closing. It is rate-limited by the same running flag, so leaning on
 * alt-tab does not produce a run per press.
 */
export function startAutoSync(): () => void {
  schedule(10_000);

  const onFocus = () => {
    if (!running) {
      sinceFullMs = 0;
      void attemptSync();
    }
  };
  window.addEventListener("focus", onFocus);

  return () => {
    if (timer) clearTimeout(timer);
    timer = null;
    window.removeEventListener("focus", onFocus);
  };
}