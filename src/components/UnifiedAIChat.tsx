// UnifiedAIChat.tsx — Gemini-powered with offline local fallback
// KEY FIX: No AnimatePresence/motion on outer backdrop.
// Uses "if (!open) return null" so the DOM element is completely gone when closed.

import { useState, useRef, useEffect } from "react";
import { motion } from "framer-motion";
import { X, Send, Sparkles, Brain, Wallet, CheckCircle, Wifi, WifiOff, Key } from "lucide-react";
import { todayLocal } from "../lib/dateUtil";
import { formatMoney, currencySymbol } from "../lib/money";
import { getAppTimeZone } from "../lib/tz";
import { getAllTasks } from "../lib/database";
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
  loadCategories, getCategoryList, type CategoryRow, ExpenseCategory,
} from "../lib/financeDatabase";
import {
  processMessage, isOnline,
  GeminiTaskResponse, GeminiFinanceResponse,
  type ContextKind, type TokenUsage,
} from "../lib/geminiService";
// The provider is read here rather than assumed. Every label in this panel used
// to say Gemini, including when the request had gone to OpenAI or Anthropic —
// the key storage and the routing were already per-provider, only the words on
// screen were not.
import { PROVIDERS, getProviderId, getApiKey, setApiKey } from "../lib/aiProviders";
import { getUsageToday, type DailyUsage } from "../lib/aiProviders";
import { learnPreset } from "../lib/aiMemory";
import {
  looksHeavy, redactHeavy, alreadyOfferedThisSession, markOffered,
  loadImportant, TH_HELPLINE,
} from "../lib/importantCard";
import { t } from "../lib/i18n";
import { Operation, runOperations, describe, needsConfirm, KNOWN_OPS } from "../lib/aiOperations";

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
  source?: "gemini" | "local" | "cache"; // shows which backend answered
  /**
   * What this turn looks like in a request, when that is not what it says.
   *
   * Set only where a phrase was cut out of an outgoing message. The screen
   * renders `text`, which is what was typed; anything leaving the machine reads
   * this instead.
   *
   * It exists because redacting the request alone would have been a fix that
   * lasted one turn: the message stays in `messages` afterwards and the next
   * request carries the last four turns with it. That is the same bug the
   * `local` flag above was added for, arriving by a different door.
   */
  sendText?: string;
  /** Stays on this machine. Rendered like any other turn, but never included in
   *  the history sent with a later request — see where `history` is built.
   *
   *  This exists because the distress path returning early was not, on its own,
   *  enough. It kept THAT message from being sent, and then the message sat in
   *  `messages` like any other, so the next request that did go out carried it
   *  in the last-four-turns window. Along with the reply, which is the contents
   *  of the important-things card: names and phone numbers. */
  local?: true;
}

// One formatter for the whole app, in lib/money. There used to be two of
// these, in two files, formatting the same expense differently.
const fmt = (n: number, currency?: string) => formatMoney(n, currency);

const DOMAIN_BADGE: Record<Domain, { label: string; color: string; icon: React.FC<any> }> = {
  task:    { label: "Tasks",   color: "from-purple-600 to-indigo-600", icon: CheckCircle },
  finance: { label: "Finance", color: "from-yellow-600 to-amber-500",  icon: Wallet },
  query:   { label: "Query",   color: "from-gray-600 to-gray-500",     icon: Brain },
};

export default function UnifiedAIChat({ open, onClose, onTaskAdded, onFinanceChanged }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  // Real token count of the last Gemini call, shown in the footer so the cost
  // of a conversation is something you can watch rather than worry about.
  const [lastUsage, setLastUsage] = useState<TokenUsage | null>(null);
  const [categories, setCategories] = useState<CategoryRow[]>(() => getCategoryList());
  const [today, setToday] = useState<DailyUsage>(() => getUsageToday());
  const [showImportant, setShowImportant] = useState(false);
  const [habits, setHabits] = useState(getTopHabits(3));
  const [online, setOnline] = useState(true);
  const [showKeyInput, setShowKeyInput] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");

  const inputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const isConfirming = useRef(false);
  // When the conversation was last touched, so a stale one can be retired
  // without throwing away a live one.
  const lastActivity = useRef<number>(Date.now());

  // A plan the model proposed, waiting to be confirmed. Separate from the two
  // older pending states because it can hold several operations at once and can
  // mix domains — "ติ๊ก Honkai แล้วบันทึกค่าเน็ต 599" is one message.
  const [pendingOps, setPendingOps] = useState<{ ops: Operation[]; names: Record<number, string> } | null>(null);

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
    /** "YYYY-MM-DD" when the sentence named a day. Absent means today. */
    date?: string;
  } | null>(null);

  const addMsg = (msg: ChatMessage) => setMessages(m => [...m, msg]);

  // Check online status on open
  useEffect(() => {
    if (open) {
      // Only start over once the last exchange has gone cold. Wiping on every
      // open meant closing the panel for ten seconds threw away exactly the
      // context that follow-ups like "เปลี่ยนเป็นสามโมงแทน" depend on.
      const STALE_MS = 30 * 60 * 1000;
      if (Date.now() - lastActivity.current > STALE_MS) {
        clearHistory();
        const key = getApiKey();
        const greeting = key
          ? t("ai.unifiedGreeting")
          : `${t("ai.unifiedGreeting")}\n\n💡 ${t("ai.addKeyHint", { p: PROVIDERS[getProviderId()].label })}`;
        setMessages([{ role: "ai", text: greeting }]);
      }
      setPendingTask(null);
      setPendingFinance(null);
      setPendingOps(null);
      setHabits(getTopHabits(3));
      setShowKeyInput(false);
      setKeyDraft(getApiKey());
      setTimeout(() => inputRef.current?.focus(), 100);
      // Check connectivity
      isOnline().then(setOnline).catch(() => setOnline(false));
      // The category set is user-editable now, so re-read it each time the
      // panel opens rather than trusting a snapshot from app start.
      loadCategories().then(() => setCategories(getCategoryList())).catch(() => {});
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
    if (showHints) retireHints();
    // What is shown is what was typed. What is sent is that with any of the
    // ambiguous phrases cut out — see redactHeavy. They are equal for almost
    // every message ever typed here, and the turn carries both only when they
    // differ, so a reader of this file is not left wondering which one is real.
    const outgoing = redactHeavy(msg);
    addMsg({
      role: "user",
      text: msg,
      ...(outgoing !== msg ? { sendText: outgoing } : {}),
    });
    setLoading(true);
    lastActivity.current = Date.now();

    // Checked BEFORE anything else, and it returns early. That ordering is the
    // whole design: a message that matches is never handed to a model, never
    // cached, never written to the usage log, and never leaves the machine.
    //
    // The reply is short and plainly says what this is. A warm therapeutic
    // tone would invite a conversation this app cannot hold — and what the
    // evidence actually supports is contact with a person, so the job here is
    // to shorten the distance to one rather than stand in it.
    //
    // TWO DIFFERENT ONCE-PER-SESSION QUESTIONS, AND THEY ARE NOT THE SAME ONE.
    //
    // This used to read `looksHeavy(msg) && !alreadyOfferedThisSession()`, so
    // the session flag gated the WHOLE branch. The first matching message was
    // held back; every one after it in the same session fell straight through
    // to the model. The guarantee in the paragraph above was true exactly once
    // per app launch, which is worse than not having it, because the comment
    // says otherwise and nothing on screen shows the difference.
    //
    // So the two decisions are now separate:
    //   • WHETHER TO SEND — never, on every match, with no condition at all.
    //   • WHETHER TO SHOW THE CARD — the first time only, because repeating a
    //     list of phone numbers at someone every message is the nagging the
    //     original note was right to avoid.
    // After the first, the reply is one line. Something has to be said, or the
    // message vanishes into a chat that simply stops answering.
    if (looksHeavy(msg)) {
      // Retroactively mark the turn added above. It is the same message the
      // guard just matched, and it must not travel either.
      setMessages(m => m.map((entry, i) =>
        i === m.length - 1 && entry.role === "user" ? { ...entry, local: true } : entry
      ));

      const firstTime = !alreadyOfferedThisSession();
      if (firstTime) markOffered();

      let text: string;
      if (firstTime) {
        const card = loadImportant();
        const lines = card.contacts.length
          ? card.contacts.map(c => `${c.label} — ${c.value}`).join("\n")
          : `${t("care.noContacts")}\n${t("care.helpline")} ${TH_HELPLINE}`;
        text = `${t("care.reply")}\n\n${lines}${card.note ? `\n\n${card.note}` : ""}`;
      } else {
        text = t("care.replyAgain");
      }

      addMsg({ role: "ai", text, local: true });
      setLoading(false);
      return;
    }

    const isCorrection = isCorrectionMessage(msg) && (pendingTask !== null || pendingFinance !== null);
    if (!isCorrection) {
      setPendingTask(null);
      setPendingFinance(null);
    }

    await new Promise(r => setTimeout(r, 400));

    try {
      // ── Context, built only if a request is really going to be sent ──
      // Four database queries per message was the old shape, paid even when the
      // offline parser answered instantly and nothing left the machine. Now the
      // service asks for this only on the way to Gemini, and says which half it
      // needs so a coffee receipt does not carry the whole task list with it.
      const buildContext = async (kind: ContextKind): Promise<string | undefined> => {
        try {
          const today = todayLocal();
          const month = today.slice(0, 7);
          const parts: string[] = [`Today is ${today} (${getAppTimeZone()}).`];

          // IDS, NOT NAMES.
          //
          // The list used to carry names only, so the model answered with a name
          // and the app went looking for the row again with a LIKE query. That
          // round trip through text is where the failures lived: two tasks with
          // similar names meant the wrong one changed, and a slightly different
          // spelling meant nothing was found at all. The same weakness on the
          // money side produced three rounds of the same bug in one afternoon
          // under three different field names.
          //
          // With the id in front of every task the model can point instead of
          // describe, and the guessing stops. It costs a handful of tokens per
          // task, which is a small price for removing an entire category of
          // being confidently wrong.
          const tasks = await getAllTasks();
          if (kind === "finance") {
            parts.push(tasks.length
              ? `The user's tasks (id: name): ${tasks.slice(0, 40).map((tk: any) => `${tk.id}: "${tk.name}"`).join(", ")}`
              : `The user has no tasks yet.`);
          } else {
            const lines = tasks.slice(0, 40).map((tk: any) => {
              const bits = [
                `"${tk.name}"`,
                tk.category,
                tk.reset_type,
                tk.reset_time ? `at ${tk.reset_time}` : null,
                tk.is_priority ? "priority" : null,
                tk.is_urgent ? "urgent" : null,
                // Whether it is already ticked, so "เล่นแล้ว" on something
                // already done can be answered rather than acted on twice.
                tk.completed_until ? "already done this cycle" : null,
              ].filter(Boolean);
              return `- id ${tk.id} — ${bits.join(", ")}`;
            }).join("\n");
            parts.push(tasks.length
              ? `The user's CURRENT tasks. Use the id when referring to one:\n${lines}`
              : `The user has no tasks yet.`);
          }

          if (kind !== "task") {
            parts.push(
              `Expense categories the user actually has (return one of these keys): ` +
              getCategoryList().map(c => `${c.key} (${c.label})`).join(", "),
            );
            const [todayAmt, monthAmt, summary] = await Promise.all([
              getTodayTotal(today), getMonthTotal(month), getSpendingSummary(),
            ]);
            parts.push(`Spending — today ${fmt(todayAmt)}, this month ${fmt(monthAmt)}. Breakdown: ${summary}`);
          }

          // A draft awaiting confirmation is not in the database yet, so it
          // cannot show up in the task list above. Without this the model is
          // asked to correct something it has no record of.
          if (pendingTask) {
            parts.push(
              `UNSAVED draft awaiting the user's confirmation: ${JSON.stringify(pendingTask)}. ` +
              `If this message corrects it, return the corrected version of THAT action, not a new task.`,
            );
          }
          if (pendingFinance) {
            parts.push(`UNSAVED finance draft awaiting confirmation: ${JSON.stringify(pendingFinance)}.`);
          }

          return parts.join("\n\n");
        } catch (e) {
          console.warn("[UnifiedAIChat] could not build context:", e);
          return undefined;
        }
      };

      // Recent turns so follow-ups like "อันนั้นแหละ" have something to refer to.
      // Filtered BEFORE the slice, not after: filtering after would let a local
      // turn eat one of the four slots and silently shorten the context.
      const history = messages.filter(m => !m.local).slice(-4).map(m => ({
        role: m.role === "user" ? ("user" as const) : ("ai" as const),
        // sendText where a phrase was cut out, text everywhere else. Reading
        // m.text here would put the words back the moment a fifth message was
        // typed, which is exactly how far the previous version of this got.
        text: m.sendText ?? m.text,
      }));

      // ── Call AI (Gemini or local) ────────────────────────────
      // NOT "&& something is pending". The real flow is: confirm a task, think
      // again, then type a correction — by which point nothing is pending and
      // the task is already saved. A sentence opening with
      // "เปลี่ยน / แก้ / ไม่ใช่ / actually" refers to something earlier by
      // definition, and the offline parser scores each sentence ALONE. It saw a
      // time in "เปลี่ยนเป็นสามโมงแทน", called it a confident new task, and
      // created a task with that whole sentence as its name.
      const needsConversation =
        isCorrectionMessage(msg) || pendingTask !== null || pendingFinance !== null;

      const { source, response, usage } = await processMessage(outgoing, {
        buildContext, history, forceRemote: needsConversation,
      });
      setLastUsage(usage ?? null);
      setToday(getUsageToday());

      // Do NOT derive connectivity from where a single answer came from. A
      // message the offline parser handled is not evidence of being offline, yet
      // this flipped the header badge to "Offline" after every locally-answered
      // message, which reads as the app losing its connection. Each bubble
      // already carries its own source label, so the header only ever gets
      // better news, never worse.
      if (source === "gemini") setOnline(true);

      // Left in on purpose. Every silent turn this app has ever produced came
      // from a reply the code could not route, and without the payload there is
      // nothing to reason about afterwards — only a description of a blank
      // screen. One line in the console costs nothing and turns "it did
      // nothing" into an answerable question.
      console.log("[UnifiedAIChat] response:", source, JSON.stringify(response));

      // ── Route by domain ──────────────────────────────────────
      if (response.domain === "chat") {
        addMsg({ role: "ai", text: (response.reply ?? "").trim() || t("ai.notUnderstood"), source });
        setLoading(false);
        return;
      }

      // ── A plan, if the model sent one ──────────────────────────────────
      //
      // Checked before the per-domain branches, because an operations list is
      // the newer and more complete answer and those branches only know seven
      // verbs between them.
      const rawOps: any[] = Array.isArray((response as any).operations) ? (response as any).operations : [];
      const ops: Operation[] = rawOps.filter(o => KNOWN_OPS.has(o.kind));
      if (ops.length) {
        const replyLine = ((response as any).reply ?? "").trim();
        if (replyLine) addMsg({ role: "ai", text: replyLine, domain: response.domain as Domain, source });

        // Names for the confirmation card, resolved here rather than trusting
        // whatever the model called them.
        const names: Record<number, string> = {};
        try {
          const all = await getAllTasks();
          for (const tk of all) names[tk.id] = tk.name;
        } catch { /* the card falls back to #id */ }

        // Anything that writes waits for a person. A model that can reach every
        // corner of the app can also delete in every corner of it — and this
        // path used to let creating run unannounced, which is how ฿1,200 got
        // into the ledger from a sentence that was never confirmed. Which verbs
        // wait is decided in aiOperations, next to where each verb is written.
        if (ops.some(needsConfirm)) {
          setPendingOps({ ops, names });
        } else {
          try {
            const n = await runOperations(ops);
            onTaskAdded();
            onFinanceChanged?.();
            addMsg({ role: "ai", text: `${t("ai.saved")}${n > 1 ? ` (${n})` : ""}` });
          } catch (e: any) {
            addMsg({ role: "ai", text: `❌ ${e?.message ?? t("ai.errorRetry")}` });
          }
        }
        setLoading(false);
        return;
      }

      if (response.domain === "finance") {
        const fr = response as GeminiFinanceResponse;
        // The model's own sentence, if it wrote one. Blank is a real outcome:
        // it used to be pushed into the chat anyway as an empty bubble, which
        // looks exactly like the app doing nothing.
        const reply = (fr.reply ?? "").trim();
        if (reply) addMsg({ role: "ai", text: reply, domain: "finance", source });

        if (fr.intent === "query_spending") {
          // Already replied with summary text — done
          setLoading(false);
          return;
        }
        if (fr.intent === "log_income" && fr.incomeAmount) {
          const today = todayLocal();
          await addIncome({
            amount: fr.incomeAmount,
            source: "other",
            note: fr.incomeNote || "income",
            date: today,
          });
          const monthIncome = await getMonthIncome(today.slice(0, 7));
          addMsg({
            role: "ai",
            text: t("ai.incomeSaved", { a: fmt(fr.incomeAmount), m: fmt(monthIncome) }),
            domain: "finance", source,
          });
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
            date: fr.date,
          });
        } else if (fr.intent === "delete_expense" || fr.intent === "edit_expense") {
          // The model decides the intent and is supposed to fill in which row
          // it means. It does not always manage the second half — "เปลี่ยนเป็น
          // 699" has no noun in it, so the subject has to be carried over from
          // the turn before, and sometimes it just comes back null.
          //
          // Nothing used to check. The confirmation card printed the word
          // undefined at the user, and pressing it handed undefined to a
          // function that immediately called .toLowerCase() on it — a
          // TypeError shown as a red ❌, which reads like the app broke rather
          // than like the app did not understand.
          //
          // Model output is untrusted input. Ask instead of guessing: deleting
          // or overwriting the WRONG expense is a worse failure than a second
          // question, and there is no way to tell which row was meant.
          // Either name. See GeminiFinanceResponse.targetExpenseName for why
          // there are two.
          const keyword = (fr.keyword ?? fr.targetExpenseName)?.trim();
          if (!keyword) {
            addMsg({
              role: "ai",
              text: fr.intent === "delete_expense" ? t("ai.deleteWhich") : t("ai.editWhich"),
              domain: "finance",
              source,
            });
            setLoading(false);
            return;
          }
          if (fr.intent === "delete_expense") {
            setPendingFinance({ intent: "delete_expense", keyword });
          } else {
            setPendingFinance({ intent: "edit_expense", keyword, newAmount: fr.newAmount });
          }
        } else if (!reply) {
          // An intent none of the branches above handle — a value outside the
          // five in the schema, or none at all. Falling through here used to
          // end the turn in silence, and a chat that stops answering reads as
          // broken rather than as confused. Say the true thing instead.
          addMsg({ role: "ai", text: t("ai.notUnderstood"), domain: "finance", source });
        }
        setLoading(false);
        return;
      }

      // ── Task domain ──────────────────────────────────────────
      if (response.domain === "task") {
        const tr = response as GeminiTaskResponse;
        const reply = (tr.reply ?? "").trim();
        if (reply) addMsg({ role: "ai", text: reply, domain: "task", source });

        if (tr.intent === "delete") {
          setPendingTask({ type: "delete", targetName: tr.targetTaskName });
        } else if (tr.intent === "edit_time") {
          setPendingTask({ type: "edit_time", targetName: tr.targetTaskName, newTime: tr.newTime });
        } else if (tr.intent === "edit_priority") {
          setPendingTask({ type: "edit_priority", targetName: tr.targetTaskName, newPriority: tr.newPriority });
        } else if (tr.intent === "add" && tr.tasks?.length > 0) {
          setPendingTask({ type: "add", tasks: tr.tasks });
          // The redacted copy here too. Habits are local, and local ends up in
          // a backup file, and a backup file is written to be carried around.
          saveHabit(outgoing, tr.tasks[0]);
          setHabits(getTopHabits(3));
          // Also push to conversation history for context
          const localResult = smartParse(outgoing);
          pushHistory({ userText: outgoing, result: localResult, timestamp: Date.now() });
        } else if (!reply) {
          // "I did not follow that" is the wrong sentence when the offline
          // parser DID follow it and simply has no verb for it. Those messages
          // are meant to go to the model, so when they come back unanswered the
          // reason is the connection, not the understanding — and saying the
          // wrong one sends someone off rephrasing a sentence that was fine.
          // Cast because GeminiTaskResponse's intent union does not include the
          // parser's own "unknown" — the two type systems meet here and the
          // value is real even though the declared union does not admit it.
          const deferred = (tr.intent as string) === "unknown" && source === "local";
          addMsg({
            role: "ai",
            text: t(deferred ? "ai.needsOnline" : "ai.notUnderstood"),
            domain: "task",
            source,
          });
        }
        setLoading(false);
        return;
      }

      // A domain outside the three above. Same rule: never end a turn without
      // saying something.
      addMsg({ role: "ai", text: t("ai.notUnderstood"), source });
      setLoading(false);
      return;

    } catch (e: any) {
      console.error("[UnifiedAIChat] sendMessage error:", e);
      addMsg({ role: "ai", text: t("ai.errorRetry") });
    }

    setLoading(false);
  };

  // ── Confirm a plan ────────────────────────────────────────────
  const confirmOps = async () => {
    if (!pendingOps || isConfirming.current) return;
    isConfirming.current = true;
    const { ops } = pendingOps;
    setPendingOps(null);
    try {
      const n = await runOperations(ops);
      onTaskAdded();
      onFinanceChanged?.();
      addMsg({ role: "ai", text: `${t("ai.saved")}${n > 1 ? ` (${n})` : ""}` });
    } catch (e: any) {
      addMsg({ role: "ai", text: `❌ ${e?.message ?? t("ai.errorRetry")}` });
    } finally {
      isConfirming.current = false;
    }
  };

  // ── Confirm finance ───────────────────────────────────────────
  const confirmFinance = async () => {
    if (!pendingFinance) return;
    try {
      if (pendingFinance.intent === "log_expense") {
        await aiLogExpense(pendingFinance.amount!, pendingFinance.category!, pendingFinance.note!, pendingFinance.date);
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
      addMsg({ role: "ai", text: `❌ ${e.message ?? t("ai.failed")}` });
      setPendingFinance(null);
    }
  };

  // ── Confirm task ──────────────────────────────────────────────
  const confirmTask = async () => {
    if (!pendingTask || isConfirming.current) return;
    isConfirming.current = true;
    try {
      if (pendingTask.type === "add" && pendingTask.tasks) {
        for (const task of pendingTask.tasks) {
          await createTask(task);
          // A confirmation is the user saying "yes, that reading was right".
          // That is the only reliable training signal this app will ever get,
          // so it is kept: the subject becomes a preset and the same game is
          // recognised offline from then on, whatever the wording next time.
          learnPreset(task);
        }
      } else if (pendingTask.type === "delete" && pendingTask.targetName) {
        await deleteTaskByName(pendingTask.targetName);
      } else if (pendingTask.type === "edit_time" && pendingTask.targetName && pendingTask.newTime) {
        await updateTaskTime(pendingTask.targetName, pendingTask.newTime);
      } else if (pendingTask.type === "edit_priority" && pendingTask.targetName) {
        await updateTaskPriority(pendingTask.targetName, pendingTask.newPriority ? 1 : 0);
      }
      setPendingTask(null);
      // Deliberately NOT closing. Closing here was the root of the follow-up
      // bug: it ended the conversation, the open-effect then wiped every
      // message, and the next sentence arrived with nothing before it. A chat
      // that hangs up after each sentence cannot have follow-ups. The finance
      // path never closed either, so this was inconsistent as well.
      addMsg({ role: "ai", text: t("ai.saved"), domain: "task" });
      onTaskAdded();
    } catch (e: any) {
      addMsg({ role: "ai", text: `❌ ${e.message ?? t("ai.failed")}` });
      setPendingTask(null);
    } finally {
      isConfirming.current = false;
    }
  };

  const cancelPending = () => {
    setPendingTask(null);
    setPendingFinance(null);
    setPendingOps(null);
    addMsg({ role: "ai", text: t("ai.cancelled") });
  };

  const saveKey = () => {
    setApiKey(keyDraft);
    setShowKeyInput(false);
    addMsg({ role: "ai", text: keyDraft
      ? t("ai.keySaved", { p: PROVIDERS[getProviderId()].label })
      : t("ai.keyCleared")
    });
  };

  // One place decides what this panel calls the thing answering it. Read on
  // every render rather than captured once, so switching provider in settings
  // is reflected without reopening the chat.
  const providerName = PROVIDERS[getProviderId()].label;
  const providerShort = PROVIDERS[getProviderId()].shortLabel;
  const providerKeyUrl = PROVIDERS[getProviderId()].keyUrl;

  const hasPending = !!(pendingTask || pendingFinance || pendingOps);
  const pendingDomain = pendingFinance ? "finance" : pendingTask ? "task" : null;
  const domainCfg = pendingDomain ? DOMAIN_BADGE[pendingDomain] : DOMAIN_BADGE.task;

  const FINANCE_QUICK = t("ai.quickFinance").split("|");

  // These are teaching examples: they exist to show that a sentence typed in
  // plain language is enough. Once someone has actually sent a message they
  // know that, and the examples become clutter that reappears at the top of
  // every empty chat forever. They also name specific games and specific
  // prices, which reads as the app assuming things about the person.
  //
  // So: shown until they are used or dismissed, then never again.
  const [showHints, setShowHints] = useState(
    () => localStorage.getItem("gamesched_ai_hints_done") !== "1",
  );
  const retireHints = () => {
    localStorage.setItem("gamesched_ai_hints_done", "1");
    setShowHints(false);
  };

  if (!open) return null;

  const hasKey = !!getApiKey();

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
                  {online && hasKey ? providerShort : t("ai.offline")}
                </span>
                {/* What the last request actually cost, straight from Gemini's
                    own usageMetadata. Nothing shows until a request is really
                    sent, so a run of locally-answered messages leaves it blank —
                    which is itself the useful signal. */}
                {lastUsage && (
                  <span className="text-white/25" title="tokens in / out (last call)">
                    {lastUsage.input}↑ {lastUsage.output}↓
                  </span>
                )}
                {/* Running total for today, which is the number that answers
                    "what is this costing me" for a provider that bills by use.
                    Resets on its own at midnight. */}
                {today.requests > 0 && (
                  <span className="text-white/25" title="today: requests · tokens in / out">
                    · {today.requests}× {today.input + today.output}tk
                  </span>
                )}
                {/* Always here, so the card never depends on a keyword matcher
                    guessing right. Detection can only ever be a nudge; a door
                    that is simply visible does not have to guess at all. Named
                    plainly, so it costs nothing to have on screen. */}
                <button onClick={() => setShowImportant(v => !v)}
                  className="text-white/25 hover:text-white transition-colors ml-auto">
                  {t("important.title")}
                </button>
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {/* API key button */}
            <button
              onClick={() => setShowKeyInput(v => !v)}
              title={t("ai.setKeyTitle", { p: providerName })}
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
              🔑 {t("ai.keyPanelTitle", { p: providerName })}
              {" — "}
              <a href={providerKeyUrl} target="_blank" rel="noreferrer" className="text-blue-400 underline">
                {t("ai.keyGetOne")}
              </a>
            </p>
            <div className="flex gap-2">
              <input
                value={keyDraft}
                onChange={e => setKeyDraft(e.target.value)}
                placeholder={getProviderId() === "gemini" ? "AIzaSy..." : "sk-..."}
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
            <p className="text-white/20 text-[9px] mt-1">{t("ai.keyLocalOnly")}</p>
          </div>
        )}

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2.5">
          {/* Quick presets (shown only on fresh open) */}
          {showImportant && (
            <div className="bg-white/[0.04] border border-white/10 rounded-xl p-3 mb-2 text-xs">
              {(() => {
                const card = loadImportant();
                if (!card.contacts.length && !card.note) {
                  return (
                    <p className="text-white/40">
                      {t("care.noContacts")}<br />
                      {t("care.helpline")} {TH_HELPLINE}
                    </p>
                  );
                }
                return (
                  <div className="space-y-1">
                    {card.contacts.map((c, i) => (
                      <div key={i} className="flex justify-between gap-2">
                        <span className="text-white/60 truncate">{c.label}</span>
                        <span className="text-white shrink-0">{c.value}</span>
                      </div>
                    ))}
                    {card.note && <p className="text-white/40 pt-1 whitespace-pre-wrap">{card.note}</p>}
                  </div>
                );
              })()}
            </div>
          )}

          {showHints && messages.length <= 1 && (
            <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
              className="bg-white/[0.03] border border-white/8 rounded-xl p-2.5 space-y-2 relative">
              <button onClick={retireHints}
                title={t("ai.hideHints")}
                className="absolute top-1.5 right-1.5 text-white/25 hover:text-white transition-colors">
                <X size={12} />
              </button>
              <div>
                <p className="text-yellow-400/50 text-[10px] font-semibold uppercase tracking-wider mb-1.5 flex items-center gap-1">
                  <Wallet size={9}/> Finance
                </p>
                <div className="flex flex-wrap gap-1">
                  {FINANCE_QUICK.map(q => (
                    <button key={q} onClick={() => { retireHints(); sendMessage(q); }}
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
                        <button key={i} onClick={() => { retireHints(); sendMessage(h.input); }}
                          className="px-2 py-1 bg-purple-600/15 border border-purple-500/15 rounded-lg text-[11px] text-purple-300/70 hover:text-purple-200 transition-all">
                          🧠 {h.result.name || h.input}
                        </button>
                      ))
                    : QUICK_PRESETS.slice(0, 4).map(p => (
                        <button key={p.label} onClick={() => { retireHints(); sendMessage(p.input); }}
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
                      {/* Which backend answered. The stored tag is still the
                          string "gemini" because it means "went over the
                          network", not "was Google" — it predates there being
                          more than one provider. The LABEL is now whichever
                          provider is configured; only the tag kept the name. */}
                      {msg.source && (
                        <span className={`text-[9px] ${msg.source === "gemini" ? "text-green-400/50" : "text-white/20"}`}>
                          {msg.source === "gemini"
                            ? t("ai.answeredBy", { p: providerShort })
                            : t("ai.answeredLocal")}
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
                  {online && hasKey ? t("ai.thinkingWith", { p: providerShort }) : t("ai.thinking")}
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
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30 text-sm pointer-events-none">{currencySymbol()}</span>
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
                  {/* Only when the sentence named another day. Today needs no
                      row: a field that is right every time is a field nobody
                      reads, and it would push the confirm button off a 590px
                      screen for the sake of repeating the obvious. */}
                  {pendingFinance.date && pendingFinance.date !== todayLocal() && (
                    <div className="flex items-center gap-2">
                      <span className="text-white/30 text-xs w-14 flex-shrink-0">{t("finance.date")}</span>
                      <div className="flex gap-1.5">
                        {[
                          { label: t("finance.yesterday"), value: pendingFinance.date },
                          { label: t("finance.today"), value: todayLocal() },
                        ].map(opt => (
                          <button key={opt.value}
                            onClick={() => setPendingFinance(p => p ? { ...p, date: opt.value } : p)}
                            className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all ${
                              pendingFinance.date === opt.value
                                ? "bg-yellow-500/20 border border-yellow-500/40 text-yellow-200"
                                : "bg-white/5 text-white/35 hover:text-white hover:bg-white/10"
                            }`}>
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="flex items-start gap-2">
                    <span className="text-white/30 text-xs w-14 flex-shrink-0 pt-1.5">Category</span>
                    <div className="flex flex-wrap gap-1 flex-1">
                      {categories.map((cat: CategoryRow) => (
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

              {/* A plan: every operation, in the order it will run.
                  Built from the operations themselves rather than from the
                  model's sentence — the sentence is a claim about what happened
                  and this is the thing that is actually about to happen. Those
                  two disagreed often enough ("แก้ไขเรียบร้อยแล้วค่ะ" arriving
                  before anything had been written) that the confirmation should
                  come from the plan. */}
              {pendingOps && (
                <div className="p-3 space-y-1.5">
                  <p className="text-white/40 text-[11px] px-0.5">{t("op.confirmTitle")}</p>
                  {pendingOps.ops.map((op, i) => (
                    <div key={i} className="flex items-center gap-2 bg-white/5 rounded-xl px-3 py-2">
                      <span className="text-white/25 text-[10px] tabular-nums w-4 shrink-0">{i + 1}</span>
                      <span className="text-white text-sm flex-1 truncate">
                        {describe(op, op.id != null ? pendingOps.names[op.id] : undefined)}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {/* Other pending: compact summary */}
              {!pendingOps && (!pendingFinance || pendingFinance.intent !== "log_expense") && (
                <div className="p-3 flex items-center gap-2.5">
                  <div className={`w-8 h-8 rounded-xl bg-gradient-to-br ${domainCfg.color} flex items-center justify-center flex-shrink-0`}>
                    <domainCfg.icon size={14} className="text-white" />
                  </div>
                  <p className="text-white/60 text-xs flex-1">
                    {pendingFinance?.intent === "delete_expense" && t("ai.pendingDeleteExpense", { keyword: pendingFinance.keyword! })}
                    {pendingFinance?.intent === "edit_expense" && (
                      pendingFinance.newAmount != null
                        ? t("ai.pendingEditExpenseTo", { keyword: pendingFinance.keyword!, amount: fmt(pendingFinance.newAmount) })
                        : t("ai.pendingEditExpense", { keyword: pendingFinance.keyword! })
                    )}
                    {pendingTask?.type === "add" && t("ai.pendingAddTask", { n: pendingTask.tasks?.length ?? 1 })}
                    {pendingTask?.type === "delete" && t("ai.pendingDeleteTask", { name: pendingTask.targetName! })}
                    {pendingTask?.type === "edit_time" && t("ai.pendingEditTime", { name: pendingTask.targetName! })}
                    {pendingTask?.type === "edit_priority" && t("ai.pendingEditPriority", { name: pendingTask.targetName! })}
                  </p>
                </div>
              )}

              {/* Task add — editable names */}
              {!pendingOps && pendingTask?.type === "add" && pendingTask.tasks && pendingTask.tasks.length > 0 && (
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
                  onClick={pendingOps ? confirmOps : pendingFinance ? confirmFinance : confirmTask}
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
                    ? t("ai.placeholderWith", { p: providerShort })
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