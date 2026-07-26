// ─── Palette from a live-wallpaper video ──────────────────────────────────────
//
// Why this exists instead of reusing the image extractor in SettingsModal:
//
//   1. A video is not one picture. Sampling a single frame gives whatever
//      happened to be on screen at that second, which for a login animation is
//      often a dark fade-in. This walks six frames spread across the clip and
//      pools them, so the palette reflects what you actually stare at all day.
//
//   2. The image extractor hard-codes taste rules from one specific picture:
//      "primary must be a non-warm hue" and "accent is gold if any gold pixel
//      exists at all" (0.2% of pixels is enough to trigger it). Those rules are
//      why a pink and cyan wallpaper can come back looking like a blue and gold
//      theme. Nothing here privileges any hue.
//
//   3. k-means seeds from Math.random, so the same picture gives a different
//      answer every press and a bad result cannot be reproduced or reasoned
//      about. This is a plain weighted hue histogram: same video in, same
//      colours out, every time.
//
// Weighting: each pixel counts as saturation² × a bell curve on lightness.
// Squaring saturation means a small vivid highlight outweighs a large muddy
// area, which is how people actually read an image. The lightness curve throws
// away near-black and blown-out pixels, which carry no hue information.

import { convertFileSrc } from "@tauri-apps/api/core";
import type { AppTheme } from "./theme";

const FRAMES = 6;
const TILE_W = 160;
const BUCKETS = 36; // 10° of hue each

type RGB = { r: number; g: number; b: number };

// ── colour maths ──────────────────────────────────────────────────────────────

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn)      h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else                 h = ((rn - gn) / d + 4) / 6;
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): RGB {
  if (s === 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return {
    r: Math.round(hue(h + 1 / 3) * 255),
    g: Math.round(hue(h) * 255),
    b: Math.round(hue(h - 1 / 3) * 255),
  };
}

const hex2 = (v: number) => Math.min(255, Math.max(0, Math.round(v))).toString(16).padStart(2, "0");
const toHex = (c: RGB) => `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
const rgba  = (c: RGB, a: number) => `rgba(${c.r},${c.g},${c.b},${a})`;

/** Human name for a hue, used to label the generated theme. */
function hueName(h: number): string {
  const d = h * 360;
  if (d < 15)  return "Crimson";
  if (d < 33)  return "Ember";
  if (d < 48)  return "Amber";
  if (d < 66)  return "Gold";
  if (d < 95)  return "Lime";
  if (d < 150) return "Jade";
  if (d < 178) return "Emerald";
  if (d < 196) return "Teal";
  if (d < 212) return "Cyan";
  if (d < 238) return "Azure";
  if (d < 258) return "Cobalt";
  if (d < 280) return "Indigo";
  if (d < 300) return "Violet";
  if (d < 322) return "Orchid";
  if (d < 344) return "Magenta";
  return "Crimson";
}

/** Shortest distance between two hue buckets, in buckets. */
function bucketDistance(a: number, b: number): number {
  const raw = Math.abs(a - b);
  return Math.min(raw, BUCKETS - raw);
}

// ── video frame grabbing ──────────────────────────────────────────────────────

function loadVideo(path: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    // Required. The page is tauri.localhost, the file is asset.localhost, and a
    // cross-origin video taints the canvas so getImageData/toDataURL throw.
    // Tauri's asset protocol does send Access-Control-Allow-Origin, so a CORS
    // request keeps the canvas clean.
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    // Chromium does not reliably decode a video that is not in the document.
    video.style.cssText =
      "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
    document.body.appendChild(video);

    const timer = setTimeout(() => {
      video.remove();
      reject(new Error("Timed out opening the video"));
    }, 20000);

    video.onloadeddata = () => {
      clearTimeout(timer);
      if (!video.videoWidth || !video.videoHeight) {
        video.remove();
        reject(new Error("This video has no picture to read"));
        return;
      }
      resolve(video);
    };
    video.onerror = () => {
      clearTimeout(timer);
      video.remove();
      reject(new Error("Could not open the video file"));
    };

    video.src = convertFileSrc(path);
    video.load();
  });
}

/** Seek and wait, but never hang: a 4K webm can refuse to land on a keyframe. */
function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise(resolve => {
    if (!Number.isFinite(time) || Math.abs(video.currentTime - time) < 0.05) {
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      video.onseeked = null;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 4000);
    video.onseeked = finish;
    try { video.currentTime = time; } catch { finish(); }
  });
}

// ── theme building ────────────────────────────────────────────────────────────

function buildTheme(data: Uint8ClampedArray): AppTheme {
  const weight = new Float64Array(BUCKETS);
  const rs = new Float64Array(BUCKETS);
  const gs = new Float64Array(BUCKETS);
  const bs = new Float64Array(BUCKETS);

  let anyR = 0, anyG = 0, anyB = 0, anyN = 0;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const [h, s, l] = rgbToHsl(r, g, b);

    if (l > 0.06 && l < 0.96) { anyR += r; anyG += g; anyB += b; anyN++; }

    // Bell curve on lightness: nothing useful lives at the extremes.
    const lw = 1 - Math.abs(l - 0.5) * 1.6;
    if (lw <= 0) continue;

    // Saturation squared: a small vivid highlight should beat a large murky wash.
    const w = s * s * lw;
    if (w < 0.002) continue;

    const idx = Math.min(BUCKETS - 1, Math.floor(h * BUCKETS));
    weight[idx] += w;
    rs[idx] += r * w;
    gs[idx] += g * w;
    bs[idx] += b * w;
  }

  // Dominant hue.
  let pIdx = -1, pBest = 0;
  for (let i = 0; i < BUCKETS; i++) {
    if (weight[i] > pBest) { pBest = weight[i]; pIdx = i; }
  }

  // Nothing vivid anywhere (a grey or near-black clip): fall back to the average.
  if (pIdx < 0 || pBest <= 0) {
    const avg: RGB = anyN
      ? { r: Math.round(anyR / anyN), g: Math.round(anyG / anyN), b: Math.round(anyB / anyN) }
      : { r: 124, g: 58, b: 237 };
    const [ah] = rgbToHsl(avg.r, avg.g, avg.b);
    return assemble(ah, 0.35, (ah + 0.5) % 1, 0.35, "Muted");
  }

  const pMean: RGB = {
    r: Math.round(rs[pIdx] / weight[pIdx]),
    g: Math.round(gs[pIdx] / weight[pIdx]),
    b: Math.round(bs[pIdx] / weight[pIdx]),
  };
  const [pHue, pSat] = rgbToHsl(pMean.r, pMean.g, pMean.b);

  // Accent: strongest hue that is far enough away to read as a second colour.
  // Separation is scored, not just filtered, so a 120° contrast beats a 40° one
  // that happens to be slightly heavier.
  let aIdx = -1, aBest = 0;
  for (let i = 0; i < BUCKETS; i++) {
    if (weight[i] <= 0) continue;
    const dist = bucketDistance(i, pIdx);
    if (dist < 3) continue; // under 30° is the same colour to the eye
    const score = weight[i] * Math.min(1, dist / 9);
    if (score > aBest) { aBest = score; aIdx = i; }
  }

  let aHue: number, aSat: number;
  if (aIdx >= 0) {
    const aMean: RGB = {
      r: Math.round(rs[aIdx] / weight[aIdx]),
      g: Math.round(gs[aIdx] / weight[aIdx]),
      b: Math.round(bs[aIdx] / weight[aIdx]),
    };
    const hsl = rgbToHsl(aMean.r, aMean.g, aMean.b);
    aHue = hsl[0];
    aSat = hsl[1];
  } else {
    // Single-hue clip: build a complement so the UI still has two colours.
    aHue = (pHue + 0.5) % 1;
    aSat = Math.max(pSat, 0.6);
  }

  return assemble(pHue, pSat, aHue, aSat, "");
}

function assemble(pHue: number, pSat: number, aHue: number, aSat: number, forcedName: string): AppTheme {
  const primary   = hslToRgb(pHue, Math.min(0.9, Math.max(0.55, pSat)), 0.55);
  const secondary = hslToRgb(pHue, Math.min(0.85, Math.max(0.5, pSat)), 0.34);
  const accent    = hslToRgb(aHue, Math.min(0.95, Math.max(0.62, aSat)), 0.62);
  const bg        = hslToRgb(pHue, 0.35, 0.045);

  const name = forcedName
    ? `${forcedName} ${hueName(pHue)}`
    : `${hueName(pHue)} ${hueName(aHue)}`;

  return {
    name,
    primary:   toHex(primary),
    secondary: toHex(secondary),
    accent:    toHex(accent),
    bg:        toHex(bg),
    bgCard:    rgba(primary, 0.09),
    border:    rgba(accent, 0.22),
    textMuted: "rgba(255,255,255,0.40)",
  };
}

// ── public API ────────────────────────────────────────────────────────────────

export interface VideoPalette {
  theme: AppTheme;
  /** Data URL of the sampled frames stacked together, for showing the user
   *  exactly which pictures the colours came from. */
  montage: string;
  frames: number;
}

export async function paletteFromVideo(path: string): Promise<VideoPalette> {
  const video = await loadVideo(path);
  try {
    const duration = Number.isFinite(video.duration) && video.duration > 0.5 ? video.duration : 0;
    const times = duration
      // Skip the first 8% and last 5%: intros fade in, outros fade out.
      ? Array.from({ length: FRAMES }, (_, i) => duration * (0.08 + (0.87 * i) / (FRAMES - 1)))
      : [0];

    const aspect = video.videoHeight / video.videoWidth;
    const tileH = Math.max(1, Math.round(TILE_W * aspect));

    const canvas = document.createElement("canvas");
    canvas.width = TILE_W;
    canvas.height = tileH * times.length;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Canvas is unavailable");

    let drawn = 0;
    for (let i = 0; i < times.length; i++) {
      await seekTo(video, times[i]);
      try {
        ctx.drawImage(video, 0, i * tileH, TILE_W, tileH);
        drawn++;
      } catch {
        // A frame that will not draw is not fatal; the others still count.
      }
    }
    if (drawn === 0) throw new Error("Could not read any frame from this video");

    let data: Uint8ClampedArray;
    try {
      data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    } catch (err) {
      // Reached only if the CORS request above did not apply.
      throw new Error(
        "The video could not be read for colour (" +
        (err instanceof Error ? err.name : String(err)) + ")",
      );
    }

    return {
      theme: buildTheme(data),
      montage: canvas.toDataURL("image/jpeg", 0.8),
      frames: drawn,
    };
  } finally {
    video.removeAttribute("src");
    try { video.load(); } catch {}
    video.remove();
  }
}