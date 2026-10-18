// ─── notes.ts — what is stuck on the home screen ─────────────────────────────
//
// A note is a line or two somebody writes so as not to forget it, the way a
// note goes on a fridge door. It has no cycle, no time and no category, and
// nothing anywhere counts how long it has been up. It stays where it can be
// seen until it is taken off, and taking it off is the end of it.
//
// WHY THE RULES ARE WRITTEN DOWN TWICE AND PINNED
//
// The phone writes the same table (Notes.kt, NoteRepo.kt), so every statement
// below and the one rule about what a note may say are also in Kotlin. They are
// emitted into store-vectors.json by gen-store-vectors and compared string by
// string on the phone, which is the only way two copies stay one rule.
//
// WHY TAKING ONE OFF BLANKS IT
//
// A note that is taken off becomes a tombstone, and a tombstone travels: it
// sits in the sync folder and on the other machine until the sweep, a month
// later. What it said has no reason to travel with it. Bringing one back from
// the undo straight after takes the words from the screen that still has them.

import type Database from "@tauri-apps/plugin-sql";

/** The papers, in the order the picker shows them. The first is what an unknown name is drawn as. */
export const NOTE_COLORS = ["yellow", "pink", "blue", "green", "purple"] as const;
export type NoteColor = (typeof NOTE_COLORS)[number];

/**
 * Each paper, and the ink on it. One ink for all of them, dark enough for every
 * paper to clear 7:1 - a note is read in a glance, from across a room.
 */
export const NOTE_PAPER: Record<NoteColor, string> = {
  yellow: "#FFF0A0",
  pink: "#FFCADC",
  blue: "#C9E5FF",
  green: "#D4F2C4",
  purple: "#E3D6FF",
};
export const NOTE_INK = "#2A2633";

// ─── how the papers look ─────────────────────────────────────────────────────
//
// One setting for every note, picked by the person and synced like the theme
// (NOTE_STYLE_KEY): the five papers as they come, a little dimmer, or dark.
// The bright ones are the most like a real note and the brightest thing in a
// dark app by far, which at night is a glare; the dim ones keep the paper and
// lose the glare; the dark ones sit in the theme and keep only the colour, as
// the ink and an edge. Each note still keeps its own colour. Every pairing
// clears 8 to 1, and the phone holds the same table (Notes.kt), pinned by the
// store vectors.

/** In picker order. The names are what is stored. */
export const NOTE_STYLES = ["bright", "muted", "dark"] as const;
export type NoteStyle = (typeof NOTE_STYLES)[number];

/** What a note looks like before anybody has picked. */
export const NOTE_STYLE_DEFAULT: NoteStyle = "muted";

/** Each style's paper and ink for each colour. */
export const NOTE_LOOKS: Record<NoteStyle, Record<NoteColor, { paper: string; ink: string }>> = {
  bright: {
    yellow: { paper: NOTE_PAPER.yellow, ink: NOTE_INK },
    pink: { paper: NOTE_PAPER.pink, ink: NOTE_INK },
    blue: { paper: NOTE_PAPER.blue, ink: NOTE_INK },
    green: { paper: NOTE_PAPER.green, ink: NOTE_INK },
    purple: { paper: NOTE_PAPER.purple, ink: NOTE_INK },
  },
  muted: {
    yellow: { paper: "#E3D58C", ink: NOTE_INK },
    pink: { paper: "#E0B6C4", ink: NOTE_INK },
    blue: { paper: "#B4CAE0", ink: NOTE_INK },
    green: { paper: "#BCD5B0", ink: NOTE_INK },
    purple: { paper: "#C8BDE2", ink: NOTE_INK },
  },
  dark: {
    yellow: { paper: "#2A2817", ink: "#FDE68A" },
    pink: { paper: "#2E1A24", ink: "#FBCFE8" },
    blue: { paper: "#172436", ink: "#BFDBFE" },
    green: { paper: "#18291F", ink: "#BBF7D0" },
    purple: { paper: "#231D38", ink: "#DDD6FE" },
  },
};

/** A style this version knows, the default for anything else. */
export function noteStyle(raw: unknown): NoteStyle {
  return (NOTE_STYLES as readonly string[]).includes(raw as string) ? (raw as NoteStyle) : NOTE_STYLE_DEFAULT;
}

/**
 * One note's paper and ink in [style]. Dark paper also draws an edge and a
 * strip of tape in its ink, since a dark square on a dark screen needs
 * something to say where it ends.
 */
export function noteLook(style: NoteStyle, color: NoteColor): { paper: string; ink: string; dark: boolean } {
  const l = NOTE_LOOKS[style][color];
  return { paper: l.paper, ink: l.ink, dark: style === "dark" };
}

/** About what fits on a square of paper in a hand you can still read. */
export const NOTE_MAX_CHARS = 120;

/** How many the boards show at once; the rest are counted. */
export const NOTES_SHOWN = 3;

/**
 * How far apart a note's lines are, in em. Mali stacks a tone mark on an upper
 * vowel as high as 1.45 em and hangs ุ and ู 0.41 em under the line, so lines
 * any closer run one line's marks into the vowels under the line above, as
 * they did at 1.33. The phone's is the same number (Notes.kt).
 */
export const NOTE_LEAD = 1.6;

export interface Note {
  id: number;
  uid: string;
  body: string;
  color: NoteColor;
  /** "YYYY-MM-DD HH:MM:SS", the column's own default. Only ever compared. */
  createdAt: string;
}

/** Newest first: the last thing stuck up is the one nearest the eye. */
export const SQL_LIVE_NOTES =
  "SELECT id, uid, body, color, created_at FROM notes " +
  "WHERE deleted = 0 AND uid IS NOT NULL ORDER BY created_at DESC, uid DESC";

/** created_at is left to its default, so both machines write it in one format. */
export const SQL_ADD_NOTE = "INSERT INTO notes (body, color) VALUES (?, ?)";

export const SQL_EDIT_NOTE = "UPDATE notes SET body = ?, color = ? WHERE uid = ? AND deleted = 0";

/** Off, and blank. See the header. */
export const SQL_PEEL_NOTE = "UPDATE notes SET deleted = 1, body = '' WHERE uid = ? AND deleted = 0";

/** The undo: back up, with the words the screen still had. */
export const SQL_UNPEEL_NOTE =
  "UPDATE notes SET deleted = 0, body = ?, color = ? WHERE uid = ? AND deleted = 1";

/**
 * What a note says, or null for nothing worth sticking up.
 *
 * Each line trimmed, blank lines dropped - a square of paper has no room for
 * paragraphs - and the whole cut at NOTE_MAX_CHARS. Nothing else: it is
 * somebody's own words, and an app that tidies them is an app with opinions
 * about how people write to themselves. Cut by code point, so a cut never
 * lands inside an emoji.
 */
export function noteBody(raw: string): string | null {
  const text = raw
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .join("\n");
  if (text === "") return null;
  const points = [...text];
  return points.length <= NOTE_MAX_CHARS ? text : points.slice(0, NOTE_MAX_CHARS).join("").trimEnd();
}

/**
 * What a note's box holds once typing has turned `was` into `now`, if `now` is
 * longer than a note may be: what was there already stays, and of what came in
 * - a paste, most likely - as much as fits, cut where noteBody counts. With
 * where the cursor goes, after what came in. Null when `now` fits as it is.
 * The phone's box does the same (Notes.kt, noteTyped).
 */
export function noteTyped(was: string, now: string): { text: string; cursor: number } | null {
  if ([...now].length <= NOTE_MAX_CHARS) return null;
  const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
  const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;
  // What came in lies between the part the two start with and the part they
  // end with; neither edge may fall inside an emoji.
  const shorter = Math.min(was.length, now.length);
  let start = 0;
  while (start < shorter && was.charCodeAt(start) === now.charCodeAt(start)) start++;
  if (start > 0 && isHigh(now.charCodeAt(start - 1))) start--;
  let end = 0;
  while (end < shorter - start && was.charCodeAt(was.length - 1 - end) === now.charCodeAt(now.length - 1 - end)) end++;
  if (end > 0 && isLow(now.charCodeAt(now.length - end))) end--;
  const head = now.slice(0, start);
  const tail = now.slice(now.length - end);
  const came = [...now.slice(start, now.length - end)];
  const room = NOTE_MAX_CHARS - [...head].length - [...tail].length;
  const kept = room <= 0 ? "" : came.slice(0, room).join("");
  const text = head + kept + tail;
  const points = [...text];
  // Only if what was there was already too long, which typing cannot make.
  if (points.length > NOTE_MAX_CHARS) {
    const cut = points.slice(0, NOTE_MAX_CHARS).join("");
    return { text: cut, cursor: cut.length };
  }
  return { text, cursor: head.length + kept.length };
}

/** A paper this version knows, the first for anything else. */
export function noteColor(raw: unknown): NoteColor {
  return (NOTE_COLORS as readonly string[]).includes(raw as string) ? (raw as NoteColor) : NOTE_COLORS[0];
}

/** How far each note leans, in degrees; which one is picked by the note's uid. */
export const NOTE_TILTS = [-3, 2, -1.5, 3, -2.5, 1.5] as const;

/**
 * A few degrees either way, the same for one note every time and on both
 * machines. The hash is Java's String.hashCode, which Kotlin has built in, and
 * the index is a floor modulo, which both languages spell out the same way -
 * Math.abs of the smallest int is negative in Kotlin and positive here.
 */
export function noteTilt(uid: string): number {
  let h = 0;
  for (let i = 0; i < uid.length; i++) h = (h * 31 + uid.charCodeAt(i)) | 0;
  const n = NOTE_TILTS.length;
  return NOTE_TILTS[((h % n) + n) % n];
}

// ─── the table ───────────────────────────────────────────────────────────────

type NoteRow = { id: number; uid: string; body: string; color: string; created_at: string | null };

function fromRow(r: NoteRow): Note {
  return { id: r.id, uid: r.uid, body: r.body, color: noteColor(r.color), createdAt: r.created_at ?? "" };
}

export async function liveNotes(db: Database): Promise<Note[]> {
  const rows = await db.select<NoteRow[]>(SQL_LIVE_NOTES);
  return rows.map(fromRow);
}

/** False when there was nothing to stick up. */
export async function addNote(db: Database, raw: string, color: NoteColor): Promise<boolean> {
  const body = noteBody(raw);
  if (body === null) return false;
  await db.execute(SQL_ADD_NOTE, [body, color]);
  return true;
}

/**
 * An edit that leaves nothing written takes the note off rather than keeping a
 * blank one. False when there was no note up to change - taken off on the other
 * machine since the screen last looked.
 */
export async function editNote(db: Database, uid: string, raw: string, color: NoteColor): Promise<boolean> {
  const body = noteBody(raw);
  const done = body === null
    ? await db.execute(SQL_PEEL_NOTE, [uid])
    : await db.execute(SQL_EDIT_NOTE, [body, color, uid]);
  return done.rowsAffected > 0;
}

export async function peelNote(db: Database, uid: string): Promise<void> {
  await db.execute(SQL_PEEL_NOTE, [uid]);
}

export async function unpeelNote(db: Database, note: Note): Promise<void> {
  await db.execute(SQL_UNPEEL_NOTE, [note.body, note.color, note.uid]);
}
