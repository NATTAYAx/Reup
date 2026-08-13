import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { PauseCircle, Trash2, RotateCcw, X, Loader2 } from "lucide-react";
import {
  getPausedTasks, getTrashedTasks, resumeTask, restoreTask, purgeTask, TRASH_TTL_DAYS,
} from "../lib/database";
import { t } from "../lib/i18n";

// ─── TaskShelf ────────────────────────────────────────────────────────────────
//
// Two lists that look alike and mean opposite things, kept together because
// they answer the same question: where did that task go.
//
//   SET ASIDE   still yours, not being asked for. Comes back whole, with no
//               missed cycles owed for the time away.
//   BIN         deleted, recoverable for thirty days, then gone.
//
// WHY IT IS NOT ON THE MAIN SCREEN
//
// The list is meant to be short and to be about today. A permanent panel of
// everything postponed is a second list of open loops sitting next to the
// first, which is the opposite of what setting something aside was for. So this
// lives one click away, and the count is the only thing that surfaces.
//
// WHY THE BIN IS WORTH BUILDING AT ALL
//
// The rows were already there. Tasks have been soft-deleted since the sync
// groundwork went in, so every task ever deleted is sitting in the database
// right now with no way to look at it. This is a list and two buttons over data
// that already exists.
//
// And an app where a mis-tap is permanent is an app that costs something to
// touch. Making delete reversible is not really about recovering data; it is
// about the list being safe to tidy.

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called after anything comes back, so the main list reloads. */
  onChanged: () => void;
}

type Row = {
  id: number;
  name: string;
  category: string;
  paused_until?: string | null;
  deleted_at?: string | null;
};

export default function TaskShelf({ open, onClose, onChanged }: Props) {
  const [paused, setPaused] = useState<Row[]>([]);
  const [trash, setTrash] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  // Purging is the one irreversible button in here, so it asks. Tracked by id
  // rather than a boolean, so opening one confirmation closes any other.
  const [confirmPurge, setConfirmPurge] = useState<number | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [p, d] = await Promise.all([getPausedTasks(), getTrashedTasks()]);
      setPaused(p as Row[]);
      setTrash(d as Row[]);
    } catch (err) {
      console.error("[TaskShelf] load failed:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (open) { setConfirmPurge(null); load(); } }, [open]);

  // Esc closes, matching every other overlay in the app.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (confirmPurge !== null) { setConfirmPurge(null); return; }
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, confirmPurge, onClose]);

  const act = async (fn: () => Promise<void>) => {
    try { await fn(); } catch (err) { console.error("[TaskShelf] action failed:", err); }
    await load();
    onChanged();
  };

  /** Whole days left before the bin empties this one out by itself. */
  const daysLeft = (deletedAt?: string | null): number | null => {
    if (!deletedAt) return null;
    const gone = Date.parse(deletedAt) + TRASH_TTL_DAYS * 86_400_000;
    if (isNaN(gone)) return null;
    return Math.max(0, Math.ceil((gone - Date.now()) / 86_400_000));
  };

  /** "no end date" is stored as a year-9999 datetime; do not print that at
   *  someone. Anything past a century out reads as indefinite. */
  const pauseLabel = (until?: string | null): string => {
    if (!until) return "";
    const ms = Date.parse(until);
    if (isNaN(ms)) return "";
    if (ms > Date.now() + 100 * 365 * 86_400_000) return t("shelf.pausedIndef");
    return `${t("shelf.pausedUntil")} ${new Date(ms).toLocaleDateString()}`;
  };

  if (!open) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-6"
        onClick={onClose}
      >
        <motion.div
          initial={{ scale: 0.96, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.96, opacity: 0 }}
          onClick={e => e.stopPropagation()}
          className="w-full max-w-md max-h-full flex flex-col rounded-2xl border border-white/10 bg-[var(--color-bg)] shadow-2xl overflow-hidden"
        >
          {/* header — pinned */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-white/10 shrink-0">
            <h2 className="text-white font-semibold text-sm">{t("shelf.title")}</h2>
            <button onClick={onClose} className="p-1.5 rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-colors">
              <X size={16} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
            {loading ? (
              <div className="flex items-center justify-center py-10 text-white/30">
                <Loader2 size={18} className="animate-spin" />
              </div>
            ) : (
              <>
                {/* ── Set aside ── */}
                <section className="space-y-2">
                  <div className="flex items-center gap-2">
                    <PauseCircle size={14} className="text-sky-300/70" />
                    <h3 className="text-white/70 text-xs font-semibold">{t("shelf.pausedTitle")}</h3>
                  </div>

                  {paused.length === 0 ? (
                    <p className="text-white/25 text-[11px] pl-6">{t("shelf.pausedEmpty")}</p>
                  ) : paused.map(row => (
                    <div key={row.id} className="flex items-center gap-2 rounded-xl bg-white/5 border border-white/10 px-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <p className="text-white text-xs truncate">{row.name}</p>
                        <p className="text-white/30 text-[10px]">{pauseLabel(row.paused_until)}</p>
                      </div>
                      <button
                        onClick={() => act(() => resumeTask(row.id))}
                        className="flex items-center gap-1.5 shrink-0 px-2.5 py-1.5 rounded-lg bg-white/5 border border-white/10 text-white/60 hover:text-white hover:border-white/25 text-[11px] font-semibold transition-colors"
                      >
                        <RotateCcw size={11} />
                        {t("shelf.resume")}
                      </button>
                    </div>
                  ))}
                </section>

                {/* ── Bin ── */}
                <section className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Trash2 size={14} className="text-white/35" />
                    <h3 className="text-white/70 text-xs font-semibold">{t("shelf.trashTitle")}</h3>
                  </div>

                  {trash.length === 0 ? (
                    <p className="text-white/25 text-[11px] pl-6">{t("shelf.trashEmpty")}</p>
                  ) : trash.map(row => {
                    const left = daysLeft(row.deleted_at);
                    return (
                      <div key={row.id} className="rounded-xl bg-white/5 border border-white/10 px-3 py-2.5 space-y-2">
                        <div className="flex items-center gap-2">
                          <div className="min-w-0 flex-1">
                            <p className="text-white/80 text-xs truncate">{row.name}</p>
                            {left !== null && (
                              <p className="text-white/30 text-[10px]">
                                {left === 0 ? t("shelf.goesToday") : `${t("shelf.goesIn")} ${left} ${t("shelf.days")}`}
                              </p>
                            )}
                          </div>
                          <button
                            onClick={() => act(() => restoreTask(row.id))}
                            className="flex items-center gap-1.5 shrink-0 px-2.5 py-1.5 rounded-lg bg-white/5 border border-white/10 text-white/60 hover:text-white hover:border-white/25 text-[11px] font-semibold transition-colors"
                          >
                            <RotateCcw size={11} />
                            {t("shelf.restore")}
                          </button>
                          <button
                            onClick={() => setConfirmPurge(c => (c === row.id ? null : row.id))}
                            className="shrink-0 p-1.5 rounded-lg text-white/20 hover:text-red-400 bg-white/5 transition-colors"
                            title={t("shelf.purge")}
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>

                        {confirmPurge === row.id && (
                          <div className="flex items-center gap-2 rounded-lg bg-red-500/10 border border-red-500/25 px-2.5 py-2">
                            <p className="flex-1 text-red-100/80 text-[11px]">{t("shelf.purgeConfirm")}</p>
                            <button
                              onClick={() => setConfirmPurge(null)}
                              className="px-2 py-1 rounded-md bg-white/5 border border-white/10 text-white/60 hover:text-white text-[11px] transition-colors"
                            >
                              {t("common.cancel")}
                            </button>
                            <button
                              onClick={() => { setConfirmPurge(null); act(() => purgeTask(row.id)); }}
                              className="px-2 py-1 rounded-md bg-red-500/80 hover:bg-red-500 text-white text-[11px] font-semibold transition-colors"
                            >
                              {t("shelf.purge")}
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}

                  <p className="text-white/20 text-[10px] pl-6 leading-relaxed">{t("shelf.trashNote")}</p>
                </section>
              </>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}