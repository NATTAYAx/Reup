import { useState, useEffect, useRef } from "react";
import { X, Save, AlertCircle } from "lucide-react";
import { updateTask, getTaskById, recentDone } from "../lib/database";
import TimePicker from "./TimePicker";
import DatePicker from "./DatePicker";
import TaskImagePicker from "./TaskImagePicker";
import Select from "./Select";
import CategoryPicker from "./CategoryPicker";
import CycleFields from "./CycleFields";
import TimeZonePin from "./TimeZonePin";
import IntentPicker from "./IntentPicker";
import { getAppTimeZone } from "../lib/tz";
import { hasHistory } from "../lib/history";
import { TYPE_OPTIONS } from "../lib/taskOptions";
import { t } from "../lib/i18n";

interface Props {
  taskId: number | null;
  initialTask?: any | null;
  onClose: () => void;
  onSaved: () => void;
}

export default function EditTaskModal({ taskId, initialTask, onClose, onSaved }: Props) {
  const [form, setForm] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [done, setDone] = useState<string[]>([]);
  // savingRef prevents double-fire even if React batches wrong
  const savingRef = useRef(false);

  // Read once, when a task is opened, and only for the kinds that have an
  // answer worth giving. A task with no uid has never synced and has no events
  // keyed to it either, so there is nothing to look up rather than nothing to
  // find.
  const loadHistory = async (task: any) => {
    if (!task?.uid || !hasHistory(String(task.reset_type))) { setDone([]); return; }
    setDone(await recentDone(String(task.uid)));
  };

  // Reset everything when taskId changes
  useEffect(() => {
    if (!taskId) {
      setForm(null);
      setLoadError(null);
      setSaveError(null);
      setSaving(false);
      savingRef.current = false;
      return;
    }
    setSaveError(null);
    setSaving(false);
    savingRef.current = false;
    setLoadError(null);
    setDone([]);

    // Use pre-loaded task if available and matching
    if (initialTask && Number(initialTask.id) === Number(taskId)) {
      setForm({ ...initialTask });
      void loadHistory(initialTask);
      return;
    }

    setForm(null);
    let cancelled = false;
    const timeoutId = setTimeout(() => {
      if (!cancelled) { cancelled = true; setLoadError(t("edit.loadSlow")); }
    }, 8000);

    getTaskById(taskId)
      .then(t => {
        clearTimeout(timeoutId);
        if (cancelled) return;
        if (t) { setForm({ ...t }); void loadHistory(t); }
        else setLoadError(t("edit.notFound", { id: String(taskId) }));
      })
      .catch(err => {
        clearTimeout(timeoutId);
        if (cancelled) return;
        setLoadError(String(err?.message ?? err));
      });

    return () => { cancelled = true; clearTimeout(timeoutId); };
  }, [taskId]);

  // Reset save guard whenever modal remounts (taskId goes null→value)
  // This catches the case where the same taskId is opened twice in a row.
  useEffect(() => {
    if (taskId) {
      savingRef.current = false;
      setSaving(false);
    }
  }, [taskId]);

  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));

  const save = async () => {
    // Double-fire guard using ref (synchronous, unlike state)
    if (!form?.name?.trim()) return;
    if (savingRef.current) { console.log("[EditTask] save blocked — already saving"); return; }
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);

    const numId = Number(taskId!);
    console.log("[EditTask] save numId=", numId, "name=", form.name);

    const baseFields = {
      name: form.name,
      description: form.description ?? "",
      category: form.category,
      reset_type: form.reset_type,
      reset_time: form.reset_time || null,
      reset_day: form.reset_day ?? null,
      reset_interval_days: form.reset_interval_days ?? null,
      anchor_date: form.anchor_date || null,
      event_start: form.event_start || null,
      event_end: form.event_end || null,
      specific_date: form.specific_date || null,
      min_step: (form.min_step ?? "").trim() || null,
      notify_before_min: Number(form.notify_before_min) > 0 ? Number(form.notify_before_min) : null,
      time_zone: form.time_zone ?? null,
      intent: (form.intent as "want" | "must" | null) ?? null,
      is_priority: form.is_priority ?? 0,
      is_urgent: form.is_urgent ?? 0,
      cover_image: form.cover_image ?? null,
    };

    try {
      try {
        await updateTask(numId, { ...baseFields, notes: form.notes ?? "" });
        console.log("[EditTask] SUCCESS with notes");
      } catch (e1: any) {
        console.warn("[EditTask] retry without notes:", e1?.message);
        await updateTask(numId, baseFields);
        console.log("[EditTask] SUCCESS without notes");
      }
      // Reset guard BEFORE closing — component unmounts on close so we can't reset after
      savingRef.current = false;
      setSaving(false);
      onClose();
      setTimeout(() => onSaved(), 80);
    } catch (e: any) {
      console.error("[EditTask] FAILED:", e?.message);
      setSaveError(String(e?.message ?? e) || t("edit.noReason"));
      setSaving(false);
      savingRef.current = false;
    }
  };

  // KEY: completely remove from DOM when no taskId
  if (!taskId) return null;


  return (
    <div
      className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
      onClick={() => { if (!saving) onClose(); }}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="bg-gray-900 border border-white/10 rounded-3xl p-6 w-full max-w-md shadow-2xl max-h-[92vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-white font-bold text-xl">{t("editTask.title")}</h2>
            <p className="text-white/30 text-xs mt-0.5">ID #{taskId}</p>
          </div>
          <button onClick={onClose} className="text-white/40 hover:text-white"><X size={20}/></button>
        </div>

        {loadError ? (
          <div className="text-center py-12">
            <p className="text-red-400 text-sm mb-2">{t("edit.loadFailed")}</p>
            <p className="text-white/30 text-xs">{loadError}</p>
            <button
              onClick={() => {
                setLoadError(null);
                getTaskById(taskId!).then(t => t && setForm({...t})).catch(e => setLoadError(String(e?.message ?? e)));
              }}
              className="mt-3 px-4 py-1.5 bg-white/10 rounded-lg text-white/60 text-xs hover:bg-white/20 transition-all"
            >{t("edit.retry")}</button>
          </div>
        ) : !form ? (
          <div className="text-center py-12 text-white/30 text-sm">{t("edit.loading")}</div>
        ) : (
          <div className="space-y-3">
            <input value={form.name ?? ""} onChange={e => set("name", e.target.value)} placeholder={t("editTask.namePH")}
              className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-white/30 text-sm focus:outline-none focus:border-purple-500"/>
            <input value={form.description ?? ""} onChange={e => set("description", e.target.value)} placeholder={t("editTask.descPH")}
              className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-white/30 text-sm focus:outline-none focus:border-purple-500"/>
            <textarea value={form.notes ?? ""} onChange={e => set("notes", e.target.value)} placeholder={t("editTask.notesPH")} rows={2}
              className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-white/30 text-sm focus:outline-none focus:border-purple-500 resize-none"/>
            {/* The smallest version of this task. Editable here as well as on
                creation, because the useful wording for it usually only becomes
                obvious after a few days of not managing the full one. */}
            <div className="flex flex-col gap-1">
              <label className="text-white/40 text-xs px-1">{t("task.minStep")}</label>
              <input value={form.min_step ?? ""} onChange={e => set("min_step", e.target.value)}
                placeholder={t("task.minStepPH")}
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-white placeholder-white/30 text-sm focus:outline-none focus:border-purple-500"/>
              <p className="text-white/25 text-[11px] px-1">{t("task.minStepHint")}</p>
              {/* Same field as on the create form, and only for the kinds where
                  leaving early exists. Usually filled in here rather than
                  there: how long the getting-ready actually takes is something
                  learned by being late once. */}
              {/* An answer, on a screen somebody opened on purpose, about a
                  task they are deciding something about. Dates rather than a
                  count of days, three rather than all of them, and nothing at
                  all for a daily — the reasoning is in lib/history, and it is
                  the same standard that turned down the weekly summary. */}
              {hasHistory(String(form.reset_type)) && done.length > 0 && (
                <p className="text-white/30 text-[11px] px-1 pt-2">
                  {t("history.lastDone")} {done.map(d => d.slice(8) + "/" + d.slice(5, 7)).join(" · ")}
                </p>
              )}

              {["specific_date", "one_time", "event_window"].includes(String(form.reset_type)) && (
                <div className="flex flex-col gap-1 pt-2">
                  <label className="text-white/40 text-xs px-1">{t("lead.field")}</label>
                  <div className="flex gap-1.5 flex-wrap px-1">
                    {["", "15", "30", "60", "90"].map(m => (
                      <button
                        key={m || "none"}
                        type="button"
                        onClick={() => set("notify_before_min", m)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                          String(form.notify_before_min ?? "") === m
                            ? "bg-sky-500/30 text-sky-100"
                            : "bg-white/5 text-white/50 hover:bg-white/10"
                        }`}
                      >
                        {m === "" ? t("lead.none") : m}
                      </button>
                    ))}
                    <input
                      value={String(form.notify_before_min ?? "")}
                      onChange={e => set("notify_before_min", e.target.value.replace(/[^0-9]/g, ""))}
                      inputMode="numeric"
                      placeholder="0"
                      className="w-16 bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-white text-xs text-center placeholder-white/30 focus:outline-none focus:border-sky-500"
                    />
                  </div>
                  <p className="text-white/25 text-[11px] px-1">{t("lead.hint")}</p>
                </div>
              )}
              <div className="px-1 pt-2">
                <IntentPicker
                  value={(form.intent as "want" | "must" | null) ?? null}
                  onChange={v => set("intent", v)}
                />
              </div>
            </div>
            <TaskImagePicker
              value={form.cover_image ?? null}
              onChange={v => set("cover_image", v)}
              category={form.category}
            />
            <div className="flex flex-col gap-2">
              <label className="text-white/40 text-[11px] font-semibold tracking-wide uppercase px-0.5">{t("editTask.labelCat")}</label>
              <CategoryPicker value={form.category ?? "personal"} onChange={v => set("category", v)} />
            </div>
            <div className="flex flex-col gap-2">
              <label className="text-white/40 text-[11px] font-semibold tracking-wide uppercase px-0.5">{t("editTask.labelType")}</label>
              <Select
                value={form.reset_type ?? "daily"}
                options={TYPE_OPTIONS}
                onChange={v => set("reset_type", v)}
                placeholder={t("addTask.typePH")}
              />
            </div>
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between px-1">
                <label className="text-white/40 text-xs">{t("task.timeLabel")}</label>
                <button type="button"
                  onClick={() => set("reset_time", form.reset_time ? "" : "00:00")}
                  className={`text-[11px] rounded-full px-2.5 py-0.5 border transition-colors ${
                    !form.reset_time
                      ? "border-purple-500/60 text-purple-300 bg-purple-500/15"
                      : "border-white/10 text-white/40 hover:text-white"
                  }`}>
                  {t("task.allDay")}
                </button>
              </div>
              {form.reset_time
                ? <TimePicker value={form.reset_time} onChange={v => set("reset_time", v)} />
                : <p className="text-white/25 text-[11px] px-1">{t("task.allDayHint")}</p>}
              <div className="px-1 pt-1">
                <TimeZonePin value={form.time_zone ?? null} onChange={v => set("time_zone", v)} />
              </div>
            </div>
            {form.reset_type === "weekly" && (
              <div className="flex flex-col gap-1">
                <label className="text-white/40 text-xs px-1">{t("editTask.labelResetDay")}</label>
                <div className="grid grid-cols-7 gap-1">
                  {[t("day.sun"),t("day.mon"),t("day.tue"),t("day.wed"),t("day.thu"),t("day.fri"),t("day.sat")].map((d,i) => (
                    <button key={i} type="button" onClick={() => set("reset_day", i)}
                      className={`py-2 rounded-lg text-xs font-semibold transition-all ${(form.reset_day ?? 1)===i?"bg-purple-600 text-white":"bg-white/5 text-white/50 hover:bg-white/15"}`}>{d}</button>
                  ))}
                </div>
              </div>
            )}
            {(form.reset_type === "biweekly" || form.reset_type === "custom_days") && (
              <CycleFields
                editableInterval={form.reset_type === "custom_days"}
                intervalDays={form.reset_type === "biweekly" ? 14 : (form.reset_interval_days ?? 14)}
                onIntervalChange={v => set("reset_interval_days", v)}
                anchorDate={form.anchor_date ?? ""}
                onAnchorChange={v => set("anchor_date", v)}
                resetTime={form.reset_time ?? ""}
              />
            )}
            {form.reset_type === "event_window" && (() => {
              // Detect AI-chat deadline (event_end has 'T' = UTC datetime) vs manual date range
              const isDatetime = !!form.event_end?.includes('T');

              // Extract local date string "YYYY-MM-DD" and time "HH:MM" from a UTC ISO string
              const getLocalDate = (iso: string) => {
                const d = new Date(iso);
                return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
              };
              const getLocalTime = (iso: string) => {
                const d = new Date(iso);
                return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
              };
              // Merge a local date string + HH:MM time → UTC ISO string
              const mergeToUtcIso = (dateStr: string, timeStr: string) => {
                return new Date(`${dateStr}T${timeStr}`).toISOString().replace(/\.\d{3}Z$/, 'Z');
              };

              if (isDatetime) {
                const deadlineDate = form.event_end ? getLocalDate(form.event_end) : "";
                const deadlineTime = form.event_end ? getLocalTime(form.event_end) : "23:59";
                return (
                  <div className="space-y-2">
                    <label className="text-white/40 text-xs px-1">⏰ Deadline ({getAppTimeZone()})</label>
                    <DatePicker
                      value={deadlineDate}
                      onChange={e => {
                        if (!e) { set("event_end", null); return; }
                        set("event_end", mergeToUtcIso(e, deadlineTime));
                      }}
                      placeholder={t("editTask.deadlinePH")}
                    />
                    <TimePicker
                      value={deadlineTime}
                      onChange={t => {
                        if (!deadlineDate) return;
                        set("event_end", mergeToUtcIso(deadlineDate, t));
                      }}
                    />
                  </div>
                );
              }
              return (
                <div className="space-y-2">
                  <div className="flex flex-col gap-1">
                    <label className="text-white/40 text-xs px-1">{t("editTask.labelEventStart")}</label>
                    <DatePicker
                      value={form.event_start ?? ""}
                      onChange={v => set("event_start", v)}
                      placeholder={t("editTask.eventStartPH")}
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-white/40 text-xs px-1">{t("editTask.labelEventEnd")}</label>
                    <DatePicker
                      value={form.event_end ?? ""}
                      onChange={v => set("event_end", v)}
                      placeholder={t("editTask.eventEndPH")}
                    />
                  </div>
                </div>
              );
            })()}
            {form.reset_type === "specific_date" && (
              <DatePicker
                value={form.specific_date ?? ""}
                onChange={v => set("specific_date", v)}
                placeholder={t("editTask.taskDatePH")}
                label={t("editTask.taskDateLabel")}
              />
            )}
            <div className="grid grid-cols-2 gap-2">
              <div onClick={() => set("is_priority", form.is_priority ? 0 : 1)}
                className={`flex items-center gap-2 px-3 py-3 rounded-xl border cursor-pointer transition-all ${form.is_priority?"bg-yellow-500/10 border-yellow-500/40 text-yellow-300":"bg-white/5 border-white/10 text-white/40 hover:text-white"}`}>
                <span>{form.is_priority ? "⭐" : "☆"}</span>
                <span className="text-xs font-medium">{form.is_priority ? t("addTask.important") : t("addTask.markImportant")}</span>
              </div>
              <div onClick={() => set("is_urgent", form.is_urgent ? 0 : 1)}
                className={`flex items-center gap-2 px-3 py-3 rounded-xl border cursor-pointer transition-all ${form.is_urgent?"bg-red-500/10 border-red-500/40 text-red-300":"bg-white/5 border-white/10 text-white/40 hover:text-white"}`}>
                <span>{form.is_urgent ? "🔥" : "○"}</span>
                <span className="text-xs font-medium">{form.is_urgent ? t("addTask.critical") : t("addTask.markCritical")}</span>
              </div>
            </div>

            {saveError && (
              <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-xl px-3 py-2.5">
                <AlertCircle size={14} className="text-red-400 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-red-400 text-xs font-semibold">{t("edit.saveFailed")}</p>
                  <p className="text-red-300/70 text-xs mt-0.5 break-all">{saveError}</p>
                </div>
              </div>
            )}

            <button
              onClick={save}
              disabled={saving}
              className="w-full py-3 bg-gradient-to-r from-purple-600 to-indigo-600 rounded-xl text-white font-semibold flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Save size={16}/> {saving ? t("editTask.saving") : t("editTask.save")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}