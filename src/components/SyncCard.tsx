import { useEffect, useState } from "react";
import {
  RefreshCw, Loader2, Eye, EyeOff, Copy, Check, KeyRound,
  CloudOff, Server, AlertTriangle, HardDrive,
} from "lucide-react";
import { getDb } from "../lib/database";
import { t } from "../lib/i18n";
import {
  loadSyncConfig, saveSyncConfig, newPairing, pairingOf, isReady,
  SYNC_OFF, syncNow, type SyncConfig,
} from "../lib/sync/config";
import { decodePairing } from "../lib/sync/crypto";
import { StorageError } from "../lib/sync/storage";
import { TauriHttpTransport } from "../lib/sync/transport";
import type { SyncReport } from "../lib/sync/engine";

// ─── SyncCard ─────────────────────────────────────────────────────────────────
//
// Everything under lib/sync has existed and been tested for a while. Nothing
// could reach it, because there was no screen. This is that screen, and it is
// the last piece on this side before a task typed here can appear on the phone.
//
// WHY THERE IS NO TIMER
// ---------------------
// The engine is safe to call again immediately and safe to interrupt anywhere,
// so a fifteen-minute interval would be correct. It is still not here, because
// the first thing anyone debugging a sync needs is to know exactly what caused
// what. A run that happens on its own turns "the phone has an old copy" into a
// question with two answers — the sync did not work, or it has not gone yet —
// and no way to tell them apart from the screen. The button comes first. The
// timer goes in once both devices are known to agree.
//
// WHY THE PAIRING CODE IS TREATED LIKE THIS
// -----------------------------------------
// It is the bucket id and the encryption key in one string. The server holds
// the data and cannot read a single task name, which is the whole design — and
// the exact same fact means nobody can recover it, including this app. So it is
// hidden by default, replacing it asks first, and the warning is on the screen
// rather than in a footnote. config.ts says the same thing at greater length.

type Phase =
  | { kind: "loading" }
  | { kind: "idle" }
  | { kind: "syncing" }
  | { kind: "done"; report: SyncReport; at: Date }
  | { kind: "failed"; message: string };

/**
 * A failure the person can act on, rather than a stack trace.
 *
 * StorageError already carries the distinction — the adapters spent real effort
 * separating "your password is wrong" from "the server is busy" — so this is a
 * lookup, not a guess. Anything that is not a StorageError keeps its own text:
 * an unexpected failure that has been rewritten into a friendly sentence is an
 * unexpected failure nobody can report.
 */
function reasonOf(e: unknown): string {
  if (e instanceof StorageError) {
    switch (e.kind) {
      case "config":   return t("sync.errConfig");
      case "auth":     return t("sync.errAuth");
      case "notFound": return t("sync.errNotFound");
      case "network":  return t("sync.errNetwork");
      case "server":   return t("sync.errServer");
    }
  }
  return e instanceof Error ? e.message : String(e);
}

export default function SyncCard() {
  const [cfg, setCfg] = useState<SyncConfig>(SYNC_OFF);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  // The WebDAV fields are held apart from the saved config so that a half-typed
  // URL is never what a sync runs against.
  const [url, setUrl]   = useState("");
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [showPass, setShowPass] = useState(false);

  const [showCode, setShowCode] = useState(false);
  const [copied, setCopied]     = useState(false);
  const [pasting, setPasting]   = useState(false);
  const [pasted, setPasted]     = useState("");
  const [pasteErr, setPasteErr] = useState(false);
  const [confirmNew, setConfirmNew] = useState(false);

  useEffect(() => {
    void (async () => {
      const db = await getDb();
      const c = await loadSyncConfig(db);
      setCfg(c);
      if (c.backend.kind === "webdav") {
        setUrl(c.backend.baseUrl);
        setUser(c.backend.username);
        setPass(c.backend.password);
      }
      setPhase({ kind: "idle" });
    })();
  }, []);

  const persist = async (next: SyncConfig) => {
    const db = await getDb();
    await saveSyncConfig(db, next);
    setCfg(next);
  };

  const on = cfg.backend.kind !== "off";
  const dirty =
    cfg.backend.kind === "webdav" &&
    (url !== cfg.backend.baseUrl || user !== cfg.backend.username || pass !== cfg.backend.password);
  const ready = isReady(cfg);

  const toggleBackend = () => {
    void persist(
      on
        // Turning it off keeps the pairing code. The code is the key, and the
        // switch on this card is not the place to destroy one.
        ? { backend: { kind: "off" }, pairing: cfg.pairing }
        : { backend: { kind: "webdav", baseUrl: url, username: user, password: pass }, pairing: cfg.pairing },
    );
  };

  const saveServer = () =>
    void persist({ backend: { kind: "webdav", baseUrl: url.trim(), username: user, password: pass }, pairing: cfg.pairing });

  const makeCode = () => {
    void persist({ backend: cfg.backend, pairing: newPairing() });
    setShowCode(true);
    setConfirmNew(false);
  };

  const usePasted = () => {
    const text = pasted.trim();
    try {
      decodePairing(text);
    } catch {
      // Refused rather than stored. A typo saved over a working code would take
      // the only copy of a key with it, and that is the one mistake here that
      // cannot be undone.
      setPasteErr(true);
      return;
    }
    void persist({ backend: cfg.backend, pairing: text });
    setPasting(false);
    setPasted("");
    setPasteErr(false);
  };

  const copyCode = () => {
    if (!cfg.pairing) return;
    void navigator.clipboard.writeText(cfg.pairing);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const run = async () => {
    setPhase({ kind: "syncing" });
    try {
      const db = await getDb();
      const report = await syncNow(db, new TauriHttpTransport());
      // Null means "not set up", which the button is already gated on, so
      // reaching it would be a bug rather than a state worth rendering.
      if (!report) { setPhase({ kind: "idle" }); return; }
      setPhase({ kind: "done", report, at: new Date() });
    } catch (e) {
      setPhase({ kind: "failed", message: reasonOf(e) });
    }
  };

  if (phase.kind === "loading") {
    return (
      <div className="bg-white/5 border border-white/10 rounded-2xl p-4 flex items-center gap-3">
        <Loader2 size={18} className="text-white/30 animate-spin" />
        <p className="text-white/40 text-sm">{t("sync.title")}</p>
      </div>
    );
  }

  return (
    <div className="bg-white/5 border border-white/10 rounded-2xl p-4 space-y-3">

      {/* ── on/off ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {on ? <Server size={18} className="text-sky-400" /> : <CloudOff size={18} className="text-white/30" />}
          <div>
            <p className="text-white text-sm font-semibold">{t("sync.title")}</p>
            <p className="text-white/40 text-xs">{on ? t("sync.subOn") : t("sync.subOff")}</p>
          </div>
        </div>
        <button
          onClick={toggleBackend}
          className={`w-12 h-6 rounded-full transition-all relative ${on ? "bg-sky-500" : "bg-white/20"}`}
        >
          <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${on ? "left-7" : "left-1"}`} />
        </button>
      </div>

      {on && (
        <>
          {/* ── where it goes ─────────────────────────────────────────────── */}
          <div className="border-t border-white/8 pt-3 space-y-2">
            <p className="text-white/60 text-xs font-semibold">{t("sync.server")}</p>

            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://…/remote.php/dav/files/me/reup"
              spellCheck={false}
              className="w-full bg-black/30 border border-white/10 rounded-xl px-3 py-2 text-white text-xs
                         outline-none focus:border-sky-400/60 placeholder:text-white/20"
            />
            <div className="flex gap-2">
              <input
                value={user}
                onChange={(e) => setUser(e.target.value)}
                placeholder={t("sync.username")}
                autoComplete="off"
                spellCheck={false}
                className="flex-1 min-w-0 bg-black/30 border border-white/10 rounded-xl px-3 py-2 text-white text-xs
                           outline-none focus:border-sky-400/60 placeholder:text-white/20"
              />
              <div className="flex-1 min-w-0 relative">
                <input
                  value={pass}
                  onChange={(e) => setPass(e.target.value)}
                  type={showPass ? "text" : "password"}
                  placeholder={t("sync.password")}
                  autoComplete="off"
                  className="w-full bg-black/30 border border-white/10 rounded-xl pl-3 pr-9 py-2 text-white text-xs
                             outline-none focus:border-sky-400/60 placeholder:text-white/20"
                />
                <button
                  onClick={() => setShowPass((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/60"
                >
                  {showPass ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={saveServer}
                disabled={!dirty}
                className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-all ${
                  dirty ? "bg-sky-500/20 text-sky-300 hover:bg-sky-500/30" : "bg-white/5 text-white/25"
                }`}
              >
                {dirty ? t("sync.save") : t("sync.saved")}
              </button>
              <p className="text-white/25 text-[10px] leading-snug">{t("sync.serverNote")}</p>
            </div>

            {/* Written down rather than left out, because an option that is
                missing reads as an option nobody thought of. */}
            <div className="flex items-start gap-2 opacity-40">
              <HardDrive size={12} className="text-white/40 mt-0.5 shrink-0" />
              <p className="text-white/40 text-[10px] leading-snug">{t("sync.driveLater")}</p>
            </div>
          </div>

          {/* ── the key ───────────────────────────────────────────────────── */}
          <div className="border-t border-white/8 pt-3 space-y-2">
            <div className="flex items-center gap-2">
              <KeyRound size={13} className="text-amber-400/70" />
              <p className="text-white/60 text-xs font-semibold">{t("sync.pairing")}</p>
            </div>

            <p className="text-white/30 text-[11px] leading-relaxed">{t("sync.pairingWhy")}</p>

            {cfg.pairing ? (
              <>
                <div className="flex items-center gap-2">
                  <code className="flex-1 min-w-0 bg-black/40 border border-white/10 rounded-xl px-3 py-2
                                   text-[11px] text-white/80 break-all font-mono">
                    {showCode ? cfg.pairing : "•".repeat(Math.min(cfg.pairing.length, 44))}
                  </code>
                  <button
                    onClick={() => setShowCode((v) => !v)}
                    className="p-2 rounded-lg bg-white/5 text-white/40 hover:text-white/70 shrink-0"
                  >
                    {showCode ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                  <button
                    onClick={copyCode}
                    className="p-2 rounded-lg bg-white/5 text-white/40 hover:text-white/70 shrink-0"
                  >
                    {copied ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
                  </button>
                </div>
                {!pairingOf(cfg) && (
                  <p className="text-amber-400/80 text-[10px] leading-snug">{t("sync.pairingBroken")}</p>
                )}
                <p className="text-amber-400/70 text-[10px] leading-snug">{t("sync.pairingWriteDown")}</p>
              </>
            ) : (
              <p className="text-white/40 text-[11px]">{t("sync.pairingNone")}</p>
            )}

            {confirmNew ? (
              <div className="bg-amber-500/10 border border-amber-500/25 rounded-xl p-3 space-y-2">
                <div className="flex items-start gap-2">
                  <AlertTriangle size={13} className="text-amber-400 mt-0.5 shrink-0" />
                  <p className="text-amber-200/90 text-[11px] leading-relaxed">{t("sync.newCodeWarn")}</p>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={makeCode}
                    className="px-3 py-1.5 rounded-lg bg-amber-500/25 text-amber-200 text-[11px] font-semibold hover:bg-amber-500/35"
                  >
                    {t("sync.newCodeGo")}
                  </button>
                  <button
                    onClick={() => setConfirmNew(false)}
                    className="px-3 py-1.5 rounded-lg bg-white/5 text-white/50 text-[11px]"
                  >
                    {t("sync.cancel")}
                  </button>
                </div>
              </div>
            ) : pasting ? (
              <div className="space-y-2">
                <input
                  value={pasted}
                  onChange={(e) => { setPasted(e.target.value); setPasteErr(false); }}
                  placeholder={t("sync.pasteHint")}
                  spellCheck={false}
                  className="w-full bg-black/30 border border-white/10 rounded-xl px-3 py-2 text-white text-[11px] font-mono
                             outline-none focus:border-sky-400/60 placeholder:text-white/20"
                />
                {pasteErr && <p className="text-amber-400/80 text-[10px]">{t("sync.pasteBad")}</p>}
                <div className="flex gap-2">
                  <button
                    onClick={usePasted}
                    disabled={pasted.trim() === ""}
                    className="px-3 py-1.5 rounded-lg bg-sky-500/20 text-sky-300 text-[11px] font-semibold
                               disabled:bg-white/5 disabled:text-white/25 hover:bg-sky-500/30"
                  >
                    {t("sync.pasteGo")}
                  </button>
                  <button
                    onClick={() => { setPasting(false); setPasted(""); setPasteErr(false); }}
                    className="px-3 py-1.5 rounded-lg bg-white/5 text-white/50 text-[11px]"
                  >
                    {t("sync.cancel")}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex gap-2">
                <button
                  onClick={() => (cfg.pairing ? setConfirmNew(true) : makeCode())}
                  className="px-3 py-1.5 rounded-lg bg-white/5 text-white/60 text-[11px] font-semibold hover:bg-white/10"
                >
                  {t("sync.newCode")}
                </button>
                <button
                  onClick={() => setPasting(true)}
                  className="px-3 py-1.5 rounded-lg bg-white/5 text-white/60 text-[11px] font-semibold hover:bg-white/10"
                >
                  {t("sync.paste")}
                </button>
              </div>
            )}
          </div>

          {/* ── the run ───────────────────────────────────────────────────── */}
          <div className="border-t border-white/8 pt-3 space-y-2">
            <button
              onClick={() => void run()}
              disabled={!ready || phase.kind === "syncing" || dirty}
              className={`w-full py-2.5 rounded-xl text-xs font-semibold flex items-center justify-center gap-2 transition-all ${
                ready && !dirty
                  ? "bg-sky-500/20 text-sky-300 hover:bg-sky-500/30"
                  : "bg-white/5 text-white/25"
              }`}
            >
              {phase.kind === "syncing"
                ? <><Loader2 size={14} className="animate-spin" />{t("sync.running")}</>
                : <><RefreshCw size={14} />{t("sync.now")}</>}
            </button>

            {!ready && <p className="text-white/30 text-[10px] leading-snug">{t("sync.notReady")}</p>}
            {ready && dirty && <p className="text-white/30 text-[10px] leading-snug">{t("sync.saveFirst")}</p>}

            {phase.kind === "done" && (
              <div className="space-y-1">
                <p className="text-white/50 text-[11px]">
                  {t("sync.result", {
                    applied: phase.report.applied,
                    pushed: phase.report.pushed,
                    read: phase.report.read,
                  })}
                </p>
                {phase.report.applied === 0 && phase.report.pushed === 0 && (
                  <p className="text-white/25 text-[10px]">{t("sync.resultQuiet")}</p>
                )}
                {phase.report.skipped.length > 0 && (
                  <p className="text-amber-400/70 text-[10px] leading-snug">
                    {t("sync.skipped", { n: phase.report.skipped.length })}
                  </p>
                )}
              </div>
            )}

            {phase.kind === "failed" && (
              <p className="text-amber-400/80 text-[11px] leading-snug">{phase.message}</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}