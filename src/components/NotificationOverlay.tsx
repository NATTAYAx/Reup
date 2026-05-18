import { useEffect, useState, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, currentMonitor } from "@tauri-apps/api/window";
import { LogicalSize, LogicalPosition } from "@tauri-apps/api/dpi";

interface ToastData {
  id: string;
  task_name: string;
  urgency: "critical" | "warning";
  time_left: string;
  category: string;
  durationMs: number;
}

const TOAST_WIDTH  = 356;
const TOAST_HEIGHT = 88;
const TOAST_GAP    = 10;
const PADDING      = 16;

const CAT: Record<string, { from: string; to: string; icon: string; label: string }> = {
  game:     { from: "#7c3aed", to: "#4f46e5", icon: "🎮", label: "Game"     },
  school:   { from: "#0ea5e9", to: "#06b6d4", icon: "📚", label: "School"   },
  work:     { from: "#f97316", to: "#ef4444", icon: "💼", label: "Work"     },
  personal: { from: "#10b981", to: "#14b8a6", icon: "✨", label: "Personal" },
};

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
      const t = ctx.currentTime + i * 0.16;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.22, t + 0.04);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.32);
      o.start(t); o.stop(t + 0.36);
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
    const win = getCurrentWindow();
    const newH = count * TOAST_HEIGHT + (count - 1) * TOAST_GAP + PADDING;
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
  const timers   = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const hasToast = useRef(false);
  // Dedup: tracks recently-shown task_name → timestamp to prevent retry emits
  // from Rust creating duplicate toasts. Window: 5 seconds.
  const recentToasts = useRef<Map<string, number>>(new Map());
  const DEDUP_WINDOW_MS = 5000;

  const dismiss = useCallback((id: string) => {
    const t = timers.current.get(id);
    if (t) { clearTimeout(t); timers.current.delete(id); }
    setToasts(p => p.filter(x => x.id !== id));
  }, []);

  useEffect(() => {
    if (!hasToast.current) return;
    if (toasts.length === 0) {
      const t = setTimeout(() => invoke("close_notification_window").catch(() => {}), 350);
      return () => clearTimeout(t);
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
    // Clean up old entries to prevent memory growth
    for (const [k, t] of recentToasts.current) {
      if (now - t > DEDUP_WINDOW_MS * 2) recentToasts.current.delete(k);
    }

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
    const t = setTimeout(() => dismiss(id), durationMs);
    timers.current.set(id, t);
  }, [dismiss]);

  addToastRef.current = addToast;

  useEffect(() => {
    // This listener is registered ONCE at mount and never torn down.
    // The window is only HIDDEN (not destroyed) when toasts clear,
    // so this listener stays active for ALL future notifications —
    // no restart needed.
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

    // Drain toasts that were queued before this listener was registered
    // (only relevant for the very first notification ever)
    invoke<Array<{ task_name: string; urgency: string; time_left: string; category: string }>>(
      "overlay_ready",
    )
      .then(p => p.forEach(x =>
        addToastRef.current?.(x.task_name, x.urgency, x.time_left, x.category),
      ))
      .catch(() => {});

    return () => { unlisten.then(fn => fn()); };
  }, []); // empty — runs once, lives forever

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
        {toasts.map(t => <Toast key={t.id} data={t} />)}
      </AnimatePresence>
    </div>
  );
}

function Toast({ data }: { data: ToastData }) {
  const cat  = CAT[data.category] ?? CAT.personal;
  const crit = data.urgency === "critical";
  const [pct, setPct] = useState(100);

  useEffect(() => {
    const start = Date.now();
    let raf: number;
    const tick = () => {
      const p = Math.max(0, 100 - ((Date.now() - start) / data.durationMs) * 100);
      setPct(p);
      if (p > 0) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [data.durationMs]);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: 40, scale: 0.92 }}
      animate={{ opacity: 1,  x: 0,  scale: 1    }}
      exit={{    opacity: 0,  x: 40, scale: 0.92, transition: { duration: 0.18 } }}
      transition={{ type: "spring", stiffness: 480, damping: 38 }}
      style={{
        width: 340,
        position: "relative",
        borderRadius: 18,
        overflow: "hidden",
        background: crit ? "rgba(18,6,6,0.97)" : "rgba(10,10,20,0.97)",
        border: crit
          ? "1px solid rgba(239,68,68,0.50)"
          : "1px solid rgba(255,255,255,0.11)",
        // ⚠️ No outer boxShadow — bleeds outside transparent WebView2 window
        // and renders as a visible grey rectangle on the Windows desktop.
      }}
    >
      {/* Inner highlight — stays inside overflow:hidden, no bleed */}
      <div style={{
        position: "absolute", inset: 0, borderRadius: 18, pointerEvents: "none",
        background: "linear-gradient(180deg, rgba(255,255,255,0.045) 0%, transparent 35%)",
      }} />

      {/* Left accent bar */}
      <div style={{
        position: "absolute", left: 0, top: 0, bottom: 0, width: 4,
        background: `linear-gradient(to bottom, ${cat.from}, ${cat.to})`,
        borderRadius: "18px 0 0 18px",
      }} />

      {/* Critical pulse — clipped by overflow:hidden */}
      {crit && (
        <motion.div
          animate={{ opacity: [0.0, 0.10, 0.0] }}
          transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
          style={{
            position: "absolute", inset: 0, pointerEvents: "none",
            background: "radial-gradient(ellipse at top right, rgba(239,68,68,0.22), transparent 65%)",
          }}
        />
      )}

      {/* Body */}
      <div style={{
        padding: "13px 14px 11px 20px",
        display: "flex",
        alignItems: "center",
        gap: 12,
      }}>
        {/* Icon */}
        <div style={{
          width: 44, height: 44, borderRadius: 14, flexShrink: 0,
          background: `linear-gradient(145deg, ${cat.from}, ${cat.to})`,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 22,
          boxShadow: `inset 0 1px 0 rgba(255,255,255,0.25)`,
        }}>
          {cat.icon}
        </div>

        {/* Text */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 3 }}>
            <span style={{
              display: "inline-flex", alignItems: "center", gap: 3,
              fontSize: 9.5, fontWeight: 800, letterSpacing: "0.10em",
              textTransform: "uppercase",
              color: crit ? "#f87171" : "#fbbf24",
              background: crit ? "rgba(239,68,68,0.14)" : "rgba(251,191,36,0.12)",
              border: crit ? "1px solid rgba(239,68,68,0.28)" : "1px solid rgba(251,191,36,0.22)",
              padding: "2px 7px 2px 5px", borderRadius: 20,
            }}>
              {crit ? "🔥" : "⏰"} {crit ? "Reset Soon" : "Heads Up"}
            </span>
            <span style={{ fontSize: 9, color: "rgba(255,255,255,0.22)", fontWeight: 600 }}>
              {cat.label}
            </span>
          </div>

          <p style={{
            color: "#fff", fontWeight: 700, fontSize: 13.5,
            lineHeight: 1.3, margin: 0,
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          }}>
            {data.task_name}
          </p>

          <p style={{ color: "rgba(255,255,255,0.32)", fontSize: 10.5, marginTop: 2, lineHeight: 1 }}>
            {crit ? "Don't miss this reset!" : "Coming up soon"}
          </p>
        </div>

        {/* Time pill — no close button, cursor events are disabled at OS level */}
        <span style={{
          fontSize: 11, fontWeight: 800,
          padding: "5px 11px", borderRadius: 20,
          whiteSpace: "nowrap", letterSpacing: "0.02em", flexShrink: 0,
          background: crit ? "rgba(239,68,68,0.18)" : "rgba(251,191,36,0.15)",
          color:      crit ? "#fca5a5"               : "#fde68a",
          border:     crit ? "1px solid rgba(239,68,68,0.35)" : "1px solid rgba(251,191,36,0.28)",
        }}>
          {data.time_left}
        </span>
      </div>

      {/* Progress bar */}
      <div style={{ height: 3, background: "rgba(255,255,255,0.05)" }}>
        <motion.div
          style={{
            height: "100%",
            background: `linear-gradient(to right, ${cat.from}, ${cat.to})`,
            originX: 0,
          }}
          animate={{ scaleX: pct / 100 }}
          transition={{ duration: 0.06, ease: "linear" }}
        />
      </div>
    </motion.div>
  );
}