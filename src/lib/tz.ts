// ─── tz.ts — the one place that knows what timezone this app runs on ──────────
//
// Before this file, "+07:00" was written into countdown.ts three different ways:
// as a literal string appended to timestamps, as the number 7 subtracted from an
// hour, and as 16:59:59 UTC standing in for 23:59:59 Bangkok. Three spellings of
// one fact, none of them findable by searching for the others.
//
// It also had a quieter problem. getNextDaily, getNextWeekly and getNextCycle
// all did their arithmetic on a Date whose *system-local* fields had been bent
// to read as Bangkok wall clock, then handed that back as if it were a real
// instant. Those two things are only the same number when the machine itself is
// set to Bangkok. On any other machine every repeating task was off by the
// difference between the two zones — and getNextCycle was worse, because
// new Date("2026-07-28") parses as UTC midnight while .setHours() writes in
// system local, so west of Greenwich it landed on the wrong day entirely.
//
// Everything here converts through real instants, so the answer no longer
// depends on what the operating system's clock is set to.
//
// ── On cost ───────────────────────────────────────────────────────────────────
// This runs inside a 1-second loop, once per task. Intl.DateTimeFormat is the
// expensive part: building one costs far more than using it, and formatToParts
// allocates about a dozen objects per call. So the formatter is built once and
// kept, and the offset it produces is cached in four preallocated slots — plain
// numbers, no Map, no string keys, nothing allocated on a hit. A zone's offset
// only changes at daylight-saving boundaries, so a cached value is not an
// approximation; it is the same answer, not recomputed.
//
// Net effect: this replaces date-fns-tz, which was pulled in for one function
// and dragged date-fns along with it.

const TZ_KEY = "gamesched_timezone";
const FALLBACK_ZONE = "Asia/Bangkok";

/** The stored preference is either this word or a real IANA name. Storing the
 *  word rather than the resolved zone is the point: it means "whatever this
 *  machine says", so moving the laptop moves the app without anyone editing a
 *  setting. */
export const SYSTEM = "system";

export function systemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || FALLBACK_ZONE;
  } catch {
    return FALLBACK_ZONE;
  }
}

export function isValidTimeZone(zone: string): boolean {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function readPreference(): string {
  try {
    return localStorage.getItem(TZ_KEY) || SYSTEM;
  } catch {
    return SYSTEM;
  }
}

function resolve(pref: string): string {
  if (pref === SYSTEM) return systemTimeZone();
  // A hand-edited or stale setting must not be able to throw on every date the
  // app formats for the rest of the session.
  return isValidTimeZone(pref) ? pref : systemTimeZone();
}

let _pref = readPreference();
let _zone = resolve(_pref);

/** The zone all task times are interpreted in. */
export const getAppTimeZone = () => _zone;

/** SYSTEM, or the IANA name the user pinned. */
export const getTimeZonePreference = () => _pref;

export function setTimeZonePreference(pref: string) {
  _pref = pref === SYSTEM || isValidTimeZone(pref) ? pref : SYSTEM;
  try { localStorage.setItem(TZ_KEY, _pref); } catch { /* private mode */ }
  _zone = resolve(_pref);
}

// ── Helpers for the settings screen and the time picker ───────────────────────

/** "UTC+07:00". Built from the cached offset, so listing a screenful of zones
 *  costs one formatter call each and nothing after that. */
export function offsetLabel(zone: string, at: number = Date.now()): string {
  const mins = Math.round(tzOffsetMs(at, zone) / 60000);
  const sign = mins < 0 ? "-" : "+";
  const abs = Math.abs(mins);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/** Every zone the runtime knows, built on first use and not before: it is around
 *  four hundred strings, and nobody who never opens the setting should pay for
 *  it. */
let _allZones: string[] | null = null;
export function allTimeZones(): string[] {
  if (_allZones) return _allZones;
  try {
    const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    _allZones = fn ? fn("timeZone").slice() : [];
  } catch {
    _allZones = [];
  }
  if (!_allZones.length) _allZones = [FALLBACK_ZONE, "UTC", systemTimeZone()];
  return _allZones;
}

/** Every zone's current offset in minutes, as one flat array lined up with
 *  allTimeZones(). Built on first use and only then, because it costs about
 *  40 ms — worth paying once so that typing "+9" can find something, not worth
 *  paying to open a settings page.
 *
 *  The formatters it builds are deliberately not kept: four hundred retained
 *  Intl objects would be real memory, and 836 bytes of Int16Array is the whole
 *  answer. It also uses en-GB rather than the app language on purpose — a Thai
 *  formatter returns the year in the Buddhist era, and feeding 2569 to Date.UTC
 *  produces a number about 27 years wrong. */
let _offsetIndex: Int16Array | null = null;
export function zoneOffsetIndex(): Int16Array {
  if (_offsetIndex) return _offsetIndex;
  const zones = allTimeZones();
  const out = new Int16Array(zones.length);
  const now = new Date();
  const nowSec = Math.floor(now.getTime() / 1000) * 1000;
  for (let i = 0; i < zones.length; i++) {
    try {
      const f = new Intl.DateTimeFormat("en-GB", {
        timeZone: zones[i],
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
      });
      let y = 0, mo = 0, d = 0, h = 0, mi = 0, sec = 0;
      for (const p of f.formatToParts(now)) {
        switch (p.type) {
          case "year": y = +p.value; break;
          case "month": mo = +p.value; break;
          case "day": d = +p.value; break;
          case "hour": h = +p.value % 24; break;
          case "minute": mi = +p.value; break;
          case "second": sec = +p.value; break;
        }
      }
      out[i] = Math.round((Date.UTC(y, mo - 1, d, h, mi, sec) - nowSec) / 60000);
    } catch { out[i] = 0; }
  }
  _offsetIndex = out;
  return out;
}

/** A zone's current offset, in minutes, read out of the flat index.
 *
 *  Drawing a list of zones must not go through tzOffsetMs: that probes each zone
 *  across four years to decide whether it observes daylight saving, and keeps a
 *  formatter for it afterwards. That is the right trade for the one or two zones
 *  the app does arithmetic in, and quite wrong for forty rows someone is
 *  scrolling past — it would be two thousand formatter calls and forty retained
 *  Intl objects to print forty labels.
 *
 *  The list from the runtime is sorted, so this is a binary search into it and
 *  costs nothing beyond the 836-byte index. Anything not in the list, such as a
 *  hand-pinned value, falls back to the accurate path. */
export function indexedOffsetMinutes(zone: string): number {
  const zones = allTimeZones();
  let lo = 0, hi = zones.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (zones[mid] === zone) return zoneOffsetIndex()[mid];
    if (zones[mid] < zone) lo = mid + 1; else hi = mid - 1;
  }
  return Math.round(tzOffsetMs(Date.now(), zone) / 60000);
}

/** "UTC+07:00" from a plain minute count, for rows drawn out of the index. */
export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/** The zone's name in the reader's language, e.g. "เวลามาตรฐานญี่ปุ่น". Asked of
 *  the runtime one zone at a time and remembered, because only the rows on
 *  screen ever need it — doing all four hundred up front costs 290 ms.
 *
 *  Only the name is read out of this formatter. Nothing else from a localized
 *  formatter is safe to parse; see the Buddhist-era note above. */
const _displayNames = new Map<string, string>();
export function zoneDisplayName(zone: string, locale: string): string {
  const key = locale + "|" + zone;
  const hit = _displayNames.get(key);
  if (hit !== undefined) return hit;
  let name = "";
  try {
    const parts = new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: "longGeneric" })
      .formatToParts(new Date());
    name = parts.find(p => p.type === "timeZoneName")?.value ?? "";
  } catch { name = ""; }
  _displayNames.set(key, name);
  return name;
}

/** The zone list lowercased with underscores turned into spaces, so matching
 *  never has to build a string per zone per keystroke. Cached because the list
 *  does not change. */
let _searchable: string[] | null = null;
export function allTimeZonesSearchable(): string[] {
  if (!_searchable) _searchable = allTimeZones().map(z => z.toLowerCase().replace(/_/g, " "));
  return _searchable;
}

// ── Searchable names for every zone, built in the background ─────────────────
// The alias table is hand-written, which means it is incomplete by construction
// and there is no way for anyone to tell what is missing from it short of typing
// country names one at a time and seeing what fails.
//
// The runtime already knows the answer for all 418 zones, in the reader's own
// language. The only reason not to use it was the price: about 290 ms to ask,
// which cannot be spent while someone is waiting for a list to appear.
//
// So it is not spent while they are waiting. The list opens instantly on the
// alias table, and the full index fills in behind it a couple of dozen zones at
// a time during idle frames. Within a second or so searching covers every zone
// the runtime knows about, in Thai and in English, without a table anyone has to
// maintain. Nothing is built unless the picker is actually opened.

let _nameIndex: string[] | null = null;
let _nameLocale = "";
let _nameBuilding = false;

const idle: (fn: () => void) => void =
  typeof requestIdleCallback === "function"
    ? fn => requestIdleCallback(() => fn())
    : fn => setTimeout(fn, 0);

/** Lowercased "<localized name> <english name>" per zone, aligned with
 *  allTimeZones(). Null until the background pass finishes. */
export const zoneNameIndex = () => _nameIndex;

export function ensureZoneNameIndex(locale: string, onReady: () => void) {
  if (_nameLocale === locale && (_nameIndex || _nameBuilding)) return;
  _nameLocale = locale;
  _nameIndex = null;
  _nameBuilding = true;

  const zones = allTimeZones();
  const out = new Array<string>(zones.length).fill("");
  let i = 0;
  const CHUNK = 24;

  const step = () => {
    const end = Math.min(i + CHUNK, zones.length);
    for (; i < end; i++) {
      // zoneDisplayName memoizes, so the rows already drawn cost nothing here
      // and the ones indexed now are free when they are later drawn.
      const local = zoneDisplayName(zones[i], locale);
      const english = locale === "en" ? "" : zoneDisplayName(zones[i], "en");
      out[i] = (local + " " + english).toLowerCase();
    }
    if (i < zones.length) { idle(step); return; }
    _nameIndex = out;
    _nameBuilding = false;
    onReady();
  };
  idle(step);
}

/** Minutes to add to a wall-clock time in `from` to read it in `to`, using
 *  today as the reference date — a bare "09:00" carries no date of its own, so
 *  a zone pair that changes offset during the year is converted as it stands
 *  today. */
export function zoneShiftMinutes(from: string, to: string = _zone, at: number = Date.now()): number {
  return Math.round((tzOffsetMs(at, to) - tzOffsetMs(at, from)) / 60000);
}

/** Convert a time of day between zones. `dayShift` is -1 or 1 when the result
 *  lands on the day before or after, which a bare time of day cannot show on
 *  its own and which the caller should say out loud. */
export function convertTimeOfDay(
  h: number, mi: number, from: string, to: string = _zone,
): { h: number; mi: number; dayShift: number } {
  const total = h * 60 + mi + zoneShiftMinutes(from, to);
  const dayShift = Math.floor(total / 1440);
  const wrapped = ((total % 1440) + 1440) % 1440;
  return { h: Math.floor(wrapped / 60), mi: wrapped % 60, dayShift };
}

// ── Per-zone cache ────────────────────────────────────────────────────────────
// Two zones are now in play at once: the app's, and whatever zone an individual
// task has been pinned to. The cache used to hold exactly one zone and wipe
// itself whenever it was asked about another, which with a mixture of pinned and
// floating tasks would have meant wiping and rebuilding on every single task,
// every second — worse than having no cache at all.
//
// So each zone gets its own record, held in a Map. In practice that is one entry,
// or two or three if some tasks are pinned. A Map lookup on a short string is a
// few nanoseconds; rebuilding an Intl formatter is several thousand times that.
//
// Each record holds two layers:
//
//   The fixed-offset answer. Most of the world does not observe daylight saving,
//   and Thailand is squarely in that group — Asia/Bangkok has sat at UTC+7 since
//   1920. A zone is probed once, monthly across a four-year window around today;
//   if every sample agrees, the offset is a constant and is returned as one, with
//   no formatter calls at all for the rest of the session.
//
//   Failing that, a ring of days. A zone's offset changes at most twice a year,
//   so a day is nearly always uniform; each day is checked once, at its first and
//   last second, and only cached if those agree. On the two days a year that do
//   contain a clock change, the cache steps aside and every lookup is computed
//   exactly. Fast path stays fast, answer stays exact.
//
//   The ring holds 32 days rather than a handful, because the days a tick asks
//   about are not one day repeated — each task reaches for its own reset date,
//   its own anchor, its own deadline. Six slots were enough while every task
//   shared one non-daylight-saving zone and never touched this layer at all; a
//   spread of tasks pinned to daylight-saving zones evicted a slot a moment
//   before it was needed again and paid the formatter every single time. Thirty
//   two slots is about 550 bytes per zone and turns that back into a scan of a
//   typed array.

const DAY_MS = 86_400_000;
const SLOTS = 32;
const PROBE_STEP = 30 * DAY_MS;
const PROBE_SPAN = 730 * DAY_MS;

interface ZoneCache {
  fmt: Intl.DateTimeFormat;
  isFixed: boolean;
  fixedOffset: number;
  lo: number;
  hi: number;
  dayKey: Float64Array;
  dayOffset: Float64Array;
  dayUniform: Uint8Array;
  next: number;
}

const _cache = new Map<string, ZoneCache>();

/** The uncached lookup. This is the expensive one. */
function rawOffsetMs(at: number, c: ZoneCache): number {
  const parts = c.fmt.formatToParts(new Date(at));
  let y = 0, mo = 0, d = 0, h = 0, mi = 0, s = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    switch (p.type) {
      case "year": y = +p.value; break;
      case "month": mo = +p.value; break;
      case "day": d = +p.value; break;
      // A 24-hour formatter renders midnight as "24" in some engines.
      case "hour": h = +p.value % 24; break;
      case "minute": mi = +p.value; break;
      case "second": s = +p.value; break;
    }
  }
  // Reading the zone's wall clock back as if it were UTC and subtracting the
  // real instant leaves exactly the offset.
  return Date.UTC(y, mo - 1, d, h, mi, s) - Math.floor(at / 1000) * 1000;
}

function cacheFor(zone: string): ZoneCache {
  let c = _cache.get(zone);
  if (c) return c;
  c = {
    fmt: new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false,
    }),
    isFixed: true,
    fixedOffset: 0,
    lo: 0, hi: 0,
    dayKey: new Float64Array(SLOTS).fill(NaN),
    dayOffset: new Float64Array(SLOTS),
    dayUniform: new Uint8Array(SLOTS),
    next: 0,
  };
  const now = Date.now();
  c.lo = now - PROBE_SPAN;
  c.hi = now + PROBE_SPAN;
  c.fixedOffset = rawOffsetMs(c.lo, c);
  for (let at = c.lo + PROBE_STEP; at <= c.hi; at += PROBE_STEP) {
    if (rawOffsetMs(at, c) !== c.fixedOffset) { c.isFixed = false; break; }
  }
  _cache.set(zone, c);
  return c;
}

/** How far ahead of UTC the zone is, in milliseconds, at this instant. */
export function tzOffsetMs(at: number, zone: string = _zone): number {
  const c = cacheFor(zone);
  if (c.isFixed && at >= c.lo && at <= c.hi) return c.fixedOffset;

  const day = Math.floor(at / DAY_MS);
  for (let i = 0; i < SLOTS; i++) {
    if (c.dayKey[i] === day) {
      return c.dayUniform[i] ? c.dayOffset[i] : rawOffsetMs(at, c);
    }
  }

  const first = rawOffsetMs(day * DAY_MS, c);
  const last = rawOffsetMs(day * DAY_MS + DAY_MS - 1000, c);
  const uniform = first === last;

  c.dayKey[c.next] = day;
  c.dayOffset[c.next] = first;
  c.dayUniform[c.next] = uniform ? 1 : 0;
  c.next = (c.next + 1) % SLOTS;

  return uniform ? first : rawOffsetMs(at, c);
}

// ── Wall clock ────────────────────────────────────────────────────────────────

export interface Wall {
  y: number; mo: number; d: number;
  h: number; mi: number; s: number;
  /** 0 = Sunday, matching Date.getDay(). */
  dow: number;
}

/** What the clock on the wall reads, in the app's zone, at this instant. */
export function wallClock(at: number = Date.now(), zone: string = _zone): Wall {
  const shifted = new Date(at + tzOffsetMs(at, zone));
  return {
    y: shifted.getUTCFullYear(),
    mo: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
    h: shifted.getUTCHours(),
    mi: shifted.getUTCMinutes(),
    s: shifted.getUTCSeconds(),
    dow: shifted.getUTCDay(),
  };
}

/** The real instant at which the clock on the wall reads this. */
export function wallToMs(w: Wall, zone: string = _zone): number {
  const asIfUTC = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  // First pass assumes the offset that applies at the same numbers read as UTC.
  // The second pass matters only within a day of a daylight-saving change, when
  // the first guess can land on the wrong side of the switch.
  const first = tzOffsetMs(asIfUTC, zone);
  const candidate = asIfUTC - first;
  const second = tzOffsetMs(candidate, zone);
  return second === first ? candidate : asIfUTC - second;
}

/** Calendar-day arithmetic, which is not the same as adding 86,400,000 ms once
 *  a zone with daylight saving is in play. Time of day is carried across. */
export function addDays(w: Wall, n: number): Wall {
  const shifted = new Date(Date.UTC(w.y, w.mo - 1, w.d + n));
  return {
    y: shifted.getUTCFullYear(),
    mo: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
    h: w.h, mi: w.mi, s: w.s,
    dow: shifted.getUTCDay(),
  };
}

/** Same day, different time of day. */
export function atTime(w: Wall, h: number, mi: number, s = 0): Wall {
  return { y: w.y, mo: w.mo, d: w.d, h, mi, s, dow: w.dow };
}

/** "YYYY-MM-DD" → a wall clock at that date and time, or null if unparseable. */
export function dateStrToWall(dateStr: string, h = 0, mi = 0, s = 0): Wall | null {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(dateStr.trim());
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (!y || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, mo, d, h, mi, s, dow: 0 };
}
