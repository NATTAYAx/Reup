import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Plus, Brain } from "lucide-react";
import { createTask } from "../lib/database";
import { Category, ResetType } from "../types";
import TimePicker from "./TimePicker";
import DatePicker from "./DatePicker";
import TaskImagePicker from "./TaskImagePicker";
import AIChatModal from "./AIChatModal";
import { t } from "../lib/i18n";
import { todayBangkok } from "../lib/dateUtil";

interface Props {
  open: boolean;
  onClose: () => void;
  onTaskAdded: () => void;
}

const EMPTY_FORM = {
  name: "",
  description: "",
  category: "game" as Category,
  reset_type: "daily" as ResetType,
  reset_time: "04:00",
  reset_day: 1,
  reset_interval_days: 14,
  anchor_date: todayBangkok(),
  event_start: "",
  event_end: "",
  specific_date: "",
  is_priority: 0,
  is_urgent: 0,
  cover_image: null as string | null,
};

export default function AddTaskModal({ open, onClose, onTaskAdded }: Props) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [showAI, setShowAI] = useState(false);

  const set = (key: string, value: any) => setForm(f => ({ ...f, [key]: value }));

  const handleSubmit = async () => {
    if (!form.name.trim()) {
      alert(t("addTask.alertName"));
      return;
    }
    if (form.reset_type === "specific_date" && !form.specific_date) {
      alert(t("addTask.alertDate"));
      return;
    }
    try {
      await createTask({
        ...form,
        specific_date: form.specific_date || null,
        event_start: form.event_start || null,
        event_end: form.event_end || null,
        cover_image: form.cover_image || null,
      });
      setForm(EMPTY_FORM);
      onTaskAdded();
      onClose();
    } catch (err: any) {
      alert(t("addTask.alertFail") + (err?.message || String(err)));
    }
  };

  const needsTime = ["daily", "weekly", "biweekly", "custom_days"].includes(form.reset_type);

  return (
    <>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, pointerEvents: "none" }}
            transition={{ duration: 0.12 }}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
            onClick={onClose}
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              onClick={e => e.stopPropagation()}
              className="bg-gray-900 border border-white/10 rounded-3xl p-6 w-full max-w-md shadow-2xl max-h-[92vh] overflow-y-auto"
            >
              {/* Header */}
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-white font-bold text-xl">{t("addTask.title")}</h2>
                <button onClick={onClose} className="text-white/40 hover:text-white transition-colors">
                  <X size={20} />
                </button>
              </div>

              {/* AI chat button */}
              <button
                onClick={() => { onClose(); setShowAI(true); }}
                className="w-full mb-5 py-3 px-4 bg-gradient-to-r from-purple-600/20 to-indigo-600/20 border border-purple-500/30 rounded-2xl flex items-center gap-3 hover:border-purple-500/60 hover:from-purple-600/30 hover:to-indigo-600/30 transition-all group"
              >
                <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center flex-shrink-0">
                  <Brain size={16} className="text-white" />
                </div>
                <div className="text-left">
                  <p className="text-white text-sm font-semibold">{t("addTask.aiTitle")}</p>
                  <p className="text-white/40 text-xs">{t("addTask.aiSub")}</p>
                </div>
                <span className="ml-auto text-purple-400 text-xs font-semibold group-hover:translate-x-0.5 transition-transform">
                  {t("addTask.aiTry")}
                </span>
              </button>

              <div className="flex items-center gap-3 mb-5">
                <div className="flex-1 h-px bg-white/10" />
                <span className="text-white/25 text-xs">{t("addTask.orManual")}</span>
                <div className="flex-1 h-px bg-white/10" />
              </div>

              {/* Manual form */}
              <div className="space-y-3">
                <input
                  value={form.name}
                  onChange={e => set("name", e.target.value)}
                  placeholder={t("addTask.namePlaceholder")}
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-white/30 text-sm focus:outline-none focus:border-purple-500"
                />
                <input
                  value={form.description}
                  onChange={e => set("description", e.target.value)}
                  placeholder={t("addTask.descPlaceholder")}
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-white/30 text-sm focus:outline-none focus:border-purple-500"
                />
                <TaskImagePicker
                  value={form.cover_image}
                  onChange={v => set("cover_image", v)}
                  category={form.category}
                />

                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1">
                    <label className="text-white/40 text-xs px-1">{t("addTask.labelCat")}</label>
                    <select
                      value={form.category}
                      onChange={e => set("category", e.target.value)}
                      className="bg-gray-800 border border-white/10 rounded-xl px-3 py-2.5 text-white text-sm focus:outline-none focus:border-purple-500"
                    >
                      <option value="game">{t("catOpt.game")}</option>
                      <option value="school">{t("catOpt.school")}</option>
                      <option value="work">{t("catOpt.work")}</option>
                      <option value="personal">{t("catOpt.personal")}</option>
                    </select>
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-white/40 text-xs px-1">{t("addTask.labelType")}</label>
                    <select
                      value={form.reset_type}
                      onChange={e => set("reset_type", e.target.value)}
                      className="bg-gray-800 border border-white/10 rounded-xl px-3 py-2.5 text-white text-sm focus:outline-none focus:border-purple-500"
                    >
                      <option value="daily">{t("resetType.daily")}</option>
                      <option value="weekly">{t("resetType.weekly")}</option>
                      <option value="biweekly">{t("resetType.biweekly")}</option>
                      <option value="custom_days">{t("resetType.custom_days")}</option>
                      <option value="event_window">{t("resetType.event_window")}</option>
                      <option value="specific_date">{t("resetType.specific_date")}</option>
                    </select>
                  </div>
                </div>

                {needsTime && (
                  <TimePicker value={form.reset_time} onChange={v => set("reset_time", v)} />
                )}

                {form.reset_type === "weekly" && (
                  <div className="flex flex-col gap-1">
                    <label className="text-white/40 text-xs px-1">{t("addTask.labelResetDay")}</label>
                    <div className="grid grid-cols-7 gap-1">
                      {[t("day.sun"),t("day.mon"),t("day.tue"),t("day.wed"),t("day.thu"),t("day.fri"),t("day.sat")].map((d, i) => (
                        <button key={i} type="button" onClick={() => set("reset_day", i)}
                          className={`py-2 rounded-lg text-xs font-semibold transition-all ${form.reset_day === i ? "bg-purple-600 text-white" : "bg-white/5 text-white/50 hover:bg-white/15 hover:text-white"}`}>
                          {d}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {(form.reset_type === "biweekly" || form.reset_type === "custom_days") && (
                  <div className="space-y-2">
                    {form.reset_type === "custom_days" && (
                      <input type="number" value={form.reset_interval_days}
                        onChange={e => set("reset_interval_days", Number(e.target.value))}
                        placeholder={t("addTask.cyclePlaceholder")}
                        className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-purple-500" />
                    )}
                    <DatePicker
                      value={form.anchor_date}
                      onChange={v => set("anchor_date", v)}
                      placeholder={t("addTask.anchorPlaceholder")}
                      label={t("addTask.labelAnchor")}
                    />
                  </div>
                )}

                {form.reset_type === "event_window" && (
                  <div className="space-y-2">
                    <div className="flex flex-col gap-1">
                      <label className="text-white/40 text-xs px-1">{t("addTask.labelEventStart")}</label>
                      <DatePicker
                        value={form.event_start}
                        onChange={v => set("event_start", v)}
                        placeholder={t("addTask.eventStartPH")}
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-white/40 text-xs px-1">{t("addTask.labelEventEnd")}</label>
                      <DatePicker
                        value={form.event_end}
                        onChange={v => set("event_end", v)}
                        placeholder={t("addTask.eventEndPH")}
                      />
                    </div>
                  </div>
                )}

                {form.reset_type === "specific_date" && (
                  <div className="flex flex-col gap-1">
                    <label className="text-white/40 text-xs px-1">{t("addTask.labelTaskDate")}</label>
                    <DatePicker
                      value={form.specific_date}
                      onChange={v => set("specific_date", v)}
                      placeholder={t("addTask.taskDatePH")}
                    />
                  </div>
                )}

                {/* Flags row: Important + Critical side by side */}
                <div className="grid grid-cols-2 gap-2">
                  <div onClick={() => set("is_priority", form.is_priority ? 0 : 1)}
                    className={`flex items-center gap-2 px-3 py-3 rounded-xl border cursor-pointer transition-all ${form.is_priority ? "bg-yellow-500/10 border-yellow-500/40 text-yellow-300" : "bg-white/5 border-white/10 text-white/40 hover:text-white"}`}>
                    <span>{form.is_priority ? "⭐" : "☆"}</span>
                    <span className="text-xs font-medium">{form.is_priority ? t("addTask.important") : t("addTask.markImportant")}</span>
                  </div>
                  <div onClick={() => set("is_urgent", form.is_urgent ? 0 : 1)}
                    className={`flex items-center gap-2 px-3 py-3 rounded-xl border cursor-pointer transition-all ${form.is_urgent ? "bg-red-500/10 border-red-500/40 text-red-300" : "bg-white/5 border-white/10 text-white/40 hover:text-white"}`}>
                    <span>{form.is_urgent ? "🔥" : "○"}</span>
                    <span className="text-xs font-medium">{form.is_urgent ? t("addTask.critical") : t("addTask.markCritical")}</span>
                  </div>
                </div>

                <button onClick={handleSubmit}
                  className="w-full py-3 bg-gradient-to-r from-purple-600 to-indigo-600 rounded-xl text-white font-semibold flex items-center justify-center gap-2">
                  <Plus size={16} />
                  {t("addTask.submit")}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AIChatModal
        open={showAI}
        onClose={() => setShowAI(false)}
        onTaskAdded={onTaskAdded}
      />
    </>
  );
}