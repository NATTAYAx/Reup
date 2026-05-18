import { useState, useEffect, useRef } from "react";
import { X, Save, AlertCircle } from "lucide-react";
import { updateTask, getTaskById } from "../lib/database";
import TimePicker from "./TimePicker";
import DatePicker from "./DatePicker";
import TaskImagePicker from "./TaskImagePicker";
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
  // savingRef prevents double-fire even if React batches wrong
  const savingRef = useRef(false);

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

    // Use pre-loaded task if available and matching
    if (initialTask && Number(initialTask.id) === Number(taskId)) {
      setForm({ ...initialTask });
      return;
    }

    setForm(null);
    let cancelled = false;
    const timeoutId = setTimeout(() => {
      if (!cancelled) { cancelled = true; setLoadError("โหลดช้าเกินไป — ลองปิดแล้วเปิดใหม่"); }
    }, 8000);

    getTaskById(taskId)
      .then(t => {
        clearTimeout(timeoutId);
        if (cancelled) return;
        if (t) setForm({ ...t });
        else setLoadError(`ไม่พบงาน #${taskId}`);
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
      setSaveError(String(e?.message ?? e) || "ไม่ทราบสาเหตุ — ดู console");
      setSaving(false);
      savingRef.current = false;
    }
  };

  // KEY: completely remove from DOM when no taskId
  if (!taskId) return null;

  const needsTime = form && ["daily","weekly","biweekly","custom_days"].includes(form.reset_type);

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
            <p className="text-red-400 text-sm mb-2">โหลดไม่สำเร็จ</p>
            <p className="text-white/30 text-xs">{loadError}</p>
            <button
              onClick={() => {
                setLoadError(null);
                getTaskById(taskId!).then(t => t && setForm({...t})).catch(e => setLoadError(String(e?.message ?? e)));
              }}
              className="mt-3 px-4 py-1.5 bg-white/10 rounded-lg text-white/60 text-xs hover:bg-white/20 transition-all"
            >ลองใหม่</button>
          </div>
        ) : !form ? (
          <div className="text-center py-12 text-white/30 text-sm">กำลังโหลด...</div>
        ) : (
          <div className="space-y-3">
            <input value={form.name ?? ""} onChange={e => set("name", e.target.value)} placeholder={t("editTask.namePH")}
              className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-white/30 text-sm focus:outline-none focus:border-purple-500"/>
            <input value={form.description ?? ""} onChange={e => set("description", e.target.value)} placeholder={t("editTask.descPH")}
              className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-white/30 text-sm focus:outline-none focus:border-purple-500"/>
            <textarea value={form.notes ?? ""} onChange={e => set("notes", e.target.value)} placeholder={t("editTask.notesPH")} rows={2}
              className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-white/30 text-sm focus:outline-none focus:border-purple-500 resize-none"/>
            <TaskImagePicker
              value={form.cover_image ?? null}
              onChange={v => set("cover_image", v)}
              category={form.category}
            />
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-white/40 text-xs px-1">{t("editTask.labelCat")}</label>
                <select value={form.category ?? "personal"} onChange={e => set("category", e.target.value)}
                  className="bg-gray-800 border border-white/10 rounded-xl px-3 py-2.5 text-white text-sm focus:outline-none focus:border-purple-500">
                  <option value="game">{t("catOpt.game")}</option>
                  <option value="school">{t("catOpt.school")}</option>
                  <option value="work">{t("catOpt.work")}</option>
                  <option value="personal">{t("catOpt.personal")}</option>
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-white/40 text-xs px-1">{t("editTask.labelType")}</label>
                <select value={form.reset_type ?? "daily"} onChange={e => set("reset_type", e.target.value)}
                  className="bg-gray-800 border border-white/10 rounded-xl px-3 py-2.5 text-white text-sm focus:outline-none focus:border-purple-500">
                  <option value="daily">{t("resetType.daily")}</option>
                  <option value="weekly">{t("resetType.weekly")}</option>
                  <option value="biweekly">{t("resetType.biweekly")}</option>
                  <option value="custom_days">{t("resetType.custom_days")}</option>
                  <option value="event_window">{t("resetType.event_window")}</option>
                  <option value="specific_date">{t("resetType.specific_date")}</option>
                </select>
              </div>
            </div>
            {needsTime && <TimePicker value={form.reset_time ?? "00:00"} onChange={v => set("reset_time", v)}/>}
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
              <div className="space-y-2">
                {form.reset_type === "custom_days" && (
                  <input type="number" value={form.reset_interval_days ?? 14} onChange={e => set("reset_interval_days", Number(e.target.value))} placeholder={t("editTask.cyclePH")}
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-purple-500"/>
                )}
                <DatePicker
                  value={form.anchor_date ?? ""}
                  onChange={v => set("anchor_date", v)}
                  placeholder={t("editTask.anchorPH")}
                  label={t("editTask.anchorLabel")}
                />
              </div>
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
                    <label className="text-white/40 text-xs px-1">⏰ Deadline (Bangkok time)</label>
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
                  <p className="text-red-400 text-xs font-semibold">บันทึกไม่สำเร็จ</p>
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