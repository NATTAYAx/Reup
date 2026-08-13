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
  getCalendarTasks, getTasksForDate,
  deleteTask, createTask, togglePriority,
  toggleUrgent, markTaskCompleted, unmarkTaskCompleted
} from "../lib/database";
import { t } from "../lib/i18n";
import { localNow } from "../lib/dateUtil";
import { formatClock, formatClockStr } from "../lib/clock";

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

/** Follows the app language: 24-hour under Thai, AM/PM under English. */
const fmtTime = formatClockStr;

/** Get the display time for any task type, including one_time deadlines stored in event_end */
function getTaskDisplayTime(task: any): string | null {
  // one_time tasks: deadline is stored as ISO datetime in event_end
  if (task.reset_type === "one_time" && task.event_end) {
    try {
      const d = new Date(task.event_end);
      if (!isNaN(d.getTime())) {
        return formatClock(d.getHours(), d.getMinutes());
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
  const [viewDate, setViewDate] = useState(() => { const n = localNow(); return new Date(n.getFullYear(), n.getMonth(), 1); });
  const [selectedDate, setSelectedDate] = useState<Date>(() => localNow());
  const [allTasks, setAllTasks] = useState<any[]>([]);
  const [dayTasks, setDayTasks] = useState<any[]>([]);
  // Daily tasks occur in EVERY cell, so naming them there fills the month with
  // the same two lines thirty-one times and buries the one meeting that
  // actually needed looking up. Calendar apps solve this by separating the two
  // kinds of thing: Google keeps repeating chores in Tasks rather than as
  // events, habit trackers use a streak grid instead of a calendar. The rule
  // here is the same idea drawn along frequency —
  //
  //   daily            summarised once above the grid; it is true of every day,
  //                    so repeating it per day carries no information
  //   weekly and up    named in cells; four or five marks a month still tells
  //                    you which day is which, which is the point of a calendar
  //   one-off, dated   always named; this is what a calendar is for
  //
  // Kept as a toggle rather than a decision, because someone whose whole day is
  // dailies may genuinely want to see them.
  const [showDaily, setShowDaily] = useState(
    () => localStorage.getItem("gamesched_cal_show_daily") === "1",
  );
  const toggleShowDaily = () => {
    setShowDaily(v => {
      localStorage.setItem("gamesched_cal_show_daily", v ? "0" : "1");
      return !v;
    });
  };

  const [showAddForm, setShowAddForm] = useState(false);
  const [addError, setAddError] = useState("");
  const [newTaskName, setNewTaskName] = useState("");
  const [newTaskCategory, setNewTaskCategory] = useState("personal");

  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();

  const loadAll = async () => {
    try {
      const all = await getCalendarTasks();
      setAllTasks(all);
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

  // The cells used to show a count and some coloured dots, which answered
  // "is something on" but never "what". Answering the second question means
  // the cell needs the tasks themselves, so this returns them, important ones
  // first — those are the ones worth the two lines a cell can spare.
  const tasksOnDate = (date: Date): any[] => {
    const ds = toDateString(date);
    return allTasks
      .filter(tk => taskOccursOnDate(tk, ds, date))
      .filter(tk => showDaily || tk.reset_type !== "daily")
      .sort((a, b) => (b.is_priority ?? 0) - (a.is_priority ?? 0));
  };

  /** The ones lifted out of the grid, listed once instead of thirty-one times. */
  const dailyTasks = allTasks.filter(tk => tk.reset_type === "daily");

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
        description: "",
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
      setShowAddForm(false);
      await loadAll();
      await loadDayTasks(selectedDate);
    } catch (e: any) {
      // Was a native alert: an OS dialog with the system error chime for a
      // failed insert on a calendar page. Shown in place instead.
      setAddError(e?.message || String(e));
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
  // ALWAYS six week-rows, 42 cells, whatever the month.
  //
  // Only leading blanks were being added, so the grid ran to whatever length
  // the month happened to need: February starting on a Sunday fills four rows,
  // a 31-day month starting on a Saturday needs six. Two things went wrong with
  // that. The last row was ragged, ending mid-week with nothing after it. And
  // because the rows share the height with auto-rows-fr, a four-row month drew
  // noticeably taller cells than a six-row one, so the whole calendar changed
  // shape when paging between months.
  //
  // Six is the maximum any month can need, so padding to it fixes both: every
  // row is complete and every cell is the same square in every month. This is
  // what Apple Calendar does, and why paging through it never moves anything.
  const WEEKS = 6;
  const cells: (Date | null)[] = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));
  while (cells.length < WEEKS * 7) cells.push(null);

  const todayLocal = localNow();
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
            onClick={() => { const tl = localNow(); setViewDate(new Date(tl.getFullYear(), tl.getMonth(), 1)); setSelectedDate(tl); }}
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

          {/* What repeats every day, said once. */}

          {dailyTasks.length > 0 && (

            <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">

              <span className="text-white/35 text-[10px] shrink-0">{t("calendar.everyDay")}</span>

              {dailyTasks.map(tk => (

                <span key={tk.id}

                  className="flex items-center gap-1 rounded-full bg-white/6 px-2 py-0.5 max-w-[150px]">

                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${CATEGORY_DOT[tk.category] || "bg-white/40"}`} />

                  <span className="text-white/60 text-[10px] truncate">{tk.name}</span>

                  {tk.reset_time && <span className="text-white/30 text-[9px] shrink-0">{tk.reset_time}</span>}

                </span>

              ))}

              <button onClick={toggleShowDaily}

                className="text-white/30 hover:text-white text-[10px] ml-auto shrink-0">

                {showDaily ? t("calendar.hideDaily") : t("calendar.showDaily")}

              </button>

            </div>

          )}



          {/* Day headers */}
          <div className="grid grid-cols-7 mb-1">
            {THAI_DAYS_SHORT.map(d => (
              <div key={d} className="text-center text-white/35 text-xs py-1 font-semibold">{d}</div>
            ))}
          </div>

          {/* Day cells.
              Two named rows per cell and a "+n" for the rest. Two is not
              arbitrary: six week-rows have to fit a 590px window, which leaves
              about 68px per cell, and two lines of 9px text plus the date
              number is exactly what that holds. A third line would push the
              last week of the month off the bottom. */}
          {/* Ruled like a table, because that is what it is. With only a 4px
              gap between cells an EMPTY cell had no edges at all, so the run of
              blanks before the 1st simply vanished and there was nothing to
              trace a weekday column down. Every real calendar rules its grid
              for this reason. The lines are 8% white: enough to follow, not
              enough to compete with the entries inside them.

              Each cell draws its own right and bottom edge and the container
              draws the left and top, so no line is ever painted twice. */}
          <div className="grid grid-cols-7 flex-1 auto-rows-fr min-h-0 rounded-lg overflow-hidden border-l border-t border-white/8">
            {cells.map((date, i) => {
              // Days outside the month still get their edges, so the shape of
              // the month reads correctly.
              if (!date) return <div key={`e-${i}`} className="border-r border-b border-white/8" />;

              const isSelected = isSameDay(date, selectedDate);
              const today = toDateString(date) === toDateString(todayLocal);
              const dayTasksHere = tasksOnDate(date);
              const shown = dayTasksHere.slice(0, 2);
              const extra = dayTasksHere.length - shown.length;

              return (
                <button
                  key={date.toISOString()}
                  onClick={() => handleSelectDate(date)}
                  // Selection is a fill and an inset ring rather than a border,
                  // so it never fights the grid lines for the same pixels.
                  className={`relative flex flex-col items-stretch px-1 pt-1 pb-0.5 text-left transition-colors overflow-hidden border-r border-b border-white/8 ${
                    isSelected
                      ? "bg-indigo-500/25 ring-1 ring-inset ring-indigo-400"
                      : today
                      ? "bg-white/6"
                      : "hover:bg-white/5"
                  }`}
                >
                  <span className={`text-[11px] font-semibold leading-none mb-0.5 ${
                    today ? "text-indigo-300" : isSelected ? "text-white" : "text-white/60"
                  }`}>
                    {date.getDate()}
                  </span>

                  <div className="flex flex-col gap-[2px] min-h-0">
                    {shown.map(tk => (
                      <span key={tk.id}
                        title={tk.name}
                        className="flex items-center gap-1 rounded-[3px] px-1 py-[1px] bg-white/8 min-w-0">
                        <span className={`w-1 h-1 rounded-full shrink-0 ${CATEGORY_DOT[tk.category] || "bg-white/40"}`} />
                        <span className={`text-[9px] leading-tight truncate ${
                          tk.is_priority ? "text-yellow-200" : "text-white/70"
                        }`}>
                          {tk.name}
                        </span>
                      </span>
                    ))}
                    {extra > 0 && (
                      <span className="text-white/35 text-[9px] leading-tight pl-1">+{extra}</span>
                    )}
                  </div>
                </button>
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
                {/* Was: a name field, a notes field, and a native <select>
                    for the category. The select is drawn by the operating
                    system, so it arrived white and blue in the middle of a dark
                    app, and the notes field asked for something almost nobody
                    fills in when jotting a date down. Adding to a day should be
                    the same two actions as adding an expense: type it, tap what
                    kind, done. Everything else is editable afterwards. */}
                <input
                  autoFocus
                  value={newTaskName}
                  onChange={e => { setNewTaskName(e.target.value); if (addError) setAddError(""); }}
                  onKeyDown={e => e.key === "Enter" && handleAddTask()}
                  placeholder={t("calendar.taskNamePH")}
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-2.5 py-2 text-white placeholder-white/25 text-xs focus:outline-none focus:border-indigo-500"
                />

                <div className="flex flex-wrap gap-1">
                  {(["game", "school", "work", "personal"] as const).map(c => (
                    <button key={c} type="button" onClick={() => setNewTaskCategory(c)}
                      className={`text-[11px] rounded-full px-2.5 py-1 border transition-colors flex items-center gap-1.5 ${
                        newTaskCategory === c
                          ? "border-indigo-400 bg-indigo-500/20 text-white"
                          : "border-white/10 text-white/45 hover:text-white"
                      }`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${CATEGORY_DOT[c]}`} />
                      {t(`catOpt.${c}`)}
                    </button>
                  ))}
                </div>

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