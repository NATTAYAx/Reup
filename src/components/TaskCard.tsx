import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Trash2, Star, Flame, CheckCircle2, RotateCcw, Edit3, Pin, PauseCircle } from "lucide-react";
import { CountdownResult, isRecurring, isOneShot } from "../types";
import { formatCountdown, getCategoryColor, getUrgencyColor } from "../lib/countdown";
import { getNextReset } from "../lib/countdown";
import { markTaskCompleted, unmarkTaskCompleted, updateTask } from "../lib/database";
import { t } from "../lib/i18n";
import { getAppTimeZone } from "../lib/tz";
import { declineEase, isEased, needsMinStep } from "../lib/cycles";

interface Props {
  result: CountdownResult;
  onDelete: (id: number) => void;
  onTogglePriority: (id: number, current: boolean) => void;
  onToggleUrgent: (id: number, current: boolean) => void;
  onRefresh: () => void;
  onEdit?: (id: number) => void;
  /** Set the task aside. Absent on surfaces where pausing makes no sense. */
  onPause?: (id: number) => void;
  /** On a low-power day the card shows the smallest version of the task
   *  instead of the whole thing, and drops the decoration around it. */
  lowPower?: boolean;
}

/** HH:MM in whatever zone the app is set to, which is what the countdown uses. */
function fmtClock(d: Date): string {
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: getAppTimeZone(),
  });
}

export default function TaskCard({ result, onDelete, onTogglePriority, onToggleUrgent, onRefresh, onEdit, onPause, lowPower = false }: Props) {
  // No interactive delay needed — the sort stability fix in useCountdowns ensures
  // TaskCards don't continuously remount each second, so phantom clicks cannot occur.
  const { task, urgency, is_completed_this_cycle } = result;
  const countdown = formatCountdown(result);
  const isPriority = Boolean(task.is_priority);
  const isUrgent = Boolean(task.is_urgent);
  const recurring = isRecurring(task);
  // Two missed cycles in a row and the task has a smallest version written
  // down. Nothing about this is announced; the ask just gets smaller.
  const eased = isEased(task);
  const oneShot = isOneShot(task);

  // When leaving early is part of the plan, the card says both times and puts
  // the one that has to be acted on first. The countdown above is already
  // counting to that one — see calculateCountdown — and this line is what keeps
  // the appointment from disappearing behind it.
  const leaveBy = result.leave_by;

  // The offer to make the ask smaller. `asked` is local so that pressing either
  // button takes it off the screen now rather than after the next refresh — the
  // one moment where a card lingering half a second reads as the app arguing.
  const [asked, setAsked] = useState(false);
  const [step, setStep] = useState("");
  const offerEase = !lowPower && !asked && needsMinStep(task);

  const saveStep = async () => {
    const value = step.trim();
    if (!value) return;
    setAsked(true);
    await updateTask(task.id, { min_step: value });
    onRefresh();
  };

  const dismissStep = () => {
    setAsked(true);
    declineEase(task);
  };

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
            {/* Two ways the smallest version REPLACES the description and notes
                rather than joining them. On a low-power day, because the point
                of the day is fewer things to read. And after two missed cycles
                in a row, because at that point the full version is not what to
                ask for — see lib/cycles. Both look identical on purpose: there
                is no marker anywhere saying which one you are looking at, and
                nothing counts or displays the misses. */}
            {(lowPower || eased) && task.min_step ? (
              <p className="text-amber-200/70 text-xs mt-0.5 truncate">
                → {task.min_step}
              </p>
            ) : (
              <>
                {task.description ? (
                  <p className="text-white/40 text-xs mt-0.5 truncate">{task.description}</p>
                ) : null}
                {(task as any).notes ? (
                  <p className="text-white/25 text-xs mt-0.5 truncate italic">📝 {(task as any).notes}</p>
                ) : null}
                {task.min_step ? (
                  <p className="text-white/30 text-xs mt-0.5 truncate">→ {task.min_step}</p>
                ) : null}
              </>
            )}

            {/* The ask, made smaller. Written as a question about the task and
                never about the person's record with it: nothing here counts
                anything, and the word "missed" does not appear. Declining is a
                real answer and is remembered — see lib/cycles. */}
            {leaveBy ? (
              <p className="text-sky-200/70 text-xs mt-0.5">
                {t("lead.leaveAt")} {fmtClock(leaveBy)}
                <span className="text-white/25"> · {t("lead.forAppt")} {fmtClock(result.next_reset)}</span>
              </p>
            ) : null}

            {offerEase ? (
              <div className="mt-2 rounded-lg border border-amber-300/20 bg-amber-300/5 p-2">
                <p className="text-amber-200/70 text-[11px] leading-relaxed">{t("ease.ask")}</p>
                <div className="flex gap-1.5 mt-1.5">
                  <input
                    value={step}
                    onChange={e => setStep(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") saveStep(); }}
                    placeholder={t("ease.placeholder")}
                    className="flex-1 min-w-0 bg-black/20 border border-white/10 rounded-md px-2 py-1 text-xs text-white/80 placeholder:text-white/25 outline-none focus:border-amber-300/40"
                  />
                  <button
                    onClick={saveStep}
                    disabled={!step.trim()}
                    className="px-2 py-1 rounded-md text-[11px] font-semibold bg-amber-400/20 text-amber-100 disabled:opacity-40"
                  >
                    {t("ease.save")}
                  </button>
                </div>
                <button
                  onClick={dismissStep}
                  className="text-white/25 text-[10px] mt-1.5 hover:text-white/40"
                >
                  {t("ease.never")}
                </button>
              </div>
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
            {/* Sits immediately before delete on purpose. The moment someone
                reaches for the bin because a task will not stop asking is the
                moment the gentler answer needs to already be under the cursor. */}
            {onPause && (
              <button
                onClick={e => { e.stopPropagation(); if (e.isTrusted) onPause(task.id); }}
                className="p-1.5 rounded-lg text-white/20 hover:text-sky-300 bg-white/5 transition-all"
                title={t("task.pause")}
              >
                <PauseCircle size={13} />
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

          {/* Only when the pin has actually parted company with the app's zone.
              While they agree there is nothing to say, so nothing is drawn. */}
          {task.time_zone && task.time_zone !== getAppTimeZone() && (
            <span className="flex items-center gap-1 text-[10px] bg-amber-500/15 text-amber-200/80 border border-amber-500/30 px-2 py-0.5 rounded-full">
              <Pin size={9} />
              {(task.time_zone.split("/").pop() ?? task.time_zone).replace(/_/g, " ")}
            </span>
          )}

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