import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowLeft, Plus, Trash2, Target, TrendingUp, Edit3, Save,
  Wallet, ChevronLeft, ChevronRight,
  PiggyBank, BarChart3, X, Check, AlertTriangle,
} from "lucide-react";
import {
  addExpense, getExpensesByMonth, getTotalByCategory, getDailyTotals,
  getMonthTotal, getTodayTotal, setBudget, getBudgetsForMonth,
  createGoal, addToGoal, getGoals, deleteExpense, deleteGoal, updateExpense,

  EXPENSE_CATEGORIES, Expense, Budget, SavingGoal, ExpenseCategory,
} from "../lib/financeDatabase";
import { getMonthIncome } from "../lib/database";
import { t, getLang } from "../lib/i18n";

interface Props {
  onBack: () => void;
  isVisible?: boolean;
  refreshKey?: number;
}

type FinanceTab = "overview" | "expenses" | "budget" | "goals";

// ─── Currency formatter ───────────────────────────────────────────────────────
const fmt = (n: number) => `฿${n.toLocaleString("th-TH", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

// Date display — Buddhist Era (พ.ศ.) in Thai mode, Gregorian DD/MM/YYYY in English
const toThaiDisplay = (isoDate: string): string => {
  if (!isoDate) return "";
  const parts = isoDate.split("-");
  if (parts.length === 3 && parts[0].length === 4) {
    const [y, m, d] = parts;
    if (getLang() === "th") {
      return `${d}/${m}/${parseInt(y) + 543}`;
    }
    return `${d}/${m}/${y}`;
  }
  return isoDate;
};

// Get today's date in Bangkok time (UTC+7) as YYYY-MM-DD
const getTodayBangkok = (): string => {
  const now = new Date();
  const bkk = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  return bkk.toISOString().split("T")[0];
};


// ─── Donut chart (pure SVG) ───────────────────────────────────────────────────
function DonutChart({ data }: { data: { category: string; total: number; color: string }[] }) {
  const total = data.reduce((s, d) => s + d.total, 0);
  if (total === 0) return <div className="w-32 h-32 rounded-full border-4 border-white/10 mx-auto flex items-center justify-center text-white/20 text-xs">{t("finance.donutNoData")}</div>;

  let offset = 0;
  const R = 54, C = 2 * Math.PI * R;
  const segments = data.map(d => {
    const pct = d.total / total;
    const seg = { ...d, pct, offset, dash: pct * C, gap: (1 - pct) * C };
    offset += pct;
    return seg;
  });

  return (
    <div className="relative w-32 h-32 mx-auto">
      <svg width="128" height="128" viewBox="0 0 128 128" className="-rotate-90">
        <circle cx="64" cy="64" r={R} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="14" />
        {segments.map((s, i) => (
          <circle key={i} cx="64" cy="64" r={R} fill="none"
            stroke={s.color} strokeWidth="14"
            strokeDasharray={`${s.dash} ${C - s.dash}`}
            strokeDashoffset={-s.offset * C}
            strokeLinecap="round"
          />
        ))}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <p className="text-white text-sm font-bold">{fmt(total)}</p>
        <p className="text-white/40 text-[10px]">{t("finance.total")}</p>
      </div>
    </div>
  );
}

// ─── Sparkline bar chart ──────────────────────────────────────────────────────
function SparkBars({ data }: { data: { date: string; total: number }[] }) {
  if (data.length === 0) return null;
  const max = Math.max(...data.map(d => d.total), 1);
  return (
    <div className="flex items-end gap-0.5 h-12">
      {data.map((d, i) => (
        <motion.div key={i}
          initial={{ scaleY: 0 }}
          animate={{ scaleY: 1 }}
          transition={{ delay: i * 0.02 }}
          className="flex-1 rounded-sm origin-bottom"
          style={{ height: `${(d.total / max) * 100}%`, background: "var(--color-primary)", opacity: 0.6 + 0.4 * (d.total / max) }}
          title={`${toThaiDisplay(d.date)}: ${fmt(d.total)}`}
        />
      ))}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function FinanceView({ onBack, isVisible = true, refreshKey = 0 }: Props) {
  const [tab, setTab] = useState<FinanceTab>("overview");
  // Track today's date in Bangkok time — refreshes every minute so overnight stays work
  const [todayDate, setTodayDate] = useState(getTodayBangkok);
  const [currentMonth, setCurrentMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  });

  // Data state
  const [expenses, setExpenses]   = useState<Expense[]>([]);
  const [catTotals, setCatTotals] = useState<{ category: string; total: number }[]>([]);
  const [dailyData, setDailyData] = useState<{ date: string; total: number }[]>([]);
  const [monthTotal, setMonthTotal] = useState(0);
  const [todayTotal, setTodayTotal] = useState(0);
  const [monthIncome, setMonthIncome] = useState(0);
  const [budgets, setBudgets]     = useState<Budget[]>([]);
  const [goals, setGoals]         = useState<SavingGoal[]>([]);
  const [loading, setLoading]     = useState(true);

  // Add expense form
  const [showAddExpense, setShowAddExpense] = useState(false);
  const [expForm, setExpForm] = useState(() => ({ amount: "", category: "food" as ExpenseCategory, note: "", date: getTodayBangkok() }));

  // Add goal form
  const [showAddGoal, setShowAddGoal] = useState(false);
  const [goalForm, setGoalForm] = useState({ name: "", target: "", deadline: "", emoji: "🎯" });

  // Budget edit
  const [editBudget, setEditBudget] = useState<{ cat: ExpenseCategory; value: string } | null>(null);

  // Add to goal
  const [addToGoalState, setAddToGoalState] = useState<{ id: number; value: string } | null>(null);

  // Inline expense editing
  const [editingExpense, setEditingExpense] = useState<{
    id: number; amount: string; category: ExpenseCategory; note: string; date: string;
  } | null>(null);

  const handleSaveExpenseEdit = async () => {
    if (!editingExpense) return;
    const amt = parseFloat(editingExpense.amount);
    if (!amt || amt <= 0) return;
    await updateExpense(editingExpense.id, {
      amount: amt,
      category: editingExpense.category,
      note: editingExpense.note,
      date: editingExpense.date,
    });
    setEditingExpense(null);
    load();
  };



  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [exp, cats, daily, mTotal, tTotal, buds, gls, mIncome] = await Promise.all([
        getExpensesByMonth(currentMonth),
        getTotalByCategory(currentMonth),
        getDailyTotals(currentMonth),
        getMonthTotal(currentMonth),
        getTodayTotal(todayDate),
        getBudgetsForMonth(currentMonth),
        getGoals(),
        getMonthIncome(currentMonth),
      ]);
      setExpenses(exp);
      setCatTotals(cats);
      setDailyData(daily);
      setMonthTotal(mTotal);
      setTodayTotal(tTotal);
      setBudgets(buds);
      setGoals(gls);
      setMonthIncome(mIncome);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, [currentMonth]);

  useEffect(() => { load(); }, [load, isVisible, refreshKey]);

  // Refresh todayDate every minute — if date changes (midnight BKK), reload data
  useEffect(() => {
    const interval = setInterval(() => {
      const newDate = getTodayBangkok();
      setTodayDate(prev => {
        if (prev !== newDate) {
          load();
          return newDate;
        }
        return prev;
      });
    }, 60_000);
    return () => clearInterval(interval);
  }, [load]);




  const prevMonth = () => {
    const d = new Date(currentMonth + "-01");
    d.setMonth(d.getMonth() - 1);
    setCurrentMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };
  const nextMonth = () => {
    const d = new Date(currentMonth + "-01");
    d.setMonth(d.getMonth() + 1);
    setCurrentMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };

  const handleAddExpense = async () => {
    const amt = parseFloat(expForm.amount);
    if (!amt || amt <= 0) return;
    await addExpense({ amount: amt, category: expForm.category, note: expForm.note, date: expForm.date });
    setExpForm({ amount: "", category: "food", note: "", date: todayDate });
    setShowAddExpense(false);
    load();
  };

  const handleAddGoal = async () => {
    if (!goalForm.name || !goalForm.target) return;
    await createGoal({ name: goalForm.name, target_amount: parseFloat(goalForm.target), deadline: goalForm.deadline || undefined, emoji: goalForm.emoji });
    setGoalForm({ name: "", target: "", deadline: "", emoji: "🎯" });
    setShowAddGoal(false);
    load();
  };

  const handleSaveBudget = async () => {
    if (!editBudget) return;
    const amt = parseFloat(editBudget.value);
    if (amt > 0) await setBudget(editBudget.cat, amt, currentMonth);
    setEditBudget(null);
    load();
  };

  const handleAddToGoal = async () => {
    if (!addToGoalState) return;
    const amt = parseFloat(addToGoalState.value);
    if (amt > 0) { await addToGoal(addToGoalState.id, amt); load(); }
    setAddToGoalState(null);
  };

  // ── AI Chat ──

  // ── Donut data ──
  const donutData = catTotals.map(c => ({
    category: c.category,
    total: c.total,
    color: EXPENSE_CATEGORIES.find(cat => cat.key === c.category)
      ? `hsl(${EXPENSE_CATEGORIES.findIndex(cat => cat.key === c.category) * 40 + 20}, 70%, 60%)`
      : "#666",
  }));

  const monthLabel = (() => {
    const d = new Date(currentMonth + "-15");
    if (getLang() === "th") {
      // Use Buddhist calendar so year shows as พ.ศ.
      return d.toLocaleDateString("th-TH-u-ca-buddhist", { month: "long", year: "numeric" });
    }
    return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  })();
  const isCurrentMonth = currentMonth === new Date().toISOString().slice(0, 7);

  // Budget status per category
  const getBudgetStatus = (cat: string) => {
    const budget = budgets.find(b => b.category === cat);
    const spent = catTotals.find(c => c.category === cat)?.total ?? 0;
    if (!budget) return null;
    const pct = Math.min((spent / budget.limit_amount) * 100, 100);
    const over = spent > budget.limit_amount;
    return { budget: budget.limit_amount, spent, pct, over };
  };

  return (
    <div className="flex flex-col h-full w-full overflow-hidden">

      {/* Header */}
      <div className="flex items-center justify-between mb-4 flex-shrink-0">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="p-2 rounded-xl bg-white/5 hover:bg-white/10 transition-all">
            <ArrowLeft size={16} className="text-white/60" />
          </button>
          <div>
            <h2 className="text-white font-bold text-xl flex items-center gap-2">
              <div className="w-7 h-7 rounded-xl bg-yellow-500/15 flex items-center justify-center">
                <Wallet size={14} className="text-yellow-400" />
              </div>
              {t("finance.headerTitle")}
            </h2>
            <p className="text-white/25 text-[11px] mt-0.5">{t("finance.subtitle")}</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Month nav */}
          <button onClick={prevMonth} className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 transition-all">
            <ChevronLeft size={14} className="text-white/50" />
          </button>
          <span className="text-white/70 text-xs font-medium min-w-24 text-center">{monthLabel}</span>
          <button onClick={nextMonth} disabled={isCurrentMonth} className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 transition-all disabled:opacity-30">
            <ChevronRight size={14} className="text-white/50" />
          </button>



          {/* Add expense */}
          <button onClick={() => setShowAddExpense(true)}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl theme-btn text-white text-xs font-semibold">
            <Plus size={14} /> {t("finance.add")}
          </button>
        </div>
      </div>

      {/* Summary cards — compact horizontal row */}
      <div className="grid grid-cols-4 gap-2 mb-3 flex-shrink-0">
        {/* Today */}
        <div className="bg-white/[0.04] border border-white/10 rounded-xl p-2.5 hover:border-blue-500/30 transition-colors group">
          <div className="flex items-center gap-1 mb-1.5">
            <div className="w-4 h-4 rounded-md bg-blue-500/20 flex items-center justify-center">
              <TrendingUp size={9} className="text-blue-400" />
            </div>
            <p className="text-white/35 text-[9px] font-semibold uppercase tracking-wider">{t("finance.statToday")}</p>
          </div>
          <p className="text-white font-bold text-base leading-none">{fmt(todayTotal)}</p>
          <p className="text-white/20 text-[9px] mt-1">{t("finance.today")}</p>
        </div>

        {/* Month */}
        <div className="bg-white/[0.04] border border-white/10 rounded-xl p-2.5 hover:border-orange-500/30 transition-colors group">
          <div className="flex items-center gap-1 mb-1.5">
            <div className="w-4 h-4 rounded-md bg-orange-500/20 flex items-center justify-center">
              <BarChart3 size={9} className="text-orange-400" />
            </div>
            <p className="text-white/35 text-[9px] font-semibold uppercase tracking-wider">{t("finance.statMonth")}</p>
          </div>
          <p className="text-white font-bold text-base leading-none">{fmt(monthTotal)}</p>
          <p className="text-white/20 text-[9px] mt-1">{t("finance.month")}</p>
        </div>

        {/* Income */}
        <div className={`border rounded-xl p-2.5 transition-colors group ${monthIncome > 0 ? "bg-emerald-500/[0.06] border-emerald-500/25 hover:border-emerald-500/40" : "bg-white/[0.04] border-white/10"}`}>
          <div className="flex items-center gap-1 mb-1.5">
            <div className={`w-4 h-4 rounded-md flex items-center justify-center ${monthIncome > 0 ? "bg-emerald-500/20" : "bg-white/5"}`}>
              <PiggyBank size={9} className={monthIncome > 0 ? "text-emerald-400" : "text-white/25"} />
            </div>
            <p className="text-white/35 text-[9px] font-semibold uppercase tracking-wider">{t("finance.statIncome")}</p>
          </div>
          <p className={`font-bold text-base leading-none ${monthIncome > 0 ? "text-emerald-400" : "text-white/20"}`}>
            {monthIncome > 0 ? fmt(monthIncome) : "—"}
          </p>
          <p className="text-white/20 text-[9px] mt-1">{t("finance.income")}</p>
        </div>

        {/* Balance */}
        {(() => {
          const balance = monthIncome - monthTotal;
          const hasIncome = monthIncome > 0;
          const positive = balance >= 0;
          return (
            <div className={`border rounded-xl p-2.5 transition-colors ${
              !hasIncome ? "bg-white/[0.04] border-white/10"
              : positive ? "bg-emerald-500/[0.06] border-emerald-500/25 hover:border-emerald-500/40"
              : "bg-red-500/[0.06] border-red-500/25 hover:border-red-500/40"
            }`}>
              <div className="flex items-center gap-1 mb-1.5">
                <div className={`w-4 h-4 rounded-md flex items-center justify-center ${
                  !hasIncome ? "bg-white/5" : positive ? "bg-emerald-500/20" : "bg-red-500/20"
                }`}>
                  <Wallet size={9} className={!hasIncome ? "text-white/25" : positive ? "text-emerald-400" : "text-red-400"} />
                </div>
                <p className="text-white/35 text-[9px] font-semibold uppercase tracking-wider">{t("finance.statBalance")}</p>
              </div>
              <p className={`font-bold text-base leading-none ${
                !hasIncome ? "text-white/20" : positive ? "text-emerald-400" : "text-red-400"
              }`}>
                {hasIncome ? fmt(balance) : "—"}
              </p>
              <p className="text-white/20 text-[9px] mt-1">{t("finance.items", { n: expenses.length })}</p>
            </div>
          );
        })()}
      </div>

            {/* Tabs */}
      <div className="flex mb-4 flex-shrink-0 bg-white/[0.03] border border-white/8 rounded-xl p-0.5">
        {([
          { key: "overview",  label: t("finance.tabOverview"),  emoji: "📊" },
          { key: "expenses",  label: t("finance.tabExpenses"),  emoji: "💸" },
          { key: "budget",    label: t("finance.tabBudget"),    emoji: "🎯" },
          { key: "goals",     label: t("finance.tabGoals"),     emoji: "💰" },
        ] as { key: FinanceTab; label: string; emoji: string }[]).map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`flex-1 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center justify-center gap-1 ${
              tab === t.key
                ? "bg-white/10 text-white shadow-sm"
                : "text-white/35 hover:text-white/70"
            }`}>
            <span>{t.emoji}</span>
            <span className="hidden sm:inline">{t.label}</span>
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto finance-scroll">
        <AnimatePresence mode="wait">

          {/* ── Overview ── */}
          {tab === "overview" && (
            <motion.div key="overview" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-4">

              {/* Donut + category list */}
              <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
                <p className="text-white/40 text-xs mb-3">{t("finance.catSpend")}</p>
                {catTotals.length === 0 ? (
                  <p className="text-white/20 text-sm text-center py-4">{t("finance.noData")}</p>
                ) : (
                  <div className="flex gap-4 items-center">
                    <DonutChart data={donutData} />
                    <div className="flex-1 space-y-1.5">
                      {catTotals.slice(0, 5).map(c => {
                        const catInfo = EXPENSE_CATEGORIES.find(x => x.key === c.category);
                        const pct = monthTotal > 0 ? (c.total / monthTotal * 100).toFixed(0) : "0";
                        return (
                          <div key={c.category} className="flex items-center gap-2">
                            <span className="text-xs">{catInfo?.emoji ?? "📦"}</span>
                            <div className="flex-1">
                              <div className="flex justify-between text-xs mb-0.5">
                                <span className="text-white/60">{catInfo?.label ?? c.category}</span>
                                <span className="text-white font-semibold">{fmt(c.total)}</span>
                              </div>
                              <div className="h-1 bg-white/10 rounded-full">
                                <motion.div className="h-full rounded-full"
                                  style={{ background: `var(--color-primary)` }}
                                  initial={{ width: 0 }}
                                  animate={{ width: `${pct}%` }}
                                  transition={{ duration: 0.5 }} />
                              </div>
                            </div>
                            <span className="text-white/30 text-[10px] w-6 text-right">{pct}%</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              {/* Daily spend chart */}
              {dailyData.length > 0 && (
                <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
                  <p className="text-white/40 text-xs mb-3">{t("finance.dailyChart")}</p>
                  <SparkBars data={dailyData} />
                  <div className="flex justify-between text-[10px] text-white/20 mt-1">
                    <span>{dailyData[0]?.date.slice(8)}</span>
                    <span>{dailyData[dailyData.length - 1]?.date.slice(8)}</span>
                  </div>
                </div>
              )}

              {/* Budget alerts */}
              {budgets.length > 0 && catTotals.some(c => {
                const b = budgets.find(b => b.category === c.category);
                return b && c.total > b.limit_amount * 0.8;
              }) && (
                <div className="bg-red-500/10 border border-red-500/20 rounded-2xl p-3 space-y-1.5">
                  <p className="text-red-400 text-xs font-semibold flex items-center gap-1.5"><AlertTriangle size={12} /> {t("finance.budgetAlerts")}</p>
                  {catTotals.map(c => {
                    const b = budgets.find(b => b.category === c.category);
                    if (!b || c.total < b.limit_amount * 0.8) return null;
                    const over = c.total > b.limit_amount;
                    const catInfo = EXPENSE_CATEGORIES.find(x => x.key === c.category);
                    return (
                      <div key={c.category} className="flex items-center justify-between text-xs">
                        <span className="text-white/60">{catInfo?.emoji} {catInfo?.label}</span>
                        <span className={over ? "text-red-400 font-bold" : "text-yellow-400"}>
                          {fmt(c.total)} / {fmt(b.limit_amount)}
                          {over ? " " + t("finance.over") : " " + t("finance.near")}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Recent transactions */}
              {expenses.length > 0 && (
                <div className="bg-white/[0.04] border border-white/10 rounded-2xl overflow-hidden">
                  <div className="flex items-center justify-between px-4 pt-3.5 pb-2">
                    <p className="text-white/50 text-xs font-semibold uppercase tracking-wider">{t("finance.recentTx")}</p>
                    <span className="text-white/25 text-[10px]">{t("finance.items", { n: expenses.length })}</span>
                  </div>
                  <div className="divide-y divide-white/[0.05]">
                    {expenses.slice(0, 5).map(e => {
                      const catInfo = EXPENSE_CATEGORIES.find(c => c.key === e.category);
                      return (
                        <div key={e.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-white/[0.03] transition-colors">
                          <div className={`w-8 h-8 rounded-xl bg-gradient-to-br ${catInfo?.color ?? "from-gray-500 to-gray-600"} flex items-center justify-center text-sm flex-shrink-0`}>
                            {catInfo?.emoji ?? "📦"}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-white/85 text-xs font-medium truncate">{e.note || catInfo?.label}</p>
                            <p className="text-white/25 text-[10px] mt-0.5">{catInfo?.label} · {toThaiDisplay(e.date)}</p>
                          </div>
                          <p className="text-white font-bold text-sm flex-shrink-0">{fmt(e.amount)}</p>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </motion.div>
          )}

          {/* ── Expenses ── */}
          {tab === "expenses" && (
            <motion.div key="expenses" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              {loading ? (
                <div className="text-center py-16 text-white/30">{t("finance.loading")}</div>
              ) : expenses.length === 0 ? (
                <div className="text-center py-16">
                  <p className="text-white/30 font-medium">{t("finance.noExpenses")}</p>
                  <p className="text-white/20 text-xs mt-1">{t("finance.noExpensesSub")}</p>
                </div>
              ) : (
                <div className="bg-white/[0.04] border border-white/10 rounded-2xl overflow-hidden divide-y divide-white/[0.05]">
                {expenses.map(e => {
                  const catInfo = EXPENSE_CATEGORIES.find(c => c.key === e.category);
                  const isEditing = editingExpense?.id === e.id;
                  return (
                    <motion.div key={e.id} layout initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }}
                      className={`overflow-hidden transition-all ${isEditing ? "bg-purple-500/5" : "hover:bg-white/[0.03]"}`}>

                      {/* Normal row */}
                      {!isEditing && (
                        <div className="flex items-center gap-3 px-3.5 py-3 group relative">
                          {/* left category accent line */}
                          <div className={`absolute left-0 top-2 bottom-2 w-0.5 rounded-full bg-gradient-to-b ${catInfo?.color ?? "from-gray-500 to-gray-600"}`} />
                          <div className={`w-9 h-9 rounded-xl bg-gradient-to-br ${catInfo?.color ?? "from-gray-500 to-gray-600"} flex items-center justify-center text-sm flex-shrink-0 shadow-sm`}>
                            {catInfo?.emoji ?? "📦"}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-white/90 text-sm font-medium truncate">{e.note || catInfo?.label}</p>
                            <div className="flex items-center gap-1.5 mt-0.5">
                              <span className="text-white/25 text-[10px] uppercase tracking-wide">{catInfo?.label}</span>
                              <span className="text-white/15 text-[10px]">·</span>
                              <span className="text-white/25 text-[10px]">{toThaiDisplay(e.date)}</span>
                            </div>
                          </div>
                          <div className="flex items-center gap-0.5 flex-shrink-0">
                            <p className="text-white font-bold text-sm mr-2">{fmt(e.amount)}</p>
                            <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button
                                onClick={() => setEditingExpense({ id: e.id, amount: String(e.amount), category: e.category as ExpenseCategory, note: e.note, date: e.date })}
                                className="p-1.5 rounded-lg text-white/30 hover:text-purple-400 hover:bg-purple-400/10 transition-all">
                                <Edit3 size={12} />
                              </button>
                              <button onClick={() => { deleteExpense(e.id); load(); }}
                                className="p-1.5 rounded-lg text-white/20 hover:text-red-400 hover:bg-red-400/10 transition-all">
                                <Trash2 size={12} />
                              </button>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Inline edit form */}
                      {isEditing && editingExpense && (
                        <div className="p-3 space-y-2.5">
                          <div className="flex items-center gap-2">
                            <span className="text-white/40 text-xs w-14 flex-shrink-0">{t("finance.editAmt")}</span>
                            <input type="number" value={editingExpense.amount}
                              onChange={e2 => setEditingExpense(s => s ? { ...s, amount: e2.target.value } : s)}
                              className="flex-1 bg-gray-800 border border-white/10 rounded-xl px-3 py-2 text-white text-sm font-bold focus:outline-none focus:border-purple-500"
                              autoFocus />
                            <span className="text-white/40 text-xs">฿</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-white/40 text-xs w-14 flex-shrink-0">{t("finance.editNote")}</span>
                            <input value={editingExpense.note}
                              onChange={e2 => setEditingExpense(s => s ? { ...s, note: e2.target.value } : s)}
                              className="flex-1 bg-gray-800 border border-white/10 rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500" />
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {EXPENSE_CATEGORIES.map(cat => (
                              <button key={cat.key}
                                onClick={() => setEditingExpense(s => s ? { ...s, category: cat.key } : s)}
                                className={`px-2 py-1 rounded-lg text-xs transition-all ${editingExpense.category === cat.key ? "theme-btn text-white" : "bg-white/5 text-white/40 hover:text-white"}`}>
                                {cat.emoji} {cat.label}
                              </button>
                            ))}
                          </div>
                          <div className="relative">
                            <input type="date" value={editingExpense.date}
                              onChange={e2 => setEditingExpense(s => s ? { ...s, date: e2.target.value } : s)}
                              className="absolute inset-0 opacity-0 w-full h-full cursor-pointer" />
                            <div className="w-full bg-gray-800 border border-white/10 rounded-xl px-3 py-2 text-white text-xs pointer-events-none flex justify-between">
                              <span>{toThaiDisplay(editingExpense.date)}</span>
                              <span className="text-white/30">📅</span>
                            </div>
                          </div>
                          <div className="flex gap-2">
                            <button onClick={handleSaveExpenseEdit}
                              className="flex-1 py-2 theme-btn rounded-xl text-white text-xs font-semibold flex items-center justify-center gap-1.5">
                              <Save size={13} /> {t("finance.editSave")}
                            </button>
                            <button onClick={() => setEditingExpense(null)}
                              className="px-4 py-2 bg-white/5 border border-white/10 rounded-xl text-white/50 text-xs hover:text-white transition-all">
                              {t("finance.editCancel")}
                            </button>
                          </div>
                        </div>
                      )}
                    </motion.div>
                  );
                })}
                </div>
              )}
            </motion.div>
          )}

          {/* ── Budget ── */}
          {tab === "budget" && (
            <motion.div key="budget" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-3">

              {/* Month summary bar */}
              <div className="bg-white/[0.04] border border-white/10 rounded-2xl p-3.5 flex items-center gap-3">
                <div className="flex-1">
                  <p className="text-white/40 text-[10px] font-semibold uppercase tracking-wider mb-1">{monthLabel}</p>
                  <p className="text-white/60 text-xs">{t("finance.budgetFor", { month: "" }).trim()}</p>
                </div>
                {(() => {
                  const totalBudget = budgets.reduce((s, b) => s + b.limit_amount, 0);
                  const totalSpent  = catTotals.reduce((s, c) => s + c.total, 0);
                  const overallPct  = totalBudget > 0 ? Math.min((totalSpent / totalBudget) * 100, 100) : 0;
                  const isOver      = totalSpent > totalBudget && totalBudget > 0;
                  return totalBudget > 0 ? (
                    <div className="text-right">
                      <p className={`text-sm font-bold ${isOver ? "text-red-400" : "text-white"}`}>{fmt(totalSpent)}</p>
                      <p className="text-white/30 text-[10px]">/ {fmt(totalBudget)} total</p>
                      <div className="w-24 h-1.5 bg-white/10 rounded-full mt-1 overflow-hidden ml-auto">
                        <motion.div className="h-full rounded-full"
                          style={{ background: isOver ? "#ef4444" : "var(--color-primary)" }}
                          initial={{ width: 0 }} animate={{ width: `${overallPct}%` }}
                          transition={{ duration: 0.6 }} />
                      </div>
                    </div>
                  ) : null;
                })()}
              </div>

              {/* Category budget cards */}
              <div className="grid grid-cols-1 gap-2">
                {EXPENSE_CATEGORIES.map((cat, idx) => {
                  const status    = getBudgetStatus(cat.key);
                  const isEditing = editBudget?.cat === cat.key;
                  const hasOver   = status?.over;
                  const nearLimit = status && !hasOver && status.pct >= 80;

                  return (
                    <motion.div
                      key={cat.key}
                      layout
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: idx * 0.03 }}
                      className={`border rounded-2xl overflow-hidden transition-all ${
                        hasOver    ? "border-red-500/40 bg-red-500/[0.06]"
                        : nearLimit ? "border-yellow-500/30 bg-yellow-500/[0.04]"
                        : isEditing ? "border-purple-500/40 bg-purple-500/[0.06]"
                        : "border-white/10 bg-white/[0.03]"
                      }`}
                    >
                      {/* Main row */}
                      <div className="flex items-center gap-3 px-4 py-3">
                        {/* Icon */}
                        <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${cat.color} flex items-center justify-center text-lg flex-shrink-0 shadow-sm`}>
                          {cat.emoji}
                        </div>

                        {/* Info */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-white text-sm font-semibold">{cat.label}</span>
                            {status ? (
                              <div className="flex items-center gap-1.5">
                                {hasOver && <AlertTriangle size={11} className="text-red-400" />}
                                {nearLimit && !hasOver && <AlertTriangle size={11} className="text-yellow-400" />}
                                <span className={`text-xs font-bold tabular-nums ${
                                  hasOver ? "text-red-400" : nearLimit ? "text-yellow-400" : "text-white/70"
                                }`}>
                                  {fmt(status.spent)}
                                </span>
                                <span className="text-white/25 text-xs">/</span>
                                <span className="text-white/45 text-xs tabular-nums">{fmt(status.budget)}</span>
                              </div>
                            ) : (
                              <span className="text-white/20 text-xs italic">{t("finance.notSet")}</span>
                            )}
                          </div>

                          {/* Progress bar */}
                          {status ? (
                            <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
                              <motion.div
                                className="h-full rounded-full"
                                style={{ background: hasOver ? "#ef4444" : nearLimit ? "#eab308" : "var(--color-primary)" }}
                                initial={{ width: 0 }}
                                animate={{ width: `${status.pct}%` }}
                                transition={{ duration: 0.5, delay: idx * 0.04 }}
                              />
                            </div>
                          ) : (
                            <div className="h-1.5 bg-white/5 rounded-full border border-dashed border-white/10" />
                          )}
                        </div>

                        {/* Edit toggle */}
                        <button
                          onClick={() => setEditBudget(isEditing ? null : { cat: cat.key, value: status?.budget.toString() ?? "" })}
                          className={`w-8 h-8 rounded-xl flex items-center justify-center transition-all flex-shrink-0 ${
                            isEditing
                              ? "bg-purple-500/20 text-purple-400 rotate-45"
                              : status
                              ? "bg-white/5 text-white/30 hover:bg-white/10 hover:text-white"
                              : "bg-white/5 text-white/20 hover:bg-purple-500/20 hover:text-purple-400"
                          }`}
                        >
                          {isEditing ? <X size={13} /> : <Edit3 size={13} />}
                        </button>
                      </div>

                      {/* Inline edit panel — slides open */}
                      <AnimatePresence>
                        {isEditing && (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: "auto", opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.2 }}
                            className="overflow-hidden"
                          >
                            <div className="px-4 pb-4 pt-0 border-t border-white/8">
                              <p className="text-white/35 text-[10px] uppercase tracking-wider mb-2.5 pt-3">
                                Set monthly budget for {cat.label}
                              </p>
                              <div className="flex gap-2">
                                {/* Amount input with ฿ prefix */}
                                <div className="flex-1 relative">
                                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30 font-bold text-sm pointer-events-none">฿</span>
                                  <input
                                    type="number"
                                    value={editBudget?.value ?? ""}
                                    placeholder="0"
                                    onChange={e => setEditBudget(b => b ? { ...b, value: e.target.value } : b)}
                                    onKeyDown={e => { if (e.key === "Enter") handleSaveBudget(); if (e.key === "Escape") setEditBudget(null); }}
                                    className="w-full bg-gray-800/80 border border-white/15 rounded-xl pl-8 pr-4 py-2.5 text-white text-sm font-bold focus:outline-none focus:border-purple-500 focus:bg-gray-800 transition-all"
                                    autoFocus
                                  />
                                </div>
                                {/* Quick-set chips */}
                                <div className="flex gap-1">
                                  {[500, 1000, 2000, 5000].map(preset => (
                                    <button
                                      key={preset}
                                      onClick={() => setEditBudget(b => b ? { ...b, value: String(preset) } : b)}
                                      className={`px-2 py-2.5 rounded-xl text-xs font-semibold transition-all whitespace-nowrap ${
                                        editBudget?.value === String(preset)
                                          ? "bg-purple-600 text-white"
                                          : "bg-white/8 text-white/40 hover:bg-white/15 hover:text-white"
                                      }`}
                                    >
                                      {preset >= 1000 ? `${preset/1000}k` : preset}
                                    </button>
                                  ))}
                                </div>
                              </div>
                              <div className="flex gap-2 mt-2.5">
                                <button
                                  onClick={handleSaveBudget}
                                  className="flex-1 py-2.5 theme-btn rounded-xl text-white text-xs font-semibold flex items-center justify-center gap-1.5"
                                >
                                  <Check size={13} /> {t("finance.budgetSave")}
                                </button>
                                {status && (
                                  <button
                                    onClick={async () => {
                                      // Clear budget by setting to 0 — treat as "remove"
                                      await setBudget(cat.key, 0, currentMonth);
                                      setEditBudget(null);
                                      load();
                                    }}
                                    className="px-3 py-2.5 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 text-xs hover:bg-red-500/20 transition-all"
                                  >
                                    <Trash2 size={13} />
                                  </button>
                                )}
                                <button
                                  onClick={() => setEditBudget(null)}
                                  className="px-3 py-2.5 bg-white/5 border border-white/10 rounded-xl text-white/40 text-xs hover:text-white transition-all"
                                >
                                  {t("finance.editCancel")}
                                </button>
                              </div>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </motion.div>
                  );
                })}
              </div>
            </motion.div>
          )}

          {/* ── Goals ── */}
          {tab === "goals" && (
            <motion.div key="goals" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-3">
              <button onClick={() => setShowAddGoal(true)}
                className="w-full py-3 bg-white/5 border border-dashed border-white/20 rounded-2xl text-white/40 text-sm hover:text-white hover:border-white/40 transition-all flex items-center justify-center gap-2">
                <Plus size={15} /> {t("finance.addGoalBtn")}
              </button>

              {goals.length === 0 ? (
                <div className="text-center py-12">
                  <PiggyBank size={40} className="text-white/10 mx-auto mb-3" />
                  <p className="text-white/30 font-medium">{t("finance.noGoals")}</p>
                  <p className="text-white/20 text-xs mt-1">{t("finance.noGoalsSub")}</p>
                </div>
              ) : (
                goals.map(g => {
                  const pct = Math.min((g.current_amount / g.target_amount) * 100, 100);
                  const remaining = g.target_amount - g.current_amount;
                  const isAdding = addToGoalState?.id === g.id;
                  return (
                    <motion.div key={g.id} layout className={`bg-white/5 border rounded-2xl p-4 ${g.is_completed ? "border-green-500/30 bg-green-500/5" : "border-white/10"}`}>
                      <div className="flex items-start justify-between gap-2 mb-3">
                        <div className="flex items-center gap-2.5">
                          <span className="text-2xl">{g.emoji}</span>
                          <div>
                            <p className="text-white font-semibold text-sm">{g.name}</p>
                            {g.deadline && <p className="text-white/30 text-xs">{t("finance.deadline", { date: toThaiDisplay(g.deadline) })}</p>}
                          </div>
                        </div>
                        <div className="flex items-center gap-1">
                          {!g.is_completed && (
                            <button onClick={() => setAddToGoalState(isAdding ? null : { id: g.id, value: "" })}
                              className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-white/40 hover:text-white transition-all">
                              <Plus size={13} />
                            </button>
                          )}
                          <button onClick={() => { deleteGoal(g.id); load(); }}
                            className="p-1.5 rounded-lg bg-white/5 hover:bg-red-500/10 text-white/20 hover:text-red-400 transition-all">
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>

                      <div className="space-y-2">
                        <div className="flex justify-between text-xs">
                          <span className="text-white/60">{t("finance.saved", { amt: fmt(g.current_amount) })}</span>
                          <span className="text-white font-semibold">{t("finance.target", { amt: fmt(g.target_amount) })}</span>
                        </div>
                        <div className="h-3 bg-white/10 rounded-full overflow-hidden">
                          <motion.div className={`h-full rounded-full ${g.is_completed ? "bg-gradient-to-r from-green-500 to-emerald-400" : "theme-btn"}`}
                            initial={{ width: 0 }}
                            animate={{ width: `${pct}%` }}
                            transition={{ duration: 0.7, ease: "easeOut" }} />
                        </div>
                        <div className="flex justify-between text-xs">
                          <span className={g.is_completed ? "text-green-400 font-bold" : "text-white/40"}>
                            {g.is_completed ? t("finance.goalDone") : t("finance.remaining", { amt: fmt(remaining) })}
                          </span>
                          <span className="text-white/60 font-semibold">{pct.toFixed(0)}%</span>
                        </div>
                      </div>

                      {isAdding && (
                        <div className="flex gap-2 mt-2">
                          <input type="number" value={addToGoalState.value} placeholder={t("finance.savingAmtPH")}
                            onChange={e => setAddToGoalState(s => s ? { ...s, value: e.target.value } : s)}
                            onKeyDown={e => e.key === "Enter" && handleAddToGoal()}
                            className="flex-1 bg-gray-800 border border-white/10 rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500"
                            autoFocus />
                          <button onClick={handleAddToGoal}
                            className="px-3 py-2 theme-btn rounded-xl text-white text-xs font-semibold">{t("finance.addSaving")}</button>
                        </div>
                      )}
                    </motion.div>
                  );
                })
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ── Add Expense Modal ── */}
      <AnimatePresence>
        {showAddExpense && isVisible && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-end justify-center p-4"
            onClick={() => setShowAddExpense(false)}>
            <motion.div initial={{ y: 60, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 60, opacity: 0 }}
              onClick={e => e.stopPropagation()}
              className="bg-gray-900 border border-white/10 rounded-3xl p-5 w-full max-w-md">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-white font-bold">{t("finance.addExpenseTitle")}</h3>
                <button onClick={() => setShowAddExpense(false)} className="text-white/40 hover:text-white"><X size={18} /></button>
              </div>
              <div className="space-y-3">
                <input type="number" value={expForm.amount} onChange={e => setExpForm(f => ({ ...f, amount: e.target.value }))}
                  placeholder={t("finance.amountPH")}
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-white/30 text-lg font-bold focus:outline-none focus:border-purple-500" />
                <input value={expForm.note} onChange={e => setExpForm(f => ({ ...f, note: e.target.value }))}
                  placeholder={t("finance.notePH")}
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-white/30 text-sm focus:outline-none focus:border-purple-500" />
                <div className="grid grid-cols-3 gap-1.5">
                  {EXPENSE_CATEGORIES.map(cat => (
                    <button key={cat.key} onClick={() => setExpForm(f => ({ ...f, category: cat.key }))}
                      className={`py-2 px-2 rounded-xl text-xs font-semibold transition-all flex items-center gap-1.5 ${
                        expForm.category === cat.key ? "theme-btn text-white" : "bg-white/5 text-white/50 hover:text-white"
                      }`}>
                      {cat.emoji} {cat.label}
                    </button>
                  ))}
                </div>
                <div className="relative">
                  <input type="date" value={expForm.date}
                    onChange={e => setExpForm(f => ({ ...f, date: e.target.value }))}
                    className="absolute inset-0 opacity-0 w-full h-full cursor-pointer" />
                  <div className="w-full bg-gray-800 border border-white/10 rounded-xl px-4 py-3 text-white text-sm pointer-events-none flex items-center justify-between">
                    <span>{toThaiDisplay(expForm.date)}</span>
                    <span className="text-white/30 text-xs">📅 {getLang() === "th" ? "วัน/เดือน/ปี (พ.ศ.)" : "MM/DD/YYYY"}</span>
                  </div>
                </div>
                <button onClick={handleAddExpense}
                  className="w-full py-3 theme-btn rounded-xl text-white font-semibold flex items-center justify-center gap-2">
                  <Plus size={16} /> {t("finance.saveTxBtn")}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Add Goal Modal ── */}
      <AnimatePresence>
        {showAddGoal && isVisible && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
            onClick={() => setShowAddGoal(false)}>
            <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }}
              onClick={e => e.stopPropagation()}
              className="bg-gray-900 border border-white/10 rounded-3xl p-5 w-full max-w-sm">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-white font-bold">{t("finance.goalTitle")}</h3>
                <button onClick={() => setShowAddGoal(false)} className="text-white/40 hover:text-white"><X size={18} /></button>
              </div>
              <div className="space-y-3">
                <div className="flex gap-2">
                  <input value={goalForm.emoji} onChange={e => setGoalForm(f => ({ ...f, emoji: e.target.value }))}
                    className="w-14 bg-white/5 border border-white/10 rounded-xl px-3 py-3 text-white text-center text-xl focus:outline-none focus:border-purple-500" />
                  <input value={goalForm.name} onChange={e => setGoalForm(f => ({ ...f, name: e.target.value }))}
                    placeholder={t("finance.goalNamePH")}
                    className="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-white/30 text-sm focus:outline-none focus:border-purple-500" />
                </div>
                <input type="number" value={goalForm.target} onChange={e => setGoalForm(f => ({ ...f, target: e.target.value }))}
                  placeholder={t("finance.goalAmtPH")}
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-white/30 text-sm focus:outline-none focus:border-purple-500" />
                <div className="flex flex-col gap-1">
                  <label className="text-white/40 text-xs px-1">{t("finance.goalDeadlineLabel")}</label>
                  <div className="relative">
                    <input type="date" value={goalForm.deadline}
                      onChange={e => setGoalForm(f => ({ ...f, deadline: e.target.value }))}
                      className="absolute inset-0 opacity-0 w-full h-full cursor-pointer" />
                    <div className="w-full bg-gray-800 border border-white/10 rounded-xl px-4 py-3 text-white text-sm pointer-events-none flex items-center justify-between">
                      <span>{goalForm.deadline ? toThaiDisplay(goalForm.deadline) : <span className="text-white/30">{t("finance.goalDeadlinePH")}</span>}</span>
                      <span className="text-white/30 text-xs">📅</span>
                    </div>
                  </div>
                </div>
                <button onClick={handleAddGoal}
                  className="w-full py-3 theme-btn rounded-xl text-white font-semibold flex items-center justify-center gap-2">
                  <Target size={16} /> {t("finance.createGoalBtn")}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
}