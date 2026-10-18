import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";

// ─── FitText ─────────────────────────────────────────────────────────────────
//
// Words cut to at most `lines` lines, ending in "…" when they had to be cut,
// and not clipped anywhere.
//
// WHY NOT -webkit-line-clamp
//
// A clamp needs overflow: hidden, and in Thai that cuts twice. A tone mark on an
// upper vowel (นี้ ซื้อ ปั๊ม) stands above the top of its line box, so the first
// line lost it; and the lines after the clamp are still laid out and painted,
// so the marks of the first hidden line stood up into the last visible one as
// stray strokes. Here nothing is hidden: the text shown is only what fits, and
// it is free to spill its marks past its box, as text normally does.
//
// HOW
//
// A probe the same width and style as the words, invisible, takes the whole text
// and then shorter and shorter beginnings of it - whole words, or whole letters
// with their marks when a single word is too long - until one with "…" fits; a
// binary search, so a note of 120 characters is a handful of tries. It runs
// again when the width changes and when the fonts have arrived, since both move
// where lines break.

interface Props {
  text: string;
  lines: number;
  className?: string;
  style?: CSSProperties;
}

// Intl.Segmenter is ES2022 and the project's lib is ES2020, so its one use
// is typed here; WebView2 has had it since Chromium 87.
type Segmenter = { segment(s: string): Iterable<{ segment: string }> };
type SegmenterClass = new (locale: string, options: { granularity: "word" | "grapheme" }) => Segmenter;
const Seg = (Intl as unknown as { Segmenter?: SegmenterClass }).Segmenter;

function splitter(granularity: "word" | "grapheme"): (s: string) => string[] {
  const seg = Seg ? new Seg("th", { granularity }) : null;
  return (s) => (seg ? Array.from(seg.segment(s), (g) => g.segment) : Array.from(s));
}

/** Words, by the same dictionary that breaks Thai lines; graphemes inside one too long for the room. */
const words = splitter("word");
const graphemes = splitter("grapheme");

const cut = (parts: string[], n: number) => parts.slice(0, n).join("").trimEnd() + "…";

/** The most of `parts` that fits with "…" after it, or 0. */
function most(parts: string[], fits: (s: string) => boolean): number {
  let lo = 0;
  let hi = parts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (fits(cut(parts, mid))) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function FitText({ text, lines, className, style }: Props) {
  const box = useRef<HTMLSpanElement>(null);
  const probe = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(text);

  useLayoutEffect(() => {
    const p = probe.current;
    const b = box.current;
    if (!p || !b) return;
    let width = -1;
    const fit = () => {
      width = b.clientWidth;
      const lineHeight = parseFloat(getComputedStyle(p).lineHeight);
      if (!(lineHeight > 0)) {
        setShown(text);
        return;
      }
      // Line boxes, not ink: a box of n lines is n line-heights tall
      // whatever its marks do. offsetHeight rather than the bounding box,
      // which a leaning note would make taller than its lines; half a pixel
      // covers its rounding.
      const room = lineHeight * lines + 0.5;
      const fits = (s: string) => {
        p.textContent = s;
        return p.offsetHeight <= room;
      };
      if (fits(text)) {
        setShown(text);
        return;
      }
      // Whole words where they fit, so "…" comes after a word and not inside
      // one; letter by letter only when not even the first word does.
      const byWord = words(text);
      const n = most(byWord, fits);
      if (n > 0) {
        setShown(cut(byWord, n));
        return;
      }
      const byLetter = graphemes(text);
      setShown(cut(byLetter, most(byLetter, fits)));
    };
    fit();
    const watch = new ResizeObserver(() => {
      if (b.clientWidth !== width) fit();
    });
    watch.observe(b);
    // A face that arrives later moves where the lines break: once when the
    // fonts already asked for are in, and again whenever another one lands.
    let live = true;
    const again = () => {
      if (live) fit();
    };
    document.fonts?.ready.then(again);
    document.fonts?.addEventListener("loadingdone", again);
    return () => {
      live = false;
      watch.disconnect();
      document.fonts?.removeEventListener("loadingdone", again);
    };
  }, [text, lines]);

  return (
    <span ref={box} className={`relative block ${className ?? ""}`} style={style}>
      {shown}
      <span
        ref={probe}
        aria-hidden
        className="absolute left-0 right-0 top-0 block invisible pointer-events-none"
      />
    </span>
  );
}
