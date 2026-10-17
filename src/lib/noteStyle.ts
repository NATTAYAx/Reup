// ─── noteStyle.ts — which way every note is drawn ────────────────────────────
//
// One setting for every note, bright, muted or dark, picked in the appearance
// tab and kept in user_settings so the phone draws its notes the same way. The
// colour of each sheet stays with the sheet; this is only how strong the
// colours are (lib/notes.ts has the papers, pinned in store-vectors.json).
//
// Read from the localStorage cache like every other synced setting, because
// the boards draw synchronously; lib/userSettings.ts is where that is argued.
// Three ways for the cache to move, and the hook listens for all three: a pick
// in this window (an event of our own, since a window does not hear its own
// storage writes), a pick in the other window (the storage event), and a sync
// that brought the phone's pick (dataChanged, after hydrateSettings).

import { useEffect, useState } from "react";
import { onDataChanged } from "./dataChanged";
import { NOTE_STYLES, noteStyle, type NoteStyle } from "./notes";
import { NOTE_STYLE_KEY } from "./settingKeys";
import { putSetting } from "./userSettings";

const PICKED = "reup-note-style";

function stored(): string | null {
  try {
    return localStorage.getItem(NOTE_STYLE_KEY);
  } catch {
    return null;
  }
}

/** The style the cache holds, or the default when it holds nothing this version knows. */
export function getNoteStyle(): NoteStyle {
  return noteStyle(stored());
}

/** Here at once, and in the row the phone reads. */
export function setNoteStyle(style: NoteStyle): void {
  putSetting(NOTE_STYLE_KEY, style);
  window.dispatchEvent(new Event(PICKED));
}

/**
 * The style, following every change to it. A name this version does not know
 * - one a later version added, picked on the phone - is not a change this
 * window can draw, so the style already on screen stays, as on the phone.
 */
export function useNoteStyle(): NoteStyle {
  const [style, setStyle] = useState<NoteStyle>(getNoteStyle);
  useEffect(() => {
    const again = () => {
      const raw = stored();
      if (raw === null || (NOTE_STYLES as readonly string[]).includes(raw)) setStyle(noteStyle(raw));
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === NOTE_STYLE_KEY) again();
    };
    window.addEventListener(PICKED, again);
    window.addEventListener("storage", onStorage);
    const off = onDataChanged(tables => {
      if (tables.has("user_settings")) again();
    });
    return () => {
      window.removeEventListener(PICKED, again);
      window.removeEventListener("storage", onStorage);
      off();
    };
  }, []);
  return style;
}
