import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Power, Image, Palette, Upload, Sparkles, Check, RotateCcw, Bell, BellOff, Clock, Languages, Globe, Wallet, ChevronDown, Moon } from "lucide-react";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { isMuted, setMuted, getQuietHours, setQuietHours, type QuietHours } from "../lib/notifier";
import TimePicker from "./TimePicker";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getSetting, setSetting, currenciesInUse } from "../lib/database";
import { getLang, setLang, t, type Lang } from "../lib/i18n";
import TimeZonePicker from "./TimeZonePicker";
import BackupCard from "./BackupCard";
import { getTimeZonePreference, setTimeZonePreference, getAppTimeZone, offsetLabel, SYSTEM } from "../lib/tz";
import { getCurrency, setCurrency, formatMoney, currencySymbol } from "../lib/money";
import CurrencyPicker from "./CurrencyPicker";
import { loadToastStyle, saveToastStyle, type ToastStyle } from "../lib/toastStyle";
import {
  PROVIDERS, getProviderId, setProviderId, getApiKey, setApiKey,
  getModel, setModel, getBaseUrl, setBaseUrl,
  getDailyRequestCap, setDailyRequestCap, getUsageToday,
  type ProviderId, type DailyUsage,
} from "../lib/aiProviders";
import {
  summariseEscapes, getLearnedPresets, forgetPreset, cacheSize, merchantCount,
  type EscapeSummary, type LearnedPreset,
} from "../lib/aiMemory";
import { loadImportant, saveImportant, shouldReviewImportant, markImportantReviewed, type ImportantCard } from "../lib/importantCard";
import { Toast } from "./ToastCard";
import { paletteFromVideo } from "../lib/videoPalette";

interface Props {
  open: boolean;
  onClose: () => void;
}

// ─── Theme type ────────────────────────────────────────────────────────────────
export interface AppTheme {
  primary: string;       // main accent color (buttons, highlights)
  secondary: string;     // secondary accent
  accent: string;        // bright pop color
  bg: string;            // main background
  bgCard: string;        // card background
  border: string;        // border color
  textMuted: string;     // muted text
  name: string;          // theme name
}

export const DEFAULT_THEME: AppTheme = {
  primary: "#7c3aed",
  secondary: "#4f46e5",
  accent: "#a78bfa",
  bg: "#030712",
  bgCard: "rgba(255,255,255,0.05)",
  border: "rgba(255,255,255,0.10)",
  textMuted: "rgba(255,255,255,0.40)",
  name: "Default Purple",
};

// ─── Theme storage helpers ────────────────────────────────────────────────────
const THEME_KEY = "gamesched_theme_v1";
const SOUND_KEY  = "gamesched_notif_sound_v1"; // base64 data URL of custom sound

export function loadCustomSound(): string | null {
  return localStorage.getItem(SOUND_KEY);
}
export function saveCustomSound(dataUrl: string | null) {
  if (dataUrl) localStorage.setItem(SOUND_KEY, dataUrl);
  else localStorage.removeItem(SOUND_KEY);
}
const ICON_KEY  = "gamesched_icon_v1";

export function loadTheme(): AppTheme {
  try { return JSON.parse(localStorage.getItem(THEME_KEY) || "null") ?? DEFAULT_THEME; }
  catch { return DEFAULT_THEME; }
}

export function saveTheme(t: AppTheme) {
  localStorage.setItem(THEME_KEY, JSON.stringify(t));
}

export function applyTheme(t: AppTheme) {
  const r = document.documentElement.style;
  r.setProperty("--color-primary",   t.primary);
  r.setProperty("--color-secondary", t.secondary);
  r.setProperty("--color-accent",    t.accent);
  r.setProperty("--color-bg",        t.bg);
  r.setProperty("--color-card",      t.bgCard);
  r.setProperty("--color-border",    t.border);
  r.setProperty("--color-muted",     t.textMuted);

  // Inject dynamic <style> that overrides all hardcoded Tailwind purple/indigo classes
  const id = "theme-override-style";
  let el = document.getElementById(id) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = id;
    document.head.appendChild(el);
  }

  // hex to "r g b" for rgb() / rgba()
  const hexToRgb = (hex: string) => {
    const c = hex.replace("#", "");
    return [parseInt(c.slice(0,2),16), parseInt(c.slice(2,4),16), parseInt(c.slice(4,6),16)];
  };
  const [pr, pg, pb] = hexToRgb(t.primary);
  const [sr, sg, sb] = hexToRgb(t.secondary);
  

  el.textContent = `
    /* Dynamic theme override — applyTheme() */

    /* Gradient buttons */
    .bg-gradient-to-r.from-purple-600.to-indigo-600 {
      background: linear-gradient(135deg, ${t.primary}, ${t.secondary}) !important;
    }
    .bg-gradient-to-br.from-purple-500.to-indigo-600 {
      background: linear-gradient(135deg, ${t.primary}, ${t.secondary}) !important;
    }

    /* Solid purple */
    .bg-purple-600 { background-color: ${t.primary} !important; }

    /* Purple text */
    .text-purple-400 { color: ${t.accent} !important; }
    .text-purple-300 { color: ${t.accent}cc !important; }

    /* Gradient stops */
    .from-purple-500, .from-purple-600 { --tw-gradient-from: ${t.primary} !important; }
    .to-indigo-600 { --tw-gradient-to: ${t.secondary} !important; }
    .from-purple-600\\/20 { --tw-gradient-from: rgba(${pr},${pg},${pb},0.20) !important; }
    .from-purple-600\\/30 { --tw-gradient-from: rgba(${pr},${pg},${pb},0.30) !important; }
    .to-indigo-600\\/20   { --tw-gradient-to: rgba(${sr},${sg},${sb},0.20) !important; }
    .to-indigo-600\\/30   { --tw-gradient-to: rgba(${sr},${sg},${sb},0.30) !important; }

    /* Tinted backgrounds */
    .bg-purple-500\\/10, .bg-purple-600\\/10 { background-color: rgba(${pr},${pg},${pb},0.10) !important; }
    .bg-purple-600\\/20 { background-color: rgba(${pr},${pg},${pb},0.20) !important; }
    .bg-purple-600\\/90 { background-color: rgba(${pr},${pg},${pb},0.90) !important; }
    .bg-indigo-500\\/10 { background-color: rgba(${sr},${sg},${sb},0.10) !important; }

    /* Borders */
    .border-purple-500\\/30 { border-color: rgba(${pr},${pg},${pb},0.30) !important; }
    .border-purple-500\\/40 { border-color: rgba(${pr},${pg},${pb},0.40) !important; }
    .border-purple-500\\/60 { border-color: rgba(${pr},${pg},${pb},0.60) !important; }
    .hover\\:border-purple-500\\/60:hover { border-color: rgba(${pr},${pg},${pb},0.60) !important; }

    /* Focus */
    .focus\\:border-purple-500:focus { border-color: ${t.primary} !important; }
    .focus\\:bg-purple-500\\/10:focus { background-color: rgba(${pr},${pg},${pb},0.10) !important; }
    input:focus, select:focus { border-color: ${t.primary} !important; outline-color: ${t.primary} !important; }

    /* Glow */
    .theme-glow { box-shadow: 0 0 20px rgba(${pr},${pg},${pb},0.35) !important; }
    .shadow-purple-500\\/30,
    .shadow-lg.shadow-purple-500\\/30 {
      box-shadow: 0 10px 15px -3px rgba(${pr},${pg},${pb},0.30) !important;
    }

    /* Ring */
    .ring-2.ring-purple-500 { --tw-ring-color: ${t.primary} !important; }

    /* Calendar badge */
    .bg-purple-600.rounded-full { background-color: ${t.primary} !important; }

    /* AI assist button highlight hover */
    .hover\\:from-purple-600\\/30:hover { --tw-gradient-from: rgba(${pr},${pg},${pb},0.30) !important; }
    .hover\\:to-indigo-600\\/30:hover   { --tw-gradient-to: rgba(${sr},${sg},${sb},0.30) !important; }
  `;
}

// ─── Preset themes ─────────────────────────────────────────────────────────────
const PRESET_THEMES: AppTheme[] = [
  DEFAULT_THEME,
  {
    name: "Ocean Cyan",
    primary: "#0891b2", secondary: "#0e7490", accent: "#22d3ee",
    bg: "#020f14", bgCard: "rgba(8,145,178,0.08)", border: "rgba(34,211,238,0.15)",
    textMuted: "rgba(255,255,255,0.40)",
  },
  {
    name: "Rose Gold",
    primary: "#e11d48", secondary: "#be123c", accent: "#fb7185",
    bg: "#0f0509", bgCard: "rgba(225,29,72,0.08)", border: "rgba(251,113,133,0.15)",
    textMuted: "rgba(255,255,255,0.40)",
  },
  {
    name: "Forest",
    primary: "#16a34a", secondary: "#15803d", accent: "#4ade80",
    bg: "#020d05", bgCard: "rgba(22,163,74,0.08)", border: "rgba(74,222,128,0.15)",
    textMuted: "rgba(255,255,255,0.40)",
  },
  {
    name: "Amber",
    primary: "#d97706", secondary: "#b45309", accent: "#fbbf24",
    bg: "#0c0800", bgCard: "rgba(217,119,6,0.08)", border: "rgba(251,191,36,0.15)",
    textMuted: "rgba(255,255,255,0.40)",
  },
];

// ─── Component ────────────────────────────────────────────────────────────────
export default function SettingsModal({ open, onClose }: Props) {
  const [autostart, setAutostart]       = useState(false);
  const [autostartNote, setAutostartNote] = useState("");
  const [activeTab, setActiveTab]       = useState<"general" | "appearance">("general");
  const [currentTheme, setCurrentTheme] = useState<AppTheme>(loadTheme);
  const [customIcon, setCustomIcon]     = useState<string | null>(null);
  const [aiLoading, setAiLoading]       = useState(false);
  const [aiTheme, setAiTheme]           = useState<AppTheme | null>(null);
  const [aiPreview, setAiPreview]       = useState<string | null>(null); // base64 of uploaded image
  const [aiError, setAiError]           = useState("");
  const [saved, setSaved]               = useState(false);
  const [notifMuted, setNotifMuted]     = useState(false);
  const [quiet, setQuiet]               = useState<QuietHours>(getQuietHours);
  const [toastDuration, setToastDuration] = useState(8);
  const [lang, setLangState] = useState<Lang>(getLang);
  const [pendingLang, setPendingLang] = useState<Lang | null>(null);
  // Same shape as the language setting: chosen, confirmed, then the window
  // reloads. A zone change moves what "today" means, and several views work out
  // their month or their calendar cursor once when they mount, so reloading is
  // both the honest and the cheap way to make every one of them agree.
  const [reviewImportant, setReviewImportant] = useState(false);
  useEffect(() => { if (open) setReviewImportant(shouldReviewImportant()); }, [open]);

  const [tzPref, setTzPref] = useState<string>(getTimeZonePreference);
  const [pendingTz, setPendingTz] = useState<string | null>(null);
  const [tzOpen, setTzOpen] = useState(false);
  // Read once. getCurrency() writes the first-run guess back to storage, so the
  // answer stops depending on the machine's region from that moment on.
  const [currencyCode, setCurrencyCode] = useState(() => getCurrency());
  // What the ledger is actually kept in, as opposed to what the setting claims
  // the next entry will be. Loaded when the screen opens, not on mount, so it
  // is fresh after a session of adding things.
  const [curInUse, setCurInUse] = useState<{ code: string; n: number }[]>([]);
  useEffect(() => {
    if (!open) return;
    currenciesInUse().then(setCurInUse).catch(() => setCurInUse([]));
  }, [open]);

  const pickCurrency = (code: string) => { setCurrency(code); setCurrencyCode(code); };
  const [pendingIconUrl, setPendingIconUrl] = useState<string | null>(null);
  const [customSound, setCustomSound]   = useState<string | null>(null);
  const [soundName, setSoundName]       = useState<string>("");
  const [toastStyle, setToastStyle]     = useState<ToastStyle>(() => loadToastStyle());
  // Montage of the frames the palette was read from, so the result is not a
  // black box the user has to take on faith.
  const [wpMontage, setWpMontage]       = useState<string | null>(null);

  // ── AI provider settings ────────────────────────────────────────────────
  const [aiProvider, setAiProvider] = useState<ProviderId>(() => getProviderId());
  const [aiModel, setAiModel]       = useState<string>(() => getModel());
  const [aiBaseUrl, setAiBaseUrl]   = useState<string>(() => getBaseUrl());
  const [aiKey, setAiKey]           = useState<string>(() => getApiKey());
  const [aiCap, setAiCap]           = useState<string>(() => String(getDailyRequestCap()));
  const [aiUsage, setAiUsage]       = useState<DailyUsage>(() => getUsageToday());
  const [aiSaved, setAiSaved]       = useState(false);
  const [escapes, setEscapes]       = useState<EscapeSummary[]>([]);
  const [learned, setLearned]       = useState<LearnedPreset[]>([]);
  const [memStats, setMemStats]     = useState({ cache: 0, shops: 0 });

  // Written by the person, read by nobody else. Never synced, never sent.
  const [important, setImportant] = useState<ImportantCard>(() => loadImportant());
  const [newContact, setNewContact] = useState({ label: "", value: "" });
  const persistImportant = (card: ImportantCard) => {
    setImportant(card);
    saveImportant(card);
  };

  const refreshMemory = () => {
    setEscapes(summariseEscapes(7).slice(0, 6));
    setLearned(getLearnedPresets());
    setMemStats({ cache: cacheSize(), shops: merchantCount() });
  };

  // Switching provider pulls that provider's own saved key and its default
  // model, so going Gemini → OpenAI → Gemini does not lose either key.
  const switchProvider = (id: ProviderId) => {
    setProviderId(id);
    setAiProvider(id);
    setAiKey(getApiKey(id));
    const def = PROVIDERS[id].defaultModel;
    setModel(def);
    setAiModel(def);
    const base = PROVIDERS[id].defaultBaseUrl ?? "";
    setBaseUrl(base);
    setAiBaseUrl(base);
  };

  const saveAiSettings = () => {
    setApiKey(aiKey, aiProvider);
    setModel(aiModel);
    setBaseUrl(aiBaseUrl);
    setDailyRequestCap(parseInt(aiCap || "0", 10) || 0);
    setAiUsage(getUsageToday());
    setAiSaved(true);
    setTimeout(() => setAiSaved(false), 1500);
    // Same pinned confirmation the rest of the page uses, so there is one
    // place to look rather than one per section.
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };
  // Wallpaper state
  const [wpPath, setWpPath]             = useState<string>("");
  const [wpEnabled, setWpEnabled]       = useState(false);
  const [wpBusy, setWpBusy]             = useState(false);
  const [wpError, setWpError]           = useState<string>("");

  // Status words from the backend ("swapped" / "started" / "stopped")
  // clear themselves; real errors stay put.
  const flashStatus = (m: string) => {
    setWpError(m);
    setTimeout(() => setWpError(v => (v === m ? "" : v)), 3000);
  };

  // Whether the click in progress began on the backdrop rather than inside the
  // dialog. See the mousedown handler on the overlay.
  const backdropPress = useRef(false);

  const iconRef  = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);
  const soundRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      isEnabled().then(setAutostart).catch(() => {});
      // Load saved icon
      const icon = localStorage.getItem(ICON_KEY);
      if (icon) setCustomIcon(icon);
      setCurrentTheme(loadTheme());
      setAiTheme(null);
      setAiPreview(null);
      setAiError("");
      setNotifMuted(isMuted());
      const stored = parseInt(localStorage.getItem("gamesched_toast_duration_sec") || "8");
      setToastDuration(isNaN(stored) ? 8 : stored);
      const snd = loadCustomSound();
      setCustomSound(snd);
      setSoundName(snd ? (localStorage.getItem("gamesched_notif_sound_name") || "Custom sound") : "");
      setToastStyle(loadToastStyle());
      setAiProvider(getProviderId());
      setAiModel(getModel());
      setAiBaseUrl(getBaseUrl());
      setAiKey(getApiKey());
      setAiCap(String(getDailyRequestCap()));
      setAiUsage(getUsageToday());
      refreshMemory();
      setImportant(loadImportant());
      // Load wallpaper settings from DB
      setWpBusy(false); // clear any stuck busy state from a previous session
      getSetting("wallpaper_path").then(p => { if (p) setWpPath(p); }).catch(() => {});
      getSetting("wallpaper_enabled").then(v => setWpEnabled(v === "1")).catch(() => {});
    }
  }, [open]);

  // ── Wallpaper handlers ──────────────────────────────────────────────
  // Native drag-drop + wallpaper status listeners.
  useEffect(() => {
    if (!open) return;
    let unlisten: (() => void) | undefined;
    let unlistenStatus: (() => void) | undefined;
    let disposed = false;
    (async () => {
      try {
        const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        const wv = getCurrentWebviewWindow();
        const un = await wv.onDragDropEvent((event: any) => {
          if (event.payload?.type !== "drop") return;
          const paths: string[] = event.payload.paths || [];
          const vid = paths.find(p => /\.(mp4|webm|mkv|mov)$/i.test(p));
          if (!vid) { setWpError("ไม่ใช่ไฟล์วิดีโอ (mp4/webm/mkv/mov)"); return; }
          setWpPath(vid);
          setWpError("");
          setSetting("wallpaper_path", vid).catch(() => {});
          if (wpEnabled) {
            invoke<string>("swap_wallpaper", { path: vid })
              .then(r => flashStatus(String(r)))
              .catch(e => setWpError("swap failed: " + String(e)));
          }
        });
        if (disposed) un(); else unlisten = un;

        const { listen } = await import("@tauri-apps/api/event");
        const un2 = await listen("wallpaper-status", (e: any) => {
          setWpError(String(e.payload));
        });
        if (disposed) un2(); else unlistenStatus = un2;
      } catch (e) { console.warn("wallpaper listeners failed:", e); }
    })();
    return () => { disposed = true; unlisten?.(); unlistenStatus?.(); };
  }, [open, wpEnabled]);

  const pickWallpaper = async () => {
    try {
      let selected: string | null = null;
      try {
        selected = await invoke<string | null>("pick_video");
      } catch (e) {
        console.warn("pick_video failed, falling back to JS dialog:", e);
        if (typeof openDialog === "function") {
          const r = await openDialog({
            multiple: false,
            title: "Select a video",
            filters: [{ name: "Video", extensions: ["mp4", "webm", "mkv", "mov"] }],
          });
          selected = typeof r === "string" ? r : null;
        } else {
          throw new Error("no dialog available");
        }
      }
      if (typeof selected === "string" && selected) {
        setWpPath(selected);
        await setSetting("wallpaper_path", selected);
        if (wpEnabled) {
          // "swapped" = pushed live down the pipe, "restarted" = child was gone
          try {
            const r = await invoke<string>("swap_wallpaper", { path: selected });
            flashStatus(String(r));
          } catch (e) {
            setWpError("swap failed: " + String(e));
          }
        } else {
          setWpError("");
        }
      } else {
        setWpError("");
      }
    } catch (err) {
      console.error("pickWallpaper failed:", err);
      setWpError("error: " + String(err));
    }
  };

  const toggleWallpaper = async () => {
    if (wpBusy) return;
    setWpBusy(true);
    const invokeWithTimeout = (cmd: string, args?: any) =>
      Promise.race([
        invoke(cmd, args),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 5000)),
      ]);
    try {
      if (!wpEnabled) {
        if (!wpPath) { setWpBusy(false); return; }
        // Flip UI first so it feels instant; revert on failure.
        setWpEnabled(true);
        await setSetting("wallpaper_enabled", "1");
        const r = await invokeWithTimeout("start_wallpaper", { path: wpPath });
        flashStatus(String(r));
      } else {
        setWpEnabled(false);
        await setSetting("wallpaper_enabled", "0");
        const r = await invokeWithTimeout("stop_wallpaper");
        flashStatus(String(r));
      }
    } catch (err) {
      console.error("toggleWallpaper failed:", err);
      setWpError(String(err));
      // Re-sync UI with what we tried; keep the setting as saved.
    } finally {
      setWpBusy(false);
    }
  };

  const handleLangChange = (newLang: Lang) => {
    if (newLang === lang) return;
    setPendingLang(newLang);
  };

  const confirmLangChange = () => {
    if (!pendingLang) return;
    setLang(pendingLang);
    setLangState(pendingLang);
    setPendingLang(null);
    setTimeout(() => window.location.reload(), 300);
  };

  const cancelLangChange = () => {
    setPendingLang(null);
  };

  const confirmTzChange = () => {
    if (!pendingTz) return;
    setTimeZonePreference(pendingTz);
    setTzPref(pendingTz);
    setPendingTz(null);
    setTimeout(() => window.location.reload(), 300);
  };

  const toggleAutostart = async () => {
    // The autostart plugin registers whichever executable is running right now.
    // Turning this on from `pnpm tauri dev` writes target\\debug\\game-scheduler.exe
    // into the Windows Run key. At the next boot Windows launches that build, it
    // tries to reach the Vite server on localhost:1420 which is not running, and
    // the user gets a blank window with DevTools on top instead of the app. So a
    // dev build is not allowed to touch the startup entry at all.
    if (import.meta.env.DEV) {
      setAutostartNote(t("settings.autostartDevOnly"));
      setTimeout(() => setAutostartNote(""), 5000);
      return;
    }
    try {
      if (autostart) { await disable(); setAutostart(false); }
      else           { await enable();  setAutostart(true);  }
    } catch (err) {
      console.error("Autostart error:", err);
      setAutostartNote(String(err));
    }
  };

  const handleSoundUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      saveCustomSound(dataUrl);
      setCustomSound(dataUrl);
      setSoundName(file.name);
      localStorage.setItem("gamesched_notif_sound_name", file.name);
    };
    reader.readAsDataURL(file);
  };

  const handleSoundReset = () => {
    saveCustomSound(null);
    setCustomSound(null);
    setSoundName("");
    localStorage.removeItem("gamesched_notif_sound_name");
    if (soundRef.current) soundRef.current.value = "";
  };

  const saveQuiet = (next: QuietHours) => {
    setQuiet(next);
    setQuietHours(next);
  };

  const toggleNotifMute = () => {
    const next = !notifMuted;
    setMuted(next);
    setNotifMuted(next);
  };

  const handleDurationChange = (v: number) => {
    setToastDuration(v);
    localStorage.setItem("gamesched_toast_duration_sec", String(v));
  };

  const DURATION_OPTIONS = [
    { label: "3s", value: 3 }, { label: "5s", value: 5 },
    { label: "8s", value: 8 }, { label: "10s", value: 10 },
    { label: "15s", value: 15 }, { label: "30s", value: 30 },
  ];

  // ── Icon upload ──────────────────────────────────────────────────────────────
  const applyIconFromDataUrl = (b64: string, andReload: boolean) => {
    setCustomIcon(b64);
    localStorage.setItem(ICON_KEY, b64);
    const img = new window.Image();
    img.onload = () => {
      const size = 32;
      const canvas = document.createElement("canvas");
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0, size, size);
      const rgba = Array.from(ctx.getImageData(0, 0, size, size).data);
      invoke("set_tray_icon", { rgba, width: size, height: size })
        .catch(console.warn)
        .finally(() => {
          if (andReload) setTimeout(() => window.location.reload(), 300);
        });
    };
    img.onerror = () => {
      if (andReload) setTimeout(() => window.location.reload(), 300);
    };
    img.src = b64;
  };

  const handleIconUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const b64 = reader.result as string;
      if (import.meta.env.DEV) {
        // Dev mode: apply live immediately, no restart needed
        applyIconFromDataUrl(b64, false);
      } else {
        // Prod: show confirm dialog, then restart
        setPendingIconUrl(b64);
      }
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  const confirmIconChange = () => {
    if (!pendingIconUrl) return;
    setPendingIconUrl(null);
    applyIconFromDataUrl(pendingIconUrl, true);
  };

  const cancelIconChange = () => {
    setPendingIconUrl(null);
  };

  const resetIcon = () => {
    setCustomIcon(null);
    localStorage.removeItem(ICON_KEY);
    // Restore default tray icon (empty signals Rust to use default)
    invoke("set_tray_icon", { rgba: [], width: 0, height: 0 }).catch(console.warn);
  };

  // ── Apply a theme ────────────────────────────────────────────────────────────
  const applyAndSave = (theme: AppTheme) => {
    setCurrentTheme(theme);
    saveTheme(theme);
    applyTheme(theme);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  // ── Color utilities ──────────────────────────────────────────────────────────

  const clamp = (v: number) => Math.min(255, Math.max(0, Math.round(v)));
  const toHex = (r: number, g: number, b: number) =>
    `#${clamp(r).toString(16).padStart(2,"0")}${clamp(g).toString(16).padStart(2,"0")}${clamp(b).toString(16).padStart(2,"0")}`;
  const darken  = (r: number, g: number, b: number, f: number) => toHex(r*f, g*f, b*f);
  const brighten = (r: number, g: number, b: number, f: number) => toHex(r*f, g*f, b*f);

  // ── Gold/warm dedicated scan ─────────────────────────────────────────────────
  // Scans every pixel for warm-tone signature (R dominates, G moderate, B clearly lower).
  // Returns averaged warm color if enough pixels found, otherwise null.
  const scanWarmHighlight = (data: Uint8ClampedArray): {r:number,g:number,b:number} | null => {
    let rSum = 0, gSum = 0, bSum = 0, n = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i+1], b = data[i+2];
      // Gold/amber signature: R clearly beats G, G clearly beats B, not too dark
      if (r > 110 && g > 70 && r > g * 1.15 && r > b * 1.9 && (r+g+b)/3 > 70) {
        rSum += r; gSum += g; bSum += b; n++;
      }
    }
    // Require at least 0.2% of total pixels (very lenient — gold streaks are small)
    if (n < (data.length / 4) * 0.002 || n < 3) return null;
    return { r: Math.round(rSum/n), g: Math.round(gSum/n), b: Math.round(bSum/n) };
  };

  // ── k-means++ clustering ─────────────────────────────────────────────────────
  // Finds k dominant color clusters using better initialization than random.
  type RGBCluster = {r:number,g:number,b:number,count:number,sat:number,brightness:number};

  const extractDominantColors = (data: Uint8ClampedArray, k = 8): RGBCluster[] => {
    type RGB = [number,number,number];
    const samples: RGB[] = [];

    // Dense sample — every pixel (skip only alpha channel)
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i+1], b = data[i+2];
      const br = (r+g+b)/3;
      if (br < 12 || br > 250) continue; // skip pure black/white only
      samples.push([r,g,b]);
    }
    if (samples.length < k) return [];

    // k-means++ init: spread centroids far apart
    const cents: RGB[] = [samples[Math.floor(samples.length/2)]];
    while (cents.length < k) {
      const dists = samples.map(([r,g,b]) => {
        let min = Infinity;
        for (const [cr,cg,cb] of cents) {
          const d = (r-cr)**2 + (g-cg)**2 + (b-cb)**2;
          if (d < min) min = d;
        }
        return min;
      });
      const total = dists.reduce((a,b) => a+b, 0);
      if (total === 0) break;
      let rand = Math.random() * total;
      let pick = samples[0];
      for (let i = 0; i < samples.length; i++) { rand -= dists[i]; if (rand <= 0) { pick = samples[i]; break; } }
      cents.push([...pick]);
    }

    // 15 iterations of k-means
    let centroids: RGB[] = cents;
    for (let iter = 0; iter < 15; iter++) {
      const sums: [number,number,number,number][] = Array.from({length:k}, () => [0,0,0,0]);
      for (const [r,g,b] of samples) {
        let best = 0, bestD = Infinity;
        for (let c = 0; c < k; c++) {
          const d = (r-centroids[c][0])**2 + (g-centroids[c][1])**2 + (b-centroids[c][2])**2;
          if (d < bestD) { bestD = d; best = c; }
        }
        sums[best][0]+=r; sums[best][1]+=g; sums[best][2]+=b; sums[best][3]++;
      }
      centroids = sums.map(([r,g,b,n],i) => n>0 ? [Math.round(r/n),Math.round(g/n),Math.round(b/n)] : centroids[i]);
    }

    // Final counts
    const counts = new Array(k).fill(0);
    for (const [r,g,b] of samples) {
      let best = 0, bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const d = (r-centroids[c][0])**2 + (g-centroids[c][1])**2 + (b-centroids[c][2])**2;
        if (d < bestD) { bestD = d; best = c; }
      }
      counts[best]++;
    }

    return centroids.map(([r,g,b],i) => {
      const mx=Math.max(r,g,b), mn=Math.min(r,g,b);
      return { r, g, b, count: counts[i], sat: mx===0?0:(mx-mn)/mx, brightness:(r+g+b)/3 };
    }).sort((a,b) => b.count - a.count);
  };

  // ── Theme builder ─────────────────────────────────────────────────────────────
  // warmHighlight: gold/amber pixels from dedicated scan (bypasses k-means for accent)
  const buildThemeFromClusters = (clusters: RGBCluster[], warmHighlight: {r:number,g:number,b:number} | null): AppTheme => {
    if (clusters.length === 0) throw new Error("No clusters");

    const isWarm = (r:number,g:number,b:number) => r > g*1.15 && r > b*1.8;

    // Sort clusters by vividness (sat × brightness, not too dark/light)
    const vivid = [...clusters]
      .filter(c => c.brightness > 20 && c.brightness < 242)
      .sort((a,b) => (b.sat * Math.min(b.brightness/90,1.8)) - (a.sat * Math.min(a.brightness/90,1.8)));

    // Primary: most vivid NON-warm cluster (blue, purple, teal etc.)
    const primary = vivid.find(c => !isWarm(c.r,c.g,c.b)) ?? vivid[0] ?? clusters[0];
    const { r:pr, g:pg, b:pb } = primary;

    // Accent: use gold scan result if present, otherwise find visually different cluster
    let ar: number, ag: number, ab: number, accentIsGold = false;
    if (warmHighlight) {
      // Boost gold saturation slightly for UI vibrancy
      ar = clamp(warmHighlight.r * 1.18);
      ag = clamp(warmHighlight.g * 1.05);
      ab = clamp(warmHighlight.b * 0.85);
      accentIsGold = true;
    } else {
      let acc = vivid[1] ?? vivid[0];
      for (const c of vivid) {
        const dist = Math.abs(c.r-pr) + Math.abs(c.g-pg) + Math.abs(c.b-pb);
        if (dist > 60) { acc = c; break; }
      }
      ar=acc.r; ag=acc.g; ab=acc.b;
    }

    // bg: darkest dominant hue, very near black
    const dom = clusters[0];
    const bg = toHex(dom.r*0.055+pr*0.02, dom.g*0.055+pg*0.02, dom.b*0.065+pb*0.02);

    // Poetic name
    const primWord = (() => {
      if (pb>pr*1.25 && pb>pg) return pb>170?"Azure":"Midnight";
      if (pr>pg && pr>pb && !isWarm(pr,pg,pb)) return pr>170?"Crimson":"Ember";
      if (pg>pr*1.2 && pg>pb) return "Jade";
      if (pr>130 && pb>130) return "Violet";
      if (pb>100) return "Cobalt";
      return "Obsidian";
    })();
    const accWord = (() => {
      if (accentIsGold) return "Gold";
      if (ar>ag*1.3 && ar>ab*1.8) return "Amber";
      if (ab>ar+40) return "Frost";
      if (ar>ag+40) return "Rose";
      if (ag>ar && ag>ab) return "Sage";
      return "Silver";
    })();

    return {
      name: `${primWord} ${accWord}`,
      primary: brighten(pr,pg,pb,1.12),
      secondary: darken(pr,pg,pb,0.58),
      accent: toHex(ar,ag,ab),
      bg,
      bgCard: `rgba(${pr},${pg},${pb},0.09)`,
      border: `rgba(${ar},${ag},${ab},0.22)`,
      textMuted: "rgba(255,255,255,0.40)",
    };
  };

  // ── Canvas extraction (runs the full pipeline on the actual image) ────────────
  const extractThemeFromCanvas = (file: File): Promise<{ theme: AppTheme; hasGold: boolean }> =>
    new Promise((resolve, reject) => {
      const img = new window.Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        try {
          // Use 200×200 — large enough to preserve thin gold streaks
          const SZ = 200;
          const canvas = document.createElement("canvas");
          canvas.width = SZ; canvas.height = SZ;
          const ctx = canvas.getContext("2d")!;
          ctx.drawImage(img, 0, 0, SZ, SZ);
          const { data } = ctx.getImageData(0, 0, SZ, SZ);

          const warmHighlight = scanWarmHighlight(data);
          const clusters = extractDominantColors(data, 9);
          if (clusters.length === 0) { reject(new Error("No usable colors")); return; }
          const theme = buildThemeFromClusters(clusters, warmHighlight);
          resolve({ theme, hasGold: warmHighlight !== null });
        } catch(e) { reject(e); }
        finally { URL.revokeObjectURL(url); }
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Image load failed")); };
      img.src = url;
    });

  // ── Theme generation from any image ───────────────────────────────────────────
  // Shared by the "upload an image" flow and the "use my wallpaper" button.
  // Returns the theme so a caller can apply it straight away.
  const generateThemeFromFile = async (file: File): Promise<AppTheme | null> => {
    setAiError(""); setAiTheme(null);

    const reader = new FileReader();
    reader.onload = () => setAiPreview(reader.result as string);
    reader.readAsDataURL(file);

    setAiLoading(true);

    // Step 1 — canvas extraction (always fast, always works)
    let canvasResult: { theme: AppTheme; hasGold: boolean } | null = null;
    try { canvasResult = await extractThemeFromCanvas(file); }
    catch(e) { console.warn("Canvas extraction failed:", e); }

    // Step 2 — AI refinement with canvas colors as ground truth
    try {
      const ab = await file.arrayBuffer();
      let binary = "";
      new Uint8Array(ab).forEach(b => binary += String.fromCharCode(b));
      const base64 = btoa(binary);
      const mediaType = file.type as "image/jpeg"|"image/png"|"image/webp"|"image/gif";

      const goldWarning = canvasResult?.hasGold
        ? " ⚠️ CRITICAL: The canvas pixel scan detected GOLD/AMBER highlights in this image. You MUST use a gold/amber color (#c8960a–#f5c842 range) as the accent. Do NOT use blue or grey for the accent."
        : "";

      const hint = canvasResult
        ? `Canvas pixel analysis: primary=${canvasResult.theme.primary}, accent=${canvasResult.theme.accent}, secondary=${canvasResult.theme.secondary}, bg=${canvasResult.theme.bg}.${goldWarning} Use these as ground truth and refine slightly.`
        : "";

      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 600,
          system: "You are a UI color theme generator. Output valid JSON only. Zero extra text.",
          messages: [{ role: "user", content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
            { type: "text", text:
              `Generate a dark UI theme from this image. ${hint}

JSON only:
{"name":"<2-3 word name>","primary":"<hex>","secondary":"<hex>","accent":"<hex>","bg":"<hex>","bgCard":"<rgba>","border":"<rgba>","textMuted":"rgba(255,255,255,0.40)"}

Rules:
- primary: dominant vivid hue (cobalt/navy/purple etc.)
- secondary: 58% brightness of primary
- accent: GOLD if any gold/yellow/amber shimmer exists — even faint streaks count; else brightest contrasting color
- bg: near-black with faint primary tint (2–6% brightness)
- bgCard: rgba(primary-rgb, 0.09), border: rgba(accent-rgb, 0.22)` }
          ]}]
        })
      });

      const res = await resp.json();
      if (!res.error) {
        const txt = (res.content ?? []).map((b: any) => b.type==="text" ? b.text : "").join("");
        const m = txt.match(/\{[\s\S]*?\}/);
        if (m) {
          const parsed = JSON.parse(m[0]) as AppTheme;
          if (parsed.primary && parsed.accent && parsed.name) {
            setAiTheme(parsed);
            setAiLoading(false);
            return parsed;
          }
        }
      }
    } catch(e) { console.warn("AI failed, using canvas:", e); }

    // Step 3 — canvas fallback
    if (canvasResult) {
      setAiTheme(canvasResult.theme);
      setAiLoading(false);
      return canvasResult.theme;
    }
    setAiError("Could not extract colors from this image.");
    setAiLoading(false);
    return null;
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await generateThemeFromFile(file);
  };

  // ── Theme from the live wallpaper ─────────────────────────────────────────────
  // Deliberately NOT the image pipeline. See src/lib/videoPalette.ts for why:
  // one frame is not a video, and the image extractor has hue rules baked in
  // from one particular picture.
  const handleThemeFromWallpaper = async () => {
    if (!wpPath) return;
    setWpError("");
    setAiLoading(true);
    try {
      const { theme, montage } = await paletteFromVideo(wpPath);
      setWpMontage(montage);
      applyAndSave(theme);
    } catch (err) {
      setWpError(err instanceof Error ? err.message : String(err));
    } finally {
      setAiLoading(false);
    }
  };

  const handleToastStyle = (v: ToastStyle) => {
    setToastStyle(v);
    saveToastStyle(v);
  };
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          /* Closing on any click that lands on the backdrop is wrong: dragging
             to select text inside a field and releasing past the dialog edge
             fires a click on their common ancestor, which is this backdrop, and
             the dialog shuts with the text unsaved.

             A click only counts as "on the backdrop" if the press STARTED
             there. A drag that began inside the dialog is a selection, not a
             dismissal, wherever it happens to end. */
          onMouseDown={e => { backdropPress.current = e.target === e.currentTarget; }}
          onClick={e => {
            if (e.target === e.currentTarget && backdropPress.current) onClose();
            backdropPress.current = false;
          }}
        >
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.9, opacity: 0 }}
            onClick={e => e.stopPropagation()}
            className="relative bg-gray-900 border border-white/10 rounded-3xl w-full max-w-md shadow-2xl overflow-hidden"
            style={{ maxHeight: "88vh" }}
          >
            {/* "Saved" used to live inside the scrolling content, up beside the
                theme preview. Anyone who had scrolled to the bottom to press a
                button never saw the confirmation for the thing they just
                pressed. It is pinned to the dialog now, not to the page. */}
            <AnimatePresence>
              {saved && (
                <motion.div
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  className="absolute top-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 rounded-full bg-emerald-500/20 border border-emerald-400/40 px-3 py-1 text-emerald-300 text-xs font-semibold pointer-events-none"
                >
                  <Check size={12} /> {t("settings.applied")}
                </motion.div>
              )}
            </AnimatePresence>

            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-white/8">
              <h2 className="text-white font-bold text-xl">{t("settings.title")}</h2>
              <button onClick={onClose} className="text-white/40 hover:text-white transition-colors">
                <X size={20} />
              </button>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-white/8">
              {(["general", "appearance"] as const).map(tab => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`flex-1 py-3 text-sm font-semibold transition-all capitalize ${
                    activeTab === tab
                      ? "text-white border-b-2 border-purple-500"
                      : "text-white/30 hover:text-white/60"
                  }`}
                >
                  {tab === "general" ? t("settings.tabGeneral") : t("settings.tabAppearance")}
                </button>
              ))}
            </div>

            <div className="overflow-y-auto" style={{ maxHeight: "calc(88vh - 130px)" }}>

              {/* ── GENERAL TAB ─────────────────────────────────────────── */}
              {activeTab === "general" && (
                <div className="p-6 space-y-4">
                  {/* Autostart */}
                  <div className="flex items-center justify-between bg-white/5 border border-white/10 rounded-2xl p-4">
                    <div className="flex items-center gap-3">
                      <Power size={18} className={autostart ? "text-green-400" : "text-white/30"} />
                      <div>
                        <p className="text-white text-sm font-semibold">{t("settings.autostart")}</p>
                        <p className="text-white/40 text-xs">{t("settings.autostartSub")}</p>
                        {autostartNote && (
                          <p className="text-amber-400/80 text-[10px] mt-0.5 leading-snug">{autostartNote}</p>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={toggleAutostart}
                      className={`w-12 h-6 rounded-full transition-all relative ${autostart ? "bg-green-500" : "bg-white/20"}`}
                    >
                      <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${autostart ? "left-7" : "left-1"}`} />
                    </button>
                  </div>

                  {/* Notifications */}
                  <div className="bg-white/5 border border-white/10 rounded-2xl p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        {notifMuted ? <BellOff size={18} className="text-white/30" /> : <Bell size={18} className="text-purple-400" />}
                        <div>
                          <p className="text-white text-sm font-semibold">{t("settings.notifications")}</p>
                          <p className="text-white/40 text-xs">{notifMuted ? t("settings.muted") : t("settings.toastSub")}</p>
                        </div>
                      </div>
                      <button onClick={toggleNotifMute} className={`w-12 h-6 rounded-full transition-all relative ${!notifMuted ? "bg-purple-500" : "bg-white/20"}`}>
                        <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${!notifMuted ? "left-7" : "left-1"}`} />
                      </button>
                    </div>
                    {!notifMuted && (
                      <div className="border-t border-white/8 pt-3 space-y-3">
                        {/* Quiet hours — a window, not an off switch.
                            Mute is all-or-nothing and that is the wrong shape
                            for "not at five in the morning". Reminders held
                            back here are delayed, not cancelled: the notifier
                            deliberately does not mark them as sent, so the
                            first tick after the window fires them. */}
                        <div>
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                              <Moon size={13} className="text-white/40" />
                              <span className="text-white/60 text-xs font-semibold">{t("quiet.title")}</span>
                            </div>
                            <button
                              onClick={() => saveQuiet({ ...quiet, enabled: !quiet.enabled })}
                              className={`w-10 h-5 rounded-full transition-all relative ${quiet.enabled ? "bg-purple-500" : "bg-white/20"}`}
                            >
                              <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all ${quiet.enabled ? "left-5.5" : "left-0.5"}`} />
                            </button>
                          </div>
                          <p className="text-white/30 text-[11px] leading-relaxed mb-2">
                            {quiet.enabled ? t("quiet.sub") : t("quiet.off")}
                          </p>
                          {quiet.enabled && (
                            <>
                              {/* The app's own picker, not <input type="time">.
                                  The native field is drawn by the browser in the
                                  OS locale, so it showed 11:00 PM here while
                                  every other time field in the app showed 23:00
                                  — two clocks, in one program, disagreeing about
                                  what country it is in. TimePicker follows the
                                  app language like the rest of them. */}
                              <div className="flex items-center gap-2">
                                <span className="text-white/40 text-[11px] w-12 shrink-0">{t("quiet.from")}</span>
                                <div className="flex-1 min-w-0">
                                  {/* No zone control here. Quiet hours are about
                                      when this person is asleep, in the app's own
                                      zone — a foreign-zone entry would be answering
                                      a question nobody asked. */}
                                  <TimePicker value={quiet.start} onChange={v => saveQuiet({ ...quiet, start: v })} showZone={false} />
                                </div>
                                <span className="text-white/40 text-[11px] w-10 text-right shrink-0">{t("quiet.to")}</span>
                                <div className="flex-1 min-w-0">
                                  <TimePicker value={quiet.end} onChange={v => saveQuiet({ ...quiet, end: v })} showZone={false} />
                                </div>
                              </div>
                              <p className="text-white/25 text-[10px] leading-relaxed mt-2">{t("quiet.note")}</p>
                            </>
                          )}
                        </div>

                        {/* Duration */}
                        <div className="border-t border-white/8 pt-3">
                          <div className="flex items-center gap-2 mb-2">
                            <Clock size={13} className="text-white/40" />
                            <span className="text-white/60 text-xs font-semibold">{t("settings.duration")}</span>
                            <span className="ml-auto text-purple-400 text-xs font-bold">{toastDuration}s</span>
                          </div>
                          <div className="flex gap-1.5 flex-wrap">
                            {DURATION_OPTIONS.map(opt => (
                              <button key={opt.value} onClick={() => handleDurationChange(opt.value)}
                                className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all ${toastDuration === opt.value ? "bg-purple-600 text-white" : "bg-white/8 text-white/40 hover:bg-white/15 hover:text-white"}`}>
                                {opt.label}
                              </button>
                            ))}
                          </div>
                        </div>
                        {/* Toast style */}
                        <div className="border-t border-white/8 pt-3">
                          <div className="flex items-center gap-2 mb-2">
                            <Sparkles size={13} className="text-white/40" />
                            <span className="text-white/60 text-xs font-semibold">{t("settings.toastStyle")}</span>
                          </div>
                          <div className="grid grid-cols-3 gap-1.5">
                            {([
                              { key: "card"    as ToastStyle, label: t("settings.styleCard") },
                              { key: "ring"    as ToastStyle, label: t("settings.styleRing") },
                              { key: "minimal" as ToastStyle, label: t("settings.styleMinimal") },
                            ]).map(opt => (
                              <button
                                key={opt.key}
                                onClick={() => handleToastStyle(opt.key)}
                                className={`py-2 rounded-lg text-[11px] font-semibold transition-all ${
                                  toastStyle === opt.key
                                    ? "theme-btn text-white"
                                    : "bg-white/8 text-white/40 hover:bg-white/15 hover:text-white"
                                }`}
                              >
                                {opt.label}
                              </button>
                            ))}
                          </div>
                          <div className="mt-2 flex justify-center" style={{ zoom: 0.8 }}>
                            <Toast
                              preview
                              style={toastStyle}
                              theme={currentTheme}
                              data={{
                                id: "preview",
                                task_name: t("settings.previewTask"),
                                urgency: "warning",
                                time_left: "2h 15m",
                                category: "game",
                                durationMs: 6000,
                              }}
                            />
                          </div>
                          <p className="text-white/25 text-[10px] mt-1.5 leading-relaxed">
                            {t("settings.toastStyleHint")}
                          </p>
                        </div>
                        {/* Custom sound */}
                        <div className="border-t border-white/8 pt-3">
                          <div className="flex items-center gap-3 mb-2">
                            <span className="text-base">🔔</span>
                            <div className="flex-1 min-w-0">
                              <p className="text-white/80 text-xs font-semibold">{t("settings.sound")}</p>
                              <p className="text-white/35 text-xs truncate">{customSound ? soundName : t("settings.soundDefault")}</p>
                            </div>
                            <div className="flex gap-1.5">
                              <button onClick={() => soundRef.current?.click()} className="px-2.5 py-1 bg-purple-600/20 border border-purple-500/30 rounded-lg text-purple-300 text-xs font-semibold hover:bg-purple-600/30 transition-all">{t("settings.soundUpload")}</button>
                              {customSound && <button onClick={handleSoundReset} className="px-2.5 py-1 bg-white/5 border border-white/10 rounded-lg text-white/40 text-xs hover:text-white transition-all">{t("settings.soundClear")}</button>}
                            </div>
                            <input ref={soundRef} type="file" accept="audio/*" className="hidden" onChange={handleSoundUpload} />
                          </div>
                          {customSound && <audio controls src={customSound} className="w-full h-7" style={{filter: "invert(0.7)"}} />}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Custom tray icon */}
                  <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
                    <div className="flex items-center gap-3 mb-3">
                      <Image size={18} className="text-white/50" />
                      <div>
                        <p className="text-white text-sm font-semibold">{t("settings.appIcon")}</p>
                        <p className="text-white/40 text-xs">{t("settings.appIconSub")}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      {/* Preview */}
                      <div className="w-12 h-12 rounded-xl border border-white/10 bg-white/5 flex items-center justify-center overflow-hidden flex-shrink-0">
                        {customIcon
                          ? <img src={customIcon} className="w-full h-full object-cover" alt="icon" />
                          : <span className="text-2xl">🎮</span>
                        }
                      </div>
                      <div className="flex gap-2 flex-1">
                        <button
                          onClick={() => iconRef.current?.click()}
                          className="flex-1 py-2 bg-purple-600/20 border border-purple-500/30 rounded-xl text-purple-300 text-xs font-semibold hover:bg-purple-600/30 transition-all flex items-center justify-center gap-1.5"
                        >
                          <Upload size={12} /> {t("settings.trayUpload")}
                        </button>
                        {customIcon && (
                          <button
                            onClick={resetIcon}
                            className="py-2 px-3 bg-white/5 border border-white/10 rounded-xl text-white/40 text-xs hover:text-white transition-all"
                          >
                            <RotateCcw size={12} />
                          </button>
                        )}
                      </div>
                      <input ref={iconRef} type="file" accept="image/*" className="hidden" onChange={handleIconUpload} />
                    </div>
                    <p className="text-white/20 text-xs mt-2">{t("settings.trayNote")}</p>
                  </div>

                  {/* Language */}
                  <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
                    <div className="flex items-center gap-3 mb-3">
                      <Languages size={18} className="text-purple-400" />
                      <div>
                        <p className="text-white text-sm font-semibold">{t("settings.language")}</p>
                        <p className="text-white/40 text-xs">{t("settings.languageSub")}</p>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        onClick={() => handleLangChange("en")}
                        className={`py-2.5 rounded-xl text-sm font-semibold transition-all flex items-center justify-center gap-2 ${
                          lang === "en"
                            ? "bg-gradient-to-r from-purple-600 to-indigo-600 text-white shadow-lg"
                            : "bg-white/5 text-white/50 hover:bg-white/10 hover:text-white border border-white/10"
                        }`}
                      >
                        🇬🇧 {t("settings.langEN")}
                      </button>
                      <button
                        onClick={() => handleLangChange("th")}
                        className={`py-2.5 rounded-xl text-sm font-semibold transition-all flex items-center justify-center gap-2 ${
                          lang === "th"
                            ? "bg-gradient-to-r from-purple-600 to-indigo-600 text-white shadow-lg"
                            : "bg-white/5 text-white/50 hover:bg-white/10 hover:text-white border border-white/10"
                        }`}
                      >
                        🇹🇭 {t("settings.langTH")}
                      </button>
                    </div>
                  </div>

                  <BackupCard />

                  {/* Currency, deliberately next to the timezone rather than
                      buried in the finance screen: both answer "where am I",
                      and asking them in two different places is two chances to
                      answer inconsistently.

                      What it does NOT do is convert anything already saved. See
                      the header of lib/money.ts — a stored row keeps the unit it
                      was recorded in, permanently, because a record that changes
                      its answer depending on the day it is read is not a record.
                      The line under the picker says so, in the place where
                      someone is about to change it and would otherwise assume
                      the opposite. */}
                  <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
                    <div className="flex items-center gap-3 mb-3">
                      <Wallet size={18} className="text-purple-400" />
                      <div className="min-w-0">
                        <p className="text-white text-sm font-semibold">{t("settings.currency")}</p>
                        <p className="text-white/40 text-xs">{t("settings.currencySub")}</p>
                      </div>
                    </div>
                    <CurrencyPicker variant="row" value={currencyCode} onChange={pickCurrency} />

                    {/* Absent, not empty, in the ordinary one-currency life —
                        the same rule the expected-income card follows. A row of
                        chips saying "you use baht" to someone who has only ever
                        used baht is a control with nothing to control. */}
                    {curInUse.length > 1 && (
                      <>
                        <p className="text-white/30 text-[11px] mt-3 mb-1.5">{t("settings.currencyInUse")}</p>
                        <div className="flex flex-wrap gap-1.5">
                          {curInUse.map(c => (
                            <button key={c.code} onClick={() => pickCurrency(c.code)}
                              className={`text-[11px] rounded-full px-2.5 py-1 border transition-colors ${
                                currencyCode === c.code
                                  ? "theme-btn text-white border-transparent"
                                  : "border-white/10 text-white/50 hover:text-white"
                              }`}>
                              {currencySymbol(c.code)} {c.code}
                              <span className="text-white/30 ml-1">{c.n}</span>
                            </button>
                          ))}
                        </div>
                      </>
                    )}

                    {/* Reading a number in the unit you just chose settles the
                        question faster than the code does: ¥1,235 has no
                        decimals and ฿1,234.50 has two, and seeing that is how
                        you know the choice took. */}
                    <p className="text-white/30 text-[11px] mt-2.5">
                      {formatMoney(1234.5, currencyCode)}
                    </p>
                    {curInUse.length > 1 && (
                      <p className="text-white/30 text-[11px] mt-1 leading-snug">
                        {t("settings.currencyTotals")}
                      </p>
                    )}
                  </div>

                  {/* Timezone */}
                  <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
                    <div className="flex items-center gap-3 mb-3">
                      <Globe size={18} className="text-purple-400" />
                      <div className="min-w-0">
                        <p className="text-white text-sm font-semibold">{t("settings.timezone")}</p>
                        <p className="text-white/40 text-xs">{t("settings.timezoneSub")}</p>
                      </div>
                    </div>
                    <button
                      onClick={() => setTzOpen(v => !v)}
                      className="w-full flex items-center gap-2 bg-white/5 border border-white/10 hover:border-white/25 rounded-xl px-3.5 py-2.5 text-left transition-colors"
                    >
                      <span className="flex-1 min-w-0">
                        <span className="block text-white text-sm font-medium truncate">
                          {getAppTimeZone()}
                        </span>
                        <span className="block text-white/35 text-[11px]">
                          {offsetLabel(getAppTimeZone())}
                          {tzPref === SYSTEM ? ` · ${t("tz.auto")}` : ` · ${t("tz.pinned")}`}
                        </span>
                      </span>
                      <ChevronDown size={15} className={`text-white/35 shrink-0 transition-transform ${tzOpen ? "rotate-180" : ""}`} />
                    </button>
                    {tzOpen && (
                      <div className="mt-2.5">
                        <TimeZonePicker
                          value={tzPref}
                          onChange={pref => { if (pref !== tzPref) setPendingTz(pref); }}
                        />
                      </div>
                    )}
                  </div>

                  {/* ── AI assistant ─────────────────────────────────────── */}
                  <div className="bg-white/5 rounded-2xl p-4 border border-white/10 space-y-3">
                    <div className="flex items-center gap-2">
                      <Sparkles size={15} className="text-white/50" />
                      <span className="text-white text-sm font-semibold">{t("ai.section")}</span>
                      {aiSaved && <span className="text-emerald-400 text-[11px] ml-auto">{t("ai.settingsSaved")}</span>}
                    </div>

                    <div>
                      <p className="text-white/40 text-[11px] mb-1.5">{t("ai.provider")}</p>
                      <div className="grid grid-cols-3 gap-1.5">
                        {(Object.keys(PROVIDERS) as ProviderId[]).map(id => (
                          <button key={id} onClick={() => switchProvider(id)}
                            className={`py-2 rounded-lg text-[11px] font-semibold transition-all ${
                              aiProvider === id
                                ? "theme-btn text-white"
                                : "bg-white/8 text-white/40 hover:bg-white/15 hover:text-white"
                            }`}>
                            {PROVIDERS[id].label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div>
                      <p className="text-white/40 text-[11px] mb-1.5">{t("ai.model")}</p>
                      <input value={aiModel}
                        onChange={e => setAiModel(e.target.value)}
                        onBlur={saveAiSettings}
                        placeholder={PROVIDERS[aiProvider].defaultModel}
                        className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-white text-xs placeholder-white/25 focus:outline-none focus:border-white/30" />
                    </div>

                    {PROVIDERS[aiProvider].configurableBaseUrl && (
                      <div>
                        <p className="text-white/40 text-[11px] mb-1.5">{t("ai.baseUrl")}</p>
                        <input value={aiBaseUrl}
                          onChange={e => setAiBaseUrl(e.target.value)}
                          onBlur={saveAiSettings}
                          placeholder={PROVIDERS[aiProvider].defaultBaseUrl}
                          className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-white text-xs placeholder-white/25 focus:outline-none focus:border-white/30" />
                        <p className="text-white/25 text-[10px] mt-1">{t("ai.baseUrlHint")}</p>
                      </div>
                    )}

                    <div>
                      <div className="flex items-baseline justify-between mb-1.5">
                        <p className="text-white/40 text-[11px]">{t("ai.apiKey")}</p>
                        <a href={PROVIDERS[aiProvider].keyUrl} target="_blank" rel="noreferrer"
                          className="text-white/30 hover:text-white text-[10px] transition-colors">
                          {t("ai.getKey")}
                        </a>
                      </div>
                      <input type="password" value={aiKey}
                        onChange={e => setAiKey(e.target.value)}
                        onBlur={saveAiSettings}
                        placeholder="sk-..." autoComplete="off"
                        className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-white text-xs placeholder-white/25 focus:outline-none focus:border-white/30" />
                      <p className="text-white/25 text-[10px] mt-1">{t("ai.localOnly")}</p>
                    </div>

                    <div>
                      <div className="flex items-center gap-2 mb-1.5">
                        <p className="text-white/40 text-[11px]">{t("ai.dailyCap")}</p>
                        <span className="text-white/25 text-[10px] ml-auto">
                          {t("ai.usedToday")} {aiUsage.requests} {t("ai.requests")} · {aiUsage.input + aiUsage.output} tk
                        </span>
                      </div>
                      <input type="number" inputMode="numeric" min={0}
                        value={aiCap} onChange={e => setAiCap(e.target.value)}
                        onBlur={saveAiSettings}
                        className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-white text-xs focus:outline-none focus:border-white/30" />
                      <p className="text-white/25 text-[10px] mt-1">{t("ai.capHint")}</p>
                    </div>

                    {/* What the app has stopped needing to ask about. The point
                        of this panel is that these numbers should climb while
                        the request count stays flat. */}
                    <div className="border-t border-white/8 pt-3 space-y-2">
                      <p className="text-white/50 text-xs font-semibold">{t("ai.memory")}</p>
                      <div className="grid grid-cols-3 gap-1.5 text-center">
                        {[
                          { n: learned.length,   l: t("ai.learnedCount") },
                          { n: memStats.cache,   l: t("ai.cachedCount") },
                          { n: memStats.shops,   l: t("ai.merchants") },
                        ].map((x, i) => (
                          <div key={i} className="rounded-lg bg-white/5 py-1.5">
                            <p className="text-white text-sm font-bold leading-none">{x.n}</p>
                            <p className="text-white/35 text-[9px] mt-0.5">{x.l}</p>
                          </div>
                        ))}
                      </div>

                      {learned.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {learned.slice(-8).map(p => (
                            <span key={p.key}
                              className="text-[10px] rounded-full border border-white/10 text-white/50 px-2 py-0.5 flex items-center gap-1">
                              {p.key}
                              <button
                                onClick={() => { forgetPreset(p.key); refreshMemory(); }}
                                title={t("ai.forget")}
                                className="text-white/25 hover:text-red-400">×</button>
                            </span>
                          ))}
                        </div>
                      )}

                      <p className="text-white/40 text-[11px] pt-1">{t("ai.escapes")}</p>
                      {escapes.length === 0 ? (
                        <p className="text-white/25 text-[10px]">{t("ai.noEscapes")}</p>
                      ) : (
                        <div className="space-y-1">
                          {escapes.map(e => (
                            <div key={e.pattern} className="flex items-baseline gap-2 text-[10px]">
                              <span className="text-white/60 flex-1 min-w-0 truncate">{e.example}</span>
                              <span className="text-white/30 shrink-0">{e.count}×</span>
                              <span className="text-white/30 shrink-0 w-14 text-right">{e.tokens}tk</span>
                            </div>
                          ))}
                        </div>
                      )}
                      <p className="text-white/25 text-[10px] leading-relaxed">{t("ai.escapesHint")}</p>
                    </div>
                  </div>



                  {/* ── Important things ──────────────────────────────────
                      Neutral name on purpose. One person keeps an insurance
                      line here, another a landlord, another someone to call at
                      four in the morning. The app does not need to know which,
                      and is better for not knowing. */}
                  <div className="bg-white/5 rounded-2xl p-4 border border-white/10 space-y-3">
                    {/* Worded like a bank asking whether your phone number still
                        works, because that is the register that gets read. At
                        most once every 60 days, never on an empty card. */}
                    {reviewImportant && (
                      <div className="flex items-center gap-2.5 bg-white/[0.04] border border-white/10 rounded-xl px-3 py-2">
                        <span className="flex-1 min-w-0">
                          <span className="block text-white/70 text-xs font-medium">{t("important.review")}</span>
                          <span className="block text-white/30 text-[10px]">{t("important.reviewSub")}</span>
                        </span>
                        <button
                          onClick={() => { markImportantReviewed(); setReviewImportant(false); }}
                          className="text-white/35 hover:text-white text-[11px] shrink-0 transition-colors"
                        >
                          {t("important.reviewLater")}
                        </button>
                      </div>
                    )}
                    <div>
                      <p className="text-white text-sm font-semibold">{t("important.title")}</p>
                      <p className="text-white/30 text-[10px] mt-0.5 leading-relaxed">{t("important.hint")}</p>
                    </div>

                    {important.contacts.length > 0 && (
                      <div className="space-y-1.5">
                        {important.contacts.map((c, i) => (
                          <div key={i} className="flex items-center gap-2">
                            <span className="text-white/70 text-xs flex-1 min-w-0 truncate">{c.label}</span>
                            <span className="text-white text-xs shrink-0">{c.value}</span>
                            <button
                              onClick={() => persistImportant({
                                ...important,
                                contacts: important.contacts.filter((_, j) => j !== i),
                              })}
                              className="text-white/25 hover:text-red-400 shrink-0">
                              <X size={12} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="flex gap-1.5">
                      <input value={newContact.label}
                        onChange={e => setNewContact(v => ({ ...v, label: e.target.value }))}
                        placeholder={t("important.label")}
                        className="flex-1 min-w-0 bg-white/5 border border-white/10 rounded-lg px-2.5 py-1.5 text-white text-xs placeholder-white/25 focus:outline-none focus:border-white/30" />
                      <input value={newContact.value}
                        onChange={e => setNewContact(v => ({ ...v, value: e.target.value }))}
                        placeholder={t("important.value")}
                        className="flex-1 min-w-0 bg-white/5 border border-white/10 rounded-lg px-2.5 py-1.5 text-white text-xs placeholder-white/25 focus:outline-none focus:border-white/30" />
                      <button
                        onClick={() => {
                          if (!newContact.label.trim() || !newContact.value.trim()) return;
                          persistImportant({
                            ...important,
                            contacts: [...important.contacts, {
                              label: newContact.label.trim(), value: newContact.value.trim(),
                            }],
                          });
                          setNewContact({ label: "", value: "" });
                        }}
                        className="theme-btn text-white text-xs rounded-lg px-3">
                        {t("important.add")}
                      </button>
                    </div>

                    <textarea value={important.note} rows={2}
                      onChange={e => setImportant({ ...important, note: e.target.value })}
                      onBlur={() => saveImportant(important)}
                      placeholder={t("important.note")}
                      className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-white text-xs placeholder-white/25 focus:outline-none focus:border-white/30 resize-none" />
                  </div>

                  <p className="text-white/20 text-[10px] text-center">
                    {t("settings.version")} {__APP_VERSION__}
                  </p>

                  {/* This read "done" beside a save icon, which said it
                      committed the page. It never did: every setting here
                      writes the moment it changes, and the AI block had its own
                      separate save. A button that looks like the save button
                      and is not one is worse than no button. */}
                  <p className="text-white/25 text-[10px] text-center">
                    {t("settings.autoSaved")}
                  </p>

                  <button
                    onClick={onClose}
                    className="w-full py-3 rounded-xl border border-white/12 text-white/70 font-semibold hover:text-white hover:border-white/25 transition-colors"
                  >
                    {t("settings.close")}
                  </button>
                </div>
              )}

              {/* ── APPEARANCE TAB ──────────────────────────────────────── */}
              {activeTab === "appearance" && (
                <div className="p-6 space-y-5">

                  {/* Current theme preview bar */}
                  <div className="flex items-center gap-2 p-3 rounded-2xl border border-white/10 bg-white/5">
                    <div className="flex gap-1.5">
                      {[currentTheme.primary, currentTheme.accent, currentTheme.secondary].map((c, i) => (
                        <div key={i} className="w-5 h-5 rounded-full border border-white/10" style={{ background: c }} />
                      ))}
                    </div>
                    <span className="text-white/60 text-xs font-semibold ml-1">{currentTheme.name}</span>

                  </div>

                  {/* Preset themes */}
                  <div>
                    <p className="text-white/40 text-xs font-semibold uppercase tracking-widest mb-2 px-1">{t("settings.presets")}</p>
                    <div className="grid grid-cols-5 gap-2">
                      {PRESET_THEMES.map(theme => (
                        <button
                          key={theme.name}
                          onClick={() => applyAndSave(theme)}
                          title={theme.name}
                          className={`relative h-10 rounded-xl border transition-all overflow-hidden ${
                            currentTheme.name === theme.name
                              ? "border-white/50 scale-105 shadow-lg"
                              : "border-white/10 hover:border-white/30 hover:scale-105"
                          }`}
                          style={{ background: `linear-gradient(135deg, ${theme.primary}, ${theme.secondary})` }}
                        >
                          {currentTheme.name === theme.name && (
                            <div className="absolute inset-0 flex items-center justify-center">
                              <Check size={14} className="text-white drop-shadow" />
                            </div>
                          )}
                        </button>
                      ))}
                    </div>
                    <div className="grid grid-cols-5 gap-2 mt-1">
                      {PRESET_THEMES.map(theme => (
                        <p key={theme.name} className="text-white/25 text-center" style={{ fontSize: "9px" }}>
                          {theme.name.split(" ")[0]}
                        </p>
                      ))}
                    </div>
                  </div>

                  {/* Divider */}
                  <div className="flex items-center gap-3">
                    <div className="flex-1 h-px bg-white/10" />
                    <span className="text-white/25 text-xs flex items-center gap-1.5">
                      <Sparkles size={10} /> {t("settings.aiFromImage")}
                    </span>
                    <div className="flex-1 h-px bg-white/10" />
                  </div>

                  {/* AI theme from image */}
                  <div className="bg-white/5 border border-white/10 rounded-2xl p-4 space-y-3">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center flex-shrink-0">
                        <Palette size={15} className="text-white" />
                      </div>
                      <div>
                        <p className="text-white text-sm font-semibold">{t("settings.themeFromImg")}</p>
                        <p className="text-white/40 text-xs">{t("settings.themeFromImgSub")}</p>
                      </div>
                    </div>

                    {/* Upload zone */}
                    <button
                      onClick={() => imageRef.current?.click()}
                      className="w-full border border-dashed border-white/20 rounded-xl py-4 flex flex-col items-center gap-2 hover:border-purple-500/50 hover:bg-purple-500/5 transition-all"
                    >
                      {aiPreview ? (
                        <img src={aiPreview} className="w-16 h-16 rounded-xl object-cover" alt="preview" />
                      ) : (
                        <Upload size={20} className="text-white/30" />
                      )}
                      <span className="text-white/40 text-xs">
                        {aiPreview ? t("settings.clickChange") : t("settings.clickUpload")}
                      </span>
                    </button>
                    <input ref={imageRef} type="file" accept="image/*" className="hidden" onChange={handleImageUpload} />

                    {/* Loading */}
                    {aiLoading && (
                      <div className="flex items-center gap-2 text-purple-400 text-sm py-1">
                        <motion.div
                          animate={{ rotate: 360 }}
                          transition={{ repeat: Infinity, duration: 1, ease: "linear" }}
                        >
                          <Sparkles size={14} />
                        </motion.div>
                        {t("settings.extracting")}
                      </div>
                    )}

                    {/* Hard error (both AI and canvas failed) */}
                    {aiError && !aiTheme && (
                      <p className="text-red-400 text-xs">{aiError}</p>
                    )}

                    {/* AI / canvas result */}
                    {aiTheme && !aiLoading && (
                      <motion.div
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="space-y-2"
                      >
                        {/* Full palette preview card */}
                        <div className="rounded-xl overflow-hidden" style={{ background: aiTheme.bg, border: `1px solid ${aiTheme.border}` }}>
                          {/* Gradient banner showing all 4 key colors */}
                          <div className="h-3 w-full" style={{ background: `linear-gradient(90deg, ${aiTheme.secondary}, ${aiTheme.primary}, ${aiTheme.accent}, ${aiTheme.primary}90, ${aiTheme.secondary})` }} />
                          <div className="p-3 space-y-2.5">
                            {/* Name + source */}
                            <div className="flex items-center justify-between">
                              <p className="text-white text-xs font-bold">{aiTheme.name}</p>
                              <span className="text-[10px] px-2 py-0.5 rounded-full" style={{ background: aiTheme.bgCard, color: aiTheme.accent }}>
                                {t("settings.extracted")}
                              </span>
                            </div>
                            {/* All swatches: bg · secondary · primary · accent + labels */}
                            <div className="grid grid-cols-5 gap-1.5">
                              {[
                                { color: aiTheme.bg, label: "BG" },
                                { color: aiTheme.secondary, label: "2nd" },
                                { color: aiTheme.primary, label: "Main" },
                                { color: aiTheme.accent, label: (aiTheme.name.includes("Gold") || aiTheme.name.includes("Amber")) ? "✦ Gold" : "Pop" },
                                { color: aiTheme.bgCard, label: "Card" },
                              ].map(({ color, label }) => (
                                <div key={label} className="flex flex-col items-center gap-1">
                                  <div className="w-full h-7 rounded-lg ring-1 ring-white/10" style={{ background: color }} />
                                  <span className="text-[9px] text-white/30">{label}</span>
                                </div>
                              ))}
                            </div>
                            {/* Mini UI mockup */}
                            <div className="rounded-lg p-2 space-y-1.5" style={{ background: aiTheme.bgCard, border: `1px solid ${aiTheme.border}` }}>
                              <div className="flex items-center gap-1.5">
                                <div className="w-2 h-2 rounded-full" style={{ background: aiTheme.primary }} />
                                <div className="h-1.5 w-16 rounded-full" style={{ background: aiTheme.primary, opacity: 0.7 }} />
                                <div className="ml-auto h-1.5 w-8 rounded-full" style={{ background: aiTheme.accent, opacity: 0.8 }} />
                              </div>
                              <div className="h-1 w-3/4 rounded-full bg-white/10" />
                              <div className="flex gap-1">
                                <div className="h-4 flex-1 rounded" style={{ background: `linear-gradient(135deg, ${aiTheme.primary}, ${aiTheme.secondary})` }} />
                                <div className="h-4 w-8 rounded bg-white/5" />
                              </div>
                            </div>
                          </div>
                        </div>
                        <button
                          onClick={() => applyAndSave(aiTheme)}
                          className="w-full py-2.5 rounded-xl text-white text-sm font-bold transition-all hover:opacity-90 hover:scale-[1.01] active:scale-[0.99]"
                          style={{ background: `linear-gradient(135deg, ${aiTheme.primary}, ${aiTheme.secondary})` }}
                        >
                          {t("settings.applyTheme")}
                        </button>
                      </motion.div>
                    )}
                  </div>

                  {/* ── Live Wallpaper ── */}
                  <div className="pt-2 border-t border-white/10">
                    <p className="text-white/40 text-xs font-semibold uppercase tracking-widest mb-2 px-1">
                      {getLang() === "th" ? "วอลเปเปอร์เคลื่อนไหว" : "Live Wallpaper"}
                    </p>
                    <div className="p-3 rounded-2xl border border-white/10 bg-white/5 space-y-3">
                      {/* Enable toggle — matches other settings switches */}
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Image size={15} className="text-white/50" />
                          <span className="text-white/80 text-sm font-medium">
                            {getLang() === "th" ? "เปิดวอลเปเปอร์" : "Enable wallpaper"}
                          </span>
                        </div>
                        <button
                          onClick={toggleWallpaper}
                          disabled={!wpPath || wpBusy}
                          className={`w-12 h-6 rounded-full transition-all relative ${
                            !wpPath ? "bg-white/10 cursor-not-allowed" : wpBusy ? "bg-white/30" : wpEnabled ? "bg-green-500" : "bg-white/20"
                          }`}
                        >
                          <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${wpEnabled ? "left-7" : "left-1"}`} />
                        </button>
                      </div>

                      {/* File picker / drag-drop zone */}
                      <button
                        onClick={pickWallpaper}
                        className="w-full py-4 bg-white/5 border border-dashed border-white/20 rounded-xl text-white/70 text-sm hover:text-white hover:border-white/40 transition-all flex flex-col items-center justify-center gap-1.5"
                      >
                        <Upload size={16} />
                        <span>
                          {wpPath
                            ? getLang() === "th" ? "เปลี่ยนวิดีโอ" : "Change video"
                            : getLang() === "th" ? "เลือกวิดีโอ" : "Choose video"}
                        </span>
                        <span className="text-white/30 text-[10px]">
                          {getLang() === "th" ? "หรือลากไฟล์มาวางที่นี่" : "or drag a file here"}
                        </span>
                      </button>

                      {/* Current file name */}
                      {wpPath && (
                        <div className="flex items-center gap-2 px-1">
                          <div className="w-1.5 h-1.5 rounded-full bg-green-400 flex-shrink-0" />
                          <p className="text-white/50 text-xs truncate" title={wpPath}>
                            {wpPath.split(/[\\/]/).pop()}
                          </p>
                        </div>
                      )}

                      {/* Theme from wallpaper */}
                      <button
                        onClick={handleThemeFromWallpaper}
                        disabled={!wpPath || aiLoading}
                        className="w-full py-2.5 rounded-xl text-white text-sm font-semibold transition-all flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
                        style={{ background: `linear-gradient(135deg, ${currentTheme.primary}, ${currentTheme.secondary})` }}
                      >
                        <Sparkles size={14} />
                        {aiLoading ? t("settings.wpThemeWorking") : t("settings.wpThemeBtn")}
                      </button>
                      <p className="text-white/25 text-[10px] px-1 leading-relaxed">
                        {t("settings.wpThemeHint")}
                      </p>

                      {wpMontage && (
                        <div className="flex items-stretch gap-2">
                          <img
                            src={wpMontage}
                            alt="sampled frames"
                            className="w-9 rounded-lg border border-white/10 object-cover"
                            style={{ maxHeight: 72 }}
                          />
                          <div className="flex-1 min-w-0 flex flex-col justify-between">
                            <div className="grid grid-cols-4 gap-1">
                              {[currentTheme.bg, currentTheme.secondary, currentTheme.primary, currentTheme.accent].map((c, i) => (
                                <div key={i} className="h-6 rounded-md" style={{ background: c, border: "1px solid rgba(255,255,255,0.10)" }} />
                              ))}
                            </div>
                            <p className="text-white/40 text-[10px] mt-1 truncate">{currentTheme.name}</p>
                          </div>
                        </div>
                      )}

                      {/* Error message */}
                      {wpError && (
                        <p className="text-red-400 text-[10px] px-1 leading-relaxed break-all">
                          {wpError}
                        </p>
                      )}

                      <p className="text-white/25 text-[10px] px-1 leading-relaxed">
                        {getLang() === "th"
                          ? "รองรับ mp4, webm หยุดเล่นเองตอนเปิดแอปเต็มจอ เพื่อไม่แย่งเครื่องตอนเล่นเกม"
                          : "Supports mp4, webm. Auto-pauses during fullscreen apps to save resources while gaming."}
                      </p>
                    </div>
                  </div>

                  {/* Reset to default */}
                  <button
                    onClick={() => applyAndSave(DEFAULT_THEME)}
                    className="w-full py-2.5 bg-white/5 border border-white/10 rounded-xl text-white/50 text-sm hover:text-white transition-all flex items-center justify-center gap-2"
                  >
                    <RotateCcw size={13} /> {t("settings.resetDefault")}
                  </button>
                </div>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
      {/* ── Language change confirmation dialog ── */}
      {pendingTz && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm" onClick={() => setPendingTz(null)}>
          <div className="bg-gray-900 border border-white/10 rounded-2xl p-5 w-full max-w-xs shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2.5 mb-2.5">
              <Globe size={18} className="text-purple-400" />
              <div>
                <p className="text-white font-bold text-sm">{t("settings.timezone")}</p>
                <p className="text-white/40 text-xs">
                  {pendingTz === SYSTEM ? t("tz.auto") : pendingTz}
                </p>
              </div>
            </div>
            <p className="text-white/60 text-xs leading-relaxed mb-4">{t("tz.confirm")}</p>
            <div className="flex gap-2">
              <button onClick={() => setPendingTz(null)}
                className="flex-1 py-2.5 rounded-xl bg-white/5 border border-white/10 text-white/60 hover:text-white text-sm font-semibold transition-colors">
                {t("common.cancel")}
              </button>
              <button onClick={confirmTzChange}
                className="flex-1 py-2.5 rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 text-white text-sm font-semibold transition-all hover:brightness-110">
                {t("tz.apply")}
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingLang && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[60] flex items-center justify-center p-4"
          onClick={cancelLangChange}
        >
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.9, opacity: 0 }}
            onClick={e => e.stopPropagation()}
            className="bg-gray-900 border border-white/15 rounded-2xl p-6 w-full max-w-xs shadow-2xl"
          >
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-xl bg-purple-600/20 border border-purple-500/30 flex items-center justify-center flex-shrink-0">
                <Languages size={18} className="text-purple-400" />
              </div>
              <div>
                <p className="text-white font-bold text-sm">{t("settings.language")}</p>
                <p className="text-white/40 text-xs">{t("settings.languageSub")}</p>
              </div>
            </div>

            <p className="text-white/70 text-sm mb-5 leading-relaxed">
              {pendingLang === "th"
                ? t("settings.langConfirmTH")
                : t("settings.langConfirmEN")}
            </p>

            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={cancelLangChange}
                className="py-2.5 rounded-xl text-sm font-semibold bg-white/5 border border-white/10 text-white/50 hover:text-white hover:bg-white/10 transition-all"
              >
                {t("settings.cancel")}
              </button>
              <button
                onClick={confirmLangChange}
                className="py-2.5 rounded-xl text-sm font-semibold bg-gradient-to-r from-purple-600 to-indigo-600 text-white hover:opacity-90 transition-all"
              >
                {pendingLang === "th" ? t("settings.switchTH") : t("settings.switchEN")}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}

      {/* ── Icon change confirmation dialog ── */}
      {pendingIconUrl && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[60] flex items-center justify-center p-4"
          onClick={cancelIconChange}
        >
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.9, opacity: 0 }}
            onClick={e => e.stopPropagation()}
            className="bg-gray-900 border border-white/15 rounded-2xl p-6 w-full max-w-xs shadow-2xl"
          >
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-xl bg-blue-600/20 border border-blue-500/30 flex items-center justify-center flex-shrink-0 overflow-hidden">
                <img src={pendingIconUrl} className="w-full h-full object-cover" alt="preview" />
              </div>
              <div>
                <p className="text-white font-bold text-sm">{t("settings.iconConfirmTitle")}</p>
                <p className="text-white/40 text-xs">{t("settings.iconConfirmSub")}</p>
              </div>
            </div>

            <p className="text-white/70 text-sm mb-5 leading-relaxed">
              {t("settings.iconConfirmMsg")}
            </p>

            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={cancelIconChange}
                className="py-2.5 rounded-xl text-sm font-semibold bg-white/5 border border-white/10 text-white/50 hover:text-white hover:bg-white/10 transition-all"
              >
                {t("settings.cancel")}
              </button>
              <button
                onClick={confirmIconChange}
                className="py-2.5 rounded-xl text-sm font-semibold bg-gradient-to-r from-blue-600 to-indigo-600 text-white hover:opacity-90 transition-all"
              >
                {t("settings.iconConfirmApply")}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}