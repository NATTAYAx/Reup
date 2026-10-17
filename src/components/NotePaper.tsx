import { t } from "../lib/i18n";
import { noteLook, type NoteColor, type NoteStyle } from "../lib/notes";

// ─── NotePaper ───────────────────────────────────────────────────────────────
//
// How a sheet of note paper is drawn in each style, for the board, the editor,
// the settings and the desktop board - the last a window of its own, which is
// why this is not in NotesBoard. The phone draws the same (ui/NoteSheet.kt,
// NotePaper.kt), from the same colours in lib/notes.ts.
//
// Dark paper on a dark window also gets an edge and a strip of tape in its
// ink: without them a dark square is a hole in the screen, and the shadow that
// holds a light note up does nothing on a dark background.

export type NoteLook = ReturnType<typeof noteLook>;

/**
 * The paper, a shade darker toward the bottom edge, where a real note lifts
 * off the door. Dark paper catches a little light at the top instead, since a
 * darker bottom on a dark sheet is invisible.
 */
export function paperFill(look: NoteLook): string {
  return look.dark
    ? `linear-gradient(to bottom, color-mix(in srgb, ${look.paper} 92%, #fff), ${look.paper} 45%)`
    : `linear-gradient(to bottom, ${look.paper} 55%, color-mix(in srgb, ${look.paper} 93%, #000))`;
}

/** Dark paper's edge, in its ink. Nothing on light paper. */
export function paperEdge(look: NoteLook): string | undefined {
  return look.dark ? `1px solid color-mix(in srgb, ${look.ink} 30%, transparent)` : undefined;
}

/** What holds a sheet up: a soft shadow, or a deeper one under dark paper. */
export function paperShadow(look: NoteLook, big = false): string {
  if (look.dark) return big ? "0 8px 20px rgba(0,0,0,0.55), 0 1px 3px rgba(0,0,0,0.45)" : "0 4px 12px rgba(0,0,0,0.55), 0 1px 3px rgba(0,0,0,0.4)";
  return big ? "0 6px 16px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.3)" : "0 3px 8px rgba(0,0,0,0.35), 0 1px 2px rgba(0,0,0,0.25)";
}

/** The strip of tape a dark note hangs from, across its top edge, in its ink. Sizes in any CSS unit. */
export function Tape({ ink, width = "40px", height = "11px", top = "-6px" }: { ink: string; width?: string; height?: string; top?: string }) {
  return (
    <span
      aria-hidden
      className="absolute left-1/2 pointer-events-none"
      style={{
        top,
        width,
        height,
        borderRadius: 2,
        background: `color-mix(in srgb, ${ink} 55%, transparent)`,
        transform: "translateX(-50%) rotate(-3deg)",
      }}
    />
  );
}

export function noteStyleName(style: NoteStyle): string {
  switch (style) {
    case "bright": return t("notes.styleBright");
    case "muted": return t("notes.styleMuted");
    case "dark": return t("notes.styleDark");
  }
}

/** A sheet the size of a thumbnail, with two strokes of ink for words: a style, as the settings show it. */
export function MiniNote({ style, color, tilt }: { style: NoteStyle; color: NoteColor; tilt: number }) {
  const look = noteLook(style, color);
  return (
    <span className="relative block shrink-0" style={{ width: 26, height: 26, transform: `rotate(${tilt}deg)` }}>
      <span
        className="absolute inset-0 flex flex-col gap-[3px] rounded-[2px]"
        style={{
          background: paperFill(look),
          border: paperEdge(look),
          boxShadow: look.dark ? "0 2px 5px rgba(0,0,0,0.55)" : "0 1px 3px rgba(0,0,0,0.35)",
          padding: "8px 0 0 5px",
        }}
      >
        <span className="block rounded-[1px]" style={{ width: 14, height: 2, background: look.ink, opacity: 0.8 }} />
        <span className="block rounded-[1px]" style={{ width: 9, height: 2, background: look.ink, opacity: 0.8 }} />
      </span>
      {look.dark && <Tape ink={look.ink} width="12px" height="5px" top="-2px" />}
    </span>
  );
}
