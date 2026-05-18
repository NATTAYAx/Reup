import { motion, AnimatePresence } from "framer-motion";
import { Trash2, Star, Flame, CheckCircle2, RotateCcw, Edit3 } from "lucide-react";
import { CountdownResult, isRecurring, isOneShot } from "../types";
import { formatCountdown, getCategoryColor, getUrgencyColor } from "../lib/countdown";
import { getNextReset } from "../lib/countdown";
import { markTaskCompleted, unmarkTaskCompleted } from "../lib/database";
import { t } from "../lib/i18n";

interface Props {
  result: CountdownResult;
  onDelete: (id: number) => void;
  onTogglePriority: (id: number, current: boolean) => void;
  onToggleUrgent: (id: number, current: boolean) => void;
  onRefresh: () => void;
  onEdit?: (id: number) => void;
}

export default function TaskCard({ result, onDelete, onTogglePriority, onToggleUrgent, onRefresh, onEdit }: Props) {
  // No interactive delay needed — the sort stability fix in useCountdowns ensures
  // TaskCards don't continuously remount each second, so phantom clicks cannot occur.
  const { task, urgency, is_completed_this_cycle } = result;
  const countdown = formatCountdown(result);
  const isPriority = Boolean(task.is_priority);
  const isUrgent = Boolean(task.is_urgent);
  const recurring = isRecurring(task);
  const oneShot = isOneShot(task);

  // Card border: completed > urgent > priority > time-based urgency
  const cardBorder = is_completed_this_cycle
    ? "border-green-500/40 bg-green-500/5"
    : isUrgent
    ? "border-red-500/50 bg-red-500/5"
    : isPriority
    ? "border-yellow-500/40 bg-yellow-500/5"
    : "border-white/10";

  const handleComplete = async () => {
    if (recurring) {
      // Mark done until next reset — auto-unmarks when the cycle resets
      const nextReset = getNextReset(task);
      if (!nextReset) return;
      await markTaskCompleted(task.id, nextReset.toISOString());
    } else if (oneShot) {
      // Mark done until end of today (Bangkok midnight) — stays visible as
      // "completed" for the rest of the day, then auto-hides tomorrow.
      const endOfToday = new Date();
      endOfToday.setHours(23, 59, 59, 999);
      await markTaskCompleted(task.id, endOfToday.toISOString());
    }
    onRefresh();
  };

  const handleUndoComplete = async () => {
    await unmarkTaskCompleted(task.id);
    onRefresh();
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{
        opacity: is_completed_this_cycle ? 0.65 : 1,
        y: 0,
        scale: is_completed_this_cycle ? 0.98 : 1,
      }}
      exit={{ opacity: 0, scale: 0.95 }}
      className={`relative bg-white/5 border rounded-2xl p-4 group transition-all ${cardBorder}`}
    >
      {/* left color bar — greyed out when done */}
      <div className={`absolute left-0 top-0 bottom-0 w-1 rounded-l-2xl bg-gradient-to-b ${
        is_completed_this_cycle ? "from-green-500 to-emerald-600" : getCategoryColor(task.category)
      }`} />

      {/* urgent pulse ring */}
      {isUrgent && !is_completed_this_cycle && (
        <div className="absolute inset-0 rounded-2xl border border-red-500/20 animate-pulse pointer-events-none" />
      )}

      {/* completed overlay check */}
      <AnimatePresence>
        {is_completed_this_cycle && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute top-2 right-2 text-green-400 pointer-events-none"
          >
            <CheckCircle2 size={16} fill="currentColor" className="opacity-60" />
          </motion.div>
        )}
      </AnimatePresence>

      <div className="pl-2">
        {/* top row */}
        <div className="flex items-start justify-between gap-2 mb-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 mb-1 flex-wrap">
              <span className={`text-xs font-bold uppercase tracking-wider bg-gradient-to-r ${
                is_completed_this_cycle ? "from-green-400 to-emerald-500" : getCategoryColor(task.category)
              } bg-clip-text text-transparent`}>
                {task.category}
              </span>
              {isPriority && <span className="text-xs text-yellow-400">⭐</span>}
              {isUrgent && <span className="text-xs text-red-400">🔥</span>}
              {is_completed_this_cycle && (recurring || oneShot) && (
                <span className="text-xs text-green-400 font-semibold">{t("task.completedMark")}</span>
              )}
            </div>
            <p className={`font-semibold text-sm leading-tight truncate ${
              is_completed_this_cycle ? "text-white/50 line-through" : "text-white"
            }`}>
              {task.name}
            </p>
            {task.description ? (
              <p className="text-white/40 text-xs mt-0.5 truncate">{task.description}</p>
            ) : null}
            {(task as any).notes ? (
              <p className="text-white/25 text-xs mt-0.5 truncate italic">📝 {(task as any).notes}</p>
            ) : null}
          </div>

          {/* action buttons — show on hover */}
          <div className="flex gap-1 flex-shrink-0">
            {/* Complete / Undo button */}
            {is_completed_this_cycle ? (
              <button
                onClick={e => { if (e.isTrusted) handleUndoComplete(); }}
                className="p-1.5 rounded-lg text-green-400 bg-green-400/10 hover:bg-green-400/20 transition-all"
                title={t("task.undoDone")}
              >
                <RotateCcw size={13} />
              </button>
            ) : (
              <button
                onClick={e => { if (e.isTrusted) handleComplete(); }}
                className="p-1.5 rounded-lg text-white/20 hover:text-green-400 hover:bg-green-400/10 bg-white/5 transition-all"
                title={recurring ? t("task.markDone") : t("task.markDoneOT")}
              >
                <CheckCircle2 size={13} />
              </button>
            )}

            {!is_completed_this_cycle && (
              <>
                <button
                  onClick={e => { if (e.isTrusted) onToggleUrgent(task.id, isUrgent); }}
                  className={`p-1.5 rounded-lg transition-all ${
                    isUrgent
                      ? "text-red-400 bg-red-400/10"
                      : "text-white/20 hover:text-red-400 bg-white/5"
                  }`}
                  title={isUrgent ? t("task.unmarkCrit") : t("task.markCrit")}
                >
                  <Flame size={13} fill={isUrgent ? "currentColor" : "none"} />
                </button>
                <button
                  onClick={e => { if (e.isTrusted) onTogglePriority(task.id, isPriority); }}
                  className={`p-1.5 rounded-lg transition-all ${
                    isPriority
                      ? "text-yellow-400 bg-yellow-400/10"
                      : "text-white/20 hover:text-yellow-400 bg-white/5"
                  }`}
                  title={isPriority ? t("task.unmarkImp") : t("task.markImp")}
                >
                  <Star size={13} fill={isPriority ? "currentColor" : "none"} />
                </button>
              </>
            )}

            {onEdit && (
              <button
                onClick={e => { e.stopPropagation(); if (e.isTrusted) onEdit(task.id); }}
                className="p-1.5 rounded-lg text-white/20 hover:text-purple-400 bg-white/5 transition-all"
                title={t("task.edit")}
              >
                <Edit3 size={13} />
              </button>
            )}
            <button
              onClick={e => { if (e.isTrusted) onDelete(task.id); }}
              className="p-1.5 rounded-lg text-white/20 hover:text-red-400 bg-white/5 transition-all"
              title={t("task.delete")}
            >
              <Trash2 size={13} />
            </button>
          </div>
        </div>

        {/* bottom: reset type badge + countdown or "resets in" */}
        <div className="flex items-center justify-between">
          <span className="text-xs bg-white/5 text-white/40 px-2 py-0.5 rounded-full">
            {task.reset_type === "event_window" ? t("type.event_window") :
             task.reset_type === "specific_date" ? t("type.specific_date") :
             task.reset_type === "custom_days" ? t("type.custom_days") :
             task.reset_type === "daily" ? t("type.daily") :
             task.reset_type === "weekly" ? t("type.weekly") :
             task.reset_type === "biweekly" ? t("type.biweekly") :
             task.reset_type.replace("_", " ")}
          </span>

          {is_completed_this_cycle ? (
            <span className="text-xs text-green-400/70 font-medium">
              {recurring
                ? `${t("task.resetsIn")} ${formatTimeUntilReset(result)}`
                : t("task.completedText")
              }
            </span>
          ) : (
            <span className={`font-mono font-bold text-sm ${
              isUrgent ? "text-red-400" : getUrgencyColor(urgency)
            }`}>
              {countdown}
            </span>
          )}
        </div>
      </div>
    </motion.div>
  );
}

/** Shows how long until the current cycle resets (e.g. "5h 30m") — caller prepends t("task.resetsIn") */
function formatTimeUntilReset(result: CountdownResult): string {
  const ms = result.time_remaining_ms;
  if (ms <= 0) return t("task.resetsSoon");
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h >= 24) {
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
  }
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}