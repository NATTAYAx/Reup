// ─── DesktopWidget.tsx — the board on the desktop ────────────────────────────
//
// The phone's large widget, laid out for one side of a screen: the clock and
// the date, what is next, the night's rounds, how much of it is done, and the
// longer rounds still open. What it says is lib/widgetFace; where it sits and
// how it stays there is src-tauri/src/widget.rs and desk_layer.rs.
//
// NO BOX
//
// The first version sat in a dark rounded rectangle. On a bright wallpaper the
// only way to read it was to turn that rectangle nearly black, and then it was
// an app window parked on the art. Now there is no edge anywhere: a mist in the
// theme's darkest colour sits behind the words and fades out well before the
// window's own edges, so the wallpaper runs on around it. The slider in
// settings sets how strong the mist is. The words carry their own shadow for
// the parts the mist does not reach.
//
// A TIMELINE, NOT A TABLE
//
// Times first, in their own column, names after: the eye goes down a schedule
// rather than across a spreadsheet with the name at one end and the time at the
// other. The day is said once, as a heading, instead of "พรุ่งนี้" in front of
// every row.
//
// THE COLUMN HUGS THE NEARER EDGE
//
// The words keep to a column a little over thirty characters wide, on whichever
// side of the board is nearer the edge of the screen, so whatever the board is
// sized to, the middle of the wallpaper stays clear.
//
// STILL BY DESIGN
//
// No animation anywhere, and one repaint a minute. A board that sits on the
// desktop all day must not be the thing keeping the GPU awake - this app has
// been there once already (see lib/windowActive). The mist and the shadows are
// drawn once and cost nothing while nothing moves.
//
// HOW MUCH FITS
//
// Rows have a fixed height in em, so the space under the card can be divided
// into whole rows and nothing is ever cut through the middle. The night's
// rounds get first claim on it, as on the phone: up to six of them, then the
// longer rounds, then whatever is left goes back to the night.
//
// THE NOTES
//
// Under the date, before what is next, as on the phone: up to three squares of
// paper, newest first, leaning a little, in the same hand, and how many more
// there are. Paper brings its own background, so a note needs neither the mist
// nor a shadow on its words - only the one under the paper. Like everything
// else here it takes no clicks; a note is changed or taken off in the app or on
// the phone, and the board hears about it with the tasks.

import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactElement } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Moon } from "lucide-react";
import type { Task } from "../types";
import type { WidgetNote, WidgetPayload } from "../lib/widgetFeed";
import { NOTE_LEAD, NOTES_SHOWN, noteColor, noteLook, noteTilt, type NoteStyle } from "../lib/notes";
import { FitText } from "./FitText";
import { getNoteStyle } from "../lib/noteStyle";
import { Tape, paperEdge, paperFill } from "./NotePaper";
import {
  widgetRows, widgetFace, moneyLine, boardDate, lineText, WIDGET_WORDS,
  type WidgetFace, type WidgetLine, type WidgetLang,
} from "../lib/widgetFace";
import { readTint, WIDGET_TINT_KEY } from "../lib/widgetLook";
import { getAppTimeZone, getTimeZonePreference, setTimeZonePreference, wallClock, SYSTEM, TZ_KEY } from "../lib/tz";
import { quietWindowEnd } from "../lib/notifier";
import { t, getLang, refreshLang } from "../lib/i18n";
import { applyTheme, loadTheme, THEME_BLOB_KEY } from "../lib/theme";
import { formatMoney } from "../lib/money";
import { LANG_KEY, NOTE_STYLE_KEY, THEME_ID_KEY } from "../lib/settingKeys";

interface Status {
  enabled: boolean;
  arranging: boolean;
}

type Edge = Parameters<ReturnType<typeof getCurrentWindow>["startResizeDragging"]>[0];
type Side = "left" | "right";

// ── colour ──────────────────────────────────────────────────────────────────
const INK = "#ffffff";
const INK_SOFT = "rgba(255,255,255,0.76)";
const INK_FAINT = "rgba(255,255,255,0.56)";
const WARN = "#fbbf24";
const GOOD = "#4ade80";
const ACCENT = "var(--color-accent)";
/** What keeps the words readable where the mist does not reach. */
const SHADOW = "0 1px 2px rgba(0,0,0,0.55), 0 0 12px rgba(0,0,0,0.38)";
/** The mist: the theme's own colour pressed almost to black, so it sits in the
 *  wallpaper like shade rather than like a sheet of grey laid over it. */
const MIST = "color-mix(in srgb, var(--color-primary) 20%, #05030a)";

// Heights in em, matched by the styles below. See HOW MUCH FITS.
const ROW_EM = 1.9;
const DAY_EM = 2.0;
const HEADING_EM = 2.6;
const TALLY_EM = 2.5;
const TALLY_BAR_EM = 3.2;
const MONEY_EM = 2.6;
const SOON_FIRST = 6;

/** Width of the column of words. */
const COLUMN_EM = 31;
/** How far the mist takes to fade, at the window's edges and at the column's open side. */
const FEATHER_EM = 3.5;

/** Settings written by the main window that change what this page shows. */
const WATCHED = [LANG_KEY, THEME_ID_KEY, THEME_BLOB_KEY, TZ_KEY, WIDGET_TINT_KEY, NOTE_STYLE_KEY];

function signature(): string {
  try {
    return WATCHED.map(k => localStorage.getItem(k) ?? "").join("\u0001");
  } catch {
    return "";
  }
}

const pad2 = (n: number) => (n < 10 ? "0" + n : String(n));

const fit = (room: number, each: number) => (room <= 0 || each <= 0 ? 0 : Math.floor(room / each + 1e-6));

/** Which side of the screen the board is nearer. */
function nearSide(): Side {
  try {
    const s = window.screen as Screen & { availLeft?: number };
    const middle = (s.availLeft ?? 0) + s.availWidth / 2;
    return window.screenX + window.innerWidth / 2 >= middle ? "right" : "left";
  } catch {
    return "right";
  }
}

/**
 * The mist's shape, as a mask: solid behind the words, fading over FEATHER_EM
 * at the window's edges, and on the open side and below the last line over
 * twice that, so nothing about it ever reads as a box. `end` is where the last
 * line stops, in px from the top; the mist ends a little after it rather than
 * running on to the bottom of the window behind nothing.
 */
function mistMask(side: Side, end: number | null): string {
  const f = `${FEATHER_EM}em`;
  const ff = `${FEATHER_EM * 2}em`;
  const reach = `calc(${COLUMN_EM}em + 3.2em)`;
  const across = side === "right"
    ? `linear-gradient(to left, transparent 0, #000 ${f}, #000 ${reach}, transparent calc(${reach} + ${ff}))`
    : `linear-gradient(to right, transparent 0, #000 ${f}, #000 ${reach}, transparent calc(${reach} + ${ff}))`;
  const stop = end === null ? `calc(100% - ${ff})` : `min(${Math.round(end)}px, calc(100% - ${ff}))`;
  const down = `linear-gradient(to bottom, transparent 0, #000 ${f}, #000 ${stop}, transparent calc(${stop} + ${ff}))`;
  return `${across}, ${down}`;
}

export default function DesktopWidget() {
  const [payload, setPayload] = useState<WidgetPayload | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [arranging, setArranging] = useState(false);
  const [tint, setTint] = useState(readTint);
  const [side, setSide] = useState<Side>(nearSide);
  const [, bump] = useReducer((n: number) => n + 1, 0);

  const listsRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ h: 0, unit: 16 });
  const [end, setEnd] = useState<number | null>(null);

  // ── what the main window has set ──────────────────────────────────────────
  //
  // The two windows share their page storage, so a change made in settings is
  // already here; this only has to re-read it. The language and the zone are
  // cached by their modules, the theme is applied as CSS variables, and each
  // has its own way back in.
  const lastSig = useRef(signature());
  const reread = () => {
    lastSig.current = signature();
    refreshLang();
    document.documentElement.lang = getLang();
    applyTheme(loadTheme());
    let pref: string | null = null;
    try {
      pref = localStorage.getItem(TZ_KEY);
    } catch {
      pref = null;
    }
    if ((pref || SYSTEM) !== getTimeZonePreference()) setTimeZonePreference(pref || SYSTEM);
    setTint(readTint());
    bump();
  };

  useLayoutEffect(() => {
    document.documentElement.lang = getLang();
    applyTheme(loadTheme());
  }, []);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === WIDGET_TINT_KEY) {
        lastSig.current = signature();
        setTint(readTint());
        return;
      }
      if (e.key === null || WATCHED.includes(e.key)) reread();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // ── which side to keep to ─────────────────────────────────────────────────
  useEffect(() => {
    const again = () => setSide(nearSide());
    window.addEventListener("resize", again);
    let off: (() => void) | undefined;
    getCurrentWindow()
      .onMoved(again)
      .then(f => { off = f; })
      .catch(() => {});
    return () => {
      window.removeEventListener("resize", again);
      off?.();
    };
  }, []);

  // ── the task list, from the main window ───────────────────────────────────
  //
  // It sends on every load. At startup the two pages come up in no fixed
  // order, so this also asks - every few seconds until the first list lands,
  // in case the first ask went out before anyone was listening.
  const gotFirst = useRef(false);
  useEffect(() => {
    let alive = true;
    const offs: Array<() => void> = [];
    let retry: number | undefined;
    (async () => {
      try {
        offs.push(await listen<WidgetPayload>("widget-tasks", e => {
          gotFirst.current = true;
          setPayload(e.payload);
          setNow(Date.now());
        }));
        offs.push(await listen<Status>("widget-status", e => {
          setArranging(!!e.payload?.arranging);
          setSide(nearSide());
        }));
      } catch {
        /* no event system: nothing will arrive, and the clock still runs */
      }
      if (!alive) {
        offs.forEach(f => f());
        return;
      }
      try {
        const s = await invoke<Status>("widget_status");
        if (alive) setArranging(!!s.arranging);
      } catch {
        /* older backend; the status event still arrives */
      }
      const hello = () => {
        if (!alive || gotFirst.current) return;
        emit("widget-hello").catch(() => {});
        retry = window.setTimeout(hello, 3_000);
      };
      hello();
    })();
    return () => {
      alive = false;
      if (retry !== undefined) clearTimeout(retry);
      offs.forEach(f => f());
    };
  }, []);

  // ── the minute ────────────────────────────────────────────────────────────
  //
  // A timer to the next minute boundary rather than an interval, so the clock
  // turns over with the system's. A page the system has decided nobody can see
  // gets its timers slowed, so coming back into view re-reads the time at once.
  useEffect(() => {
    let timer: number;
    const arm = () => {
      timer = window.setTimeout(tick, 60_000 - (Date.now() % 60_000) + 200);
    };
    const tick = () => {
      setNow(Date.now());
      // The storage event should have said; this is the backstop.
      if (signature() !== lastSig.current) reread();
      arm();
    };
    arm();
    const onVisible = () => {
      if (document.visibilityState === "visible") setNow(Date.now());
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // ── how much room there is ────────────────────────────────────────────────
  useLayoutEffect(() => {
    const el = listsRef.current;
    if (!el) return;
    const measure = () => {
      const unit = parseFloat(getComputedStyle(el).fontSize) || 16;
      setBox(b => (b.h === el.clientHeight && b.unit === unit ? b : { h: el.clientHeight, unit }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Where the words stop, for the mist. Read after every paint, which is once
  // a minute; the bottom of whatever was drawn last is the answer.
  useLayoutEffect(() => {
    const col = columnRef.current;
    if (!col) return;
    let bottom = 0;
    col.querySelectorAll<HTMLElement>("[data-ink]").forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.height > 0) bottom = Math.max(bottom, r.bottom);
    });
    const next = bottom > 0 ? Math.round(bottom) : null;
    setEnd(e => (e === next ? e : next));
  });

  // ── what to say ───────────────────────────────────────────────────────────
  const zone = getAppTimeZone();
  const lang: WidgetLang = getLang();
  const face = useMemo(
    () => (payload ? widgetFace(widgetRows(payload.tasks as unknown as Task[], now, zone), now, zone, lang) : null),
    [payload, now, zone, lang],
  );
  const wall = wallClock(now, zone);
  const clock = pad2(wall.h) + ":" + pad2(wall.mi);
  const quiet = quietWindowEnd(now) !== null;
  const money = payload?.money
    ? moneyLine(payload.money.spent, payload.money.received, payload.money.month, lang, n =>
        formatMoney(n, payload.money!.currency))
    : null;

  // Whole rows into the room under the card.
  let soonN = 0;
  let laterN = 0;
  if (face) {
    const u = box.unit;
    const row = ROW_EM * u;
    const firstLater = face.soon.findIndex(l => l.day >= 1);
    const soonHeight = (n: number) => n * row + (firstLater >= 0 && firstLater < n ? DAY_EM * u : 0);
    const tally = face.tally ? (face.done > 0 ? TALLY_BAR_EM : TALLY_EM) * u : 0;
    const roomFor = (h: number, n: number, cap: number) => {
      let k = Math.min(n, cap);
      while (k > 0 && soonHeight(k) > h) k--;
      return k;
    };
    let room = box.h - tally - (money ? MONEY_EM * u : 0);
    soonN = roomFor(room, face.soon.length, SOON_FIRST);
    room -= soonHeight(soonN);
    const heading = HEADING_EM * u;
    if (face.later.length > 0 && room >= heading + row) {
      laterN = Math.min(face.later.length, fit(room - heading, row));
      room -= heading + laterN * row;
    }
    soonN = roomFor(room + soonHeight(soonN), face.soon.length, face.soon.length);
  }
  const hiddenLater = face ? face.later.length - laterN : 0;
  const complete = !!face && face.load > 0 && face.done >= face.load;
  const pct = face && face.load > 0 ? Math.min(100, (face.done / face.load) * 100) : 0;

  const notes = payload?.notes ?? [];
  const align = side === "right" ? "flex-end" : "flex-start";

  return (
    <div
      className="w-screen h-screen relative overflow-hidden select-none"
      style={{ fontSize: "clamp(13px, min(2.15vw, 2.3vh), 24px)", color: INK, cursor: "default" }}
    >
      {tint > 0 && (
        <div
          aria-hidden
          className="absolute inset-0 pointer-events-none"
          style={{
            background: MIST,
            opacity: tint / 100,
            WebkitMaskImage: mistMask(side, end),
            maskImage: mistMask(side, end),
            WebkitMaskComposite: "source-in",
            maskComposite: "intersect",
          } as CSSProperties}
        />
      )}

      <div className="relative h-full flex" style={{ justifyContent: align, padding: "1.5em 1.9em 1.3em" }}>
        <div ref={columnRef} className="h-full flex flex-col min-w-0" style={{ width: `min(100%, ${COLUMN_EM}em)`, textShadow: SHADOW }}>
          {/* the clock: the one large thing */}
          <div data-ink className="shrink-0">
            <div
              className="leading-none"
              style={{
                fontSize: "min(6.6em, 20vh)",
                fontWeight: 300,
                letterSpacing: "-0.035em",
                fontVariantNumeric: "tabular-nums",
                marginLeft: "-0.04em",
                textShadow: `0 0 0.35em color-mix(in srgb, ${ACCENT} 55%, transparent), 0 2px 6px rgba(0,0,0,0.45)`,
              }}
            >
              {clock}
            </div>
            <div className="flex items-center gap-[0.45em] mt-[0.45em]" style={{ fontSize: "1.2em", fontWeight: 500, color: INK_SOFT }}>
              <span className="truncate">{face?.date ?? boardDate(now, zone, lang)}</span>
              {quiet && (
                <span title={t("widget.quiet")} className="inline-flex shrink-0">
                  <Moon size="0.9em" strokeWidth={2.2} />
                </span>
              )}
            </div>
          </div>

          {notes.length > 0 && <Papers notes={notes} style={getNoteStyle()} />}

          {/* what is next */}
          <div data-ink className="shrink-0 mt-[1.4em]">
            {face ? <Next face={face} lang={lang} /> : (
              <p style={{ color: INK_FAINT }}>{t("widget.waiting")}</p>
            )}
          </div>

          {/* the night's rounds, the tally, the longer rounds: one grid, so
              every name starts at the same place whichever list it is in */}
          <div ref={listsRef} className="flex-1 min-h-0 overflow-hidden mt-[0.8em]">
            {face && (
              <div
                data-ink
                className="grid"
                style={{ gridTemplateColumns: "max-content minmax(0, 1fr)", columnGap: "1.1em", alignContent: "start" }}
              >
                {timeline(face.soon.slice(0, soonN), lang, "s")}
                {face.tally && (
                  <div style={{ gridColumn: "1 / -1", height: `${face.done > 0 ? TALLY_BAR_EM : TALLY_EM}em`, paddingTop: "0.8em" }}>
                    <p className="truncate" style={{ height: "1.6em", color: complete ? GOOD : INK_SOFT }}>
                      {face.tally}
                    </p>
                    {face.done > 0 && (
                      <div
                        className="rounded-full overflow-hidden mt-[0.3em]"
                        style={{ height: "0.3em", width: "100%", background: "rgba(255,255,255,0.2)", boxShadow: "0 1px 3px rgba(0,0,0,0.35)" }}
                      >
                        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: complete ? GOOD : ACCENT }} />
                      </div>
                    )}
                  </div>
                )}
                {laterN > 0 && (
                  <>
                    <div
                      className="flex items-end justify-between"
                      style={{ gridColumn: "1 / -1", height: `${HEADING_EM}em`, paddingBottom: "0.45em", color: INK_FAINT, fontWeight: 500 }}
                    >
                      <span className="truncate">{t("widget.later")}</span>
                      {hiddenLater > 0 && <span style={{ fontVariantNumeric: "tabular-nums" }}>+{hiddenLater}</span>}
                    </div>
                    {timeline(face.later.slice(0, laterN), lang, "l")}
                  </>
                )}
                {money && (
                  <p className="truncate" style={{ gridColumn: "1 / -1", height: `${MONEY_EM}em`, paddingTop: "1em", color: INK_SOFT }}>
                    {money}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {arranging && <Arrange />}
    </div>
  );
}

/**
 * The notes that are up: the newest few on paper, in the style the app is set
 * to (a change there reaches this window through WATCHED), and a count of the
 * rest.
 */
function Papers({ notes, style }: { notes: WidgetNote[]; style: NoteStyle }) {
  const shown = notes.slice(0, NOTES_SHOWN);
  const more = notes.length - shown.length;
  return (
    <div className="shrink-0 mt-[1.3em] flex items-start" style={{ gap: "0.95em", paddingLeft: "0.15em", textShadow: "none" }}>
      {shown.map(n => {
        const look = noteLook(style, noteColor(n.color));
        return (
          <div
            key={n.uid}
            className="note-hand relative"
            style={{
              flex: "0 1 8.8em",
              minWidth: "5.5em",
              height: "6.4em",
              padding: "0.6em 0.7em",
              background: paperFill(look),
              border: paperEdge(look),
              color: look.ink,
              borderRadius: "0.18em",
              transform: `rotate(${noteTilt(n.uid)}deg)`,
              boxShadow: look.dark
                ? "0 0.25em 0.7em rgba(0,0,0,0.55), 0 0.06em 0.16em rgba(0,0,0,0.4)"
                : "0 0.2em 0.55em rgba(0,0,0,0.42), 0 0.06em 0.14em rgba(0,0,0,0.3)",
            }}
          >
            {look.dark && <Tape ink={look.ink} width="2.6em" height="0.7em" top="-0.38em" />}
            <FitText
              text={n.body}
              lines={3}
              style={{ fontSize: "0.92em", lineHeight: NOTE_LEAD, whiteSpace: "pre-line", overflowWrap: "anywhere" }}
            />
          </div>
        );
      })}
      {more > 0 && (
        <span className="shrink-0 self-center" style={{ color: INK_SOFT, fontWeight: 500, fontVariantNumeric: "tabular-nums", textShadow: SHADOW }}>
          +{more}
        </span>
      )}
    </div>
  );
}

/** What is next, large; or the day said in words when nothing is due within a day. */
function Next({ face, lang }: { face: WidgetFace; lang: WidgetLang }) {
  const next = face.next;
  if (next) {
    return (
      <div>
        <p style={{ color: ACCENT, fontWeight: 500 }}>{t("widget.next")}</p>
        {/* Two lines at most, cut without clipping: a clamp would take the
            tone marks off the first line of a Thai name (see FitText). */}
        <FitText
          text={next.name}
          lines={2}
          className="font-semibold"
          style={{ fontSize: "1.95em", lineHeight: 1.3, marginTop: "0.08em" }}
        />
        <p style={{ fontSize: "1.25em", fontWeight: 500, marginTop: "0.12em", color: next.warn ? WARN : ACCENT, fontVariantNumeric: "tabular-nums" }}>
          {lineText(next, lang)}
        </p>
      </div>
    );
  }
  const after = face.calmNext;
  return (
    <div>
      <p style={{ color: face.done > 0 ? GOOD : INK_SOFT, fontWeight: 500 }}>{face.calm}</p>
      <p className="font-medium truncate" style={{ fontSize: "1.5em", lineHeight: 1.35, marginTop: "0.1em", color: INK_SOFT }}>
        {after ? after.name : t("widget.noNext")}
      </p>
      {after && (
        <p style={{ fontSize: "1.1em", marginTop: "0.1em", color: INK_FAINT, fontVariantNumeric: "tabular-nums" }}>
          {lineText(after, lang)}
        </p>
      )}
    </div>
  );
}

/**
 * Rows as a schedule: the time in its own column, the name after it, as grid
 * cells for the one grid the lists share. In the night's list the day is a
 * heading over the rows it covers, so the times can be bare clocks; the longer
 * rounds keep their whole phrase, since every one of them is a different day.
 */
function timeline(lines: WidgetLine[], lang: WidgetLang, key: string): ReactElement[] {
  const out: ReactElement[] = [];
  let lastDay: number | null = null;
  for (const line of lines) {
    const dated = !line.ending && !line.overdue;
    if (dated && line.day >= 1 && lastDay !== line.day) {
      out.push(
        <div
          key={`${key}d${line.day}`}
          className="flex items-end"
          style={{ gridColumn: "1 / -1", height: `${DAY_EM}em`, paddingBottom: "0.35em", color: INK_FAINT, fontWeight: 500 }}
        >
          {line.day === 1 ? WIDGET_WORDS.tomorrow[lang] : lineText(line, lang)}
        </div>,
      );
    }
    if (dated) lastDay = line.day;
    const tone = line.warn ? WARN : INK_SOFT;
    out.push(
      <div
        key={`${key}t${line.id}`}
        className="flex items-center justify-end whitespace-nowrap"
        style={{ height: `${ROW_EM}em`, fontVariantNumeric: "tabular-nums", color: tone, fontWeight: line.warn ? 500 : 400 }}
      >
        {line.ending ? (
          <>
            <span style={{ color: line.warn ? WARN : INK_FAINT }}>{WIDGET_WORDS.ends[lang]}&nbsp;</span>
            {line.when}
          </>
        ) : line.overdue ? line.when : line.day >= 1 ? line.clock : line.when}
      </div>,
      <div key={`${key}n${line.id}`} className="flex items-center min-w-0" style={{ height: `${ROW_EM}em` }}>
        <span className="truncate" style={{ fontSize: "1.06em" }}>{line.name}</span>
      </div>,
    );
  }
  return out;
}

/**
 * Moving and resizing. The whole board is the handle for moving; the edges and
 * corners resize. Shown only while the tray or the settings screen has asked
 * for it - the rest of the time the board takes no clicks at all.
 */
function Arrange() {
  const win = getCurrentWindow();
  const drag = (e: ReactMouseEvent) => {
    if (e.button !== 0) return;
    win.startDragging().catch(() => {});
  };
  const resize = (dir: Edge) => (e: ReactMouseEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    win.startResizeDragging(dir).catch(() => {});
  };
  const stop = (e: ReactMouseEvent) => e.stopPropagation();
  const done = () => {
    invoke("widget_arrange", { on: false }).catch(() => {});
  };
  const reset = () => {
    invoke("widget_reset").catch(() => {});
  };

  const E = 8; // edge grip, px
  const C = 18; // corner grip, px
  const edges: Array<[Edge, CSSProperties]> = [
    ["North", { top: 0, left: C, right: C, height: E, cursor: "ns-resize" }],
    ["South", { bottom: 0, left: C, right: C, height: E, cursor: "ns-resize" }],
    ["West", { left: 0, top: C, bottom: C, width: E, cursor: "ew-resize" }],
    ["East", { right: 0, top: C, bottom: C, width: E, cursor: "ew-resize" }],
    ["NorthWest", { top: 0, left: 0, width: C, height: C, cursor: "nwse-resize" }],
    ["SouthEast", { bottom: 0, right: 0, width: C, height: C, cursor: "nwse-resize" }],
    ["NorthEast", { top: 0, right: 0, width: C, height: C, cursor: "nesw-resize" }],
    ["SouthWest", { bottom: 0, left: 0, width: C, height: C, cursor: "nesw-resize" }],
  ];

  return (
    <div className="absolute inset-0 z-50" style={{ cursor: "move", textShadow: "none" }} onMouseDown={drag}>
      <div
        className="absolute pointer-events-none"
        style={{
          inset: 3,
          borderRadius: 22,
          border: "2px dashed rgba(255,255,255,0.8)",
          background: "rgba(12,12,24,0.38)",
        }}
      />
      {edges.map(([dir, style]) => (
        <div key={dir} className="absolute" style={style} onMouseDown={resize(dir)} />
      ))}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none p-6">
        <div
          className="pointer-events-auto text-center rounded-2xl px-5 py-4"
          style={{ background: "rgba(10,10,20,0.82)", border: "1px solid rgba(255,255,255,0.18)", maxWidth: 420 }}
          onMouseDown={stop}
        >
          <p className="text-white/85 text-sm leading-relaxed">{t("widget.dragHint")}</p>
          <div className="flex gap-2 justify-center mt-3">
            <button
              onClick={reset}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white/70 hover:text-white transition-colors"
              style={{ background: "rgba(255,255,255,0.10)", border: "1px solid rgba(255,255,255,0.16)" }}
            >
              {t("widget.reset")}
            </button>
            <button
              onClick={done}
              className="px-4 py-1.5 rounded-lg text-xs font-semibold text-white theme-btn"
            >
              {t("widget.moveDone")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
