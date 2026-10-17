// ─── useNotes.ts — the notes, for the main window ────────────────────────────
//
// What is up, and the things that change it. Every change ends the same way:
// the list read again, and the board on the desktop sent its copy. A note that
// arrives from the phone comes in through dataChanged, like any synced row, and
// ends the same way too.
//
// THE UNDO
//
// Taking a note off blanks its words in the database (see lib/notes), so they
// are kept here, in memory, for ten minutes - long enough to notice a slip of
// the mouse, short enough not to become a record of what was taken off. Only the
// last one: an undo that reaches further back is a bin, and a note is meant to
// leave nothing behind once it is gone.

import { useCallback, useEffect, useState } from "react";
import { getDb } from "../lib/database";
import { onDataChanged } from "../lib/dataChanged";
import { sendToWidget } from "../lib/widgetFeed";
import {
  addNote, editNote, liveNotes, noteBody, peelNote, unpeelNote,
  type Note, type NoteColor,
} from "../lib/notes";

/** How long a note taken off can be put back. The phone keeps its own for as long. */
export const PEEL_UNDO_MS = 10 * 60_000;

export interface NotesApi {
  notes: Note[];
  /** The last one taken off on this machine, while it can still be put back. */
  peeled: Note | null;
  /** False when there was nothing written to stick up. */
  add(raw: string, color: NoteColor): Promise<boolean>;
  /** False when the note had already been taken off, on the other machine. */
  edit(note: Note, raw: string, color: NoteColor): Promise<boolean>;
  peel(note: Note): Promise<void>;
  unpeel(): Promise<void>;
  forgetPeeled(): void;
}

export function useNotes(): NotesApi {
  const [notes, setNotes] = useState<Note[]>([]);
  const [peeled, setPeeled] = useState<{ note: Note; at: number } | null>(null);

  const reload = useCallback(async () => {
    try {
      setNotes(await liveNotes(await getDb()));
    } catch (err) {
      console.error("[notes] could not read the notes:", err);
    }
  }, []);

  /** After any change, from here or from the phone. */
  const changed = useCallback(async () => {
    await reload();
    void sendToWidget();
  }, [reload]);

  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => onDataChanged(tables => {
    if (tables.has("notes")) void changed();
  }), [changed]);

  // The undo runs out by itself.
  useEffect(() => {
    if (!peeled) return;
    const left = PEEL_UNDO_MS - (Date.now() - peeled.at);
    if (left <= 0) {
      setPeeled(null);
      return;
    }
    const timer = window.setTimeout(() => setPeeled(null), left);
    return () => clearTimeout(timer);
  }, [peeled]);

  const add = useCallback(async (raw: string, color: NoteColor) => {
    const ok = await addNote(await getDb(), raw, color);
    if (ok) await changed();
    return ok;
  }, [changed]);

  const peel = useCallback(async (note: Note) => {
    await peelNote(await getDb(), note.uid);
    setPeeled({ note, at: Date.now() });
    await changed();
  }, [changed]);

  const edit = useCallback(async (note: Note, raw: string, color: NoteColor) => {
    const ok = await editNote(await getDb(), note.uid, raw, color);
    // Every word rubbed out is the note taken off, with the same way back.
    if (ok && noteBody(raw) === null) setPeeled({ note, at: Date.now() });
    await changed();
    return ok;
  }, [changed]);

  const unpeel = useCallback(async () => {
    if (!peeled) return;
    await unpeelNote(await getDb(), peeled.note);
    setPeeled(null);
    await changed();
  }, [peeled, changed]);

  const forgetPeeled = useCallback(() => setPeeled(null), []);

  return { notes, peeled: peeled?.note ?? null, add, edit, peel, unpeel, forgetPeeled };
}
