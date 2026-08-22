import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Plus, AlertCircle, Sparkles } from "lucide-react";
import { createTask } from "../lib/database";
import { Category, ResetType } from "../types";
import TimePicker from "./TimePicker";
import DatePicker from "./DatePicker";
import TaskImagePicker from "./TaskImagePicker";
import Select from "./Select";
import CategoryPicker from "./CategoryPicker";
import CycleFields from "./CycleFields";
import TimeZonePin from "./TimeZonePin";
import IntentPicker from "./IntentPicker";
import { t } from "../lib/i18n";
import { TYPE_OPTIONS } from "../lib/taskOptions";
import { todayLocal } from "../lib/dateUtil";

interface Props {
  open: boolean;
  onClose: () => void;
  onTaskAdded: () => void;
  /** No longer used here — the assistant lives in the app header. Kept so
   *  the existing call site does not need touching. */
  onOpenAI?: () => void;
}

const EMPTY_FORM = {
  name: "",
  description: "",
  category: "game" as Category,
  reset_type: "daily" as ResetType,
  reset_time: "04:00",
  reset_day: 1,
  reset_interval_days: 14,
  anchor_date: todayLocal(),
  event_start: "",
  event_end: "",
  specific_date: "",
  is_priority: 0,
  is_urgent: 0,
  cover_image: null as string | null,
  notify_before_min: "",
  min_step: "",
  time_zone: null as string | null,
  intent: null as "want" | "must" | null,
};

export default function AddTaskModal({ open, onClose, onTaskAdded }: Props) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState("");
  // Which field to outline. Saying what is wrong is half of it; showing where
  // is the other half.
  const [invalid, setInvalid] = useState<"name" | "date" | null>(null);
  // Almost every task is a name, a kind and a time. Everything else — a
  // description, a cover image — is occasionally useful and was permanently on
  // screen, which is what made this form feel like paperwork.
  const [showMore, setShowMore] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  // The first thing anyone does here is type a name, so the cursor starts in
  // it instead of asking for a click first. The delay lets the open animation
  // begin before focus moves, otherwise the panel jumps.
  useEffect(() => {
    if (!open) return;
    const id = setTimeout(() => nameRef.current?.focus(), 120);
    return () => clearTimeout(id);
  }, [open]);

  // Reaching for the mouse to leave a form is the sort of small friction that
  // adds up. Escape closes, exactly like clicking the backdrop already does.
  // Select and the pickers stop the event first when their popover is open, so
  // Escape closes the popover before it closes the form.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const set = (key: string, value: any) => {
    setForm(f => ({ ...f, [key]: value }));
    // Typing is the user answering the complaint, so the complaint goes away.
    if (error) setError("");
    if (invalid) setInvalid(null);
  };

  // window.alert draws an operating-system dialog: it lands outside the app,
  // ignores the theme, plays the system error chime, and blocks everything
  // until it is dismissed. For "you left the name blank" that is a fire alarm
  // for a missing sock. Validation now points at the field that needs filling
  // in, which is also the only place the answer can be typed.
  const handleSubmit = async () => {
    setError("");
    if (!form.name.trim()) {
      setError(t("addTask.alertName"));
      setInvalid("name");
      nameRef.current?.focus();
      return;
    }
    if (form.reset_type === "specific_date" && !form.specific_date) {
      setError(t("addTask.alertDate"));
      setInvalid("date");
      return;
    }
    setInvalid(null);
    try {
      await createTask({
        ...form,
        specific_date: form.specific_date || null,
        event_start: form.event_start || null,
        event_end: form.event_end || null,
        cover_image: form.cover_image || null,
        min_step: form.min_step.trim() || null,
        notify_before_min: Number(form.notify_before_min) > 0 ? Number(form.notify_before_min) : null,
        time_zone: form.time_zone,
        intent: form.intent,
      });
      setForm(EMPTY_FORM);
      setShowMore(false);
      onTaskAdded();
      onClose();
    } catch (err: any) {
      setError(t("addTask.alertFail") + (err?.message || String(err)));
    }
  };

  // Everything inside "When" that is not the type or the time. Kept together in
  // one place so the conditional fields read as one answer to one question
  // instead of appearing to be four unrelated settings that come and go.
  const extraWhenFields = (
    <>
      {form.reset_type === "weekly" && (
        <div className="flex flex-col gap-1.5">
          <label className="text-white/40 text-[11px]">{t("addTask.labelResetDay")}</label>
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
        <CycleFields
          editableInterval={form.reset_type === "custom_days"}
          intervalDays={form.reset_type === "biweekly" ? 14 : form.reset_interval_days}
          onIntervalChange={v => set("reset_interval_days", v)}
          anchorDate={form.anchor_date}
          onAnchorChange={v => set("anchor_date", v)}
          resetTime={form.reset_time}
        />
      )}

      {form.reset_type === "event_window" && (
        <div className="space-y-2">
          <div className="flex flex-col gap-1.5">
            <label className="text-white/40 text-[11px]">{t("addTask.labelEventStart")}</label>
            <DatePicker
              value={form.event_start}
              onChange={v => set("event_start", v)}
              placeholder={t("addTask.eventStartPH")}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-white/40 text-[11px]">{t("addTask.labelEventEnd")}</label>
            <DatePicker
              value={form.event_end}
              onChange={v => set("event_end", v)}
              placeholder={t("addTask.eventEndPH")}
            />
          </div>
        </div>
      )}

      {form.reset_type === "specific_date" && (
        <div className={`flex flex-col gap-1.5 rounded-xl ${invalid === "date" ? "ring-1 ring-red-400/70" : ""}`}>
          <label className="text-white/40 text-[11px]">{t("addTask.labelTaskDate")}</label>
          <DatePicker
            value={form.specific_date}
            onChange={v => set("specific_date", v)}
            placeholder={t("addTask.taskDatePH")}
          />
        </div>
      )}
    </>
  );

  return (
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
            initial={{ scale: 0.94, opacity: 0, y: 8 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.94, opacity: 0, y: 8 }}
            transition={{ duration: 0.16 }}
            onClick={e => e.stopPropagation()}
            /* Column layout instead of one long scrolling box: the title and the
               Add button are pinned, and only the fields between them move. On a
               590px window the button used to sit below the fold whenever a date
               type was picked, so finishing the form meant scrolling to find it. */
            className="bg-gray-900 border border-white/10 rounded-3xl w-full max-w-md shadow-2xl shadow-black/60 max-h-[92vh] flex flex-col overflow-hidden"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-white/[0.07]">
              <h2 className="text-white font-bold text-lg">{t("addTask.title")}</h2>
              <button
                onClick={onClose}
                className="text-white/35 hover:text-white hover:bg-white/10 rounded-lg p-1.5 -mr-1.5 transition-colors"
              >
                <X size={18} />
              </button>
            </div>

            {/* Fields */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
              {/* The name is the only required field, so it is the only one
                  drawn at full size and it is what the cursor lands on. */}
              <input
                ref={nameRef}
                value={form.name}
                onChange={e => set("name", e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") handleSubmit(); }}
                placeholder={t("addTask.namePlaceholder")}
                className={`w-full bg-white/5 border rounded-xl px-4 py-3.5 text-white placeholder-white/25 text-base font-medium focus:outline-none transition-colors ${
                  invalid === "name"
                    ? "border-red-400/70 focus:border-red-400"
                    : "border-white/10 focus:border-purple-500"
                }`}
              />

              {/* ── The spine: what it is, and when it comes back ──────────
                  Two controls, no labels, no surrounding panel. A label above a
                  dropdown that already reads "ทุกวัน" is a word explaining a
                  word, and a border around two fields draws a box around the
                  only thing on screen.

                  The time field replaces the all-day chip that used to sit
                  beside it: an empty box IS all day. One control, one meaning.  */}
              <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0">
                  <Select
                    value={form.reset_type}
                    options={TYPE_OPTIONS}
                    onChange={v => set("reset_type", v)}
                    placeholder={t("addTask.typePH")}
                  />
                </div>
                <div className="w-[132px] shrink-0">
                  <TimePicker
                    value={form.reset_time}
                    onChange={v => set("reset_time", v)}
                    showZone={false}
                    allowEmpty
                    placeholder={t("task.allDay")}
                  />
                </div>
              </div>

              {extraWhenFields}

              {/* ── Everything else ────────────────────────────────────────
                  Category, the smallest version, want-or-must, the two flags,
                  a description, a cover image, a pinned zone. Nine controls,
                  and a task needs none of them to exist.

                  They were all on the first screen. Opening the form to add
                  "Honkai daily" meant reading past six labels and fifteen
                  controls to reach a button, every single time — which is what
                  made adding a task feel like filling in paperwork rather than
                  writing something down.

                  Every one of them is still here, one click away, and every one
                  is still editable afterwards. Nothing was removed; the default
                  answer just stopped asking to be confirmed.                    */}
              <button type="button" onClick={() => setShowMore(v => !v)}
                className="self-start text-white/35 hover:text-white text-xs transition-colors">
                {showMore ? t("addTask.less") : t("addTask.more")}
              </button>

              <AnimatePresence initial={false}>
                {showMore && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.18 }}
                    className="overflow-hidden"
                  >
                    <div className="space-y-4 pt-1">
                      <CategoryPicker value={form.category} onChange={v => set("category", v)} />

                      <div className="flex items-center gap-2 flex-wrap">
                        <button type="button" onClick={() => set("is_priority", form.is_priority ? 0 : 1)}
                          className={`text-xs rounded-full px-3 py-1.5 border transition-colors ${
                            form.is_priority
                              ? "bg-yellow-500/15 border-yellow-500/40 text-yellow-300"
                              : "border-white/10 text-white/40 hover:text-white"
                          }`}>
                          {form.is_priority ? "⭐" : "☆"} {t("addTask.important")}
                        </button>
                        <button type="button" onClick={() => set("is_urgent", form.is_urgent ? 0 : 1)}
                          className={`text-xs rounded-full px-3 py-1.5 border transition-colors ${
                            form.is_urgent
                              ? "bg-red-500/15 border-red-500/40 text-red-300"
                              : "border-white/10 text-white/40 hover:text-white"
                          }`}>
                          {form.is_urgent ? "🔥" : "○"} {t("addTask.critical")}
                        </button>
                      </div>

                      <input
                        value={form.description}
                        onChange={e => set("description", e.target.value)}
                        placeholder={t("addTask.descPlaceholder")}
                        className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-white placeholder-white/25 text-sm focus:outline-none focus:border-purple-500 transition-colors"
                      />

                      {/* The smallest version of the task, with the reason for
                          it printed underneath — on the days it matters most,
                          nobody is going to remember what the field was for. */}
                      <div className="flex flex-col gap-1.5">
                        <label className="text-white/40 text-[11px] font-semibold tracking-wide uppercase px-0.5 flex items-center gap-1.5">
                          <Sparkles size={11} className="text-purple-400/70" />
                          {t("task.minStep")}
                        </label>
                        <input
                          value={form.min_step}
                          onChange={e => set("min_step", e.target.value)}
                          placeholder={t("task.minStepPH")}
                          className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-white text-sm placeholder-white/25 focus:outline-none focus:border-purple-500 transition-colors"
                        />
                        <p className="text-white/25 text-[11px] px-0.5">{t("task.minStepHint")}</p>
                      </div>

                      {/* Only where leaving early is a thing that exists. A game
                          reset is not somewhere anybody travels to, and the
                          countdown is only shifted for these kinds — see
                          HAS_LEAD in lib/countdown. */}
                      {["specific_date", "one_time", "event_window"].includes(form.reset_type) && (
                        <div className="flex flex-col gap-1.5">
                          <label className="text-white/40 text-[11px] font-semibold tracking-wide uppercase px-0.5">
                            {t("lead.field")}
                          </label>
                          <div className="flex gap-1.5 flex-wrap">
                            {["", "15", "30", "60", "90"].map(m => (
                              <button
                                key={m || "none"}
                                type="button"
                                onClick={() => set("notify_before_min", m)}
                                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                                  form.notify_before_min === m
                                    ? "bg-sky-500/30 text-sky-100"
                                    : "bg-white/5 text-white/50 hover:bg-white/10"
                                }`}
                              >
                                {m === "" ? t("lead.none") : `${m}`}
                              </button>
                            ))}
                            <input
                              value={form.notify_before_min}
                              onChange={e => set("notify_before_min", e.target.value.replace(/[^0-9]/g, ""))}
                              inputMode="numeric"
                              placeholder="0"
                              className="w-16 bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-white text-xs text-center placeholder-white/25 focus:outline-none focus:border-sky-500"
                            />
                          </div>
                          <p className="text-white/25 text-[11px] px-0.5">{t("lead.hint")}</p>
                        </div>
                      )}

                      <IntentPicker value={form.intent} onChange={v => set("intent", v)} />

                      <TimeZonePin value={form.time_zone} onChange={v => set("time_zone", v)} />

                      <TaskImagePicker
                        value={form.cover_image}
                        onChange={v => set("cover_image", v)}
                        category={form.category}
                      />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Footer. The complaint sits directly above the button that
                triggered it, so the problem and the thing that caused it are in
                one glance. Nothing is blocked and nothing chimes. */}
            <div className="px-6 pt-3 pb-5 border-t border-white/[0.07] space-y-2.5">
              {error && (
                <p className="text-red-300/90 text-xs flex items-start gap-1.5">
                  <AlertCircle size={13} className="shrink-0 mt-px" />
                  <span>{error}</span>
                </p>
              )}
              <button onClick={handleSubmit}
                className="w-full py-3 bg-gradient-to-r from-purple-600 to-indigo-600 rounded-xl text-white font-semibold text-sm flex items-center justify-center gap-2 hover:brightness-110 active:scale-[0.99] transition-all">
                <Plus size={16} />
                {t("addTask.submit")}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}