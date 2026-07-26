import { useEffect, useState, useRef, useCallback } from "react";
import { AnimatePresence } from "framer-motion";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, currentMonitor } from "@tauri-apps/api/window";
import { LogicalSize, LogicalPosition } from "@tauri-apps/api/dpi";
import { loadTheme, type AppTheme } from "../lib/theme";
import { refreshLang } from "../lib/i18n";
import { loadToastStyle, STYLE_HEIGHT, type ToastStyle } from "../lib/toastStyle";
import { Toast, type ToastData } from "./ToastCard";

const TOAST_WIDTH = 356;
const TOAST_GAP   = 10;
const PADDING     = 16;

// Module-level because resizeWindowToFit is called from inside a state updater,
// where reading React state would be unreliable. Only one overlay window exists.
let activeStyle: ToastStyle = loadToastStyle();

function playChime(urgency: "critical" | "warning") {
  try {
    const s = localStorage.getItem("gamesched_notif_sound_v1");
    if (s) { const a = new Audio(s); a.volume = 0.7; a.play().catch(() => {}); return; }
  } catch {}
  try {
    const ctx = new AudioContext();
    const freqs = urgency === "critical" ? [900, 1120, 900] : [660, 820, 660];
    freqs.forEach((freq, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.type = "sine"; o.frequency.value = freq;
      const t0 = ctx.currentTime + i * 0.16;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(0.22, t0 + 0.04);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.32);
      o.start(t0); o.stop(t0 + 0.36);
    });
  } catch {}
}

function getDuration() {
  const v = localStorage.getItem("gamesched_toast_duration_sec");
  const n = parseInt(v ?? "8");
  return (isNaN(n) ? 8 : Math.max(3, Math.min(30, n))) * 1000;
}

async function resizeWindowToFit(count: number) {
  if (count <= 0) return;
  try {
    const h = STYLE_HEIGHT[activeStyle];
    const win = getCurrentWindow();
    const newH = count * h + (count - 1) * TOAST_GAP + PADDING;
    await win.setSize(new LogicalSize(TOAST_WIDTH, newH));
    const monitor = await currentMonitor();
    if (monitor) {
      const scale = monitor.scaleFactor;
      const sw = monitor.size.width / scale;
      const sh = monitor.size.height / scale;
      await win.setPosition(new LogicalPosition(sw - TOAST_WIDTH - 16, sh - newH - 56));
    }
  } catch (_) {}
}

export default function NotificationOverlay() {
  const [toasts, setToasts] = useState<ToastData[]>([]);
  // This window is hidden rather than destroyed between notifications, so the
  // theme, language and style are re-read on every toast, not only at mount.
  const [theme, setTheme] = useState<AppTheme>(() => loadTheme());
  const [style, setStyle] = useState<ToastStyle>(() => loadToastStyle());
  const timers   = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const hasToast = useRef(false);
  // Dedup: tracks recently-shown task_name → timestamp to prevent retry emits
  // from Rust creating duplicate toasts. Window: 5 seconds.
  const recentToasts = useRef<Map<string, number>>(new Map());
  const DEDUP_WINDOW_MS = 5000;

  // Settings live in another window of the same origin, so localStorage writes
  // there raise a storage event here. Without this the overlay would keep the
  // old look until the next toast, which reads as "the setting did nothing".
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key.startsWith("gamesched_")) {
        activeStyle = loadToastStyle();
        setStyle(activeStyle);
        setTheme(loadTheme());
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const dismiss = useCallback((id: string) => {
    const tm = timers.current.get(id);
    if (tm) { clearTimeout(tm); timers.current.delete(id); }
    setToasts(p => p.filter(x => x.id !== id));
  }, []);

  useEffect(() => {
    if (!hasToast.current) return;
    if (toasts.length === 0) {
      const tm = setTimeout(() => invoke("close_notification_window").catch(() => {}), 350);
      return () => clearTimeout(tm);
    }
    void resizeWindowToFit(toasts.length);
  }, [toasts.length]);

  // Stable ref so the listener closure never captures a stale addToast
  const addToastRef = useRef<(n: string, u: string, t: string, c: string) => void>(undefined as any);

  const addToast = useCallback((
    task_name: string, urgency: string, time_left: string, category: string,
  ) => {
    // Dedup: if this task_name was shown within the last 5 seconds, skip.
    // This prevents the Rust retry-emit from creating duplicate toasts.
    const now = Date.now();
    const lastSeen = recentToasts.current.get(task_name);
    if (lastSeen && now - lastSeen < DEDUP_WINDOW_MS) return;
    recentToasts.current.set(task_name, now);
    for (const [k, tm] of recentToasts.current) {
      if (now - tm > DEDUP_WINDOW_MS * 2) recentToasts.current.delete(k);
    }

    // Pick up theme / language / style changes made since the last notification.
    refreshLang();
    setTheme(loadTheme());
    activeStyle = loadToastStyle();
    setStyle(activeStyle);

    const id = `${Date.now()}-${Math.random()}`;
    const durationMs = getDuration();
    hasToast.current = true;

    setToasts(p => {
      const next = [...p, {
        id, task_name, time_left, category, durationMs,
        urgency: urgency as "critical" | "warning",
      }].slice(-4);
      void resizeWindowToFit(next.length);
      return next;
    });

    // Kick WebView2 repaint — clears ghost transparent areas after hide→show
    requestAnimationFrame(() => {
      document.body.style.opacity = "0.99";
      requestAnimationFrame(() => { document.body.style.opacity = "1"; });
    });

    playChime(urgency as "critical" | "warning");
    const tm = setTimeout(() => dismiss(id), durationMs);
    timers.current.set(id, tm);
  }, [dismiss]);

  addToastRef.current = addToast;

  useEffect(() => {
    // Registered ONCE at mount and never torn down. The window is only HIDDEN
    // (not destroyed) when toasts clear, so this stays active for all future
    // notifications with no restart.
    //
    // lib.rs calls win.show() then emits "new-toast" with staggered retries
    // (150ms, 400ms, 900ms) to handle WebView2 wake-up latency after hide→show.
    // The dedup map in addToast ensures retries don't create duplicate toasts.
    const unlisten = listen<{
      task_name: string; urgency: string; time_left: string; category: string;
    }>("new-toast", e => {
      addToastRef.current?.(
        e.payload.task_name,
        e.payload.urgency,
        e.payload.time_left,
        e.payload.category,
      );
    });

    invoke<Array<{ task_name: string; urgency: string; time_left: string; category: string }>>(
      "overlay_ready",
    )
      .then(p => p.forEach(x =>
        addToastRef.current?.(x.task_name, x.urgency, x.time_left, x.category),
      ))
      .catch(() => {});

    return () => { unlisten.then(fn => fn()); };
  }, []);

  return (
    <div style={{
      position: "fixed",
      inset: 0,
      display: "flex",
      flexDirection: "column",
      justifyContent: "flex-end",
      alignItems: "flex-end",
      padding: "8px",
      gap: `${TOAST_GAP}px`,
    }}>
      <AnimatePresence mode="popLayout">
        {toasts.map(x => <Toast key={x.id} data={x} theme={theme} style={style} />)}
      </AnimatePresence>
    </div>
  );
}