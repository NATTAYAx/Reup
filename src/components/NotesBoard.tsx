import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Check, Plus, X } from "lucide-react";
import { t } from "../lib/i18n";
import {
  NOTE_COLORS, NOTE_MAX_CHARS, noteBody, noteColor, noteLook, noteTilt, noteTyped,
  type Note, type NoteColor,
} from "../lib/notes";
import { useNoteStyle } from "../lib/noteStyle";
import { Tape, paperEdge, paperFill, paperShadow, type NoteLook } from "./NotePaper";
import type { NotesApi } from "../hooks/useNotes";

// ─── NotesBoard ──────────────────────────────────────────────────────────────
//
// The notes that are up, as squares of paper at the top of the list - the same
// papers, the same lean and the same hand as on the phone and on the desktop
// board, so a note looks like one piece of paper wherever it is seen. A click
// opens one to change it; the round button on its corner takes it off.
//
// NOTHING WHEN THERE IS NOTHING
//
// No empty row waiting to be filled: with no notes up, the board is not there,
// and the note button in the header is the way in. A row of blank paper at the
// top of the list would be one more thing asking to be dealt with, which is the
// opposite of what a note is for.
//
// THE UNDO
//
// Taking one off says so in a line under the row, with the way back, for ten
// minutes (hooks/useNotes). The click that took it off cost nothing to make, so
// the one that brings it back must not cost more.
//
// THE STYLE
//
// Every note is drawn bright, muted or dark, one setting for all of them
// (lib/noteStyle); how a sheet looks in each is NotePaper's business.

/** The tick's disc: white on light paper, dark on dark paper, so the tick is always the paper's ink. */
function tickStyle(look: NoteLook): CSSProperties {
  return look.dark
    ? { background: "rgba(31,36,51,0.95)", border: "1px solid rgba(255,255,255,0.25)", boxShadow: "0 1px 3px rgba(0,0,0,0.45)" }
    : { background: "#fff", border: `1px solid color-mix(in srgb, ${look.ink} 25%, transparent)`, boxShadow: "0 1px 3px rgba(0,0,0,0.3)" };
}

function paperName(color: NoteColor): string {
  switch (color) {
    case "yellow": return t("notes.yellow");
    case "pink": return t("notes.pink");
    case "blue": return t("notes.blue");
    case "green": return t("notes.green");
    case "purple": return t("notes.purple");
  }
}

/** One line of a note, for a label or the undo line. */
const oneLine = (body: string) => body.replace(/\n/g, " ");

interface BoardProps {
  api: NotesApi;
  onOpen: (note: Note) => void;
  onAdd: () => void;
}

export function NotesBoard({ api, onOpen, onAdd }: BoardProps) {
  const { notes, peeled } = api;
  const style = useNoteStyle();
  if (notes.length === 0 && !peeled) return null;

  const peel = (note: Note) => {
    api.peel(note).catch(err => console.error("[notes] could not take a note off:", err));
  };
  const unpeel = () => {
    api.unpeel().catch(err => console.error("[notes] could not put a note back:", err));
  };

  return (
    <div className="mb-3 shrink-0">
      {notes.length > 0 && (
        <div className="flex gap-4 overflow-x-auto px-1 pt-1 pb-3">
          {notes.map(note => {
            const look = noteLook(style, note.color);
            return (
            <div key={note.uid} className="relative shrink-0 transition-transform duration-150 hover:-translate-y-0.5" style={{ width: 138, height: 106, paddingTop: 8, paddingRight: 8 }}>
              <button
                onClick={() => onOpen(note)}
                title={t("notes.edit")}
                aria-label={t("notes.open", { body: oneLine(note.body) })}
                className="note-hand relative flex flex-col justify-start items-stretch w-full h-full text-left rounded-[3px] focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                style={{
                  background: paperFill(look),
                  border: paperEdge(look),
                  color: look.ink,
                  transform: `rotate(${noteTilt(note.uid)}deg)`,
                  boxShadow: paperShadow(look),
                  padding: look.dark ? "8px 10px" : "9px 11px",
                }}
              >
                {look.dark && <Tape ink={look.ink} />}
                <span
                  className="block overflow-hidden"
                  style={{
                    fontSize: 15,
                    lineHeight: 1.33,
                    display: "-webkit-box",
                    WebkitLineClamp: 4,
                    WebkitBoxOrient: "vertical",
                    whiteSpace: "pre-line",
                    overflowWrap: "anywhere",
                  }}
                >
                  {note.body}
                </span>
              </button>
              <button
                onClick={() => peel(note)}
                title={t("notes.peel")}
                aria-label={t("notes.peelOne", { body: oneLine(note.body) })}
                className="absolute top-0 right-0 w-6 h-6 rounded-full flex items-center justify-center transition-transform hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                style={tickStyle(look)}
              >
                <Check size={13} strokeWidth={2.6} color={look.ink} />
              </button>
            </div>
            );
          })}
          <button
            onClick={onAdd}
            title={t("notes.add")}
            className="shrink-0 mt-2 rounded-[3px] border border-dashed border-white/15 text-white/35 hover:text-white/70 hover:border-white/35 transition-colors flex flex-col items-center justify-center gap-1.5"
            style={{ width: 96, height: 96 }}
          >
            <Plus size={18} />
            <span className="text-[11px] font-medium">{t("notes.add")}</span>
          </button>
        </div>
      )}
      {peeled && (
        <div className="flex items-center gap-3 px-1 text-xs">
          <p className="min-w-0 truncate text-white/40">{t("notes.peeled", { body: oneLine(peeled.body) })}</p>
          <button onClick={unpeel} className="shrink-0 font-semibold theme-accent hover:opacity-80 transition-opacity">
            {t("notes.undo")}
          </button>
          <div className="flex-1" />
          <button onClick={api.forgetPeeled} className="shrink-0 p-1 rounded-md text-white/30 hover:text-white/70 transition-colors" aria-label={t("week.dismiss")}>
            <X size={12} />
          </button>
        </div>
      )}
    </div>
  );
}

// ─── NoteEditor ──────────────────────────────────────────────────────────────
//
// Writing on the paper itself rather than in a box under a picture of it: the
// words and where they are written are one thing, and one field is one thing
// to look at for somebody who opened this to get a thought out of their head
// before it goes.

interface EditorProps {
  open: boolean;
  /** The note to change, or null to write a new one. */
  note: Note | null;
  api: NotesApi;
  onClose: () => void;
}

export function NoteEditor({ open, note, api, onClose }: EditorProps) {
  const style = useNoteStyle();
  const [text, setText] = useState("");
  const [color, setColor] = useState<NoteColor>(NOTE_COLORS[0]);
  /** The note being changed; null once it turns out to be gone, and the words go up as a new one. */
  const [editing, setEditing] = useState<Note | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const cursor = useRef<number | null>(null);

  useEffect(() => {
    if (!open) return;
    setText(note?.body ?? "");
    setColor(note ? noteColor(note.color) : NOTE_COLORS[0]);
    setEditing(note);
    setBusy(false);
    setProblem(null);
  }, [open, note]);

  // After a paste was cut to fit, the cursor goes after what went in.
  useLayoutEffect(() => {
    const at = cursor.current;
    if (at === null || !box.current) return;
    cursor.current = null;
    box.current.setSelectionRange(at, at);
  });

  const close = () => {
    if (!busy) onClose();
  };

  const type = (now: string) => {
    setProblem(null);
    const cut = noteTyped(text, now);
    if (cut === null) {
      setText(now);
      return;
    }
    cursor.current = cut.cursor;
    setText(cut.text);
  };

  const save = async () => {
    if (busy) return;
    if (noteBody(text) === null && !editing) {
      setProblem(t("notes.empty"));
      return;
    }
    setBusy(true);
    try {
      if (editing) {
        const ok = await api.edit(editing, text, color);
        if (!ok) {
          setEditing(null);
          setProblem(t("notes.gone"));
          setBusy(false);
          return;
        }
      } else {
        await api.add(text, color);
      }
      setBusy(false);
      onClose();
    } catch (err) {
      setProblem(t("notes.failed", { msg: err instanceof Error ? err.message : String(err) }));
      setBusy(false);
    }
  };

  const peel = async () => {
    if (!editing || busy) return;
    setBusy(true);
    try {
      await api.peel(editing);
      setBusy(false);
      onClose();
    } catch (err) {
      setProblem(t("notes.failed", { msg: err instanceof Error ? err.message : String(err) }));
      setBusy(false);
    }
  };

  // Esc closes and Ctrl+Enter sticks it up, wherever the focus is, matching
  // every other overlay in the app. Through a ref, so the listener added once
  // per opening always calls the latest of the two.
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void save();
    }
  };
  useEffect(() => {
    if (!open) return;
    const on = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [open]);

  const count = [...text].length;
  const tilt = editing ? noteTilt(editing.uid) : -1.5;
  const look = noteLook(style, color);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-6"
          onClick={close}
        >
          <motion.div
            initial={{ scale: 0.96, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.96, opacity: 0 }}
            onClick={e => e.stopPropagation()}
            className="w-full max-w-sm rounded-2xl border border-white/10 bg-[var(--color-bg)] shadow-2xl px-6 pt-5 pb-5"
          >
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-white font-semibold text-sm">{editing ? t("notes.edit") : t("notes.add")}</h2>
              <button onClick={close} className="p-1.5 rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-colors" aria-label={t("notes.cancel")}>
                <X size={16} />
              </button>
            </div>

            <div
              className="relative mx-auto rounded-[3px]"
              style={{
                width: "88%",
                background: paperFill(look),
                border: paperEdge(look),
                transform: `rotate(${tilt}deg)`,
                boxShadow: paperShadow(look, true),
                padding: look.dark ? "15px 17px" : "16px 18px",
              }}
            >
              {look.dark && <Tape ink={look.ink} width="52px" height="13px" top="-7px" />}
              <textarea
                ref={box}
                autoFocus
                value={text}
                onChange={e => type(e.target.value)}
                disabled={busy}
                rows={5}
                placeholder={t("notes.placeholder")}
                aria-label={editing ? t("notes.edit") : t("notes.add")}
                className={`note-hand w-full resize-none bg-transparent outline-none ${look.dark ? "placeholder:opacity-50" : "placeholder:opacity-40"}`}
                style={{ color: look.ink, fontSize: 21, lineHeight: 1.42, caretColor: look.ink }}
              />
            </div>

            <div className="flex items-center justify-center gap-3 mt-6" role="radiogroup" aria-label={t("notes.paper")}>
              {NOTE_COLORS.map(c => {
                const on = c === color;
                const dot = noteLook(style, c);
                return (
                  <button
                    key={c}
                    role="radio"
                    aria-checked={on}
                    aria-label={`${t("notes.paper")} ${paperName(c)}`}
                    title={paperName(c)}
                    onClick={() => setColor(c)}
                    className="w-8 h-8 rounded-full flex items-center justify-center transition-transform hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                    style={{
                      background: dot.paper,
                      // Dark paper's colour is in its ink, so its dot carries the ink as a ring.
                      boxShadow: [
                        dot.dark ? `inset 0 0 0 2px color-mix(in srgb, ${dot.ink} 70%, transparent)` : "inset 0 0 0 1px rgba(255,255,255,0.15)",
                        on ? "0 0 0 2px var(--color-bg), 0 0 0 4px var(--color-accent)" : "",
                      ].filter(Boolean).join(", "),
                    }}
                  >
                    {on && <Check size={15} strokeWidth={2.6} color={dot.ink} />}
                  </button>
                );
              })}
            </div>

            <div className="flex items-center justify-between gap-3 mt-4 text-[11px]">
              <p className={problem ? "text-amber-300" : "text-white/30"}>{problem ?? `${count}/${NOTE_MAX_CHARS}`}</p>
              {!problem && <p className="text-white/25 truncate">{editing ? t("notes.keysEdit") : t("notes.keys")}</p>}
            </div>

            <div className="flex items-center gap-2 mt-4">
              {editing && (
                <button
                  onClick={() => void peel()}
                  disabled={busy}
                  className="px-3 py-2 rounded-xl text-xs font-semibold text-amber-300/90 hover:text-amber-200 hover:bg-white/5 transition-colors disabled:opacity-40"
                >
                  {t("notes.peel")}
                </button>
              )}
              <div className="flex-1" />
              <button
                onClick={close}
                disabled={busy}
                className="px-4 py-2 rounded-xl text-xs font-semibold text-white/60 hover:text-white bg-white/5 border border-white/10 hover:border-white/25 transition-colors disabled:opacity-40"
              >
                {t("notes.cancel")}
              </button>
              <button
                onClick={() => void save()}
                disabled={busy}
                className="px-5 py-2 rounded-xl text-xs font-semibold text-white theme-btn hover:opacity-90 transition-opacity disabled:opacity-40"
              >
                {editing ? t("notes.save") : t("notes.stick")}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
