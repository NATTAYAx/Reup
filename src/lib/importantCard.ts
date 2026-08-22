// ─── สิ่งสำคัญ / Important things ─────────────────────────────────────────────
//
// Two jobs, deliberately kept in one file because the second one is useless
// without the first.
//
//   1. A short list the person writes themselves — names, numbers, and a note.
//      Deliberately NOT called a "safety plan" or a "crisis card". A neutral
//      name means everyone fills it in: one person puts their insurance line,
//      another their landlord, another a friend. The app does not need to know
//      which, and should not.
//
//   2. The rule for what the assistant does when someone types something heavy
//      into it. That is a text box that answers back, sitting on a machine at
//      three in the morning. Whether or not it was designed for that, one day
//      someone types something into it, and right now nothing decides what
//      happens next — the model answers however it sees fit, which is neither
//      specified nor testable.
//
// WHAT THIS DELIBERATELY DOES NOT DO
//
//   No diagnosis. No risk scoring. No screening questions. No follow-up
//   notification. Nothing is sent anywhere — a message that matches is never
//   given to a model, never cached, never written to the usage log.
//
//   And the reply is SHORT and plain, on purpose. A warm, therapeutic tone
//   invites more of the same conversation, which is exactly what this app
//   cannot hold and should not pretend to. The evidence on digital mental
//   health is consistent that what reduces people dropping out is contact with
//   an actual person. So the job here is to make the distance to a real person
//   as short as possible, not to stand in the way of it.

import { personalDaysBetween, personalToday } from "./dateUtil";

const K_CONTACTS = "gamesched_important_v1";
const K_SHOWN    = "gamesched_important_shown";

export interface ImportantContact {
  label: string;
  /** Free text: a phone number, a username, anything. */
  value: string;
}

export interface ImportantCard {
  contacts: ImportantContact[];
  /** Whatever the person wants to read back later, in their own words. */
  note: string;
}

const BLANK: ImportantCard = { contacts: [], note: "" };

export function loadImportant(): ImportantCard {
  try {
    const raw = localStorage.getItem(K_CONTACTS);
    if (!raw) return BLANK;
    const parsed = JSON.parse(raw) as ImportantCard;
    return {
      contacts: Array.isArray(parsed.contacts) ? parsed.contacts : [],
      note: typeof parsed.note === "string" ? parsed.note : "",
    };
  } catch {
    return BLANK;
  }
}

export function saveImportant(card: ImportantCard) {
  try {
    localStorage.setItem(K_CONTACTS, JSON.stringify(card));
    // Editing it is a review. Saving resets the clock so the prompt below never
    // arrives days after the person has just been through the whole card.
    localStorage.setItem(K_REVIEWED, personalToday());
  } catch { /* full */ }
}

// ─── The occasional nudge to look at it ───────────────────────────────────────
//
// A safety plan only works if it gets used, and what predicts it getting used
// is having read it before — rehearsing the review and access is part of the
// intervention, not an optional extra. A card written once and never opened
// again is a card nobody will think to open on the night it matters.
//
// The obvious implementation is a reminder that says "review your crisis plan",
// and that is the wrong one twice over. It labels the person every time it
// appears, and a prompt that arrives often enough to be a habit is a prompt
// nobody reads — the same alarm fatigue that is the reason the distress matcher
// below is quiet and easy to ignore.
//
// So: at most once every 60 days, worded like a bank asking whether your phone
// number still works, dismissible, and never shown to someone who has not
// written anything down yet. If the card is empty there is nothing to review,
// and pestering someone to fill in a crisis card is not this app's business.

const K_REVIEWED = "gamesched_important_reviewed";
const REVIEW_EVERY_DAYS = 60;

export function shouldReviewImportant(): boolean {
  const card = loadImportant();
  if (card.contacts.length === 0 && !card.note.trim()) return false;
  try {
    const last = localStorage.getItem(K_REVIEWED);
    if (!last) { localStorage.setItem(K_REVIEWED, personalToday()); return false; }
    const days = personalDaysBetween(last, personalToday());
    return days >= REVIEW_EVERY_DAYS;
  } catch {
    return false;
  }
}

/** Dismissing counts the same as reviewing. Asking twice is how it stops being
 *  read at all. */
export function markImportantReviewed() {
  try { localStorage.setItem(K_REVIEWED, personalToday()); } catch { /* full */ }
}

// ─── Distress matching ────────────────────────────────────────────────────────
//
// FALSE POSITIVES ARE THE HARD PART, and especially here: this is an app about
// games, where "ตาย" and "ฆ่า" are ordinary vocabulary. "ตายในเกม" and
// "ฆ่าบอสไม่ได้" must never match.
//
// So the patterns are all about the SELF, never a bare word. "อยากตาย" is not
// the same string as "ตาย". Even then Thai uses "อยากตาย" as everyday
// exaggeration for being tired, so a match cannot be treated as an emergency —
// which is the other reason the response is small, quiet, and easy to ignore.
// It is an open door, not an intervention.

// Two tiers, because they are not the same kind of sentence.
//
// SPECIFIC: phrases that are almost never used as exaggeration in either
// language. Nobody says "ฆ่าตัวตาย" about a long shift.
const SPECIFIC: RegExp[] = [
  /ฆ่าตัวตาย/,
  /ทำร้ายตัวเอง/,
  /จบชีวิต/,
  /ไม่อยากมีชีวิต(อยู่)?/,
  /\bkill(ing)?\s+myself\b/i,
  /\bend\s+(my\s+life|it\s+all)\b/i,
  /\bself[-\s]?harm(ing)?\b/i,
  /\bsuicid(e|al)\b/i,
  /\btake\s+my\s+own\s+life\b/i,
];

// AMBIGUOUS: literally the words, but in Thai these are everyday exaggeration
// far more often than not. "เหนื่อยอยากตาย" is a complaint about a shift.
const AMBIGUOUS: RegExp[] = [
  /อยากตาย/,
  /ไม่อยากอยู่(แล้ว)?/,
  /อยากหายไป/,
  /อยู่ไปก็เท่านั้น/,
  /\bwant\s+to\s+die\b/i,
  /\bdon'?t\s+want\s+to\s+(live|be here)\b/i,
];

// The grammar of the joke. Thai puts the intensifier AFTER the state:
// เหนื่อยอยากตาย, หิวอยากตาย, เบื่อจนอยากตาย. Positive ones settle the
// argument that it is not about dying at all — อร่อยอยากตาย, น่ารักอยากตาย.
const INTENSIFIER_BEFORE = new RegExp(
  // ยาก / โหด added after a gaming-context miss: "บอสยากอยากตาย" sits in the
  // same grammatical slot as เหนื่อย and เยอะ — a property of a thing out there,
  // with the death phrase acting as the degree marker.
  "(เหนื่อย|หิว|ง่วง|เบื่อ|ร้อน|หนาว|เมื่อย|ปวด|ขี้เกียจ|เครียด|เพลีย|หนัก|เยอะ|นาน|ช้า|แพง|ยาก|โหด|" +
  "อร่อย|สวย|น่ารัก|ดี|ขำ|สนุก|เจ็บ|งง|ตื่นเต้น|อาย|เขิน|รัก)" +
  "\\s*(จน|จะ)?\\s*$",
);

// English does the same thing with a preceding clause: "this meeting makes me
// want to die", "so tired I want to die".
const INTENSIFIER_EN = /\b(so|this|that|it)\b[^.!?]{0,40}$/i;

function isJoking(text: string, match: RegExpMatchArray | null): boolean {
  if (!match || match.index === undefined) return false;
  const before = text.slice(0, match.index);
  if (INTENSIFIER_BEFORE.test(before)) return true;

  // REMOVED: a rule that treated a sentence-final ว่ะ / โว้ย / วุ้ย / อ่ะ / ดิ
  // as banter. It was wrong, and testing it against real messages showed why.
  //
  // The intensifier rule above earns its place because the word in front
  // genuinely changes what the sentence is about, and there is proof inside the
  // data: อร่อยอยากตาย and น่ารักอยากตาย exist, so the phrase is plainly working
  // as a degree marker rather than as a statement about dying.
  //
  // No such proof exists for the particles. They mark register — blunt,
  // unguarded, talking to someone you do not perform for — and that is closer
  // to how people speak when they mean it than when they do not. "อยากตายว่ะ"
  // is not a softer version of "อยากตาย".
  //
  // The costs are not symmetrical either. A false positive is one card, once
  // per session, and it can be scrolled past. A false negative sends the
  // message off the machine and answers a real moment with whatever a general
  // model says to strangers. Between a bounded annoyance and an unbounded miss,
  // this errs toward the annoyance.
  //
  // Sentences that are genuinely exaggeration still stay silent, because the
  // intensifier rule catches them first: เหนื่อยอยากตายว่ะ and งานเยอะจนอยากตายว่ะ
  // never reach this line.

  if (/[a-z]/i.test(before) && INTENSIFIER_EN.test(before)) return true;
  return false;
}

export function looksHeavy(text: string): boolean {
  const t = text.trim();
  if (!t) return false;

  // Specific phrasing goes straight through; there is no reading of it that is
  // a joke about a long day.
  if (SPECIFIC.some(p => p.test(t))) return true;

  // Ambiguous phrasing only counts when nothing around it says otherwise.
  for (const p of AMBIGUOUS) {
    const m = t.match(p);
    if (m && !isJoking(t, m)) return true;
  }
  return false;
}

/** Once per session is enough. Saying it again on every message would turn a
 *  quiet offer into nagging, and nagging about this is worse than silence. */
export function alreadyOfferedThisSession(): boolean {
  return sessionStorage.getItem(K_SHOWN) === "1";
}
export function markOffered() {
  try { sessionStorage.setItem(K_SHOWN, "1"); } catch { /* ignore */ }
}

/** Thailand's mental health line, shown as a fallback when the person has not
 *  filled in a card of their own. A public phone number is a fact, not advice,
 *  and an empty card at three in the morning is worse than a generic one. */
export const TH_HELPLINE = "1323";