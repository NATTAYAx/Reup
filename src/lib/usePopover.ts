import { useState, useEffect, useLayoutEffect } from "react";

// ─── Popover positioning ──────────────────────────────────────────────────────
// The old approach put the panel inside the trigger with position:absolute. That
// works right up until the trigger sits inside something that scrolls — which is
// exactly where every one of these lives, since the task form is a scrolling box
// with a pinned header and footer. An absolutely positioned child cannot leave
// its scrolling ancestor: the panel gets sliced off at the edge of the box, and
// what is left of it slides around when the form scrolls underneath.
//
// The fix is to stop nesting it. The panel is rendered into document.body with
// createPortal and positioned with fixed coordinates measured from the trigger,
// so its only boundary is the window. It is clamped to the window on all four
// sides and re-measured whenever anything scrolls or the window resizes.

export interface PopoverPos {
  top: number;
  left: number;
  width: number;
  /** What is actually available, so the panel scrolls internally rather than
   *  running off the screen. */
  maxHeight: number;
}

interface Options {
  /** Preferred height. The panel gets this much or whatever fits, whichever is less. */
  height: number;
  /** A pixel width, or the trigger's own width. */
  width?: number | "anchor";
  gap?: number;
}

const MARGIN = 8;

export function usePopoverPos(
  open: boolean,
  anchor: React.RefObject<HTMLElement | null>,
  { height, width = "anchor", gap = 8 }: Options,
): PopoverPos | null {
  const [pos, setPos] = useState<PopoverPos | null>(null);

  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }

    const measure = () => {
      const el = anchor.current;
      if (!el) return;
      const r = el.getBoundingClientRect();

      const w = width === "anchor" ? r.width : width;
      const roomBelow = window.innerHeight - r.bottom - gap - MARGIN;
      const roomAbove = r.top - gap - MARGIN;

      let left = r.left;
      if (left + w > window.innerWidth - MARGIN) left = window.innerWidth - MARGIN - w;
      if (left < MARGIN) left = MARGIN;

      // WHEN TO FLIP.
      //
      // This used to read `roomBelow < Math.min(height, 160)`, which asks "is
      // there almost no room below" rather than "does it fit". So a panel
      // wanting 404px with 360 below and 465 above stayed below, got clamped to
      // 360, and grew a scrollbar — while a space it fitted in sat directly
      // above it, unused. That is how the last week of the month ended up
      // behind a scrollbar.
      //
      // The question is whether the contents FIT, so that is what is asked.
      const fitsBelow = roomBelow >= height;
      const up = !fitsBelow && roomAbove > roomBelow;
      const best = up ? roomAbove : roomBelow;

      // NEITHER SIDE FITS.
      //
      // On a 600px-tall window there may be no side with room for a month grid,
      // and clinging to the trigger then means scrolling no matter which way it
      // opens. At that point being attached to the field is worth less than
      // being readable, so it stops hugging and centres in the window, where the
      // whole height is available. This is what a phone does with a date picker,
      // and for the same reason.
      if (best < height && window.innerHeight - 2 * MARGIN > best) {
        const maxHeight = Math.min(height, window.innerHeight - 2 * MARGIN);
        setPos({
          top: Math.max(MARGIN, Math.round((window.innerHeight - maxHeight) / 2)),
          left,
          width: w,
          maxHeight,
        });
        return;
      }

      const maxHeight = Math.max(120, Math.min(height, best));
      setPos({
        top: up ? r.top - gap - maxHeight : r.bottom + gap,
        left,
        width: w,
        maxHeight,
      });
    };

    measure();
    // Capture phase, because the scroll that matters happens on the form's own
    // scrolling box and never reaches the window in the bubble phase.
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [open, height, width, gap]);

  return pos;
}

/** Closes when the pointer goes down anywhere that is neither the trigger nor
 *  the panel. The panel now lives outside the trigger in the DOM, so checking
 *  the trigger alone would swallow every click on an option. */
export function useDismiss(
  open: boolean,
  onClose: () => void,
  ...refs: React.RefObject<HTMLElement | null>[]
) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (refs.some(r => r.current?.contains(target))) return;
      onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  });
}