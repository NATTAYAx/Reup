// ─── DesktopWidgetCard.tsx — the board's settings ────────────────────────────
//
// On or off, how dark the backing is, whether the month's money shows, and
// moving it. Whether it is on and where it sits belong to the Rust side
// (widget.rs) and are asked for and told through commands; the look is page
// storage the board reads live. The tray can change the first two as well, so
// this listens for the board's status rather than assuming its own clicks are
// the only ones.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LayoutDashboard, Move, RotateCcw, Wallet } from "lucide-react";
import { t } from "../lib/i18n";
import { readTint, writeTint, moneyOn, setMoneyOn, TINT_MAX } from "../lib/widgetLook";
import { sendToWidget } from "../lib/widgetFeed";

interface Status {
  enabled: boolean;
  arranging: boolean;
}

function Switch({ on, busy, onClick }: { on: boolean; busy?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className={`w-12 h-6 rounded-full transition-all relative shrink-0 ${busy ? "bg-white/30" : on ? "bg-green-500" : "bg-white/20"}`}
    >
      <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${on ? "left-7" : "left-1"}`} />
    </button>
  );
}

export default function DesktopWidgetCard() {
  const [status, setStatus] = useState<Status>({ enabled: false, arranging: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [tint, setTintState] = useState(readTint);
  const [money, setMoney] = useState(moneyOn);

  useEffect(() => {
    let alive = true;
    invoke<Status>("widget_status").then(s => { if (alive) setStatus(s); }).catch(() => {});
    const un = listen<Status>("widget-status", e => setStatus(e.payload));
    return () => {
      alive = false;
      un.then(f => f()).catch(() => {});
    };
  }, []);

  const call = async (cmd: string, args?: Record<string, unknown>) => {
    setBusy(true);
    setError("");
    try {
      setStatus(await invoke<Status>(cmd, args));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const onTint = (n: number) => {
    setTintState(n);
    writeTint(n);
  };

  const toggleMoney = () => {
    const next = !money;
    setMoney(next);
    setMoneyOn(next);
    // The board's money line comes with the task list; send one now rather
    // than waiting for the next load.
    void sendToWidget();
  };

  return (
    <div className="pt-2 border-t border-white/10">
      <p className="text-white/40 text-xs font-semibold uppercase tracking-widest mb-2 px-1">
        {t("widget.title")}
      </p>
      <div className="p-3 rounded-2xl border border-white/10 bg-white/5 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-start gap-2 min-w-0">
            <LayoutDashboard size={15} className="text-white/50 mt-0.5 shrink-0" />
            <div className="min-w-0">
              <p className="text-white/80 text-sm font-medium">{t("widget.enable")}</p>
              <p className="text-white/35 text-[11px] leading-snug">{t("widget.enableSub")}</p>
            </div>
          </div>
          <Switch on={status.enabled} busy={busy} onClick={() => call("widget_enable", { on: !status.enabled })} />
        </div>

        {status.enabled && (
          <>
            <div>
              <div className="flex items-center justify-between mb-1.5 px-0.5">
                <span className="text-white/60 text-xs font-semibold">{t("widget.tint")}</span>
                <span className="text-white/45 text-xs">{tint === 0 ? t("widget.tintNone") : `${tint}%`}</span>
              </div>
              <input
                type="range"
                min={0}
                max={TINT_MAX}
                step={5}
                value={tint}
                onChange={e => onTint(Number(e.target.value))}
                className="w-full h-1.5 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow"
                style={{
                  background: `linear-gradient(to right, var(--color-primary) ${(tint / TINT_MAX) * 100}%, rgba(255,255,255,0.15) ${(tint / TINT_MAX) * 100}%)`,
                }}
              />
            </div>

            <div className="flex items-center justify-between gap-3">
              <div className="flex items-start gap-2 min-w-0">
                <Wallet size={15} className="text-white/50 mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <p className="text-white/80 text-sm font-medium">{t("widget.money")}</p>
                  <p className="text-white/35 text-[11px] leading-snug">{t("widget.moneySub")}</p>
                </div>
              </div>
              <Switch on={money} onClick={toggleMoney} />
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => call("widget_arrange", { on: !status.arranging })}
                disabled={busy}
                className={`flex-1 py-2 rounded-xl text-sm font-semibold transition-all flex items-center justify-center gap-2 disabled:opacity-50 ${
                  status.arranging ? "theme-btn text-white" : "bg-white/5 border border-white/10 text-white/70 hover:text-white"
                }`}
              >
                <Move size={13} />
                {status.arranging ? t("widget.moveDone") : t("widget.move")}
              </button>
              <button
                onClick={() => call("widget_reset")}
                disabled={busy}
                title={t("widget.reset")}
                className="px-3 py-2 rounded-xl bg-white/5 border border-white/10 text-white/50 hover:text-white transition-all disabled:opacity-50"
              >
                <RotateCcw size={13} />
              </button>
            </div>
          </>
        )}

        {error && <p className="text-red-400 text-[10px] px-1 leading-relaxed break-all">{error}</p>}

        <p className="text-white/25 text-[10px] px-1 leading-relaxed">{t("widget.note")}</p>
      </div>
    </div>
  );
}
