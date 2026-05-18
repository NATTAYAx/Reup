// UnifiedAIChat.tsx — Gemini-powered with offline local fallback
// KEY FIX: No AnimatePresence/motion on outer backdrop.
// Uses "if (!open) return null" so the DOM element is completely gone when closed.

import { useState, useRef, useEffect } from "react";
import { motion } from "framer-motion";
import { X, Send, Sparkles, Brain, Wallet, CheckCircle, Wifi, WifiOff, Key } from "lucide-react";
import {
  saveHabit, getTopHabits, QUICK_PRESETS,
  pushHistory, clearHistory, smartParse,
} from "../lib/smartAI";
import {
  createTask, deleteTaskByName, updateTaskTime, updateTaskPriority,
  addIncome, getMonthIncome,
} from "../lib/database";
import {
  aiLogExpense, aiDeleteExpenseByKeyword, aiEditExpenseByKeyword,
  getSpendingSummary, getTodayTotal, getMonthTotal,
  EXPENSE_CATEGORIES, ExpenseCategory,
} from "../lib/financeDatabase";
import {
  processMessage, getGeminiKey, setGeminiKey, isOnline,
  GeminiTaskResponse, GeminiFinanceResponse,
} from "../lib/geminiService";
import { t } from "../lib/i18n";

interface Props {
  open: boolean;
  onClose: () => void;
  onTaskAdded: () => void;
  onFinanceChanged?: () => void;
}

type Domain = "task" | "finance" | "query";

interface ChatMessage {
  role: "user" | "ai";
  text: string;
  domain?: Domain;
  source?: "gemini" | "local"; // shows which backend answered
}

const getTodayBangkok = () => {
  const bkk = new Date(Date.now() + 7 * 3600000);
  return bkk.toISOString().split("T")[0];
};

const fmt = (n: number) => `฿${n.toLocaleString("th-TH")}`;

const DOMAIN_BADGE: Record<Domain, { label: string; color: string; icon: React.FC<any> }> = {
  task:    { label: "Tasks",   color: "from-purple-600 to-indigo-600", icon: CheckCircle },
  finance: { label: "Finance", color: "from-yellow-600 to-amber-500",  icon: Wallet },
  query:   { label: "Query",   color: "from-gray-600 to-gray-500",     icon: Brain },
};

export default function UnifiedAIChat({ open, onClose, onTaskAdded, onFinanceChanged }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [habits, setHabits] = useState(getTopHabits(3));
  const [online, setOnline] = useState(true);
  const [showKeyInput, setShowKeyInput] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");

  const inputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const isConfirming = useRef(false);

  const [pendingTask, setPendingTask] = useState<{
    type: "add" | "delete" | "edit_time" | "edit_priority";
    tasks?: any[];
    targetName?: string;
    newTime?: string;
    newPriority?: boolean;
  } | null>(null);

  const [pendingFinance, setPendingFinance] = useState<{
    intent: "log_expense" | "delete_expense" | "edit_expense" | "query_spending" | "log_income";
    amount?: number;
    category?: ExpenseCategory;
    note?: string;
    keyword?: string;
    newAmount?: number;
    incomeAmount?: number;
    incomeNote?: string;
  } | null>(null);

  const addMsg = (msg: ChatMessage) => setMessages(m => [...m, msg]);

  // Check online status on open
  useEffect(() => {
    if (open) {
      clearHistory();
      const key = getGeminiKey();
      const greeting = key
        ? t("ai.unifiedGreeting")
        : `${t("ai.unifiedGreeting")}\n\n💡 เพิ่ม Gemini API key เพื่อให้ AI เข้าใจภาษาไทยได้ดีขึ้น (ฟรี)`;
      setMessages([{ role: "ai", text: greeting }]);
      setPendingTask(null);
      setPendingFinance(null);
      setHabits(getTopHabits(3));
      setShowKeyInput(false);
      setKeyDraft(getGeminiKey());
      setTimeout(() => inputRef.current?.focus(), 100);
      // Check connectivity
      isOnline().then(setOnline);
    }
  }, [open]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, pendingTask, pendingFinance]);

  const isCorrectionMessage = (msg: string): boolean =>
    /^(no[,.]?|wait[,.]?|actually|แก้|เปลี่ยน|ไม่ใช่|หมายถึง|อ๋อ|เอาใหม่|ขอแก้|fix|change|make it|แก้เป็น|เปลี่ยนเป็น|ไม่ถูก)/i.test(msg.trim());

  // ── Main send handler ─────────────────────────────────────────
  const sendMessage = async (text?: string) => {
    const msg = (text || input).trim();
    if (!msg || loading) return;
    setInput("");
    addMsg({ role: "user", text: msg });
    setLoading(true);

    const isCorrection = isCorrectionMessage(msg) && (pendingTask !== null || pendingFinance !== null);
    if (!isCorrection) {
      setPendingTask(null);
      setPendingFinance(null);
    }

    await new Promise(r => setTimeout(r, 400));

    try {
      // ── Build context for finance queries ───────────────────
      let context: string | undefined;
      const mightBeFinance = /ใช้จ่าย|สรุป|เดือนนี้|ยอด|บาท|฿|summary|spending|income|รายได้/i.test(msg);
      if (mightBeFinance) {
        try {
          const today = getTodayBangkok();
          const month = today.slice(0, 7);
          const [todayAmt, monthAmt, summary] = await Promise.all([
            getTodayTotal(today), getMonthTotal(month), getSpendingSummary(),
          ]);
          context = `User spending — Today: ${fmt(todayAmt)}, This month: ${fmt(monthAmt)}, Breakdown: ${summary}`;
        } catch { /* ignore */ }
      }

      // ── Call AI (Gemini or local) ────────────────────────────
      const { source, response } = await processMessage(msg, { context });

      // Update online status indicator
      setOnline(source === "gemini");

      // ── Route by domain ──────────────────────────────────────
      if (response.domain === "chat") {
        addMsg({ role: "ai", text: response.reply, source });
        setLoading(false);
        return;
      }

      if (response.domain === "finance") {
        const fr = response as GeminiFinanceResponse;
        addMsg({ role: "ai", text: fr.reply, domain: "finance", source });

        if (fr.intent === "query_spending") {
          // Already replied with summary text — done
          setLoading(false);
          return;
        }
        if (fr.intent === "log_income" && fr.incomeAmount) {
          const today = getTodayBangkok();
          await addIncome({
            amount: fr.incomeAmount,
            source: "other",
            note: fr.incomeNote || "income",
            date: today,
          });
          const monthIncome = await getMonthIncome(today.slice(0, 7));
          addMsg({ role: "ai", text: `✅ บันทึกรายรับ ${fmt(fr.incomeAmount)} แล้ว (เดือนนี้รวม ${fmt(monthIncome)})`, domain: "finance", source });
          onFinanceChanged?.();
          setLoading(false);
          return;
        }
        if (fr.intent === "log_expense") {
          setPendingFinance({
            intent: "log_expense",
            amount: fr.amount,
            category: (fr.category as ExpenseCategory) || "other",
            note: fr.note || "",
          });
        } else if (fr.intent === "delete_expense") {
          setPendingFinance({ intent: "delete_expense", keyword: fr.keyword });
        } else if (fr.intent === "edit_expense") {
          setPendingFinance({ intent: "edit_expense", keyword: fr.keyword, newAmount: fr.newAmount });
        }
        setLoading(false);
        return;
      }

      // ── Task domain ──────────────────────────────────────────
      if (response.domain === "task") {
        const tr = response as GeminiTaskResponse;
        addMsg({ role: "ai", text: tr.reply, domain: "task", source });

        if (tr.intent === "delete") {
          setPendingTask({ type: "delete", targetName: tr.targetTaskName });
        } else if (tr.intent === "edit_time") {
          setPendingTask({ type: "edit_time", targetName: tr.targetTaskName, newTime: tr.newTime });
        } else if (tr.intent === "edit_priority") {
          setPendingTask({ type: "edit_priority", targetName: tr.targetTaskName, newPriority: tr.newPriority });
        } else if (tr.intent === "add" && tr.tasks?.length > 0) {
          setPendingTask({ type: "add", tasks: tr.tasks });
          saveHabit(msg, tr.tasks[0]);
          setHabits(getTopHabits(3));
          // Also push to conversation history for context
          const localResult = smartParse(msg);
          pushHistory({ userText: msg, result: localResult, timestamp: Date.now() });
        }
        setLoading(false);
        return;
      }

    } catch (e: any) {
      console.error("[UnifiedAIChat] sendMessage error:", e);
      addMsg({ role: "ai", text: t("ai.errorRetry") });
    }

    setLoading(false);
  };

  // ── Confirm finance ───────────────────────────────────────────
  const confirmFinance = async () => {
    if (!pendingFinance) return;
    try {
      if (pendingFinance.intent === "log_expense") {
        await aiLogExpense(pendingFinance.amount!, pendingFinance.category!, pendingFinance.note!);
        onFinanceChanged?.();
      } else if (pendingFinance.intent === "delete_expense") {
        await aiDeleteExpenseByKeyword(pendingFinance.keyword!);
        onFinanceChanged?.();
      } else if (pendingFinance.intent === "edit_expense") {
        await aiEditExpenseByKeyword(pendingFinance.keyword!, { amount: pendingFinance.newAmount });
        onFinanceChanged?.();
      }
      setPendingFinance(null);
      addMsg({ role: "ai", text: t("ai.saved"), domain: "finance" });
    } catch (e: any) {
      addMsg({ role: "ai", text: `❌ ${e.message ?? "ไม่สำเร็จ"}` });
      setPendingFinance(null);
    }
  };

  // ── Confirm task ──────────────────────────────────────────────
  const confirmTask = async () => {
    if (!pendingTask || isConfirming.current) return;
    isConfirming.current = true;
    try {
      if (pendingTask.type === "add" && pendingTask.tasks) {
        for (const task of pendingTask.tasks) await createTask(task);
      } else if (pendingTask.type === "delete" && pendingTask.targetName) {
        await deleteTaskByName(pendingTask.targetName);
      } else if (pendingTask.type === "edit_time" && pendingTask.targetName && pendingTask.newTime) {
        await updateTaskTime(pendingTask.targetName, pendingTask.newTime);
      } else if (pendingTask.type === "edit_priority" && pendingTask.targetName) {
        await updateTaskPriority(pendingTask.targetName, pendingTask.newPriority ? 1 : 0);
      }
      setPendingTask(null);
      onClose();
      setTimeout(() => onTaskAdded(), 80);
    } catch (e: any) {
      addMsg({ role: "ai", text: `❌ ${e.message ?? "ไม่สำเร็จ"}` });
      setPendingTask(null);
    } finally {
      isConfirming.current = false;
    }
  };

  const cancelPending = () => {
    setPendingTask(null);
    setPendingFinance(null);
    addMsg({ role: "ai", text: t("ai.cancelled") });
  };

  const saveKey = () => {
    setGeminiKey(keyDraft);
    setShowKeyInput(false);
    addMsg({ role: "ai", text: keyDraft
      ? "✅ บันทึก Gemini API key แล้ว! ลองพิมพ์อะไรก็ได้"
      : "🔑 ลบ API key แล้ว (ใช้โหมด offline)"
    });
  };

  const hasPending = !!(pendingTask || pendingFinance);
  const pendingDomain = pendingFinance ? "finance" : pendingTask ? "task" : null;
  const domainCfg = pendingDomain ? DOMAIN_BADGE[pendingDomain] : DOMAIN_BADGE.task;

  const FINANCE_QUICK = ["กินข้าว 80 บาท", "ค่า Grab 45 บาท", "ใช้ไปเท่าไรแล้ว?", "สรุปเดือนนี้"];

  if (!open) return null;

  const hasKey = !!getGeminiKey();

  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.92, opacity: 0, y: 20 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        onClick={e => e.stopPropagation()}
        className="bg-gray-950 border border-white/10 rounded-3xl w-full max-w-lg shadow-2xl flex flex-col overflow-hidden"
        style={{ maxHeight: "min(600px, 88vh)", height: "min(600px, 88vh)" }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/8 flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl theme-btn flex items-center justify-center">
              <Brain size={15} className="text-white" />
            </div>
            <div>
              <p className="text-white font-bold text-sm">AI Assistant</p>
              <p className="text-white/30 text-xs flex items-center gap-2">
                <span className="flex items-center gap-1"><CheckCircle size={9} className="text-purple-400" /> Tasks</span>
                <span className="flex items-center gap-1"><Wallet size={9} className="text-yellow-400" /> Finance</span>
                {/* Online/offline badge */}
                <span className={`flex items-center gap-1 ${online && hasKey ? "text-green-400" : "text-white/25"}`}>
                  {online && hasKey ? <Wifi size={9} /> : <WifiOff size={9} />}
                  {online && hasKey ? "Gemini" : "Offline"}
                </span>
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {/* API key button */}
            <button
              onClick={() => setShowKeyInput(v => !v)}
              title="Set Gemini API key"
              className={`p-1.5 rounded-lg transition-colors ${hasKey ? "text-green-400/60 hover:text-green-400" : "text-white/20 hover:text-yellow-400"}`}
            >
              <Key size={14} />
            </button>
            <button onClick={onClose} className="text-white/30 hover:text-white p-1 transition-colors">
              <X size={18} />
            </button>
          </div>
        </div>

        {/* API Key input (collapsible) */}
        {showKeyInput && (
          <div className="px-4 py-3 bg-gray-900/80 border-b border-white/8 flex-shrink-0">
            <p className="text-white/40 text-[10px] mb-1.5 font-semibold uppercase tracking-wider">
              🔑 Gemini API Key (ฟรี — <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer" className="text-blue-400 underline">aistudio.google.com</a>)
            </p>
            <div className="flex gap-2">
              <input
                value={keyDraft}
                onChange={e => setKeyDraft(e.target.value)}
                placeholder="AIzaSy..."
                type="password"
                className="flex-1 bg-gray-800 border border-white/10 rounded-xl px-3 py-2 text-white text-xs focus:outline-none focus:border-green-500 font-mono"
              />
              <button
                onClick={saveKey}
                className="px-3 py-2 bg-green-600/80 hover:bg-green-600 rounded-xl text-white text-xs font-bold transition-all"
              >
                Save
              </button>
            </div>
            <p className="text-white/20 text-[9px] mt-1">ข้อมูลเก็บใน localStorage เครื่องคุณเท่านั้น</p>
          </div>
        )}

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2.5">
          {/* Quick presets (shown only on fresh open) */}
          {messages.length <= 1 && (
            <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
              className="bg-white/[0.03] border border-white/8 rounded-xl p-2.5 space-y-2">
              <div>
                <p className="text-yellow-400/50 text-[10px] font-semibold uppercase tracking-wider mb-1.5 flex items-center gap-1">
                  <Wallet size={9}/> Finance
                </p>
                <div className="flex flex-wrap gap-1">
                  {FINANCE_QUICK.map(q => (
                    <button key={q} onClick={() => sendMessage(q)}
                      className="px-2 py-1 bg-yellow-500/10 border border-yellow-500/15 rounded-lg text-[11px] text-yellow-300/70 hover:text-yellow-200 hover:bg-yellow-500/20 transition-all">
                      {q}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <p className="text-purple-400/50 text-[10px] font-semibold uppercase tracking-wider mb-1.5 flex items-center gap-1">
                  <CheckCircle size={9}/> Tasks
                </p>
                <div className="flex flex-wrap gap-1">
                  {habits.length > 0
                    ? habits.map((h, i) => (
                        <button key={i} onClick={() => sendMessage(h.input)}
                          className="px-2 py-1 bg-purple-600/15 border border-purple-500/15 rounded-lg text-[11px] text-purple-300/70 hover:text-purple-200 transition-all">
                          🧠 {h.result.name || h.input}
                        </button>
                      ))
                    : QUICK_PRESETS.slice(0, 4).map(p => (
                        <button key={p.label} onClick={() => sendMessage(p.input)}
                          className="px-2 py-1 bg-white/5 border border-white/10 rounded-lg text-[11px] text-white/50 hover:text-white transition-all">
                          {p.label}
                        </button>
                      ))
                  }
                </div>
              </div>
            </motion.div>
          )}

          {/* Message bubbles */}
          {messages.map((msg, i) => {
            const badge = msg.domain ? DOMAIN_BADGE[msg.domain] : null;
            return (
              <motion.div key={i} initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }}
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                <div className="max-w-[88%] space-y-1">
                  {badge && msg.role === "ai" && (
                    <div className="flex items-center gap-1.5">
                      <div className={`flex items-center gap-1 px-2 py-0.5 rounded-full bg-gradient-to-r ${badge.color} w-fit`}>
                        <badge.icon size={9} className="text-white" />
                        <span className="text-white text-[9px] font-semibold">{badge.label}</span>
                      </div>
                      {/* Show which backend answered */}
                      {msg.source && (
                        <span className={`text-[9px] ${msg.source === "gemini" ? "text-green-400/50" : "text-white/20"}`}>
                          {msg.source === "gemini" ? "✦ Gemini" : "⬡ offline"}
                        </span>
                      )}
                    </div>
                  )}
                  <div className={`px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed whitespace-pre-line ${
                    msg.role === "user"
                      ? "theme-btn text-white rounded-br-sm"
                      : "bg-white/8 text-white/85 rounded-bl-sm border border-white/8"
                  }`}>{msg.text}</div>
                </div>
              </motion.div>
            );
          })}

          {/* Thinking animation */}
          {loading && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex justify-start">
              <div className="bg-white/8 border border-white/8 rounded-2xl rounded-bl-sm px-4 py-3 flex gap-1.5 items-center">
                {[0,1,2].map(i => (
                  <motion.div key={i} className="w-1.5 h-1.5 rounded-full theme-btn"
                    animate={{ opacity: [0.3,1,0.3], y: [0,-3,0] }}
                    transition={{ duration: 0.8, delay: i * 0.15, repeat: Infinity }} />
                ))}
                <span className="text-white/30 text-xs ml-1">
                  {online && hasKey ? "Gemini กำลังคิด..." : t("ai.thinking")}
                </span>
              </div>
            </motion.div>
          )}

          {/* Pending action card */}
          {hasPending && (
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
              className="bg-white/5 border border-white/12 rounded-2xl overflow-hidden">
              <div className={`h-1 bg-gradient-to-r ${domainCfg.color}`} />

              {/* Expense log — editable */}
              {pendingFinance?.intent === "log_expense" && (
                <div className="p-3 space-y-2.5">
                  <p className="text-white/40 text-[10px] uppercase tracking-wider font-semibold">
                    {t("ai.pendingLogExpense")}
                  </p>
                  <div className="flex items-center gap-2">
                    <span className="text-white/30 text-xs w-14 flex-shrink-0">Amount</span>
                    <div className="relative flex-1">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30 text-sm pointer-events-none">฿</span>
                      <input
                        type="number"
                        value={pendingFinance.amount ?? ""}
                        onChange={e => setPendingFinance(p => p ? { ...p, amount: parseFloat(e.target.value) || 0 } : p)}
                        className="w-full bg-gray-800 border border-white/10 rounded-xl pl-7 pr-3 py-2 text-white text-sm font-bold focus:outline-none focus:border-yellow-500 transition-all"
                      />
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-white/30 text-xs w-14 flex-shrink-0">Note</span>
                    <input
                      value={pendingFinance.note ?? ""}
                      onChange={e => setPendingFinance(p => p ? { ...p, note: e.target.value } : p)}
                      placeholder="description..."
                      className="flex-1 bg-gray-800 border border-white/10 rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:border-yellow-500 transition-all placeholder-white/20"
                    />
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="text-white/30 text-xs w-14 flex-shrink-0 pt-1.5">Category</span>
                    <div className="flex flex-wrap gap-1 flex-1">
                      {EXPENSE_CATEGORIES.map(cat => (
                        <button key={cat.key}
                          onClick={() => setPendingFinance(p => p ? { ...p, category: cat.key } : p)}
                          className={`px-2 py-1 rounded-lg text-xs font-semibold transition-all flex items-center gap-1 ${
                            pendingFinance.category === cat.key
                              ? "bg-yellow-500/20 border border-yellow-500/40 text-yellow-200"
                              : "bg-white/5 text-white/35 hover:text-white hover:bg-white/10"
                          }`}>
                          {cat.emoji} {cat.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* Other pending: compact summary */}
              {(!pendingFinance || pendingFinance.intent !== "log_expense") && (
                <div className="p-3 flex items-center gap-2.5">
                  <div className={`w-8 h-8 rounded-xl bg-gradient-to-br ${domainCfg.color} flex items-center justify-center flex-shrink-0`}>
                    <domainCfg.icon size={14} className="text-white" />
                  </div>
                  <p className="text-white/60 text-xs flex-1">
                    {pendingFinance?.intent === "delete_expense" && t("ai.pendingDeleteExpense", { keyword: pendingFinance.keyword! })}
                    {pendingFinance?.intent === "edit_expense" && t("ai.pendingEditExpense", { keyword: pendingFinance.keyword! })}
                    {pendingTask?.type === "add" && t("ai.pendingAddTask", { n: pendingTask.tasks?.length ?? 1 })}
                    {pendingTask?.type === "delete" && t("ai.pendingDeleteTask", { name: pendingTask.targetName! })}
                    {pendingTask?.type === "edit_time" && t("ai.pendingEditTime", { name: pendingTask.targetName! })}
                    {pendingTask?.type === "edit_priority" && t("ai.pendingEditPriority", { name: pendingTask.targetName! })}
                  </p>
                </div>
              )}

              {/* Task add — editable names */}
              {pendingTask?.type === "add" && pendingTask.tasks && pendingTask.tasks.length > 0 && (
                <div className="px-3 pb-2 space-y-1.5">
                  {pendingTask.tasks.map((task, idx) => (
                    <div key={idx} className="flex items-center gap-2 bg-white/5 rounded-xl px-3 py-2">
                      <span className="text-base flex-shrink-0">
                        {task.category === "game" ? "🎮" : task.category === "school" ? "📚" : task.category === "work" ? "💼" : "✨"}
                      </span>
                      <input
                        value={task.name}
                        onChange={e => {
                          const updated = [...pendingTask.tasks!];
                          updated[idx] = { ...updated[idx], name: e.target.value };
                          setPendingTask(p => p ? { ...p, tasks: updated } : p);
                        }}
                        className="flex-1 bg-transparent text-white text-sm font-semibold focus:outline-none border-b border-transparent focus:border-white/20 transition-all"
                      />
                      <span className="text-white/25 text-[10px] flex-shrink-0">{task.reset_type}</span>
                      {task.reset_time && (
                        <span className="text-white/20 text-[10px] flex-shrink-0">{task.reset_time}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}

              <div className="flex gap-2 px-3 pb-3">
                <button
                  onClick={pendingFinance ? confirmFinance : confirmTask}
                  className={`flex-1 py-2.5 bg-gradient-to-r ${domainCfg.color} rounded-xl text-white text-sm font-bold hover:opacity-90 transition-all`}>
                  {t("ai.btnConfirmCheck")}
                </button>
                <button onClick={cancelPending}
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
                placeholder={
                  online && hasKey
                    ? "พิมพ์ภาษาไทยหรืออังกฤษได้เลย... (Gemini)"
                    : t("ai.unifiedPlaceholder")
                }
                disabled={loading}
                className="w-full bg-white/6 border border-white/10 rounded-xl pl-4 pr-10 py-2.5 text-white placeholder-white/25 text-sm focus:outline-none focus:border-purple-500 disabled:opacity-40 transition-all" />
              <Sparkles size={13} className="absolute right-3 top-1/2 -translate-y-1/2 text-purple-400/40" />
            </div>
            <button onClick={() => sendMessage()} disabled={!input.trim() || loading}
              className="w-10 h-10 rounded-xl theme-btn flex items-center justify-center text-white disabled:opacity-30 transition-all flex-shrink-0">
              <Send size={16} />
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  );
}