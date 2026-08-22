import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Plus, Settings, Gamepad2, Clock, CalendarDays, CheckCircle2, Brain, Wallet, BatteryLow, Archive } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { useCountdowns } from "./hooks/useCountdowns";
import { onDataChanged } from "./lib/dataChanged";
import { runAutoBackupIfDue } from "./lib/autoBackup";
import { startAutoSync } from "./lib/autoSync";
import { loadTheme, applyTheme } from "./lib/theme";
import { deleteTask, togglePriority, toggleUrgent, getSetting, pauseTask } from "./lib/database";
import { PAUSE_FOREVER } from "./types";
import { installWindowActive, useWindowActive } from "./lib/windowActive";
import TaskCard from "./components/TaskCard";
import AddTaskModal from "./components/AddTaskModal";
import SettingsModal from "./components/SettingsModal";
import { t, getLang } from "./lib/i18n";
import CalendarView from "./components/CalendarView";
import FinanceView from "./components/FinanceView";
import EditTaskModal from "./components/EditTaskModal";
import UnifiedAIChat from "./components/UnifiedAIChat";
import TaskShelf from "./components/TaskShelf";
// import DebugOverlay from "./components/DebugOverlay"; // debug tool, re-enable if needed
import { localHour, personalToday } from "./lib/dateUtil";
import { getAppTimeZone } from "./lib/tz";
import { shouldShowWeekNote, markWeekNoteShown } from "./lib/weekNote";
import { listen } from "@tauri-apps/api/event";

type Filter = "all" | "priority" | "urgent" | "done" | "game" | "school" | "work" | "personal";

/**
 * Keeps a heavy child unmounted until the first time it is actually needed,
 * then keeps it mounted for the rest of the session so its state survives.
 * Deliberately NOT React.lazy: dynamic import() has hung in production builds
 * on this project before, and this gets most of the startup win with none of
 * that risk.
 */
function useMountOnce(active: boolean): boolean {
  const [seen, setSeen] = useState(active);
  useEffect(() => { if (active) setSeen(true); }, [active]);
  return seen || active;
}

export default function App() {
  const { countdowns, loading, refreshTasks } = useCountdowns();

  useEffect(() => {
    applyTheme(loadTheme());
    getCurrentWindow().show().catch(() => {});

    // Restore the live wallpaper if it was on when the app last closed.
    // This was disabled while the wallpaper window lived in this process and
    // froze the event loop at launch. It now runs in its own process
    // (see src-tauri/src/wallpaper.rs), so starting it here is safe.
    (async () => {
      try {
        const [enabled, path] = await Promise.all([
          getSetting("wallpaper_enabled"),
          getSetting("wallpaper_path"),
        ]);
        if (enabled === "1" && path) {
          await invoke("start_wallpaper", { path });
        }
      } catch (e) {
        console.error("wallpaper auto-restore failed:", e);
      }
    })();

    // Restore custom tray icon from localStorage on every startup.
    // The Rust tray always starts with the default icon — we must re-send
    // the custom one each launch so it persists across restarts.
    const savedIcon = localStorage.getItem("gamesched_icon_v1");
    if (savedIcon) {
      const img = new window.Image();
      img.onload = () => {
        const SIZE = 32;
        const canvas = document.createElement("canvas");
        canvas.width = SIZE; canvas.height = SIZE;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(img, 0, 0, SIZE, SIZE);
        const rgba = Array.from(ctx.getImageData(0, 0, SIZE, SIZE).data);
        invoke("set_tray_icon", { rgba, width: SIZE, height: SIZE }).catch(() => {});
      };
      img.src = savedIcon;
    }
  }, []);

  const [addOpen, setAddOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [view, setView] = useState<"tasks" | "calendar" | "finance">("tasks");
  const [editTaskId, setEditTaskId] = useState<number | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [calendarKey, setCalendarKey] = useState(0);
  const [financeKey, setFinanceKey] = useState(0);

  // A switch the PERSON flips, never the app. An app guessing at someone's
  // capacity gets it wrong in both directions: it nags on a fine day and
  // consoles on a busy one, and neither is its business. On the days it is on,
  // every task shows only its smallest version and the counters go away.
  // One sentence, at most once a week, and only when a whole week of answered
  // tasks contained nothing wanted. Computed once when the list changes rather
  // than on the countdown tick — it reads the calendar, not the clock.
  // Shown once, ever, the first time the close button turns out not to close
  // anything. Set while the window is already hidden, so it is sitting there
  // when it comes back.
  const [shelfOpen, setShelfOpen] = useState(false);
  // Stops every looping animation while the window is not in front. See
  // lib/windowActive — this is the thing that was holding the GPU at 80%.
  useEffect(() => { installWindowActive(); }, []);
  const windowActive = useWindowActive();
  const [trayHint, setTrayHint] = useState(false);
  useEffect(() => {
    const un = listen("closed-to-tray", () => {
      if (localStorage.getItem("gamesched_tray_hint_seen")) return;
      localStorage.setItem("gamesched_tray_hint_seen", "1");
      setTrayHint(true);
    });
    return () => { un.then(f => f()); };
  }, []);

  const [weekNote, setWeekNote] = useState(false);
  useEffect(() => {
    if (loading) return;
    setWeekNote(shouldShowWeekNote(countdowns.map(c => c.task)));
  }, [loading, countdowns.length]);

  const [lowPower, setLowPower] = useState(
    () => localStorage.getItem("gamesched_low_power_date") === personalToday(),
  );
  const toggleLowPower = () => {
    setLowPower(v => {
      // Stored as a DATE, so it clears itself overnight. Nobody should have to
      // remember to turn it off, and it should never quietly persist for weeks.
      if (v) localStorage.removeItem("gamesched_low_power_date");
      else localStorage.setItem("gamesched_low_power_date", personalToday());
      return !v;
    });
  };

  // Nothing below is built until it is opened for the first time.
  const mountCalendar = useMountOnce(view === "calendar");
  const mountFinance  = useMountOnce(view === "finance");
  const mountAdd      = useMountOnce(addOpen);
  const mountSettings = useMountOnce(settingsOpen);
  const mountEdit     = useMountOnce(editTaskId !== null);
  const mountAi       = useMountOnce(aiOpen);

  const refreshAll = useCallback(() => {
    refreshTasks();
    setCalendarKey(k => k + 1);
    setFinanceKey(k => k + 1);
  }, [refreshTasks]);

  // Started once, for the life of the window. Nothing is passed in and nothing
  // comes back: it announces what it wrote through dataChanged like any other
  // sync, so the effect below is what makes the screen follow.
  useEffect(() => startAutoSync(), []);

  // A backup nobody has to remember, once a week, into the app's own folder.
  //
  // Started here rather than in the settings card, because the card is a place
  // somebody has to go and this is a thing that has to happen whether or not
  // they ever go there. It reads and writes nothing the screen shows, reports
  // nothing, and skips itself on every run but one in seven — see lib/autoBackup.
  useEffect(() => { void runAutoBackupIfDue(); }, []);

  // ── rows that arrived without anyone pressing anything ────────────────────
  //
  // Sync writes straight into SQLite. Every other write in this file is started
  // by a handler that refreshes on its way out; a task ticked done on the phone
  // has no handler, so without this the list stays as it was and the only way
  // to see the truth is to reload the window — which tears down the webview,
  // reopens the database and restarts the notify loop to show one changed row.
  //
  // Only what actually moved is redrawn. A sync carrying one budget should not
  // make every countdown reload and re-run its cycle reconciliation.
  useEffect(() => onDataChanged((tables) => {
    if (tables.has("tasks")) refreshTasks();
    if (tables.has("expenses") || tables.has("income") || tables.has("budgets") ||
        tables.has("saving_goals") || tables.has("expected_income") ||
        tables.has("expense_categories")) {
      setFinanceKey(k => k + 1);
    }
    // The calendar reads tasks and expenses both, so it follows either.
    if (tables.size > 0) setCalendarKey(k => k + 1);
  }), [refreshTasks]);

  const handleDelete = useCallback(async (id: number) => {
    try { await deleteTask(id); } catch (e) { console.error("deleteTask failed:", e); }
    refreshTasks();
  }, [refreshTasks]);

  // No end date by default. Asking "until when" is asking someone to predict
  // when they will have the energy for a thing they just decided they do not
  // have the energy for, and a wrong answer means it comes back too early. It
  // is one click to bring back, which is the cheaper direction to be wrong in.
  const handlePause = useCallback(async (id: number) => {
    try { await pauseTask(id, PAUSE_FOREVER); } catch (e) { console.error("pauseTask failed:", e); }
    refreshTasks();
  }, [refreshTasks]);

  const handleTogglePriority = useCallback(async (id: number, current: boolean) => {
    try { await togglePriority(id, !current); } catch (e) { console.error("togglePriority failed:", e); }
    refreshTasks();
  }, [refreshTasks]);

  const handleToggleUrgent = useCallback(async (id: number, current: boolean) => {
    try { await toggleUrgent(id, !current); } catch (e) { console.error("toggleUrgent failed:", e); }
    refreshTasks();
  }, [refreshTasks]);

  const countdownsRef = useRef<typeof countdowns>([]);
  countdownsRef.current = countdowns;

  const [editTask, setEditTask] = useState<any | null>(null);
  // CRITICAL: handleEdit must NOT depend on countdowns state — countdowns changes
  // every second (tick), so if handleEdit is in useCallback([countdowns]) it gets
  // a new function reference every second → TaskCard re-renders every second →
  // click events can miss their handler during the re-render frame.
  // Fix: read from a ref instead, so handleEdit is stable (created once).
  const handleEdit = useCallback((id: number) => {
    const found = countdownsRef.current.find(r => Number(r.task.id) === Number(id));
    setEditTask(found?.task ?? null);
    setEditTaskId(id);
  }, []); // stable — no deps needed, reads from ref

  // Memoize filtered — avoids creating a new array on every render (tick fires every second)
  const filtered = useMemo(() => {
    if (filter === "all") return countdowns;
    if (filter === "priority") return countdowns.filter(c => c.task.is_priority);
    if (filter === "urgent") return countdowns.filter(c => c.task.is_urgent);
    if (filter === "done") return countdowns.filter(c => c.is_completed_this_cycle);
    return countdowns.filter(c => c.task.category === filter);
  }, [countdowns, filter]);

  const hr = localHour();
  // hr < 12 meant 01:54 greeted you with "good morning". Anyone awake at that
  // hour knows it is not morning, and for this app in particular the small
  // hours are prime time — game resets land at 04:00.
  const greeting =
    hr < 5  ? t("greeting.night")
    : hr < 12 ? t("greeting.morning")
    : hr < 18 ? t("greeting.afternoon")
    : t("greeting.evening");

  const priorityCount = countdowns.filter(c => c.task.is_priority).length;
  const urgentCount = countdowns.filter(c => c.task.is_urgent).length;
  const doneCount = countdowns.filter(c => c.is_completed_this_cycle).length;
  const pendingCount = countdowns.filter(c => !c.is_completed_this_cycle).length;

  return (
    <div className="w-screen h-screen text-white overflow-hidden rounded-2xl border flex flex-col" style={{ background: "var(--color-bg)", borderColor: "var(--color-border)" }}>
      {/* <DebugOverlay countdowns={countdowns} /> — debug tool, re-enable if needed */}
      {/* Drag region: left greeting text area only — buttons are on right side */}
      <div data-tauri-drag-region className="absolute top-0 left-0 w-52 h-20 cursor-grab" style={{ zIndex: 20 }} />

      {/* background blobs */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none rounded-2xl">
        <div className="absolute -top-20 -right-20 w-72 h-72 bg-purple-500/10 rounded-full blur-3xl" />
        <div className="absolute -bottom-20 -left-20 w-72 h-72 bg-indigo-500/10 rounded-full blur-3xl" />
        {/* This blob used to pulse forever with scale and opacity keyframes.
            blur-3xl is a 64px gaussian over a 384px circle, which the compositor
            caches for free while it holds still — but animating scale forces the
            whole blur to be recomputed every frame, 60 times a second, all day.
            That was the WebView2 GPU process sitting at 90% with no video
            playing at all. The blob stays, it just stops breathing. */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 bg-purple-600/10 rounded-full blur-3xl" />
      </div>

      <div className="relative z-10 flex flex-col h-full p-6">

        {/* header */}
        <div className="flex items-center justify-between mb-5">
          <div>
            <p className="text-white/40 text-xs">
              {new Date().toLocaleDateString(getLang() === "th" ? "th-TH" : "en-US", { weekday: "long", month: "long", day: "numeric", timeZone: getAppTimeZone() })}
            </p>
            <h1 className="text-xl font-bold text-white">{greeting} 👋</h1>
          </div>

          {view === "tasks" && lowPower && (
            <span className="text-white/45 text-xs rounded-xl bg-white/5 border border-white/10 px-3 py-2">
              {t("app.lowPowerOn")}
            </span>
          )}

          {view === "tasks" && !lowPower && (
            <div className="flex gap-2">
              {/* Total pending */}
              <div className="bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-center min-w-14">
                <p className="text-base font-bold text-white">{pendingCount}</p>
                <p className="text-white/40 text-[10px]">{t("stats.pending")}</p>
              </div>
              {/* Done counter */}
              <button
                onClick={() => setFilter(f => f === "done" ? "all" : "done")}
                className={`bg-white/5 border rounded-xl px-3 py-2 text-center min-w-14 transition-all hover:scale-105 ${
                  filter === "done" ? "border-green-500/60 bg-green-500/10" : "border-white/10"
                }`}
              >
                <p className="text-base font-bold text-green-400">{doneCount}</p>
                <p className="text-white/40 text-[10px]">{t("stats.done")}</p>
              </button>
              {/* Important */}
              <button
                onClick={() => setFilter(f => f === "priority" ? "all" : "priority")}
                className={`bg-white/5 border rounded-xl px-3 py-2 text-center min-w-14 transition-all hover:scale-105 ${
                  filter === "priority" ? "border-yellow-500/60 bg-yellow-500/10" : "border-white/10"
                }`}
              >
                <p className="text-base font-bold text-yellow-400">{priorityCount}</p>
                <p className="text-white/40 text-[10px]">{t("stats.important")}</p>
              </button>
              {/* Critical */}
              <button
                onClick={() => setFilter(f => f === "urgent" ? "all" : "urgent")}
                className={`bg-white/5 border rounded-xl px-3 py-2 text-center min-w-14 transition-all hover:scale-105 ${
                  filter === "urgent" ? "border-red-500/60 bg-red-500/10" : "border-white/10"
                }`}
              >
                <p className="text-base font-bold text-red-400">{urgentCount}</p>
                <p className="text-white/40 text-[10px]">{t("stats.critical")}</p>
              </button>
            </div>
          )}

          <div className="flex gap-2">
            <motion.button whileTap={{ scale: 0.95 }} onClick={toggleLowPower}
              className={`p-2.5 rounded-xl border transition-all ${
                lowPower
                  ? "bg-amber-500/15 border-amber-500/40"
                  : "bg-white/5 border-white/10 hover:bg-white/10"
              }`}
              title={t("app.lowPower")}>
              <BatteryLow size={16} className={lowPower ? "text-amber-400" : "text-white/40"} />
            </motion.button>

            <motion.button whileTap={{ scale: 0.95 }} onClick={() => setShelfOpen(true)}
              className="p-2.5 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 transition-all"
              title={t("shelf.title")}>
              <Archive size={16} className="text-white/40" />
            </motion.button>

            <motion.button whileTap={{ scale: 0.95 }} onClick={() => setAiOpen(true)}
              className="p-2.5 rounded-xl bg-purple-500/10 border border-purple-500/25 hover:bg-purple-500/20 hover:border-purple-500/50 transition-all relative"
              title="AI Assistant">
              <Brain size={16} className="text-purple-400" />
              <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-purple-500 ring-1 ring-[var(--color-bg)] animate-pulse" />
            </motion.button>
            <motion.button whileTap={{ scale: 0.95 }} onClick={() => setSettingsOpen(true)}
              className="p-2.5 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 transition-all">
              <Settings size={16} />
            </motion.button>
            {view === "tasks" && (
              <motion.button whileTap={{ scale: 0.95 }} onClick={() => setAddOpen(true)}
                className="px-4 py-2.5 rounded-xl hover:opacity-90 transition-all flex items-center gap-2 theme-btn">
                <Plus size={16} />
                <span className="text-sm font-semibold">{t("btn.addTask")}</span>
              </motion.button>
            )}
          </div>
        </div>

        <div className="flex flex-col flex-1 overflow-hidden min-h-0">
          {/* All views stay mounted — hidden via CSS to prevent re-mount freezes */}
          <div style={{ display: view === "tasks" ? "flex" : "none" }} className="flex flex-col flex-1 overflow-hidden min-h-0">


              {/* urgent alert banner */}
              <AnimatePresence>
                {urgentCount > 0 && filter !== "done" && (
                  <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                    className="mb-4 bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 flex items-center gap-3 cursor-pointer"
                    onClick={() => setFilter(f => f === "urgent" ? "all" : "urgent")}
                  >
                    <motion.div
                      animate={windowActive ? { scale: [1, 1.2, 1] } : { scale: 1 }}
                      transition={windowActive ? { repeat: Infinity, duration: 1 } : { duration: 0 }}>
                      <Clock size={16} className="text-red-400" />
                    </motion.div>
                    <p className="text-red-300 text-sm font-medium">
                      🔥 {t("progress.critical", { n: urgentCount, s: urgentCount > 1 ? "s" : "" })}
                    </p>
                  </motion.div>
                )}
              </AnimatePresence>

              {trayHint && (
                <div className="flex items-start gap-2.5 bg-white/[0.03] border border-white/[0.08] rounded-xl px-3.5 py-2.5 mb-3">
                  <p className="flex-1 text-white/50 text-xs leading-relaxed">{t("settings.trayToast")}</p>
                  <button onClick={() => setTrayHint(false)}
                    className="text-white/35 hover:text-white text-[11px] shrink-0 transition-colors">
                    {t("week.dismiss")}
                  </button>
                </div>
              )}

              {/* Stated and dismissible, never repeated within the week. See
                  lib/weekNote for the rules on when this is allowed to appear
                  at all — the short version is that silence is the default and
                  a quiet week stays quiet. */}
              <AnimatePresence>
                {view === "tasks" && weekNote && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    className="mb-3"
                  >
                    <div className="flex items-start gap-2.5 bg-white/[0.03] border border-white/[0.08] rounded-xl px-3.5 py-2.5">
                      <p className="flex-1 text-white/50 text-xs leading-relaxed">{t("week.allMust")}</p>
                      <button
                        onClick={() => { markWeekNoteShown(); setWeekNote(false); }}
                        className="text-white/35 hover:text-white text-[11px] shrink-0 transition-colors"
                      >
                        {t("week.dismiss")}
                      </button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* done progress bar — shows when any tasks are done */}
              <AnimatePresence>
                {!lowPower && doneCount > 0 && countdowns.length > 0 && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    className="mb-3"
                  >
                    <div className="flex justify-between text-xs text-white/40 mb-1">
                      {/* With nothing ticked yet this line used to read
                          "0 of 3 done today" beside a big 0%, which is a score
                          of your morning before the morning has happened. Same
                          data, but until there is something to report it
                          reports the schedule instead of the shortfall. */}
                      <span className="flex items-center gap-1">
                        {doneCount > 0 && <CheckCircle2 size={11} className="text-green-400" />}
                        {doneCount > 0
                          ? t("progress.doneOf", { done: doneCount, total: countdowns.length })
                          : t("progress.noneYet", { total: countdowns.length })}
                      </span>
                      {doneCount > 0 && (
                        <span>{Math.round((doneCount / countdowns.length) * 100)}%</span>
                      )}
                    </div>
                    <div className="h-1 bg-white/5 rounded-full overflow-hidden">
                      <motion.div
                        className="h-full bg-gradient-to-r from-green-500 to-emerald-400 rounded-full"
                        initial={{ width: 0 }}
                        animate={{ width: `${(doneCount / countdowns.length) * 100}%` }}
                        transition={{ duration: 0.5, ease: "easeOut" }}
                      />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* filter tabs */}
              <div className="flex gap-2 mb-4 overflow-x-auto pb-1">
                {([
                  { key: "all",      label: t("filter.all") },
                  { key: "done",     label: t("filter.done") },
                  { key: "urgent",   label: t("filter.urgent") },
                  { key: "priority", label: t("filter.priority") },
                  { key: "game",     label: t("filter.game") },
                  { key: "school",   label: t("filter.school") },
                  { key: "work",     label: t("filter.work") },
                  { key: "personal", label: t("filter.personal") },
                ] as const).map(f => (
                  <button key={f.key} onClick={() => setFilter(f.key)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all whitespace-nowrap flex-shrink-0 ${
                      filter === f.key
                        ? f.key === "done"     ? "bg-green-500/80 text-white"
                        : f.key === "urgent"   ? "bg-red-500/80 text-white"
                        : f.key === "priority" ? "bg-yellow-500/80 text-white"
                        : "bg-purple-600 text-white"
                        : "bg-white/5 text-white/40 hover:text-white"
                    }`}>
                    {f.label}
                  </button>
                ))}
              </div>

              {/* task grid */}
              <div className="flex-1 overflow-y-auto pr-1">
                {loading ? (
                  <div className="text-center py-16 text-white/30">{t("app.loading")}</div>
                ) : filtered.length === 0 ? (
                  <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-center py-16">
                    {filter === "done" ? (
                      <>
                        <CheckCircle2 size={40} className="text-white/10 mx-auto mb-3" />
                        <p className="text-white/30 font-medium">{t("app.nothingDone")}</p>
                        <p className="text-white/20 text-sm mt-1">{t("app.nothingDoneSub")}</p>
                      </>
                    ) : (
                      <>
                        <Gamepad2 size={40} className="text-white/10 mx-auto mb-3" />
                        <p className="text-white/30 font-medium">{t("btn.noTasks")}</p>
                        <p className="text-white/20 text-sm mt-1">{t("btn.noTasksSub")}</p>
                      </>
                    )}
                  </motion.div>
                ) : (
                  <div className="grid grid-cols-2 gap-3">
                    <AnimatePresence mode="popLayout">
                      {filtered.map(result => (
                        <TaskCard
                          key={result.task.id}
                          result={result}
                          onDelete={handleDelete}
                          onTogglePriority={handleTogglePriority}
                          onToggleUrgent={handleToggleUrgent}
                          onRefresh={refreshTasks}
                          onEdit={handleEdit}
                          onPause={handlePause}
                          lowPower={lowPower}
                        />
                      ))}
                    </AnimatePresence>
                  </div>
                )}
              </div>
          </div>
          <div style={{ display: view === "calendar" ? "flex" : "none" }} className="flex-1 overflow-hidden min-h-0">
            {mountCalendar && <CalendarView onBack={() => setView("tasks")} isVisible={view === "calendar"} refreshKey={calendarKey} onTaskChanged={refreshTasks} />}
          </div>
          <div style={{ display: view === "finance" ? "flex" : "none" }} className="flex-1 overflow-hidden min-h-0">
            {mountFinance && <FinanceView onBack={() => setView("tasks")} isVisible={view === "finance"} refreshKey={financeKey} />}
          </div>
        </div>

        {/* Bottom nav — clean 3 tabs */}
        <div className="flex gap-1 mt-3 flex-shrink-0 bg-white/5 border border-white/10 rounded-2xl p-1">
          {([
            { key: "tasks",    icon: Gamepad2,    label: t("nav.tasks") },
            { key: "calendar", icon: CalendarDays, label: t("nav.calendar") },
            { key: "finance",  icon: Wallet,       label: t("nav.finance") },
          ] as const).map(({ key, icon: Icon, label }) => (
            <button key={key} onClick={() => setView(key)}
              className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold transition-all ${
                view === key ? "theme-btn text-white" : "text-white/40 hover:text-white"
              }`}>
              <Icon size={15}/> {label}
            </button>
          ))}
        </div>
      </div>

      {mountAdd && <AddTaskModal open={addOpen} onClose={() => setAddOpen(false)}
        onTaskAdded={refreshAll} onOpenAI={() => { setAddOpen(false); setAiOpen(true); }} />}
      {mountSettings && <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />}
      <TaskShelf open={shelfOpen} onClose={() => setShelfOpen(false)} onChanged={refreshAll} />
      {mountEdit && <EditTaskModal taskId={editTaskId} initialTask={editTask} onClose={() => { setEditTaskId(null); setEditTask(null); }} onSaved={() => { setEditTaskId(null); setEditTask(null); setTimeout(refreshAll, 100); }} />}
      {mountAi && <UnifiedAIChat
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        onTaskAdded={() => {
          // Always clear any open edit modal first, THEN refresh.
          // Without this, a stale editTaskId causes EditTaskModal to re-open
          // automatically on the next re-render and auto-fire save().
          setEditTaskId(null);
          setEditTask(null);
          setTimeout(refreshAll, 150);
        }}
        onFinanceChanged={() => setFinanceKey(k => k + 1)}
      />}
    </div>
  );
}