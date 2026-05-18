import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Send, Sparkles, Check, Edit3, Brain, Trash2, Clock, Star } from "lucide-react";
import {
  smartParse, saveHabit, getTopHabits, QUICK_PRESETS,
  ParsedTask, AIIntent, pushHistory, clearHistory,
} from "../lib/smartAI";
import { createTask, deleteTaskByName, updateTaskTime, updateTaskPriority } from "../lib/database";
import { Category, ResetType } from "../types";
import { t } from "../lib/i18n";

interface Props {
  open: boolean;
  onClose: () => void;
  onTaskAdded: () => void;
}

type ChatStep = "idle" | "thinking" | "preview" | "confirmed";

const CATEGORY_EMOJI: Record<string, string> = {
  game: "🎮", school: "📚", work: "💼", personal: "✨"
};
const TYPE_LABEL: Record<string, string> = {
  daily: "Daily", weekly: "Weekly", biweekly: "Biweekly",
  custom_days: "Custom", one_time: "One-time",
  event_window: "🎌 Limited", specific_date: "📌 One-Time"
};

interface ChatMessage {
  role: "user" | "ai";
  text: string;
  isAction?: boolean; // for confirmed actions
}

// Intent display config
const INTENT_CONFIG: Record<AIIntent, { icon: React.FC<any>; color: string; labelKey: string }> = {
  add:            { icon: Sparkles,  color: "from-purple-600 to-indigo-600", labelKey: "ai.intentAdding" },
  delete:         { icon: Trash2,    color: "from-red-600 to-rose-600",      labelKey: "ai.intentDeleting" },
  edit_time:      { icon: Clock,     color: "from-blue-600 to-cyan-600",     labelKey: "ai.intentEditTime" },
  edit_name:      { icon: Edit3,     color: "from-amber-600 to-orange-600",  labelKey: "ai.intentEditName" },
  edit_priority:  { icon: Star,      color: "from-yellow-600 to-amber-600",  labelKey: "ai.intentPriority" },
  clarify:        { icon: Brain,     color: "from-gray-600 to-gray-500",     labelKey: "ai.intentClarify" },
  unknown:        { icon: Sparkles,  color: "from-purple-600 to-indigo-600", labelKey: "ai.intentAdding" },
};

export default function AIChatModal({ open, onClose, onTaskAdded }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [step, setStep] = useState<ChatStep>("idle");
  const [previewTasks, setPreviewTasks] = useState<ParsedTask[]>([]);
  const [selectedTaskIdx, setSelectedTaskIdx] = useState<number | null>(null);
  const [confidence, setConfidence] = useState(0);
  const [confDetails, setConfDetails] = useState<{ field: string; value: string; sure: boolean }[]>([]);
  const [isMulti, setIsMulti] = useState(false);
  const [currentIntent, setCurrentIntent] = useState<AIIntent>("add");
  const [pendingAction, setPendingAction] = useState<{
    intent: AIIntent;
    targetName?: string;
    newTime?: string;
    newPriority?: boolean;
  } | null>(null);
  const [habits, setHabits] = useState(getTopHabits(3));
  const lastUserInput = useRef("");
  const inputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  const closeNow = () => {
    if (backdropRef.current) {
      backdropRef.current.style.pointerEvents = "none";
      (backdropRef.current.style as any).backdropFilter = "none";
      (backdropRef.current.style as any).webkitBackdropFilter = "none";
    }
    onClose();
  };

  useEffect(() => {
    if (open) {
      clearHistory();
      setMessages([{
        role: "ai",
        text: t("ai.greeting"),
      }]);
      setStep("idle");
      setPreviewTasks([]);
      setPendingAction(null);
      setHabits(getTopHabits(3));
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [open]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, step, previewTasks]);

  const addMsg = (msg: ChatMessage) => setMessages(m => [...m, msg]);

  const sendMessage = async (text?: string) => {
    const msg = (text || input).trim();
    if (!msg || step === "thinking") return;
    lastUserInput.current = msg;
    setInput("");
    addMsg({ role: "user", text: msg });

    // If there's a live preview and user is correcting, apply field patches inline
    if (step === "preview" && previewTasks.length > 0 && isCorrectionMsg(msg)) {
      setStep("thinking");
      await new Promise(r => setTimeout(r, 400));

      // Try to extract correction patches from the message
      const lower = msg.toLowerCase();

      // Category correction
      const catMap: [string[], string][] = [
        [["food","กิน","อาหาร","ข้าว"], "food"],
        [["transport","รถ","เดินทาง","grab","taxi"], "transport"],
        [["game","เกม","gacha"], "game"],
        [["school","เรียน","การศึกษา"], "school"],
        [["work","งาน","ออฟฟิศ"], "work"],
        [["personal","ส่วนตัว"], "personal"],
        [["shopping","ซื้อ","ช้อป"], "shopping"],
        [["health","ยา","หมอ"], "health"],
        [["bills","ค่าน้ำ","ค่าไฟ","bill"], "bills"],
        [["entertainment","บันเทิง","หนัง"], "entertainment"],
      ];

      // Time correction
      const timeMatch = msg.match(/(\d{1,2})[:.：](\d{2})|(\d{1,2})\s*(am|pm|โมง|นาฬิกา)/i);
      // Name correction
      const nameMatch = msg.match(/(?:ชื่อ|name|เป็น|to|called?)\s+["""']?(.+?)["""']?$/i);
      // Reset type correction
      const typePatches: [RegExp, string][] = [
        [/daily|ทุกวัน|รายวัน/, "daily"],
        [/weekly|ทุกอาทิตย์|รายสัปดาห์/, "weekly"],
        [/biweekly|สองอาทิตย์/, "biweekly"],
      ];

      let patched = false;
      const updated = previewTasks.map((task, idx) => {
        let t = { ...task };
        const newChanged = new Set(changedFields);

        for (const [keys, cat] of catMap) {
          if (keys.some(k => lower.includes(k)) && t.category !== cat) {
            t = { ...t, category: cat as any };
            newChanged.add(`${idx}-category`);
            patched = true;
          }
        }
        if (timeMatch) {
          let h = parseInt(timeMatch[1] || timeMatch[3]);
          const m = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
          const period = (timeMatch[4] || "").toLowerCase();
          if (period === "pm" && h !== 12) h += 12;
          if (period === "am" && h === 12) h = 0;
          const newTime = `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`;
          t = { ...t, reset_time: newTime };
          newChanged.add(`${idx}-reset_time`);
          patched = true;
        }
        if (nameMatch?.[1]) {
          t = { ...t, name: nameMatch[1].trim() };
          newChanged.add(`${idx}-name`);
          patched = true;
        }
        for (const [re, rtype] of typePatches) {
          if (re.test(lower)) {
            t = { ...t, reset_type: rtype as any };
            newChanged.add(`${idx}-reset_type`);
            patched = true;
          }
        }
        setChangedFields(newChanged);
        return t;
      });

      if (patched) {
        setPreviewTasks(updated);
        addMsg({ role: "ai", text: "✏️ Updated! Check the preview and confirm when ready." });
        setStep("preview");
        return;
      }
      // Fall through to normal parse if nothing matched
      setStep("thinking");
    } else {
      setStep("thinking");
    }

    await new Promise(r => setTimeout(r, 750));

    const result = smartParse(msg);

    // Push to conversation history for context memory
    pushHistory({ userText: msg, result, timestamp: Date.now() });

    setCurrentIntent(result.intent);
    setConfidence(result.confidence);
    setConfDetails(result.details);

    addMsg({ role: "ai", text: result.reply });

    if (result.needsClarification && result.clarificationQuestion) {
      addMsg({ role: "ai", text: result.clarificationQuestion });
      setStep("idle");
      return;
    }

    // Non-add intents: show confirm card (not task preview)
    if (result.intent !== "add") {
      setPendingAction({
        intent: result.intent,
        targetName: result.targetTaskName,
        newTime: result.newTime,
        newPriority: result.newPriority,
      });
      setPreviewTasks([]);
      setStep("preview");
      return;
    }

    // Add intent
    setPreviewTasks(result.tasks);
    setIsMulti(result.isMulti);
    setSelectedTaskIdx(null);
    setPendingAction(null);
    setStep("preview");
  };

  const [changedFields, setChangedFields] = useState<Set<string>>(new Set());

  const editTask = (idx: number, field: string, value: any) => {
    setPreviewTasks(t => t.map((task, i) => i === idx ? { ...task, [field]: value } : task));
    setChangedFields(prev => new Set([...prev, `${idx}-${field}`]));
  };

  // ── Confirm: ADD ──────────────────────────────────────────
  const confirmAdd = async () => {
    let count = 0;
    for (const task of previewTasks) {
      try { await createTask(task); count++; } catch (e) { console.error(e); }
    }
    if (previewTasks.length > 0) saveHabit(lastUserInput.current, previewTasks[0]);
    closeNow();
    setTimeout(() => onTaskAdded(), 80);
  };

  // ── Confirm: DELETE ───────────────────────────────────────
  const confirmDelete = async () => {
    if (!pendingAction?.targetName) return;
    try {
      await deleteTaskByName(pendingAction.targetName);
      closeNow();
      setTimeout(() => onTaskAdded(), 80);
    } catch {
      addMsg({ role: "ai", text: t("ai.notFound", { name: pendingAction.targetName! }) });
      setStep("idle");
    }
  };

  // ── Confirm: EDIT TIME ────────────────────────────────────
  const confirmEditTime = async () => {
    if (!pendingAction?.targetName || !pendingAction.newTime) return;
    try {
      await updateTaskTime(pendingAction.targetName, pendingAction.newTime);
      closeNow();
      setTimeout(() => onTaskAdded(), 80);
    } catch {
      addMsg({ role: "ai", text: t("ai.notFound", { name: pendingAction.targetName }) });
      setStep("idle");
    }
  };

  // ── Confirm: EDIT PRIORITY ────────────────────────────────
  const confirmEditPriority = async () => {
    if (!pendingAction?.targetName) return;
    const val = pendingAction.newPriority ? 1 : 0;
    try {
      await updateTaskPriority(pendingAction.targetName, val);
      closeNow();
      setTimeout(() => onTaskAdded(), 80);
    } catch {
      addMsg({ role: "ai", text: t("ai.notFound", { name: pendingAction.targetName }) });
      setStep("idle");
    }
  };

  const cancelPreview = () => {
    setStep("idle");
    setPreviewTasks([]);
    setPendingAction(null);
    setChangedFields(new Set());
    addMsg({ role: "ai", text: t("ai.cancelled") });
  };

  // Detect correction messages so we can amend rather than discard the preview
  const isCorrectionMsg = (msg: string) =>
    /^(no[,.]?|wait[,.]?|actually|แก้|เปลี่ยน|ไม่ใช่|หมายถึง|อ๋อ|เอาใหม่|ขอแก้|fix|change|make it|แก้เป็น|เปลี่ยนเป็น|ไม่ถูก)/i.test(msg.trim());

  const confidenceColor = confidence > 0.8 ? "text-green-400" : confidence > 0.5 ? "text-yellow-400" : "text-orange-400";
  const intentCfg = INTENT_CONFIG[currentIntent] || INTENT_CONFIG.add;
  const IntentIcon = intentCfg.icon;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          ref={backdropRef}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          onClick={closeNow}
        >
          <motion.div
            initial={{ scale: 0.92, opacity: 0, y: 20 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.92, opacity: 0, y: 20 }}
            onClick={e => e.stopPropagation()}
            className="bg-gray-950 border border-white/10 rounded-3xl w-full max-w-lg shadow-2xl flex flex-col overflow-hidden"
            style={{ height: "620px" }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-white/8 flex-shrink-0">
              <div className="flex items-center gap-2.5">
                <div className={`w-8 h-8 rounded-xl bg-gradient-to-br ${intentCfg.color} flex items-center justify-center transition-all duration-300`}>
                  <IntentIcon size={15} className="text-white" />
                </div>
                <div>
                  <p className="text-white font-bold text-sm">AI Assistant</p>
                  <p className="text-white/30 text-xs">{t("ai.subtitle")}</p>
                </div>
              </div>
              <button onClick={closeNow} className="text-white/30 hover:text-white p-1 transition-colors">
                <X size={18} />
              </button>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">

              {/* Habits + quick presets (fresh state) */}
              {messages.length <= 1 && step === "idle" && (
                <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="space-y-3">
                  {habits.length > 0 && (
                    <div>
                      <p className="text-white/25 text-xs mb-1.5 flex items-center gap-1"><Brain size={10} />{t("ai.recentLabel")}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {habits.map((h, i) => (
                          <button key={i} onClick={() => sendMessage(h.input)}
                            className="px-2.5 py-1 bg-purple-600/15 border border-purple-500/20 rounded-lg text-xs text-purple-300 hover:bg-purple-600/30 hover:text-white transition-all">
                            🧠 {h.result.name || h.input}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <div>
                    <p className="text-white/25 text-xs mb-1.5">{t("ai.quickAdd")}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {QUICK_PRESETS.map(p => (
                        <button key={p.label} onClick={() => sendMessage(p.input)}
                          className="px-2.5 py-1 bg-white/5 border border-white/10 rounded-lg text-xs text-white/50 hover:bg-white/10 hover:text-white transition-all">
                          {p.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </motion.div>
              )}

              {/* Message bubbles */}
              {messages.map((msg, i) => (
                <motion.div key={i} initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }}
                  className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[85%] px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed whitespace-pre-line ${
                    msg.role === "user"
                      ? "bg-purple-600 text-white rounded-br-sm"
                      : msg.isAction
                        ? "bg-green-900/40 border border-green-500/30 text-green-300 rounded-bl-sm"
                        : "bg-white/8 text-white/85 rounded-bl-sm border border-white/8"
                  }`}>{msg.text}</div>
                </motion.div>
              ))}

              {/* Thinking dots */}
              {step === "thinking" && (
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex justify-start">
                  <div className="bg-white/8 border border-white/8 rounded-2xl rounded-bl-sm px-4 py-3 flex gap-1.5 items-center">
                    {[0,1,2].map(i => (
                      <motion.div key={i} className="w-1.5 h-1.5 bg-purple-400 rounded-full"
                        animate={{ opacity: [0.3,1,0.3], y: [0,-3,0] }}
                        transition={{ duration: 0.8, delay: i * 0.15, repeat: Infinity }} />
                    ))}
                    <span className="text-white/30 text-xs ml-1">{t("ai.thinking")}</span>
                  </div>
                </motion.div>
              )}

              {/* Preview card */}
              {step === "preview" && (
                <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
                  className="bg-white/5 border border-white/12 rounded-2xl overflow-hidden">

                  {/* Confidence bar */}
                  <div className="px-4 pt-3 pb-2.5 border-b border-white/8">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-white/40 text-xs flex items-center gap-1.5">
                        <IntentIcon size={11} />
                        {t(intentCfg.labelKey as any)}
                      </span>
                      <span className={`text-xs font-bold ${confidenceColor}`}>
                        {Math.round(confidence * 100)}%
                        {isMulti && previewTasks.length > 1 && (
                          <span className="ml-2 text-purple-400">· {previewTasks.length} tasks</span>
                        )}
                      </span>
                    </div>
                    <div className="h-1 bg-white/10 rounded-full overflow-hidden mb-2">
                      <motion.div
                        className={`h-full rounded-full bg-gradient-to-r ${intentCfg.color}`}
                        initial={{ width: 0 }} animate={{ width: `${confidence * 100}%` }}
                        transition={{ duration: 0.5 }} />
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {confDetails.slice(0, 5).map((d, i) => (
                        <span key={i} className={`text-xs px-2 py-0.5 rounded-full border ${
                          d.sure ? "bg-green-500/10 text-green-400 border-green-500/20"
                                 : "bg-yellow-500/10 text-yellow-400 border-yellow-500/20"
                        }`}>{d.field}: {d.value}</span>
                      ))}
                    </div>
                  </div>

                  {/* ── Non-add intent confirm card ─────────── */}
                  {pendingAction && pendingAction.intent !== "add" && (
                    <div className="p-4 space-y-3">
                      {pendingAction.intent === "delete" && (
                        <div className="flex items-center gap-3 p-3 bg-red-500/10 border border-red-500/20 rounded-xl">
                          <Trash2 size={18} className="text-red-400 flex-shrink-0" />
                          <div>
                            <p className="text-white text-sm font-semibold">{t("ai.deleteLabel", { name: pendingAction.targetName! })}</p>
                            <p className="text-white/40 text-xs">{t("ai.deleteWarn")}</p>
                          </div>
                        </div>
                      )}
                      {pendingAction.intent === "edit_time" && (
                        <div className="space-y-2">
                          <div className="flex items-center gap-3 p-3 bg-blue-500/10 border border-blue-500/20 rounded-xl">
                            <Clock size={18} className="text-blue-400 flex-shrink-0" />
                            <div className="flex-1">
                              <p className="text-white text-sm font-semibold">"{pendingAction.targetName}"</p>
                              <p className="text-white/40 text-xs">{t("ai.changeTimeTo")}</p>
                            </div>
                          </div>
                          <input type="time" value={pendingAction.newTime || "00:00"}
                            onChange={e => setPendingAction(p => p ? { ...p, newTime: e.target.value } : p)}
                            className="w-full bg-gray-800 border border-white/10 rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-blue-500" />
                        </div>
                      )}
                      {pendingAction.intent === "edit_priority" && (
                        <div className="flex items-center gap-3 p-3 bg-yellow-500/10 border border-yellow-500/20 rounded-xl">
                          <Star size={18} className="text-yellow-400 flex-shrink-0" />
                          <div>
                            <p className="text-white text-sm font-semibold">"{pendingAction.targetName}"</p>
                              <p className="text-white/40 text-xs">
                              {pendingAction.newPriority ? t("ai.priorityOn") : t("ai.priorityOff")}
                            </p>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* ── Add task cards ──────────────────────── */}
                  {previewTasks.length > 0 && (
                    <div className="px-3 pt-2 pb-2 space-y-2">
                      {/* Multi-task tabs */}
                      {isMulti && previewTasks.length > 1 && (
                        <div className="flex gap-1.5 pb-1">
                          {previewTasks.map((t, i) => (
                            <button key={i} onClick={() => setSelectedTaskIdx(selectedTaskIdx === i ? null : i)}
                              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold transition-all ${
                                selectedTaskIdx === i ? "bg-purple-600 text-white" : "bg-white/8 text-white/50 hover:text-white hover:bg-white/12"
                              }`}>
                              {CATEGORY_EMOJI[t.category]} {t.name}
                              <Edit3 size={10} className="opacity-50" />
                            </button>
                          ))}
                        </div>
                      )}

                      {previewTasks.map((task, idx) => {
                        const isExpanded = !isMulti || selectedTaskIdx === idx;
                        return (
                          <div key={idx} className={`rounded-xl overflow-hidden ${isMulti ? "border border-white/8" : ""}`}>
                            {/* Collapsed row for multi */}
                            {isMulti && !isExpanded && (
                              <button onClick={() => setSelectedTaskIdx(idx)}
                                className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-white/5 transition-all">
                                <span className="text-base">{CATEGORY_EMOJI[task.category]}</span>
                                <div className="flex-1 text-left">
                                  <p className="text-white text-sm font-semibold">{task.name}</p>
                                  {task.description && <p className="text-white/40 text-xs">{task.description}</p>}
                                </div>
                                <div className="flex items-center gap-2">
                                  <span className="text-xs text-white/30">{task.specific_date || TYPE_LABEL[task.reset_type]}</span>
                                  {task.is_priority ? <span className="text-yellow-400 text-xs">⭐</span> : null}
                                </div>
                              </button>
                            )}

                            {/* Expanded edit form */}
                            {isExpanded && (
                              <div className="p-3 space-y-2">
                                <div className="flex items-center gap-2">
                                  <span className="text-white/30 text-xs w-16 flex-shrink-0">Name</span>
                                  <input value={task.name} onChange={e => editTask(idx, "name", e.target.value)}
                                    className={`flex-1 border rounded-lg px-2.5 py-1.5 text-white text-sm focus:outline-none transition-all ${
                                      changedFields.has(`${idx}-name`) ? "bg-green-500/10 border-green-500/40" : "bg-white/8 border-white/10 focus:border-purple-500"
                                    }`} />
                                  {changedFields.has(`${idx}-name`) && <span className="text-green-400 text-xs">✓</span>}
                                </div>
                                {task.description && (
                                  <div className="flex items-center gap-2">
                                    <span className="text-white/30 text-xs w-16 flex-shrink-0">Desc</span>
                                    <span className="text-white/60 text-xs font-mono bg-white/5 px-2 py-1 rounded-lg">{task.description}</span>
                                  </div>
                                )}
                                <div className="flex items-center gap-2">
                                  <span className="text-white/30 text-xs w-16 flex-shrink-0">Category</span>
                                  <div className="flex gap-1 flex-wrap">
                                    {(["game","school","work","personal"] as Category[]).map(c => (
                                      <button key={c} onClick={() => editTask(idx, "category", c)}
                                        className={`px-2 py-0.5 rounded-lg text-xs transition-all ${
                                          task.category === c
                                            ? changedFields.has(`${idx}-category`) ? "bg-green-500/20 border border-green-500/40 text-green-300" : "bg-purple-600 text-white"
                                            : "bg-white/5 text-white/40 hover:text-white"
                                        }`}>
                                        {CATEGORY_EMOJI[c]} {c}
                                      </button>
                                    ))}
                                  </div>
                                  {changedFields.has(`${idx}-category`) && <span className="text-green-400 text-xs">✓</span>}
                                </div>
                                <div className="flex items-center gap-2">
                                  <span className="text-white/30 text-xs w-16 flex-shrink-0">Type</span>
                                  <div className="flex flex-wrap gap-1">
                                    {(["daily","weekly","specific_date","event_window"] as ResetType[]).map(rt => (
                                      <button key={rt} onClick={() => editTask(idx, "reset_type", rt)}
                                        className={`px-2 py-0.5 rounded-lg text-xs transition-all ${
                                          task.reset_type === rt
                                            ? changedFields.has(`${idx}-reset_type`) ? "bg-green-500/20 border border-green-500/40 text-green-300" : "bg-indigo-600 text-white"
                                            : "bg-white/5 text-white/40 hover:text-white"
                                        }`}>
                                        {TYPE_LABEL[rt]}
                                      </button>
                                    ))}
                                  </div>
                                  {changedFields.has(`${idx}-reset_type`) && <span className="text-green-400 text-xs">✓</span>}
                                </div>
                                {task.reset_type === "event_window" && task.event_end && (
                                  <div className="flex items-center gap-2">
                                    <span className="text-white/30 text-xs w-16 flex-shrink-0">Deadline</span>
                                    <span className="text-red-400 text-xs font-mono bg-white/5 px-2 py-1 rounded-lg">
                                      {(() => { const d = new Date(task.event_end!); return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")} (${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")})`; })()}
                                    </span>
                                  </div>
                                )}
                                {task.reset_type === "specific_date" && (
                                  <div className="flex items-center gap-2">
                                    <span className="text-white/30 text-xs w-16 flex-shrink-0">Date</span>
                                    <input type="date" value={task.specific_date || ""}
                                      onChange={e => editTask(idx, "specific_date", e.target.value)}
                                      className={`border rounded-lg px-2 py-1 text-white text-xs focus:outline-none transition-all ${
                                        changedFields.has(`${idx}-specific_date`) ? "bg-green-500/10 border-green-500/40" : "bg-gray-800 border-white/10 focus:border-purple-500"
                                      }`} />
                                    {changedFields.has(`${idx}-specific_date`) && <span className="text-green-400 text-xs">✓</span>}
                                  </div>
                                )}
                                {["daily","weekly","biweekly"].includes(task.reset_type) && (
                                  <div className="flex items-center gap-2">
                                    <span className="text-white/30 text-xs w-16 flex-shrink-0">Time</span>
                                    <input type="time" value={task.reset_time || "00:00"}
                                      onChange={e => editTask(idx, "reset_time", e.target.value)}
                                      className={`border rounded-lg px-2 py-1 text-white text-xs focus:outline-none transition-all ${
                                        changedFields.has(`${idx}-reset_time`) ? "bg-green-500/10 border-green-500/40" : "bg-gray-800 border-white/10 focus:border-purple-500"
                                      }`} />
                                    {changedFields.has(`${idx}-reset_time`) && <span className="text-green-400 text-xs">✓</span>}
                                  </div>
                                )}
                                <div className="flex items-center gap-2">
                                  <span className="text-white/30 text-xs w-16 flex-shrink-0">Priority</span>
                                  <button onClick={() => editTask(idx, "is_priority", task.is_priority ? 0 : 1)}
                                    className={`px-2.5 py-0.5 rounded-lg text-xs font-semibold transition-all ${
                                      task.is_priority
                                        ? changedFields.has(`${idx}-is_priority`) ? "bg-green-500/15 border border-green-500/30 text-green-300" : "bg-yellow-500/20 text-yellow-300 border border-yellow-500/30"
                                        : "bg-white/5 text-white/40 hover:text-white"
                                    }`}>
                                    {task.is_priority ? "⭐ Important" : "☆ Normal"}
                                  </button>
                                  {changedFields.has(`${idx}-is_priority`) && <span className="text-green-400 text-xs">✓</span>}
                                </div>
                                {changedFields.size === 0 && (
                                  <p className="text-white/15 text-[10px] italic pt-1">
                                    💬 Tip: type "actually weekly" or "change to game" to correct via chat
                                  </p>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Action buttons */}
                  <div className="flex gap-2 px-3 pb-3">
                    <button
                      onClick={() => {
                        if (pendingAction?.intent === "delete") confirmDelete();
                        else if (pendingAction?.intent === "edit_time") confirmEditTime();
                        else if (pendingAction?.intent === "edit_priority") confirmEditPriority();
                        else confirmAdd();
                      }}
                      className={`flex-1 py-2.5 bg-gradient-to-r ${intentCfg.color} rounded-xl text-white text-sm font-bold flex items-center justify-center gap-2 hover:opacity-90 transition-all`}>
                      <Check size={15} />
                      {pendingAction?.intent === "delete" ? t("ai.btnDelete") :
                       pendingAction?.intent === "edit_time" ? t("ai.btnUpdateTime") :
                       pendingAction?.intent === "edit_priority" ? t("ai.btnConfirm") :
                       previewTasks.length > 1 ? t("ai.btnSaveMulti", { n: previewTasks.length }) : t("ai.btnSaveOrSave")}
                    </button>
                    <button onClick={cancelPreview}
                      className="px-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-white/50 text-sm hover:text-white transition-all">
                      {t("ai.btnCancel")}
                    </button>
                  </div>
                </motion.div>
              )}

              <div ref={bottomRef} />
            </div>

            {/* Input */}
            <div className="px-4 pb-4 pt-2 border-t border-white/8 flex-shrink-0">
              <div className="flex gap-2 items-center">
                <div className="flex-1 relative">
                  <input ref={inputRef} value={input}
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && !e.shiftKey && sendMessage()}
                    placeholder={t("ai.placeholder")}
                    disabled={step === "thinking"}
                    className="w-full bg-white/6 border border-white/10 rounded-xl pl-4 pr-10 py-2.5 text-white placeholder-white/25 text-sm focus:outline-none focus:border-purple-500 disabled:opacity-40 transition-all" />
                  <Sparkles size={13} className="absolute right-3 top-1/2 -translate-y-1/2 text-purple-400/40" />
                </div>
                <button onClick={() => sendMessage()} disabled={!input.trim() || step === "thinking"}
                  className={`w-10 h-10 rounded-xl bg-gradient-to-r ${intentCfg.color} flex items-center justify-center text-white disabled:opacity-30 hover:opacity-90 transition-all flex-shrink-0`}>
                  <Send size={16} />
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}