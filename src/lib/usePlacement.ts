import { useState } from "react";
// ─── Popover placement ────────────────────────────────────────────────────────
// A popover pinned to top-full always opens downwards, which is fine until the
// trigger sits low in a 590px window and the panel runs off the bottom edge
// with no way to reach the rest of it. Measure once on open and flip.

import { useLayoutEffect } from "react";

export interface Placement { up: boolean; right: boolean }

export function usePlacement(
  open: boolean,
  anchor: React.RefObject<HTMLElement | null>,
  panel: React.RefObject<HTMLElement | null>,
  fallback: { height: number; width: number },
): Placement {
  const [placement, setPlacement] = useState<Placement>({ up: false, right: false });

  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const rect = anchor.current.getBoundingClientRect();
    // The panel may not be laid out on the very first pass, hence the fallback
    // measurements — they only have to be close enough to choose a side.
    const h = panel.current?.offsetHeight || fallback.height;
    const w = panel.current?.offsetWidth || fallback.width;
    const below = window.innerHeight - rect.bottom;
    const above = rect.top;
    setPlacement({
      up: below < h + 12 && above > below,
      right: rect.left + w + 12 > window.innerWidth,
    });
  }, [open]);

  return placement;
}