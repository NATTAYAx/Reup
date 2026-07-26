// ─── The toast card itself ────────────────────────────────────────────────────
//
// Split out of NotificationOverlay so the settings screen can render a live
// preview of each style without importing the overlay. That matters for more
// than tidiness: if SettingsModal pulled from NotificationOverlay, Rollup would
// fold the overlay into the main app chunk and the tiny notification window
// would have to download the entire app before it could show anything.

import { motion } from "framer-motion";
import type { AppTheme } from "../lib/theme";
import type { ToastStyle } from "../lib/toastStyle";
import { t } from "../lib/i18n";

export interface ToastData {
  id: string;
  task_name: string;
  urgency: "critical" | "warning";
  time_left: string;
  category: string;
  durationMs: number;
}

type CatKey = "notif.cat.game" | "notif.cat.school" | "notif.cat.work" | "notif.cat.personal";
type CatDef = { from: string; to: string; icon: string; key: CatKey };

// Category identity stays fixed — it is semantic, not decorative, so it does
// not follow the app theme. The chrome around it does.
export const CAT: Record<string, CatDef> = {
  game:     { from: "#7c3aed", to: "#4f46e5", icon: "🎮", key: "notif.cat.game"     },
  school:   { from: "#0ea5e9", to: "#06b6d4", icon: "📚", key: "notif.cat.school"   },
  work:     { from: "#f97316", to: "#ef4444", icon: "💼", key: "notif.cat.work"     },
  personal: { from: "#10b981", to: "#14b8a6", icon: "✨", key: "notif.cat.personal" },
};

/** #rgb / #rrggbb → rgba(). Anything else is passed through untouched. */
export function withAlpha(color: string, alpha: number): string {
  const c = (color || "").trim();
  if (!c.startsWith("#")) return c;
  const hex = c.slice(1);
  const full = hex.length === 3 ? hex.split("").map(x => x + x).join("") : hex;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return c;
  return `rgba(${r},${g},${b},${alpha})`;
}

export function Toast({
  data, theme, style, preview = false,
}: {
  data: ToastData;
  theme: AppTheme;
  style: ToastStyle;
  /** In the settings preview the countdown loops, so it never sits at empty. */
  preview?: boolean;
}) {
  const cat  = CAT[data.category] ?? CAT.personal;
  const crit = data.urgency === "critical";

  const surface = crit
    ? `linear-gradient(135deg, ${withAlpha(theme.bg, 0.97)}, rgba(40,8,8,0.97))`
    : withAlpha(theme.bg, style === "minimal" ? 0.93 : 0.97);
  const borderColor = crit ? "rgba(239,68,68,0.50)" : theme.border;
  const radius = style === "minimal" ? 14 : style === "ring" ? 22 : 18;

  return (
    <motion.div
      layout={!preview}
      initial={preview ? false : { opacity: 0, x: 40, scale: 0.92 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 40, scale: 0.92, transition: { duration: 0.18 } }}
      transition={{ type: "spring", stiffness: 480, damping: 38 }}
      style={{
        width: 340,
        position: "relative",
        borderRadius: radius,
        overflow: "hidden",
        background: surface,
        border: `1px solid ${borderColor}`,
        // No outer boxShadow — it bleeds outside the transparent WebView2 window
        // and renders as a visible grey rectangle on the Windows desktop.
      }}
    >
      <div style={{
        position: "absolute", inset: 0, borderRadius: radius, pointerEvents: "none",
        background: "linear-gradient(180deg, rgba(255,255,255,0.045) 0%, transparent 35%)",
      }} />

      {/* Theme-tinted ambient glow, so a custom theme reaches the toast too */}
      <div style={{
        position: "absolute", inset: 0, pointerEvents: "none",
        background: `radial-gradient(ellipse at top left, ${withAlpha(theme.primary, 0.16)}, transparent 60%)`,
      }} />

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

      {style === "card"    && <CardBody    data={data} theme={theme} cat={cat} crit={crit} preview={preview} radius={radius} />}
      {style === "ring"    && <RingBody    data={data} theme={theme} cat={cat} crit={crit} preview={preview} />}
      {style === "minimal" && <MinimalBody data={data} theme={theme} cat={cat} crit={crit} preview={preview} />}
    </motion.div>
  );
}

type BodyProps = { data: ToastData; theme: AppTheme; cat: CatDef; crit: boolean; preview: boolean };

function drainTransition(durationMs: number, preview: boolean) {
  return preview
    ? { duration: durationMs / 1000, ease: "linear" as const, repeat: Infinity }
    : { duration: durationMs / 1000, ease: "linear" as const };
}

function Badge({ crit }: { crit: boolean }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 3,
      fontSize: 9.5, fontWeight: 800, letterSpacing: "0.06em",
      color: crit ? "#f87171" : "#fbbf24",
      background: crit ? "rgba(239,68,68,0.14)" : "rgba(251,191,36,0.12)",
      border: crit ? "1px solid rgba(239,68,68,0.28)" : "1px solid rgba(251,191,36,0.22)",
      padding: "2px 7px 2px 5px", borderRadius: 20,
      whiteSpace: "nowrap",
    }}>
      {crit ? "🔥" : "⏰"} {crit ? t("notif.critical") : t("notif.warning")}
    </span>
  );
}

function TimePill({ text, crit }: { text: string; crit: boolean }) {
  return (
    <span style={{
      fontSize: 11, fontWeight: 800,
      padding: "5px 11px", borderRadius: 20,
      whiteSpace: "nowrap", letterSpacing: "0.02em", flexShrink: 0,
      background: crit ? "rgba(239,68,68,0.18)" : "rgba(251,191,36,0.15)",
      color:      crit ? "#fca5a5"              : "#fde68a",
      border:     crit ? "1px solid rgba(239,68,68,0.35)" : "1px solid rgba(251,191,36,0.28)",
    }}>
      {text}
    </span>
  );
}

// ── Style 1: card ─────────────────────────────────────────────────────────────
function CardBody({ data, theme, cat, crit, preview, radius }: BodyProps & { radius: number }) {
  return (
    <>
      <div style={{
        position: "absolute", left: 0, top: 0, bottom: 0, width: 4,
        background: `linear-gradient(to bottom, ${cat.from}, ${cat.to})`,
        borderRadius: `${radius}px 0 0 ${radius}px`,
      }} />

      <div style={{
        padding: "13px 14px 11px 20px",
        display: "flex", alignItems: "center", gap: 12, position: "relative",
      }}>
        <div style={{
          width: 44, height: 44, borderRadius: 14, flexShrink: 0,
          background: `linear-gradient(145deg, ${cat.from}, ${cat.to})`,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 22,
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.25)",
        }}>
          {cat.icon}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 3 }}>
            <Badge crit={crit} />
            <span style={{ fontSize: 9, color: theme.textMuted, fontWeight: 600 }}>{t(cat.key)}</span>
          </div>
          <p style={{
            color: "#fff", fontWeight: 700, fontSize: 13.5, lineHeight: 1.3, margin: 0,
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          }}>
            {data.task_name}
          </p>
          <p style={{ color: "rgba(255,255,255,0.32)", fontSize: 10.5, marginTop: 2, lineHeight: 1 }}>
            {crit ? t("notif.criticalSub") : t("notif.warningSub")}
          </p>
        </div>

        <TimePill text={data.time_left} crit={crit} />
      </div>

      {/* One declarative transform animation — this used to be a 60fps setState
          loop that re-rendered the whole card every frame. */}
      <div style={{ height: 3, background: "rgba(255,255,255,0.05)" }}>
        <motion.div
          style={{
            height: "100%",
            background: `linear-gradient(to right, ${cat.from}, ${cat.to})`,
            originX: 0,
          }}
          initial={{ scaleX: 1 }}
          animate={{ scaleX: 0 }}
          transition={drainTransition(data.durationMs, preview)}
        />
      </div>
    </>
  );
}

// ── Style 2: ring ─────────────────────────────────────────────────────────────
// The countdown drains around the category icon with a slow halo turning behind
// it. A generic UI motif — no game art or character asset is involved.
function RingBody({ data, theme, cat, crit, preview }: BodyProps) {
  const gradId = `ring-${data.id.replace(/[^a-zA-Z0-9]/g, "")}`;
  const R = 26;
  const BOX = 68;

  return (
    <div style={{
      padding: "14px 16px 14px 14px",
      display: "flex", alignItems: "center", gap: 14, position: "relative",
      height: "100%", boxSizing: "border-box",
    }}>
      <div style={{ position: "relative", width: BOX, height: BOX, flexShrink: 0 }}>
        <motion.div
          animate={{ rotate: 360 }}
          transition={{ duration: 9, repeat: Infinity, ease: "linear" }}
          style={{
            position: "absolute", inset: -4, borderRadius: "50%",
            background: `conic-gradient(from 0deg, transparent 0deg, ${withAlpha(cat.from, 0.55)} 90deg, transparent 200deg)`,
            filter: "blur(6px)", opacity: 0.75,
          }}
        />
        <svg width={BOX} height={BOX} viewBox={`0 0 ${BOX} ${BOX}`} style={{ position: "relative" }}>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%"   stopColor={cat.from} />
              <stop offset="100%" stopColor={cat.to} />
            </linearGradient>
          </defs>
          <circle
            cx={BOX / 2} cy={BOX / 2} r={R}
            fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={4}
          />
          <motion.circle
            cx={BOX / 2} cy={BOX / 2} r={R}
            fill="none" stroke={`url(#${gradId})`} strokeWidth={4} strokeLinecap="round"
            transform={`rotate(-90 ${BOX / 2} ${BOX / 2})`}
            initial={{ pathLength: 1 }}
            animate={{ pathLength: 0 }}
            transition={drainTransition(data.durationMs, preview)}
          />
        </svg>
        <div style={{
          position: "absolute", inset: 0,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 24, pointerEvents: "none",
        }}>
          {cat.icon}
        </div>
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 4 }}>
          <Badge crit={crit} />
          <span style={{ fontSize: 9, color: theme.textMuted, fontWeight: 600 }}>{t(cat.key)}</span>
        </div>
        <p style={{
          color: "#fff", fontWeight: 700, fontSize: 14, lineHeight: 1.25, margin: 0,
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }}>
          {data.task_name}
        </p>
        <div style={{ marginTop: 6 }}>
          <TimePill text={data.time_left} crit={crit} />
        </div>
      </div>
    </div>
  );
}

// ── Style 3: minimal ──────────────────────────────────────────────────────────
function MinimalBody({ data, theme, cat, crit, preview }: BodyProps) {
  return (
    <>
      <div style={{
        padding: "0 14px", height: 59, boxSizing: "border-box",
        display: "flex", alignItems: "center", gap: 11, position: "relative",
      }}>
        <div style={{
          width: 28, height: 28, borderRadius: 9, flexShrink: 0,
          background: `linear-gradient(145deg, ${cat.from}, ${cat.to})`,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 14,
        }}>
          {cat.icon}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{
            color: "#fff", fontWeight: 700, fontSize: 12.5, lineHeight: 1.25, margin: 0,
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          }}>
            {data.task_name}
          </p>
          <p style={{
            color: theme.textMuted, fontSize: 9.5, margin: 0, marginTop: 1,
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          }}>
            {(crit ? t("notif.critical") : t("notif.warning")) + " · " + t(cat.key)}
          </p>
        </div>

        <TimePill text={data.time_left} crit={crit} />
      </div>

      <div style={{ height: 2, background: "rgba(255,255,255,0.05)" }}>
        <motion.div
          style={{
            height: "100%",
            background: `linear-gradient(to right, ${cat.from}, ${cat.to})`,
            originX: 0,
          }}
          initial={{ scaleX: 1 }}
          animate={{ scaleX: 0 }}
          transition={drainTransition(data.durationMs, preview)}
        />
      </div>
    </>
  );
}