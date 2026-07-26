import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronLeft, ChevronRight, Plus, Trash2, RefreshCw, Star, Clock, Flame, CheckCircle2, RotateCcw } from "lucide-react";
import {
  THAI_MONTHS, THAI_DAYS_SHORT,
  formatThaiMonthYear,
  getDaysInMonth, getFirstDayOfMonth,
  toDateString, isSameDay, toBuddhistYear
} from "../lib/thaiDate";
import {
  getAllTasks, getTasksForDate,
  deleteTask, createTask, getPriorityTasksForMonth, togglePriority,
  toggleUrgent, markTaskCompleted, unmarkTaskCompleted
} from "../lib/database";
import { t } from "../lib/i18n";
import { bangkokNow } from "../lib/dateUtil";

interface Props {
  onBack?: () => void;
  isVisible?: boolean;
  refreshKey?: number;
  onTaskChanged?: () => void;
}

const CATEGORY_DOT: Record<string, string> = {
  game:     "bg-purple-400",
  school:   "bg-blue-400",
  work:     "bg-orange-400",
  personal: "bg-green-400",
};

const CATEGORY_PILL: Record<string, string> = {
  game:     "text-purple-300 bg-purple-500/15",
  school:   "text-blue-300 bg-blue-500/15",
  work:     "text-orange-300 bg-orange-500/15",
  personal: "text-green-300 bg-green-500/15",
};

const CATEGORY_LEFT: Record<string, string> = {
  game:     "border-l-purple-500",
  school:   "border-l-blue-500",
  work:     "border-l-orange-500",
  personal: "border-l-green-500",
};

/** Format "HH:MM" 24h → "10:00 AM" style. Returns null if no time. */
function fmtTime(t: string | null | undefined): string | null {
  if (!t) return null;
  const parts = t.split(":");
  if (parts.length < 2) return null;
  const h = parseInt(parts[0]);
  const m = parseInt(parts[1]);
  if (isNaN(h) || isNaN(m)) return null;
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

/** Get the display time for any task type, including one_time deadlines stored in event_end */
function getTaskDisplayTime(task: any): string | null {
  // one_time tasks: deadline is stored as ISO datetime in event_end
  if (task.reset_type === "one_time" && task.event_end) {
    try {
      const d = new Date(task.event_end);
      if (!isNaN(d.getTime())) {
        const h = d.getHours();
        const m = d.getMinutes();
        const period = h >= 12 ? "PM" : "AM";
        const h12 = h % 12 === 0 ? 12 : h % 12;
        return `${h12}:${String(m).padStart(2, "0")} ${period}`;
      }
    } catch { /* fall through */ }
  }
  // event_window: show end date/time
  if (task.reset_type === "event_window" && task.event_end) {
    try {
      const d = new Date(task.event_end);
      if (!isNaN(d.getTime())) {
        return `ends ${d.getMonth()+1}/${d.getDate()}`;
      }
    } catch { /* fall through */ }
  }
  // All other types: use reset_time
  return fmtTime(task.reset_time);
}

/**
 * Does this task actually occur on the given date?
 * Fixes the old bug where ALL recurring tasks were counted on EVERY day.
 * - daily: every day
 * - weekly: only on reset_day (0=Sun..6=Sat)
 * - biweekly / custom_days: only days landing on a cycle boundary from anchor_date
 * - specific_date / one_time / event_window: exact date or within window
 */
function taskOccursOnDate(task: any, ds: string, date: Date): boolean {
  switch (task.reset_type) {
    case "daily":
      return true;
    case "weekly":
      return task.reset_day != null && date.getDay() === task.reset_day;
    case "biweekly":
    case "custom_days": {
      if (!task.anchor_date) return false;
      const interval = task.reset_type === "biweekly" ? 14 : (task.reset_interval_days ?? 14);
      const anchor = new Date(task.anchor_date.substring(0, 10) + "T00:00:00");
      const target = new Date(ds + "T00:00:00");
      const diffDays = Math.round((target.getTime() - anchor.getTime()) / (24 * 60 * 60 * 1000));
      return diffDays >= 0 && diffDays % interval === 0;
    }
    case "specific_date":
      return task.specific_date === ds;
    case "one_time":
      return !!task.event_end && task.event_end.substring(0, 10) === ds;
    case "event_window": {
      if (!task.event_end) return false;
      const end = task.event_end.substring(0, 10);
      if (task.event_start) return ds >= task.event_start.substring(0, 10) && ds <= end;
      return ds === end;
    }
    default:
      return false;
  }
}

export default function CalendarView({ onBack, isVisible = true, refreshKey = 0, onTaskChanged }: Props) {
  const [viewDate, setViewDate] = useState(() => { const n = bangkokNow(); return new Date(n.getFullYear(), n.getMonth(), 1); });
  const [selectedDate, setSelectedDate] = useState<Date>(() => bangkokNow());
  const [allTasks, setAllTasks] = useState<any[]>([]);
  const [dayTasks, setDayTasks] = useState<any[]>([]);
  const [monthPriorityTasks, setMonthPriorityTasks] = useState<any[]>([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newTaskName, setNewTaskName] = useState("");
  const [newTaskDesc, setNewTaskDesc] = useState("");
  const [newTaskCategory, setNewTaskCategory] = useState("personal");

  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();

  const loadAll = async () => {
    try {
      const all = await getAllTasks();
      setAllTasks(all);
      const priority = await getPriorityTasksForMonth(year, month);
      setMonthPriorityTasks(priority);
    } catch (e) { console.error(e); }
  };

  const loadDayTasks = async (date: Date) => {
    try {
      const tasks = await getTasksForDate(toDateString(date));
      setDayTasks(tasks);
    } catch (e) { console.error(e); }
  };

  useEffect(() => { loadAll(); }, [year, month, isVisible, refreshKey]);
  useEffect(() => {
    // Always reload — even when not visible — so data is fresh when user switches to Calendar
    loadDayTasks(selectedDate);
  }, [selectedDate, isVisible, refreshKey]);

  const getDateIndicators = (date: Date): string[] => {
    const ds = toDateString(date);
    const cats = new Set<string>();
    for (const t of allTasks) {
      if (taskOccursOnDate(t, ds, date)) cats.add(t.category);
    }
    return Array.from(cats);
  };

  const getTaskCount = (date: Date): number => {
    const ds = toDateString(date);
    return allTasks.filter(t => taskOccursOnDate(t, ds, date)).length;
  };

  const priorityTasksOnDay = (date: Date) =>
    monthPriorityTasks.filter(t => t.specific_date === toDateString(date));

  const handleSelectDate = (date: Date) => {
    setSelectedDate(date);
    setShowAddForm(false);
    setNewTaskName("");
  };

  const handleAddTask = async () => {
    if (!newTaskName.trim()) return;
    try {
      await createTask({
        name: newTaskName,
        description: newTaskDesc,
        category: newTaskCategory,
        reset_type: "specific_date",
        reset_time: null,
        reset_day: null,
        reset_interval_days: null,
        anchor_date: null,
        event_start: null,
        event_end: null,
        specific_date: toDateString(selectedDate),
        is_priority: 0,
      });
      setNewTaskName("");
      setNewTaskDesc("");
      setShowAddForm(false);
      await loadAll();
      await loadDayTasks(selectedDate);
    } catch (e: any) {
      alert("Failed: " + e.message);
    }
  };

  const handleDelete = async (id: number) => {
    await deleteTask(id);
    await loadAll();
    await loadDayTasks(selectedDate);
    onTaskChanged?.();
  };

  const handleTogglePriority = async (id: number, currentPriority: boolean) => {
    await togglePriority(id, !currentPriority);
    await loadAll();
    await loadDayTasks(selectedDate);
    onTaskChanged?.();
  };

  const handleToggleUrgent = async (id: number, currentUrgent: boolean) => {
    await toggleUrgent(id, !currentUrgent);
    await loadAll();
    await loadDayTasks(selectedDate);
    onTaskChanged?.();
  };

  const handleComplete = async (task: any) => {
    const isRecurringType = ["daily","weekly","biweekly","custom_days"].includes(task.reset_type);
    if (isRecurringType) {
      // For recurring: mark until end of today (simple — calendar doesn't have getNextReset)
      const endOfToday = new Date(); endOfToday.setHours(23,59,59,999);
      await markTaskCompleted(task.id, endOfToday.toISOString());
    } else {
      const endOfToday = new Date(); endOfToday.setHours(23,59,59,999);
      await markTaskCompleted(task.id, endOfToday.toISOString());
    }
    await loadDayTasks(selectedDate);
    onTaskChanged?.();
  };

  const handleUndoComplete = async (id: number) => {
    await unmarkTaskCompleted(id);
    await loadDayTasks(selectedDate);
    onTaskChanged?.();
  };

  const prevMonth = () => setViewDate(new Date(year, month - 1, 1));
  const nextMonth = () => setViewDate(new Date(year, month + 1, 1));

  const daysInMonth = getDaysInMonth(year, month);
  const firstDay = getFirstDayOfMonth(year, month);
  const cells: (Date | null)[] = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));

  const todayLocal = bangkokNow();
  const isSelectedToday = toDateString(selectedDate) === toDateString(todayLocal);

  return (
    <div className="flex flex-col h-full w-full">
      {/* ── Header ─────────────────────────────────────── */}
      <div className="flex items-center justify-between mb-4 flex-shrink-0">
        <div className="flex items-center gap-3">
          {onBack && (
            <button
              onClick={onBack}
              className="p-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 transition-all text-white"
            >
              ←
            </button>
          )}
          <h2 className="text-white font-bold text-lg">{t("calendar.title")}</h2>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { const tl = bangkokNow(); setViewDate(new Date(tl.getFullYear(), tl.getMonth(), 1)); setSelectedDate(tl); }}
            className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-white/60 text-xs hover:text-white transition-all"
          >
            {t("calendar.today")}
          </button>
          <button onClick={prevMonth} className="p-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 text-white transition-all">
            <ChevronLeft size={14} />
          </button>
          <span className="text-white font-semibold text-sm min-w-40 text-center">
            {formatThaiMonthYear(viewDate)}
          </span>
          <button onClick={nextMonth} className="p-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 text-white transition-all">
            <ChevronRight size={14} />
          </button>
        </div>
      </div>

      <div className="flex gap-4 flex-1 overflow-hidden">

        {/* ── LEFT: Calendar Grid ──────────────────────── */}
        <div className="flex-1 flex flex-col min-w-0">

          {/* Day headers */}
          <div className="grid grid-cols-7 mb-1">
            {THAI_DAYS_SHORT.map(d => (
              <div key={d} className="text-center text-white/35 text-xs py-1 font-semibold">{d}</div>
            ))}
          </div>

          {/* Day cells */}
          <div className="grid grid-cols-7 gap-1 flex-1 auto-rows-fr">
            {cells.map((date, i) => {
              if (!date) return <div key={`e-${i}`} />;

              const isSelected = isSameDay(date, selectedDate);
              const today = toDateString(date) === toDateString(todayLocal);
              const indicators = getDateIndicators(date);
              const taskCount = getTaskCount(date);
              const priorityOnDay = priorityTasksOnDay(date);

              return (
                <motion.button
                  key={date.toISOString()}
                  whileTap={{ scale: 0.92 }}
                  onClick={() => handleSelectDate(date)}
                  className={`relative rounded-xl flex flex-col items-center justify-start pt-1.5 pb-1 px-0.5 transition-all min-h-[44px] ${
                    isSelected
                      ? "bg-indigo-600 shadow-lg shadow-indigo-500/30"
                      : today
                      ? "bg-white/8 border border-indigo-400/40"
                      : "hover:bg-white/6"
                  }`}
                >
                  {/* task count badge */}
                  {taskCount > 0 && (
                    <div className={`absolute top-1 right-1 w-4 h-4 rounded-full text-[9px] font-bold flex items-center justify-center ${
                      isSelected ? "bg-white/25 text-white" : "bg-indigo-500/70 text-white"
                    }`}>
                      {taskCount > 9 ? "9+" : taskCount}
                    </div>
                  )}

                  {/* Date number */}
                  <span className={`text-sm font-semibold ${
                    isSelected ? "text-white" : today ? "text-indigo-300" : "text-white/75"
                  }`}>
                    {date.getDate()}
                  </span>

                  {/* Priority task chips */}
                  {priorityOnDay.slice(0, 1).map(t => (
                    <span
                      key={t.id}
                      className={`text-[8px] px-1 rounded truncate w-full mt-0.5 leading-tight text-center ${
                        isSelected ? "bg-yellow-400/30 text-yellow-100" : "bg-yellow-500/20 text-yellow-300"
                      }`}
                    >
                      ⭐
                    </span>
                  ))}

                  {/* Category dots */}
                  {priorityOnDay.length === 0 && indicators.length > 0 && (
                    <div className="flex gap-0.5 mt-1 flex-wrap justify-center">
                      {indicators.slice(0, 3).map(cat => (
                        <div
                          key={cat}
                          className={`w-1.5 h-1.5 rounded-full ${isSelected ? "bg-white/60" : CATEGORY_DOT[cat] || "bg-white/40"}`}
                        />
                      ))}
                    </div>
                  )}
                </motion.button>
              );
            })}
          </div>

          {/* Legend */}
          <div className="flex gap-4 mt-3 pt-2 border-t border-white/8 flex-wrap">
            {Object.entries(CATEGORY_DOT).map(([cat, color]) => (
              <div key={cat} className="flex items-center gap-1.5">
                <div className={`w-2 h-2 rounded-full ${color}`} />
                <span className="text-white/35 text-xs">{t(`cat.${cat as "game"|"school"|"work"|"personal"}`)}</span>
              </div>
            ))}
            <div className="flex items-center gap-1.5">
              <span className="text-yellow-400 text-xs">⭐</span>
              <span className="text-white/35 text-xs">{t("calendar.important")}</span>
            </div>
          </div>
        </div>

        {/* ── RIGHT: Day detail panel ──────────────────── */}
        <div className="w-60 flex flex-col border-l border-white/8 pl-4 min-w-0">

          {/* Panel header */}
          <div className="flex items-center justify-between mb-3 flex-shrink-0">
            <div>
              <p className="text-white font-bold text-sm leading-tight">
                {selectedDate.getDate()} {THAI_MONTHS[selectedDate.getMonth()]}
                {isSelectedToday && (
                  <span className="ml-2 text-xs text-indigo-400 font-normal">{t("calendar.today")}</span>
                )}
              </p>
              <p className="text-white/30 text-xs">พ.ศ. {toBuddhistYear(selectedDate)}</p>
            </div>
            <button
              onClick={() => setShowAddForm(!showAddForm)}
              className={`w-7 h-7 rounded-lg border transition-all flex items-center justify-center ${
                showAddForm
                  ? "bg-indigo-600 border-indigo-500 text-white"
                  : "bg-indigo-600/20 border-indigo-500/30 hover:bg-indigo-600/40 text-indigo-300"
              }`}
            >
              <Plus size={13} />
            </button>
          </div>

          {/* Inline add form */}
          <AnimatePresence>
            {showAddForm && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="mb-3 space-y-1.5 overflow-hidden flex-shrink-0"
              >
                <input
                  autoFocus
                  value={newTaskName}
                  onChange={e => setNewTaskName(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && handleAddTask()}
                  placeholder={t("calendar.taskNamePH")}
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-2.5 py-1.5 text-white placeholder-white/25 text-xs focus:outline-none focus:border-indigo-500"
                />
                <input
                  value={newTaskDesc}
                  onChange={e => setNewTaskDesc(e.target.value)}
                  placeholder={t("calendar.notesPH")}
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-2.5 py-1.5 text-white placeholder-white/25 text-xs focus:outline-none focus:border-indigo-500"
                />
                <select
                  value={newTaskCategory}
                  onChange={e => setNewTaskCategory(e.target.value)}
                  className="w-full bg-gray-800 border border-white/10 rounded-lg px-2.5 py-1.5 text-white text-xs focus:outline-none focus:border-indigo-500"
                >
                  <option value="game">{t("catOpt.game")}</option>
                  <option value="school">{t("catOpt.school")}</option>
                  <option value="work">{t("catOpt.work")}</option>
                  <option value="personal">{t("catOpt.personal")}</option>
                </select>
                <div className="flex gap-1.5">
                  <button
                    onClick={handleAddTask}
                    className="flex-1 py-1.5 bg-indigo-600 rounded-lg text-white text-xs font-semibold hover:bg-indigo-700 transition-all"
                  >
                    {t("calendar.add")}
                  </button>
                  <button
                    onClick={() => setShowAddForm(false)}
                    className="flex-1 py-1.5 bg-white/5 rounded-lg text-white/40 text-xs hover:text-white transition-all"
                  >
                    {t("calendar.cancel")}
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>


          {/* Task list */}
          <div className="flex-1 overflow-y-auto space-y-2 pr-0.5">
            {dayTasks.length === 0 ? (
              <div className="text-center py-8">
                <div className="text-2xl mb-2">📅</div>
                <p className="text-white/20 text-xs">{t("calendar.noTasks")}</p>
                <p className="text-white/12 text-xs mt-0.5">{t("calendar.noTasksSub")}</p>
              </div>
            ) : (
              <AnimatePresence>
                {dayTasks.map(task => {
                  const timeStr = getTaskDisplayTime(task);
                  const isPriority = Boolean(task.is_priority);
                  const isUrgent = Boolean(task.is_urgent);
                  const isCompleted = task.completed_until && new Date(task.completed_until) > new Date();
                  const isRecurring = ["daily","weekly","biweekly","custom_days"].includes(task.reset_type);
                  const isDeletable = !isRecurring;

                  return (
                    <motion.div
                      key={task.id}
                      layout
                      initial={{ opacity: 0, x: 8 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -8, height: 0 }}
                      className={`group relative border-l-2 rounded-r-xl rounded-bl-lg overflow-hidden transition-all ${
                        CATEGORY_LEFT[task.category] || "border-l-white/20"
                      } ${
                        isCompleted ? "bg-green-500/5 border border-green-500/15 opacity-60" :
                        isUrgent    ? "bg-red-500/5 border border-red-500/20" :
                        isPriority  ? "bg-yellow-500/5 border border-yellow-500/15" :
                                      "bg-white/5 border border-white/8"
                      }`}
                    >
                      <div className="p-2.5">
                        {/* Top: name + action buttons */}
                        <div className="flex items-start justify-between gap-1.5">
                          <div className="flex-1 min-w-0">
                            {/* Task name */}
                            <p className={`text-xs font-semibold leading-tight truncate ${
                              isCompleted ? "text-white/40 line-through" : isPriority ? "text-white" : "text-white/90"
                            }`}>
                              {isCompleted && <span className="text-green-400 mr-1">✓</span>}
                              {!isCompleted && isPriority && <span className="text-yellow-400 mr-1">⭐</span>}
                              {!isCompleted && isUrgent && <span className="text-red-400 mr-1">🔥</span>}
                              {task.name}
                            </p>

                            {/* Description */}
                            {task.description && (
                              <p className="text-white/35 text-xs mt-0.5 truncate">{task.description}</p>
                            )}
                          </div>

                          {/* ── Action buttons ── */}
                          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all duration-150 flex-shrink-0">
                            {/* Done / Undo */}
                            {isCompleted ? (
                              <button
                                onClick={() => handleUndoComplete(task.id)}
                                title={t("calendar.undoDone")}
                                className="flex items-center justify-center w-6 h-6 rounded-lg bg-green-500/20 text-green-400 hover:bg-green-500/30 transition-all"
                              >
                                <RotateCcw size={11} />
                              </button>
                            ) : (
                              <button
                                onClick={() => handleComplete(task)}
                                title={t("calendar.markDone")}
                                className="flex items-center justify-center w-6 h-6 rounded-lg bg-white/8 text-white/30 hover:bg-green-500/20 hover:text-green-400 transition-all"
                              >
                                <CheckCircle2 size={11} />
                              </button>
                            )}

                            {/* Urgent toggle */}
                            <button
                              onClick={() => handleToggleUrgent(task.id, isUrgent)}
                              title={isUrgent ? t("calendar.unmarkCrit") : t("calendar.markCrit")}
                              className={`flex items-center justify-center w-6 h-6 rounded-lg transition-all ${
                                isUrgent
                                  ? "bg-red-500/20 text-red-400 hover:bg-red-500/30"
                                  : "bg-white/8 text-white/30 hover:bg-red-500/20 hover:text-red-400"
                              }`}
                            >
                              <Flame size={11} fill={isUrgent ? "currentColor" : "none"} />
                            </button>

                            {/* Priority toggle */}
                            <button
                              onClick={() => handleTogglePriority(task.id, isPriority)}
                              title={isPriority ? t("calendar.unmarkImp") : t("calendar.markImp")}
                              className={`flex items-center justify-center w-6 h-6 rounded-lg transition-all ${
                                isPriority
                                  ? "bg-yellow-500/25 text-yellow-400 hover:bg-yellow-500/40"
                                  : "bg-white/8 text-white/30 hover:bg-yellow-500/20 hover:text-yellow-400"
                              }`}
                            >
                              <Star size={11} fill={isPriority ? "currentColor" : "none"} />
                            </button>

                            {/* Delete — only for non-recurring tasks */}
                            {isDeletable && (
                              <button
                                onClick={() => handleDelete(task.id)}
                                title={t("calendar.delete")}
                                className="flex items-center justify-center w-6 h-6 rounded-lg bg-white/8 text-white/30 hover:bg-red-500/25 hover:text-red-400 transition-all"
                              >
                                <Trash2 size={11} />
                              </button>
                            )}
                          </div>
                        </div>

                        {/* Bottom: category pill + time badge */}
                        <div className="flex items-center justify-between gap-1.5 mt-1.5">
                          <div className="flex items-center gap-1.5 min-w-0">
                            {/* Category dot + label */}
                            <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full font-medium ${CATEGORY_PILL[task.category] || "text-white/40 bg-white/8"}`}>
                              <div className={`w-1 h-1 rounded-full ${CATEGORY_DOT[task.category] || "bg-white/40"}`} />
                              {task.category}
                            </span>

                            {/* Recurring badge */}
                            {isRecurring && (
                              <span className="inline-flex items-center gap-0.5 text-[10px] text-white/25">
                                <RefreshCw size={8} />
                                {task.reset_type === "daily" ? t("type.daily") :
                                 task.reset_type === "weekly" ? t("type.weekly") :
                                 task.reset_type === "biweekly" ? t("type.biweekly") :
                                 task.reset_type === "custom_days" ? t("type.custom_days") :
                                 task.reset_type.replace("_", " ")}
                              </span>
                            )}
                          </div>

                          {/* Reset time — formatted properly */}
                          {timeStr && (
                            <span className="flex items-center gap-0.5 text-[10px] text-white/35 flex-shrink-0">
                              <Clock size={9} />
                              {timeStr}
                            </span>
                          )}
                        </div>
                      </div>
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}