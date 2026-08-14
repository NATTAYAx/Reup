import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowLeft, Plus, Trash2, Target, Edit3,
  ChevronLeft, ChevronRight, X, Check, AlertTriangle, CalendarDays, BarChart3, ScanLine,
  TrendingUp, TrendingDown, Wallet,
} from "lucide-react";
import {
  addExpense, getExpensesByMonth, getTotalByCategory, getDailyTotals,
  getMonthTotal, getTodayTotal, setBudget, getBudgetsForMonth,
  createGoal, addToGoal, getGoals, deleteExpense, deleteGoal, updateExpense,
  getRecentCategories,
  loadCategories, getCategoryList, getAllCategoriesCached, lookupCategory,
  createCategory, updateCategory, setCategoryHidden, moveCategory, type CategoryRow,
  Expense, Budget, SavingGoal, ExpenseCategory,
} from "../lib/financeDatabase";
import { getMonthIncome, getIncomeByMonth, addIncome, deleteIncome } from "../lib/database";
import { t, getLang } from "../lib/i18n";
import DatePicker from "./DatePicker";
import ExpectedIncomeCard from "./ExpectedIncomeCard";
import Select from "./Select";
import { scanImage, getLastRawReply, type ScannedItem } from "../lib/slipScanner";
import { slipAlreadyRecorded, looksLikeDuplicate, otherCurrencyTotals } from "../lib/financeDatabase";
import { otherIncomeCurrencyTotals } from "../lib/database";
import { learnMerchant, recallMerchant } from "../lib/aiMemory";
import { todayLocal, monthLocal } from "../lib/dateUtil";
import { formatMoney, currencySymbol, formatTotals, getCurrency } from "../lib/money";
import CurrencyPicker from "./CurrencyPicker";

interface Props {
  onBack: () => void;
  isVisible?: boolean;
  refreshKey?: number;
}

// ─── Currency formatter ───────────────────────────────────────────────────────
// Was a second, differently-behaving copy of the chat's formatter: this one
// truncated the satang off a scanned 2,761.78 and the other did not.
//
// AGGREGATES BELOW STILL ASSUME ONE CURRENCY. Each stored row now carries
// its own, and each row is displayed in it, so nothing on screen lies about
// an individual entry. Totals, the category bars and the calendar's daily
// figures add rows together, which is only meaningful within one currency —
// use sumByCurrency + formatTotals from lib/money when that stops being
// true, which for anyone who has not travelled is never.
const fmt = (n: number, currency?: string) => formatMoney(n, currency);

// Date display — Buddhist Era (พ.ศ.) in Thai mode, Gregorian DD/MM/YYYY in English
const toThaiDisplay = (isoDate: string): string => {
  if (!isoDate) return "";
  const parts = isoDate.split("-");
  if (parts.length === 3 && parts[0].length === 4) {
    const [y, m, d] = parts;
    if (getLang() === "th") return `${d}/${m}/${parseInt(y) + 543}`;
    return `${d}/${m}/${y}`;
  }
  return isoDate;
};

const shiftDay = (iso: string, days: number): string => {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// ─── Daily trend strip ────────────────────────────────────────────────────────
// Kept because it answers a different question from the category bars: those say
// what the money went on, this says when. The donut was dropped — it repeated
// what the category bars already show, and with one category it was a large
// circle announcing 100%.
// Every day of the month gets a slot, including the empty ones. Plotting only
// the days that happen to have spending turned two transactions into two bars
// half the card wide, which reads as a broken chart rather than a quiet month.
function SparkBars({ month, data }: { month: string; data: { date: string; total: number }[] }) {
  const first = new Date(month + "-01T00:00:00");
  const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const totals = new Map(data.map(d => [d.date, d.total]));
  const series = Array.from({ length: days }, (_, i) => {
    const date = `${month}-${String(i + 1).padStart(2, "0")}`;
    return { date, total: totals.get(date) ?? 0 };
  });
  const max = Math.max(...series.map(d => d.total), 1);
  return (
    <div className="flex items-end gap-[2px] h-14">
      {series.map((d, i) => (
        <motion.div key={i}
          initial={{ scaleY: 0 }}
          animate={{ scaleY: 1 }}
          transition={{ delay: i * 0.015 }}
          className="flex-1 rounded-[1px] origin-bottom"
          style={{
            height: `${Math.max(4, (d.total / max) * 100)}%`,
            background: d.total > 0 ? "var(--color-primary)" : "rgba(255,255,255,0.07)",
            opacity: d.total > 0 ? 0.45 + 0.55 * (d.total / max) : 1,
          }}
          title={`${toThaiDisplay(d.date)}: ${fmt(d.total)}`}
        />
      ))}
    </div>
  );
}

// The native date field is gone from this screen. Chromium's own calendar is
// drawn by the system: white panel, blue selection, and no CSS reaches inside
// it. The app already had a themed DatePicker that the task forms use, so the
// finance sheets use the same one, in its compact chip form.

// ─── Month calendar ───────────────────────────────────────────────────────────
// Built entirely from the per-day totals already loaded for the month, so this
// view costs no extra query. A darker cell means a heavier day.
function MonthCalendar({ month, data, selected, onPick }: {
  month: string;
  data: { date: string; total: number }[];
  selected: string;
  onPick: (iso: string) => void;
}) {
  const first = new Date(month + "-01T00:00:00");
  const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const pad = first.getDay();
  const totals = new Map(data.map(d => [d.date, d.total]));
  const max = Math.max(...data.map(d => d.total), 1);
  const dow = getLang() === "th"
    ? ["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"]
    : ["S", "M", "T", "W", "T", "F", "S"];

  const cells: (string | null)[] = [
    ...Array(pad).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) =>
      `${month}-${String(i + 1).padStart(2, "0")}`),
  ];

  return (
    <div>
      <div className="grid grid-cols-7 gap-1 mb-1">
        {dow.map((d, i) => (
          <div key={i} className="text-center text-white/25 text-[9px]">{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {cells.map((iso, i) => {
          if (!iso) return <div key={i} />;
          const total = totals.get(iso) ?? 0;
          const isSel = iso === selected;
          return (
            <button key={i} onClick={() => onPick(iso)}
              className={`rounded-md py-0.5 flex flex-col items-center justify-center transition-colors border ${
                isSel ? "border-white/40" : "border-transparent hover:border-white/15"
              }`}
              style={{
                background: total > 0
                  ? `color-mix(in srgb, var(--color-primary) ${Math.round(18 + 62 * (total / max))}%, transparent)`
                  : "rgba(255,255,255,0.03)",
              }}>
              <span className="text-white text-[10px] leading-none">{parseInt(iso.slice(8))}</span>
              <span className="text-white/60 text-[8px] leading-none mt-[1px] h-[9px]">
                {total > 0 ? total.toLocaleString("th-TH", { maximumFractionDigits: 0 }) : ""}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function FinanceView({ onBack, isVisible = true, refreshKey = 0 }: Props) {
  const [todayDate, setTodayDate] = useState(todayLocal);
  const [currentMonth, setCurrentMonth] = useState(() => monthLocal());

  const [expenses, setExpenses]     = useState<Expense[]>([]);
  const [catTotals, setCatTotals]   = useState<{ category: string; total: number }[]>([]);
  const [dailyData, setDailyData]   = useState<{ date: string; total: number }[]>([]);
  const [monthTotal, setMonthTotal] = useState(0);
  const [todayTotal, setTodayTotal] = useState(0);
  const [monthIncome, setMonthIncome] = useState(0);
  const [budgets, setBudgets]       = useState<Budget[]>([]);
  const [goals, setGoals]           = useState<SavingGoal[]>([]);
  const [recentCats, setRecentCats] = useState<string[]>([]);
  // Categories come from the database now, so they are state like anything else
  // the user can change rather than a constant imported at the top of the file.
  const [categories, setCategories] = useState<CategoryRow[]>(() => getCategoryList());
  const [showCats, setShowCats] = useState(false);
  const [allCats, setAllCats] = useState<CategoryRow[]>([]);
  const [newCat, setNewCat] = useState({ label: "", emoji: "📦" });

  const refreshCats = async () => {
    await loadCategories();
    setCategories(getCategoryList());
    setAllCats(getAllCategoriesCached());
  };
  const [loading, setLoading]       = useState(true);

  // How the month is being looked at. All three modes read data that is already
  // loaded, so switching between them costs no query.
  const [viewMode, setViewMode]       = useState<"month" | "calendar">("month");
  const [selectedDay, setSelectedDay] = useState(todayLocal);
  const [showAllCats, setShowAllCats] = useState(false);

  // Income could only ever be entered through the AI chat, which is why the
  // income and balance figures had been reading zero and a dash since the
  // screen was built. It gets a real button and a real list entry now.
  const [incomes, setIncomes] = useState<any[]>([]);
  const [prevMonthTotal, setPrevMonthTotal] = useState(0);
  const [showAddIncome, setShowAddIncome] = useState(false);
  const [incForm, setIncForm] = useState(() => ({
    amount: "", source: "", note: "", date: todayLocal(), currency: getCurrency(),
  }));

  const [showAddExpense, setShowAddExpense] = useState(false);
  const [expForm, setExpForm] = useState(() => ({
    amount: "", category: "food" as ExpenseCategory, note: "", date: todayLocal(),
    slipRef: null as string | null, merchant: null as string | null,
    currency: getCurrency(),
  }));
  const slipRef = useRef<HTMLInputElement>(null);
  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState("");

  /** A row read out of an image, waiting to be confirmed. */
  interface ReviewRow extends ScannedItem {
    id: number;
    keep: boolean;
    maybeDup: boolean;
  }
  const [review, setReview] = useState<ReviewRow[] | null>(null);

  // One image can be a single slip or eight rows of a Shopee list, so the
  // result is always reviewed rather than saved. The model misreads a smudged
  // digit occasionally, and eight wrong expenses appearing unannounced is far
  // worse than eight that took one extra tap.
  const handleImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setScanning(true);
    setScanMsg("");
    try {
      const result = await scanImage(
        file,
        categories.map(c => ({ key: c.key, label: c.label })),
        // The spinner alone during a second attempt looks like a hang.
        n => { if (n === 2) setScanMsg(t("finance.scanRetry")); },
      );
      if (result.items.length === 0) {
        setScanMsg(t("finance.scanNone"));
        return;
      }

      const rows: ReviewRow[] = [];
      for (let i = 0; i < result.items.length; i++) {
        const it = result.items[i];
        // Two kinds of duplicate. A reference match is exact, so that row is
        // switched off. A same-day same-amount match is only a hint — buying
        // the same coffee twice in one day is real — so it is flagged and left
        // for the user to judge.
        const exact = it.reference ? await slipAlreadyRecorded(it.reference) : false;
        const soft = !exact && it.date && it.amount
          ? await looksLikeDuplicate(it.date, it.amount)
          : false;
        rows.push({
          ...it,
          id: i,
          // A top-up moves money between the user's own accounts. Counting it
          // as spending double-counts the same baht when it is finally spent.
          // Off by default for anything that is not plainly money spent. A
          // top-up moves money between the user's own accounts, so counting it
          // as spending double-counts the same baht when it is finally spent.
          // A bill that has not been paid is a claim about the future, not a
          // record of anything.
          //
          // Incoming rows are the case where the two kinds of image want
          // opposite defaults, which is what result.source is for. Pointing a
          // camera at ONE payment slip means that payment, whichever way the
          // money went — a salary slip arriving unticked is the app arguing
          // with something the person plainly just chose to scan. A LIST is
          // different: a wallet history is almost always opened to find
          // spending, and it carries incoming rows as a side effect, so those
          // start off.
          keep: !exact && !soft && it.kind !== "topup" && it.kind !== "bill_due"
            && (it.direction === "out" || result.source === "slip"),
          maybeDup: exact || soft,
          // A shop categorised before beats the model's guess for this image.
          category: (it.merchant && recallMerchant(it.merchant)) || it.category,
        });
      }
      setReview(rows);
      setScanMsg(
        t("finance.scanFound", { n: String(rows.length) }) +
        (result.truncated ? ` · ${t("finance.scanPartial")}` : ""),
      );
    } catch (err: any) {
      const code = String(err?.message ?? "");
      // Showing what actually came back beats a generic failure: a wrong key, a
      // refused request and a model answering in prose all look identical
      // otherwise, and each needs a different fix.
      const raw = getLastRawReply();
      setScanMsg(
        code.includes("NO_KEY") ? t("finance.scanNoKey")
        : code.includes("DAILY_CAP") ? t("finance.scanCapped")
        : code.includes("BAD_JSON") && raw ? `${t("finance.scanRaw")} ${raw.slice(0, 120)}`
        : `${t("finance.scanFailed")} (${code.replace("AI_ERROR: ", "").slice(0, 90)})`,
      );
    } finally {
      setScanning(false);
    }
  };

  const saveReviewed = async () => {
    if (!review) return;
    for (const row of review) {
      if (!row.keep || row.amount == null) continue;

      // Ticked on despite being incoming: the person means it, so it is saved
      // as what it is. Writing it to expenses because that is the table this
      // screen happens to be attached to would be the bug this field exists to
      // prevent, just moved one step later.
      if (row.direction === "in") {
        await addIncome({
          amount: row.amount,
          // On an arriving payment the name on the slip IS the source. It was
          // being written to the note with "other" as the source, which threw
          // away the one thing that says where the money came from.
          source: row.merchant?.trim() || "other",
          note: "",
          date: row.date ?? todayDate,
          currency: row.currency ?? undefined,
        });
        continue;
      }

      await addExpense({
        amount: row.amount,
        // "other", not the most recently used category. Falling back to that
        // filed a row the model could not classify under whatever happened to
        // be at the front of the picker, which is a wrong number in a real
        // category rather than an honest unknown in a bucket meant for them.
        category: (row.category ?? "other") as ExpenseCategory,
        note: row.merchant ?? "",
        date: row.date ?? todayDate,
        slipRef: row.reference,
        // What the slip was printed in, not what the app is set to.
        currency: row.currency ?? undefined,
      });
      if (row.merchant && row.category) learnMerchant(row.merchant, row.category);
    }
    setReview(null);
    setScanMsg("");
    setShowAddExpense(false);
    load();
  };

  const [showAddGoal, setShowAddGoal] = useState(false);
  const [goalForm, setGoalForm] = useState({ name: "", target: "", deadline: "", emoji: "🎯" });

  const [editBudget, setEditBudget] = useState<{ cat: ExpenseCategory; value: string } | null>(null);
  const [addToGoalState, setAddToGoalState] = useState<{ id: number; value: string } | null>(null);
  const [openGoal, setOpenGoal] = useState<number | null>(null);

  const [editingExpense, setEditingExpense] = useState<{
    id: number; amount: string; category: ExpenseCategory; note: string; date: string;
    currency: string;
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
      currency: editingExpense.currency,
    });
    setEditingExpense(null);
    load();
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const prev = (() => {
        const d = new Date(currentMonth + "-01T00:00:00");
        d.setMonth(d.getMonth() - 1);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      })();
      const [exp, cats, daily, mTotal, tTotal, buds, gls, mIncome, recent, incs, pTotal] = await Promise.all([
        getExpensesByMonth(currentMonth),
        getTotalByCategory(currentMonth),
        getDailyTotals(currentMonth),
        getMonthTotal(currentMonth),
        getTodayTotal(todayDate),
        getBudgetsForMonth(currentMonth),
        getGoals(),
        getMonthIncome(currentMonth),
        getRecentCategories(),
        getIncomeByMonth(currentMonth),
        getMonthTotal(prev),
      ]);
      await loadCategories();
      setCategories(getCategoryList());
      setExpenses(exp);
      setCatTotals(cats);
      setDailyData(daily);
      setMonthTotal(mTotal);
      setTodayTotal(tTotal);
      setBudgets(buds);
      setGoals(gls);
      setMonthIncome(mIncome);
      setRecentCats(recent);
      setIncomes(incs);
      setPrevMonthTotal(pTotal);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, [currentMonth, todayDate]);

  useEffect(() => { load(); }, [load, isVisible, refreshKey]);

  // Paging the month must drag the selected day with it, or the calendar shows
  // June while the list beside it is still headed 26 July.
  useEffect(() => {
    if (selectedDay.slice(0, 7) === currentMonth) return;
    const today = todayLocal();
    setSelectedDay(today.slice(0, 7) === currentMonth ? today : `${currentMonth}-01`);
  }, [currentMonth, selectedDay]);

  // Roll the "today" figure over at midnight without a restart.
  useEffect(() => {
    const interval = setInterval(() => {
      const now = todayLocal();
      setTodayDate(prev => (prev === now ? prev : now));
    }, 60_000);
    return () => clearInterval(interval);
  }, []);

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

  const openAddExpense = () => {
    setScanMsg("");
    setExpForm({
      amount: "",
      category: (orderedCats[0]?.key ?? "food") as ExpenseCategory,
      note: "",
      date: todayDate,
      slipRef: null,
      merchant: null,
      // Read on open rather than once at mount, so changing the setting while
      // the screen is up is picked up by the next entry.
      currency: getCurrency(),
    });
    setShowAddExpense(true);
  };

  const handleAddExpense = async () => {
    const amt = parseFloat(expForm.amount);
    if (!amt || amt <= 0) return;
    await addExpense({
      amount: amt, category: expForm.category, note: expForm.note,
      date: expForm.date, slipRef: expForm.slipRef, currency: expForm.currency,
    });
    // Whatever category it was saved under is the right one for that shop,
    // including when the user overrode the model's guess.
    if (expForm.merchant) learnMerchant(expForm.merchant, expForm.category);
    setExpForm({ amount: "", category: "food", note: "", date: todayDate, slipRef: null, merchant: null, currency: getCurrency() });
    setScanMsg("");
    setShowAddExpense(false);
    load();
  };

  const handleAddIncome = async () => {
    const amt = parseFloat(incForm.amount);
    if (!amt || amt <= 0) return;
    await addIncome({
      amount: amt, source: incForm.source, note: incForm.note,
      date: incForm.date, currency: incForm.currency,
    });
    setIncForm({ amount: "", source: "", note: "", date: todayDate, currency: getCurrency() });
    setShowAddIncome(false);
    load();
  };

  const handleAddGoal = async () => {
    if (!goalForm.name || !goalForm.target) return;
    await createGoal({
      name: goalForm.name,
      target_amount: parseFloat(goalForm.target),
      deadline: goalForm.deadline || undefined,
      emoji: goalForm.emoji,
    });
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

  // Categories most recently used first, then the rest in their declared order.
  const orderedCats = useMemo(() => {
    const rank = new Map(recentCats.map((c, i) => [c, i]));
    return [...categories].sort((a: CategoryRow, b: CategoryRow) => {
      const ra = rank.has(a.key) ? rank.get(a.key)! : 999;
      const rb = rank.has(b.key) ? rank.get(b.key)! : 999;
      return ra - rb;
    });
  }, [recentCats, categories]);

  const pickDay = (iso: string) => {
    setSelectedDay(iso);
    const m = iso.slice(0, 7);
    if (m !== currentMonth) setCurrentMonth(m);
  };

  // The analysis pane is always about the month. Only the list pane narrows to
  // a single day, and it does so from rows already in memory — no extra query,
  // so clicking around the calendar is instant.
  const isCalendar = viewMode === "calendar";
  const listExpenses = useMemo(
    () => (isCalendar ? expenses.filter(e => e.date === selectedDay) : expenses),
    [isCalendar, expenses, selectedDay],
  );
  const dayTotal = useMemo(
    () => listExpenses.reduce((sum, e) => sum + e.amount, 0),
    [listExpenses],
  );

  // One list for money out and money in. Two separate lists would mean two
  // places to look for "what happened on the 26th", which is the question the
  // list exists to answer.
  // `currency` is optional and absent means "whatever the app is set to",
  // which is what every row written before the column existed means too.
  type Row =
    | { kind: "expense"; id: number; date: string; amount: number; currency?: string; note: string; category: string }
    | { kind: "income";  id: number; date: string; amount: number; currency?: string; note: string; source: string };

  const listRows = useMemo<Row[]>(() => {
    const inc = (isCalendar ? incomes.filter(i => i.date === selectedDay) : incomes)
      .map((i): Row => ({
        kind: "income", id: i.id, date: i.date, amount: i.amount,
        currency: i.currency ?? undefined,
        note: i.note ?? "", source: i.source ?? "",
      }));
    const exp = listExpenses.map((e): Row => ({
      kind: "expense", id: e.id, date: e.date, amount: e.amount,
      currency: e.currency ?? undefined,
      note: e.note ?? "", category: e.category,
    }));
    return [...inc, ...exp].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }, [isCalendar, incomes, selectedDay, listExpenses]);

  // Rows this month in some other unit, which the totals above deliberately do
  // not include. Empty almost always, and then this renders nothing at all.
  const [otherCur, setOtherCur] = useState<Map<string, number>>(new Map());
  useEffect(() => { otherCurrencyTotals(currentMonth).then(setOtherCur); }, [currentMonth, expenses]);

  // The same question asked of income, which nobody had asked before. Without
  // it a month whose earnings were all in dollars is indistinguishable from a
  // month with no earnings — and the balance beside it says so in the direction
  // most likely to frighten someone checking it because they are worried.
  const [otherInc, setOtherInc] = useState<Map<string, number>>(new Map());
  useEffect(() => { otherIncomeCurrencyTotals(currentMonth).then(setOtherInc); }, [currentMonth, incomes]);

  // Figures that need more than one month of context. Projection only makes
  // sense while a month is still running, so it is hidden once it has ended.
  const insights = useMemo(() => {
    const first = new Date(currentMonth + "-01T00:00:00");
    const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    const running = currentMonth === monthLocal();
    const elapsed = running ? Math.max(1, parseInt(todayDate.slice(8), 10)) : daysInMonth;
    const avg = monthTotal / elapsed;
    const deltaPct = prevMonthTotal > 0
      ? Math.round(((monthTotal - prevMonthTotal) / prevMonthTotal) * 100)
      : null;
    return {
      avg,
      deltaPct,
      projected: running ? avg * daysInMonth : null,
      prev: prevMonthTotal,
    };
  }, [currentMonth, todayDate, monthTotal, prevMonthTotal]);

  const catRows = useMemo(() => {
    const base = getCurrency();
    // WHY THIS IS NOT JUST `categories.map`.
    //
    // This panel used to be built from the visible category list alone, so any
    // spending filed under a key that is not in it had nowhere to land: hidden
    // categories, and keys the model invented before those were coerced. The
    // money still counted in the figure at the top and still drew its bar on
    // the daily chart. It simply had no row here.
    //
    // So the bars were free to sum to less than the headline with nothing
    // saying so — the same failure as a total that leaves rows out silently,
    // which is the thing this screen was just taught not to do. Anything with
    // money in it gets a row, whether or not the list knows what it is.
    const known = new Set(categories.map(c => c.key));
    const strays = [...new Set(catTotals.map(c => c.category))]
      .filter(k => !known.has(k))
      .map(k => lookupCategory(k));
    const rows = [...categories, ...strays].map((cat: CategoryRow) => {
      const spent = catTotals.find(c => c.category === cat.key)?.total ?? 0;
      // A limit only means something against spending counted the same way. One
      // recorded in another unit is kept and shown on the budget sheet, but it
      // does not drive the bar, because a ฿5,000 line and $600 of spending have
      // no ratio between them.
      const bRow = budgets.find(b => b.category === cat.key);
      const budget = bRow && (bRow.currency ?? base) === base ? bRow.limit_amount : null;
      const shareOfSpend = monthTotal > 0 ? spent / monthTotal : 0;
      const pct = budget ? Math.min(spent / budget, 1) : shareOfSpend;
      return {
        ...cat, spent, budget, pct,
        over: budget !== null && spent > budget,
        near: budget !== null && spent <= budget && spent >= budget * 0.8,
      };
    });
    // Anything with money or a budget floats up; untouched categories sit below.
    return rows.sort((a, b) => {
      if ((b.spent > 0 ? 1 : 0) !== (a.spent > 0 ? 1 : 0)) return (b.spent > 0 ? 1 : 0) - (a.spent > 0 ? 1 : 0);
      if (b.spent !== a.spent) return b.spent - a.spent;
      return (b.budget ?? 0) - (a.budget ?? 0);
    });
  }, [catTotals, budgets, monthTotal, categories]);

  // Categories with nothing in them are kept out of the way until asked for.
  // Nine always-visible rows were pushing goals and transactions off screen.
  const visibleCatRows = useMemo(
    () => (showAllCats ? catRows : catRows.filter(r => r.spent > 0 || r.budget !== null)),
    [catRows, showAllCats],
  );
  const hiddenCatCount = catRows.length - visibleCatRows.length;

  const monthLabel = useMemo(() => {
    const d = new Date(currentMonth + "-15");
    if (getLang() === "th") {
      return d.toLocaleDateString("th-TH-u-ca-buddhist", { month: "long", year: "numeric" });
    }
    return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  }, [currentMonth]);

  const isCurrentMonth = currentMonth === monthLocal();
  const balance = monthIncome - monthTotal;

  const goalsCard = (
    <div className="rounded-xl border border-white/8 p-3">
      <div className="flex items-center justify-between mb-2">
        <p className="text-white/40 text-[11px]">{t("finance.tabGoals")}</p>
        <button onClick={() => setShowAddGoal(true)}
          className="text-white/30 hover:text-white transition-colors"><Plus size={13} /></button>
      </div>

      {goals.length === 0 ? (
        <p className="text-white/25 text-[11px]">{t("finance.noGoals")}</p>
      ) : (
        <div className="space-y-2">
          {goals.map(g => {
            const pct = Math.min(100, Math.round((g.current_amount / g.target_amount) * 100));
            const open = openGoal === g.id;
            return (
              <div key={g.id}>
                <button onClick={() => setOpenGoal(open ? null : g.id)}
                  className="w-full text-left">
                  <div className="flex items-baseline gap-1.5 mb-1">
                    <span className="text-[13px]">{g.emoji}</span>
                    <span className="text-white text-[11px] truncate flex-1 min-w-0">{g.name}</span>
                    <span className="text-white/45 text-[10px] shrink-0">{pct}%</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-white/6 overflow-hidden">
                    <div className="h-full rounded-full transition-all"
                      style={{ width: `${pct}%`, background: "var(--color-primary)" }} />
                  </div>
                  <p className="text-white/25 text-[10px] mt-0.5">
                    {fmt(g.current_amount, g.currency)} / {fmt(g.target_amount, g.currency)}
                  </p>
                </button>

                <AnimatePresence>
                  {open && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      className="overflow-hidden">
                      <div className="flex gap-1.5 pt-2">
                        <input type="number"
                          value={addToGoalState?.id === g.id ? addToGoalState.value : ""}
                          onChange={e => setAddToGoalState({ id: g.id, value: e.target.value })}
                          onKeyDown={e => { if (e.key === "Enter") handleAddToGoal(); }}
                          placeholder={t("finance.savingAmtPH", { c: currencySymbol(g.currency) })}
                          className="flex-1 min-w-0 bg-white/5 border border-white/10 rounded-lg px-2 py-1 text-white text-[11px] placeholder-white/25 focus:outline-none focus:border-white/30" />
                        <button onClick={handleAddToGoal}
                          className="theme-btn text-white rounded-lg px-2.5"><Check size={12} /></button>
                        <button onClick={async () => { await deleteGoal(g.id); setOpenGoal(null); load(); }}
                          className="text-white/30 hover:text-red-400 transition-colors px-1">
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  // w-full on the root is load-bearing. Its parent in App.tsx is a row flex
  // container, so without an explicit width this whole screen sizes to its own
  // content and leaves the right of the window empty however the panes inside
  // are configured. That was the empty right half, not the pane percentages.
  return (
    <div className="flex flex-col h-full w-full min-h-0">

      {/* ── Header: one line ─────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-3.5 py-2 border-b border-white/8 shrink-0">
        <button onClick={onBack} className="text-white/50 hover:text-white transition-colors p-1 -ml-1">
          <ArrowLeft size={17} />
        </button>
        <span className="text-white font-bold text-sm">{t("finance.title")}</span>

        {/* Two chips instead of a <select>. Chromium renders the native option
            list with OS chrome that cannot be styled, so it arrived white and
            blue in the middle of a dark app. Two options also do not deserve a
            menu — one click beats two. */}
        <div className="flex items-center gap-1 rounded-lg bg-white/5 p-0.5">
          {([
            { key: "month" as const,    label: t("finance.viewMonth"),    Icon: BarChart3 },
            { key: "calendar" as const, label: t("finance.viewCalendar"), Icon: CalendarDays },
          ]).map(m => (
            <button key={m.key} onClick={() => setViewMode(m.key)}
              className={`text-[11px] rounded-md px-2.5 py-1 flex items-center gap-1.5 transition-colors ${
                viewMode === m.key ? "theme-btn text-white" : "text-white/45 hover:text-white"
              }`}>
              <m.Icon size={12} /> {m.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-0.5 ml-auto">
          <button onClick={prevMonth} className="text-white/40 hover:text-white p-1"><ChevronLeft size={15} /></button>
          <span className="text-white/70 text-xs min-w-[92px] text-center">{monthLabel}</span>
          <button onClick={nextMonth} disabled={isCurrentMonth}
            className="text-white/40 hover:text-white disabled:opacity-20 p-1"><ChevronRight size={15} /></button>
        </div>

        <button onClick={openAddExpense}
          className="theme-btn text-white text-xs font-semibold rounded-lg px-3 py-1.5 flex items-center gap-1">
          <Plus size={13} /> {t("finance.add")}
        </button>
      </div>

      {/* ── Stat strip ───────────────────────────────────────────────────────
          Four tiles instead of a run-on line. Income has an add button on it,
          because until now the only way to record income anywhere in the app
          was to ask the AI chat, which is why this figure and the balance next
          to it had never shown anything but zero and a dash. */}
      <div className="grid grid-cols-4 gap-2 px-3.5 py-2.5 shrink-0">
        <div className="rounded-xl bg-white/4 px-3 py-2">
          <p className="text-white/40 text-[10px]">{t("finance.statMonth")}</p>
          <div className="flex items-baseline gap-1.5">
            <span className="text-white text-lg font-bold leading-tight">{fmt(monthTotal)}</span>
            {otherCur.size > 0 && (
              <span className="block text-white/35 text-[10px] leading-tight">
                + {formatTotals(otherCur)}
              </span>
            )}
            {insights.deltaPct !== null && (
              <span className={`text-[10px] flex items-center gap-0.5 ${
                insights.deltaPct > 0 ? "text-red-400" : "text-emerald-400"}`}>
                {insights.deltaPct > 0 ? <TrendingUp size={10} /> : <TrendingDown size={10} />}
                {Math.abs(insights.deltaPct)}%
              </span>
            )}
          </div>
        </div>

        <div className="rounded-xl bg-white/4 px-3 py-2">
          <p className="text-white/40 text-[10px]">{t("finance.statToday")}</p>
          <span className="text-white text-lg font-bold leading-tight">{fmt(todayTotal)}</span>
        </div>

        <div className="rounded-xl bg-white/4 px-3 py-2 flex items-start justify-between gap-1">
          <div className="min-w-0">
            <p className="text-white/40 text-[10px]">{t("finance.statIncome")}</p>
            <span className="text-white text-lg font-bold leading-tight">{fmt(monthIncome)}</span>
            {otherInc.size > 0 && (
              <span className="block text-white/35 text-[10px] leading-tight">
                + {formatTotals(otherInc)}
              </span>
            )}
          </div>
          <button onClick={() => { setIncForm({ amount: "", source: "", note: "", date: todayDate, currency: getCurrency() }); setShowAddIncome(true); }}
            title={t("finance.incomeTitle")}
            className="text-white/35 hover:text-white transition-colors shrink-0 mt-0.5">
            <Plus size={14} />
          </button>
        </div>

        {/* Income minus spending is only a subtraction when both sides are
            counted in the same unit, and this figure is the one someone opens
            the screen to look at. When part of either side was recorded in
            something else it still shows — the number is true of the currency
            it is in — with a line saying it is not the whole picture. Saying
            nothing would be the same failure as an incomplete total that does
            not admit it. */}
        <div className="rounded-xl bg-white/4 px-3 py-2">
          <p className="text-white/40 text-[10px]">{t("finance.statBalance")}</p>
          <span className={`text-lg font-bold leading-tight ${
            monthIncome === 0 ? "text-white/25" : balance < 0 ? "text-red-400" : "text-emerald-400"}`}>
            {monthIncome === 0 ? "—" : fmt(balance)}
          </span>
          {(otherInc.size > 0 || otherCur.size > 0) && (
            <span className="block text-white/35 text-[10px] leading-tight">
              {t("finance.balancePartial")}
            </span>
          )}
        </div>
      </div>

      {/* ── Two panes ──────────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 flex flex-col md:flex-row gap-3 px-3.5 pb-3">

        {/* Left: analysis. Four small cards rather than one wide one — a single
            category bar stretched across the full column read as a meaningless
            100% progress bar, and the day chart became two enormous blocks. */}
        <div className="md:w-[58%] min-h-0 overflow-y-auto finance-scroll pr-1">

          {viewMode === "calendar" ? (
            <div className="flex flex-col gap-3">
              <div className="rounded-xl border border-white/8 p-3">
                <MonthCalendar month={currentMonth} data={dailyData}
                  selected={selectedDay} onPick={pickDay} />
              </div>
              <ExpectedIncomeCard onChanged={load} />
              {goalsCard}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 auto-rows-min">
              {/* Categories and budgets, one row each */}
              <div className="rounded-xl border border-white/8 p-3">
                <p className="text-white/40 text-[11px] mb-2.5">{t("finance.catSpend")}</p>
                {loading && catRows.every(r => r.spent === 0) ? (
                  <p className="text-white/25 text-[11px]">{t("finance.loading")}</p>
                ) : visibleCatRows.length === 0 ? (
                  <p className="text-white/25 text-[11px]">{t("finance.noData")}</p>
                ) : (
                  <div className="space-y-2">
                    {visibleCatRows.map(row => (
                      <div key={row.key}>
                        <div className="flex items-baseline gap-1.5 mb-1">
                          <span className="text-[13px]">{row.emoji}</span>
                          <span className="text-white text-[11px] truncate flex-1 min-w-0">{row.label}</span>
                          <span className={`text-[11px] ${row.over ? "text-red-400" : "text-white/70"}`}>
                            {fmt(row.spent)}
                          </span>
                          {row.over && <AlertTriangle size={10} className="text-red-400" />}
                        </div>
                        <div className="h-1.5 rounded-full bg-white/6 overflow-hidden">
                          <motion.div
                            initial={{ width: 0 }} animate={{ width: `${row.pct * 100}%` }}
                            transition={{ duration: 0.4 }}
                            className="h-full rounded-full"
                            style={{ background: row.over ? "#f87171" : row.near ? "#fbbf24" : "var(--color-primary)" }}
                          />
                        </div>
                        <button
                          onClick={() => setEditBudget({ cat: row.key, value: row.budget !== null ? String(row.budget) : "" })}
                          className="text-white/25 hover:text-white text-[10px] transition-colors mt-0.5">
                          {row.budget !== null ? `${t("finance.ofBudget")} ${fmt(row.budget)}` : t("finance.setBudget")}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex items-center gap-3 mt-2">
                  {(hiddenCatCount > 0 || showAllCats) && (
                    <button onClick={() => setShowAllCats(v => !v)}
                      className="text-white/30 hover:text-white text-[10px] transition-colors">
                      {showAllCats ? t("finance.hideCats") : `${t("finance.showAllCats")} (+${hiddenCatCount})`}
                    </button>
                  )}
                  <button onClick={async () => { await refreshCats(); setShowCats(true); }}
                    className="text-white/30 hover:text-white text-[10px] transition-colors ml-auto">
                    {t("finance.manageCats")}
                  </button>
                </div>
              </div>

              {/* Daily trend across the whole month */}
              <div className="rounded-xl border border-white/8 p-3 flex flex-col">
                <p className="text-white/40 text-[11px] mb-2.5">{t("finance.dailyChart")}</p>
                <SparkBars month={currentMonth} data={dailyData} />
                <div className="flex justify-between text-white/25 text-[9px] mt-1">
                  <span>1</span>
                  <span>{new Date(new Date(currentMonth + "-01T00:00:00").getFullYear(),
                    new Date(currentMonth + "-01T00:00:00").getMonth() + 1, 0).getDate()}</span>
                </div>
              </div>

              {goalsCard}

              {/* Numbers that need more than this month to mean anything */}
              <div className="rounded-xl border border-white/8 p-3">
                <p className="text-white/40 text-[11px] mb-2.5">{t("finance.summary")}</p>
                <div className="space-y-1.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-white/45 text-[11px]">{t("finance.vsLastMonth")}</span>
                    <span className="text-white text-[11px]">
                      {insights.prev > 0 ? fmt(insights.prev) : t("finance.noPrevMonth")}
                    </span>
                  </div>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-white/45 text-[11px]">{t("finance.avgPerDay")}</span>
                    <span className="text-white text-[11px]">{fmt(Math.round(insights.avg))}</span>
                  </div>
                  {insights.projected !== null && (
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-white/45 text-[11px]">{t("finance.projected")}</span>
                      <span className="text-white text-[11px]">{fmt(Math.round(insights.projected))}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Right: money out and money in, one list, scrolling on its own */}
        <div className="flex-1 min-h-0 flex flex-col rounded-xl border border-white/8">
          <div className="flex items-baseline gap-2 px-3 py-2.5 border-b border-white/8 shrink-0">
            <p className="text-white/40 text-[11px]">
              {isCalendar ? toThaiDisplay(selectedDay) : t("finance.recentTx")}
            </p>
            <span className="text-white/25 text-[10px]">
              {t("finance.items", { n: listRows.length })}
            </span>
            {isCalendar && (
              <span className="text-white text-xs font-semibold ml-auto">{fmt(dayTotal)}</span>
            )}
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto finance-scroll px-3 pb-2">
            {listRows.length === 0 ? (
              <p className="text-white/25 text-xs py-4">{t("finance.noExpenses")}</p>
            ) : (
              <div className="space-y-0.5">
                {listRows.map(r => {
                  const cat = r.kind === "expense"
                    ? lookupCategory(r.category)
                    : undefined;
                  return (
                    <div key={`${r.kind}-${r.id}`}
                      className="group flex items-center gap-2.5 py-1.5 border-b border-white/5">
                      <span className="text-sm w-5 text-center shrink-0">
                        {r.kind === "income" ? <Wallet size={14} className="text-emerald-400 mx-auto" /> : (cat?.emoji ?? "💸")}
                      </span>
                      <span className="text-white text-xs flex-1 min-w-0 truncate">
                        {r.kind === "income"
                          ? (r.note || r.source || t("finance.addIncome"))
                          : (r.note || cat?.label || r.category)}
                      </span>
                      {!isCalendar && (
                        <span className="text-white/30 text-[10px] shrink-0">{toThaiDisplay(r.date)}</span>
                      )}
                      <span className={`text-xs font-semibold shrink-0 w-16 text-right ${
                        r.kind === "income" ? "text-emerald-400" : "text-white"}`}>
                        {/* IN ITS OWN CURRENCY, not the app's.
                            This read fmt(r.amount), which falls back to the
                            setting — so a $10,000 slip scanned and saved
                            correctly as USD was drawn as ฿10,000 the moment the
                            setting went back to baht. The database was right
                            the whole time and the screen was rewriting history
                            every time the setting changed, which looks exactly
                            like the app converting old rows, the one thing it
                            promises never to do. */}
                        {r.kind === "income" ? "+" : ""}{fmt(r.amount, r.currency)}
                      </span>
                      <div className="flex gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                        {r.kind === "expense" && (
                          <button
                            onClick={() => setEditingExpense({
                              id: r.id, amount: String(r.amount),
                              category: r.category as ExpenseCategory, note: r.note, date: r.date,
                              currency: r.currency ?? getCurrency(),
                            })}
                            className="text-white/30 hover:text-white p-1"><Edit3 size={11} /></button>
                        )}
                        <button
                          onClick={async () => {
                            if (r.kind === "income") await deleteIncome(r.id);
                            else await deleteExpense(r.id);
                            load();
                          }}
                          className="text-white/30 hover:text-red-400 p-1"><Trash2 size={11} /></button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Add expense sheet: amount, category, done ────────────────────── */}
      <AnimatePresence>
        {showAddExpense && isVisible && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
            onClick={() => setShowAddExpense(false)}>
            <motion.div initial={{ y: 30, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 30, opacity: 0 }}
              onClick={e => e.stopPropagation()}
              className="bg-gray-900 border border-white/10 rounded-2xl p-4 w-full max-w-sm">

              <div className="flex items-center justify-between mb-3">
                <h3 className="text-white font-semibold text-sm">{t("finance.addExpenseTitle")}</h3>
                <button onClick={() => setShowAddExpense(false)} className="text-white/40 hover:text-white"><X size={16} /></button>
              </div>

              <button onClick={() => slipRef.current?.click()} disabled={scanning}
                className="w-full mb-3 py-2 rounded-xl border border-white/12 text-white/70 text-xs font-semibold flex items-center justify-center gap-2 hover:text-white hover:border-white/25 transition-colors disabled:opacity-40">
                <ScanLine size={14} />
                {scanning ? t("finance.scanning") : t("finance.scanImage")}
              </button>
              <input ref={slipRef} type="file" accept="image/*" className="hidden" onChange={handleImage} />
              {scanMsg && <p className="text-amber-300/80 text-[11px] mb-2 px-1">{scanMsg}</p>}

              {/* Review list. Shown instead of the manual form when an image
                  produced rows: a Shopee list gives eight of them, and typing
                  those in by hand is exactly what this feature exists to
                  avoid. Rows the app is unsure about arrive unticked. */}
              {review && (
                <div className="mb-3">
                  <div className="flex items-center gap-2 mb-2">
                    <button onClick={() => setReview(r => r && r.map(x => ({ ...x, keep: true })))}
                      className="text-white/40 hover:text-white text-[10px]">{t("finance.selectAll")}</button>
                    <button onClick={() => setReview(r => r && r.map(x => ({ ...x, keep: false })))}
                      className="text-white/40 hover:text-white text-[10px]">{t("finance.selectNone")}</button>
                    <button onClick={() => { setReview(null); setScanMsg(""); }}
                      className="text-white/30 hover:text-white text-[10px] ml-auto">{t("finance.editCancel")}</button>
                  </div>

                  <div className="max-h-52 overflow-y-auto finance-scroll space-y-1.5 pr-1">
                    {review.map(row => (
                      <div key={row.id}
                        className={`rounded-xl border p-2 ${row.keep ? "border-white/15" : "border-white/6 opacity-50"}`}>
                        <div className="flex items-center gap-2">
                          <input type="checkbox" checked={row.keep}
                            onChange={e => setReview(r => r && r.map(x => x.id === row.id ? { ...x, keep: e.target.checked } : x))}
                            className="accent-purple-500" />
                          {/* Editable, because a misread is the normal case, not
                              the exception. Reading a wrong value and being
                              unable to correct it is worse than typing it. */}
                          <input value={row.merchant ?? ""}
                            onChange={e => setReview(r => r && r.map(x => x.id === row.id ? { ...x, merchant: e.target.value } : x))}
                            placeholder={t("finance.notePH")}
                            className="flex-1 min-w-0 bg-transparent border-b border-white/10 text-white text-xs px-0.5 py-0.5 placeholder-white/25 focus:outline-none focus:border-white/40" />
                          {/* The symbol sits outside the input so the field
                              stays a real number input: typing a symbol into
                              one would silently clear it. It shows the currency
                              printed on the SLIP, which on a receipt from a
                              trip is not the one this app is set to. */}
                          <div className="flex items-baseline gap-0.5 border-b border-white/10 focus-within:border-white/40">
                            <CurrencyPicker size="sm" value={row.currency ?? undefined}
                              onChange={c => setReview(r => r && r.map(x => x.id === row.id ? { ...x, currency: c } : x))} />
                            <input type="number" inputMode="decimal" value={row.amount ?? ""}
                              onChange={e => setReview(r => r && r.map(x => x.id === row.id ? { ...x, amount: parseFloat(e.target.value) || null } : x))}
                              className="w-16 bg-transparent text-white text-xs font-semibold text-right px-0.5 py-0.5 focus:outline-none" />
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 mt-1.5 pl-6">
                          <DatePicker compact
                            value={row.date ?? ""}
                            onChange={v => setReview(r => r && r.map(x => x.id === row.id ? { ...x, date: v } : x))}
                            compactLabel={t("finance.noDate")} />
                          {row.maybeDup && (
                            <span className="text-amber-300/80 text-[10px]">{t("finance.maybeDup")}</span>
                          )}
                          {row.kind === "topup" && (
                            <span className="text-amber-300/80 text-[10px]">{t("finance.scanTopup")}</span>
                          )}
                          {/* DIRECTION IS A BUTTON, NOT A CAPTION.
                              It is the field most likely to be wrong and the
                              only one whose mistake is invisible: an expense
                              misfiled as income lands in a table nobody opens,
                              so it is not noticed the way a wrong amount on the
                              spending list is. It was rendered here as a label,
                              which meant the app could tell you it had guessed
                              and give you no way to say otherwise.

                              Shown on every row, not only incoming ones, so
                              that a wrong "out" can be corrected too. */}
                          <button
                            onClick={() => setReview(r => r && r.map(x => x.id === row.id
                              ? { ...x, direction: x.direction === "in" ? "out" : "in" } : x))}
                            className={`text-[10px] px-1.5 py-0.5 rounded-md border transition-colors ${
                              row.direction === "in"
                                ? "border-emerald-400/40 text-emerald-300/90 hover:bg-emerald-400/10"
                                : "border-white/10 text-white/35 hover:text-white/70"
                            }`}>
                            {row.direction === "in" ? t("finance.scanIncoming") : t("finance.scanOutgoing")}
                          </button>
                          {row.kind === "bill_due" && (
                            <span className="text-sky-300/80 text-[10px]">{t("finance.scanBillDue")}</span>
                          )}
                          {/* The last native <select> in the app. Chromium hands
                              the option list to Windows, so this one row was
                              still opening a grey system menu in the system font
                              in the middle of a dark app. */}
                          {/* Only for money going out. A spending category on
                              an incoming row is a question with no answer: what
                              names an arriving payment is who sent it, which is
                              already in the field above. It was still rendered,
                              still demanded an answer, and the answer was
                              discarded on save. */}
                          <div className={`ml-auto w-40 ${row.direction === "in" ? "invisible" : row.category ? "" : "rounded-xl ring-1 ring-amber-400/40"}`}>
                            <Select
                              value={row.category ?? ""}
                              placeholder={t("finance.pickCat")}
                              options={[
                                { value: "", label: t("finance.pickCat") },
                                ...categories.map(c => ({ value: c.key, icon: c.emoji, label: c.label })),
                              ]}
                              onChange={v => setReview(r => r && r.map(x => x.id === row.id ? { ...x, category: v || null } : x))}
                            />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>

                  <button onClick={saveReviewed}
                    disabled={!review.some(r => r.keep)}
                    className="w-full mt-2 py-2.5 theme-btn rounded-xl text-white text-sm font-semibold disabled:opacity-40">
                    {t("finance.addSelected")} ({review.filter(r => r.keep).length})
                  </button>
                </div>
              )}

              {/* The manual form is hidden while a scan is being reviewed. Two
                  amount fields on screen at once, only one of which the save
                  button reads, is a trap. */}
              {!review && (<>
              {/* Amount is the only thing that always has to be typed, so it is
                  focused on open and given the whole first line. */}
              <div className="flex items-baseline gap-2 border-b border-white/15 pb-2 mb-3">
                <CurrencyPicker value={expForm.currency}
                  onChange={c => setExpForm(f => ({ ...f, currency: c }))} />
                <input type="number" inputMode="decimal" autoFocus
                  value={expForm.amount}
                  onChange={e => setExpForm(f => ({ ...f, amount: e.target.value }))}
                  onKeyDown={e => { if (e.key === "Enter") handleAddExpense(); }}
                  placeholder="0"
                  className="flex-1 min-w-0 bg-transparent text-white text-3xl font-bold placeholder-white/15 focus:outline-none" />
              </div>

              {/* Most recently used first — after a week the one you want is at
                  the front instead of somewhere in a nine-button grid.

                  Wrapped rather than scrolled. Sideways scrolling hides how
                  many options there are and costs a drag to reach the last one,
                  to save vertical space this dialog was not short of. The same
                  chips already wrap in the assistant's confirmation card, so
                  two screens showing one list were disagreeing about it. */}
              <div className="flex flex-wrap gap-1.5 pb-2 mb-2">
                {orderedCats.map(cat => (
                  <button key={cat.key}
                    onClick={() => setExpForm(f => ({ ...f, category: cat.key }))}
                    className={`shrink-0 text-[11px] rounded-full px-3 py-1.5 border transition-colors whitespace-nowrap ${
                      expForm.category === cat.key
                        ? "theme-btn text-white border-transparent"
                        : "border-white/10 text-white/50 hover:text-white"
                    }`}>
                    {cat.emoji} {cat.label}
                  </button>
                ))}
              </div>

              <input value={expForm.note}
                onChange={e => setExpForm(f => ({ ...f, note: e.target.value }))}
                onKeyDown={e => { if (e.key === "Enter") handleAddExpense(); }}
                placeholder={t("finance.notePH")}
                className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-white text-xs placeholder-white/25 focus:outline-none focus:border-white/30 mb-2.5" />

              {/* Almost every entry is today or yesterday, so those are one tap
                  and the calendar is the exception rather than the default. */}
              <div className="flex items-center gap-1.5 mb-3">
                {[
                  { label: t("finance.today"), value: todayDate },
                  { label: t("finance.yesterday"), value: shiftDay(todayDate, -1) },
                ].map(opt => (
                  <button key={opt.value}
                    onClick={() => setExpForm(f => ({ ...f, date: opt.value }))}
                    className={`text-[11px] rounded-full px-3 py-1 border transition-colors ${
                      expForm.date === opt.value
                        ? "theme-btn text-white border-transparent"
                        : "border-white/10 text-white/50 hover:text-white"
                    }`}>
                    {opt.label}
                  </button>
                ))}
                <DatePicker compact
                  value={expForm.date !== todayDate && expForm.date !== shiftDay(todayDate, -1) ? expForm.date : ""}
                  onChange={v => v && setExpForm(f => ({ ...f, date: v }))}
                  compactLabel={t("finance.pickDate")} />
              </div>

              <button onClick={handleAddExpense}
                className="w-full py-2.5 theme-btn rounded-xl text-white text-sm font-semibold flex items-center justify-center gap-2">
                <Plus size={15} /> {t("finance.saveTxBtn")}
              </button>
              </>)}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Manage categories ────────────────────────────────────────────── */}
      <AnimatePresence>
        {showCats && isVisible && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
            onClick={() => setShowCats(false)}>
            <motion.div initial={{ y: 24, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 24, opacity: 0 }}
              onClick={e => e.stopPropagation()}
              className="bg-gray-900 border border-white/10 rounded-2xl p-4 w-full max-w-md max-h-[80vh] flex flex-col">

              <div className="flex items-center justify-between mb-3 shrink-0">
                <h3 className="text-white font-semibold text-sm">{t("finance.manageCats")}</h3>
                <button onClick={() => setShowCats(false)} className="text-white/40 hover:text-white"><X size={16} /></button>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto finance-scroll space-y-1.5 pr-1">
                {allCats.map((c, i) => (
                  <div key={c.id} className={`flex items-center gap-1.5 ${c.is_hidden ? "opacity-40" : ""}`}>
                    <input value={c.emoji}
                      onChange={e => updateCategory(c.id, { emoji: e.target.value.slice(0, 2) }).then(refreshCats)}
                      className="w-9 bg-white/5 border border-white/10 rounded-lg px-1 py-1.5 text-center text-sm focus:outline-none focus:border-white/30" />
                    <input defaultValue={c.label}
                      onBlur={e => { if (e.target.value !== c.label) updateCategory(c.id, { label: e.target.value }).then(refreshCats).catch(() => refreshCats()); }}
                      className="flex-1 min-w-0 bg-white/5 border border-white/10 rounded-lg px-2.5 py-1.5 text-white text-xs focus:outline-none focus:border-white/30" />
                    <button onClick={() => moveCategory(c.id, -1).then(refreshCats)} disabled={i === 0}
                      className="text-white/30 hover:text-white disabled:opacity-20 p-1"><ChevronLeft size={13} className="rotate-90" /></button>
                    <button onClick={() => moveCategory(c.id, 1).then(refreshCats)} disabled={i === allCats.length - 1}
                      className="text-white/30 hover:text-white disabled:opacity-20 p-1"><ChevronRight size={13} className="rotate-90" /></button>
                    <button onClick={() => setCategoryHidden(c.id, !c.is_hidden).then(refreshCats)}
                      className="text-white/30 hover:text-white text-[10px] px-1.5 whitespace-nowrap">
                      {c.is_hidden ? t("finance.showCat") : t("finance.hideCat")}
                    </button>
                  </div>
                ))}
              </div>

              <div className="border-t border-white/8 pt-3 mt-3 shrink-0">
                <div className="flex items-center gap-1.5">
                  <input value={newCat.emoji}
                    onChange={e => setNewCat(v => ({ ...v, emoji: e.target.value.slice(0, 2) }))}
                    className="w-9 bg-white/5 border border-white/10 rounded-lg px-1 py-1.5 text-center text-sm focus:outline-none focus:border-white/30" />
                  <input value={newCat.label}
                    onChange={e => setNewCat(v => ({ ...v, label: e.target.value }))}
                    onKeyDown={e => {
                      if (e.key === "Enter" && newCat.label.trim()) {
                        createCategory(newCat.label, newCat.emoji)
                          .then(refreshCats).then(() => setNewCat({ label: "", emoji: "📦" }));
                      }
                    }}
                    placeholder={t("finance.catNamePH")}
                    className="flex-1 min-w-0 bg-white/5 border border-white/10 rounded-lg px-2.5 py-1.5 text-white text-xs placeholder-white/25 focus:outline-none focus:border-white/30" />
                  <button
                    onClick={() => {
                      if (!newCat.label.trim()) return;
                      createCategory(newCat.label, newCat.emoji)
                        .then(refreshCats).then(() => setNewCat({ label: "", emoji: "📦" }));
                    }}
                    className="theme-btn text-white text-xs rounded-lg px-3 py-1.5 flex items-center gap-1">
                    <Plus size={12} /> {t("finance.newCat")}
                  </button>
                </div>
                <p className="text-white/25 text-[10px] mt-2 leading-relaxed">{t("finance.catHint")}</p>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Add income sheet ─────────────────────────────────────────────── */}
      <AnimatePresence>
        {showAddIncome && isVisible && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
            onClick={() => setShowAddIncome(false)}>
            <motion.div initial={{ y: 30, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 30, opacity: 0 }}
              onClick={e => e.stopPropagation()}
              className="bg-gray-900 border border-white/10 rounded-2xl p-4 w-full max-w-sm">

              <div className="flex items-center justify-between mb-3">
                <h3 className="text-white font-semibold text-sm">{t("finance.incomeTitle")}</h3>
                <button onClick={() => setShowAddIncome(false)} className="text-white/40 hover:text-white"><X size={16} /></button>
              </div>

              <div className="flex items-baseline gap-2 border-b border-emerald-400/40 pb-2 mb-3">
                <CurrencyPicker value={incForm.currency} tone="text-emerald-400/60"
                  onChange={c => setIncForm(f => ({ ...f, currency: c }))} />
                <input type="number" inputMode="decimal" autoFocus
                  value={incForm.amount}
                  onChange={e => setIncForm(f => ({ ...f, amount: e.target.value }))}
                  onKeyDown={e => { if (e.key === "Enter") handleAddIncome(); }}
                  placeholder="0"
                  className="flex-1 min-w-0 bg-transparent text-emerald-400 text-3xl font-bold placeholder-white/15 focus:outline-none" />
              </div>

              <input value={incForm.source}
                onChange={e => setIncForm(f => ({ ...f, source: e.target.value }))}
                onKeyDown={e => { if (e.key === "Enter") handleAddIncome(); }}
                placeholder={t("finance.sourcePH")}
                className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-white text-xs placeholder-white/25 focus:outline-none focus:border-white/30 mb-2" />

              <input value={incForm.note}
                onChange={e => setIncForm(f => ({ ...f, note: e.target.value }))}
                onKeyDown={e => { if (e.key === "Enter") handleAddIncome(); }}
                placeholder={t("finance.notePH")}
                className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-white text-xs placeholder-white/25 focus:outline-none focus:border-white/30 mb-2.5" />

              <div className="flex items-center gap-1.5 mb-3">
                {[
                  { label: t("finance.today"), value: todayDate },
                  { label: t("finance.yesterday"), value: shiftDay(todayDate, -1) },
                ].map(opt => (
                  <button key={opt.value}
                    onClick={() => setIncForm(f => ({ ...f, date: opt.value }))}
                    className={`text-[11px] rounded-full px-3 py-1 border transition-colors ${
                      incForm.date === opt.value
                        ? "theme-btn text-white border-transparent"
                        : "border-white/10 text-white/50 hover:text-white"
                    }`}>
                    {opt.label}
                  </button>
                ))}
                <DatePicker compact
                  value={incForm.date !== todayDate && incForm.date !== shiftDay(todayDate, -1) ? incForm.date : ""}
                  onChange={v => v && setIncForm(f => ({ ...f, date: v }))}
                  compactLabel={t("finance.pickDate")} />
              </div>

              <button onClick={handleAddIncome}
                className="w-full py-2.5 rounded-xl bg-emerald-500/20 border border-emerald-400/40 text-emerald-300 text-sm font-semibold flex items-center justify-center gap-2 hover:bg-emerald-500/30 transition-colors">
                <Plus size={15} /> {t("finance.incomeTitle")}
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Budget sheet ─────────────────────────────────────────────────── */}
      <AnimatePresence>
        {editBudget && isVisible && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
            onClick={() => setEditBudget(null)}>
            <motion.div initial={{ scale: 0.94, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.94, opacity: 0 }}
              onClick={e => e.stopPropagation()}
              className="bg-gray-900 border border-white/10 rounded-2xl p-4 w-full max-w-xs">
              <div className="flex items-start justify-between gap-2 mb-3">
                <div className="min-w-0">
                  <h3 className="text-white font-semibold text-sm leading-snug truncate">
                    {lookupCategory(editBudget.cat).emoji} {lookupCategory(editBudget.cat).label}
                  </h3>
                  {/* The month is a fact about this dialog, not part of the
                      category's name. It was being concatenated onto the end of
                      the title, which is how a sentence and a noun ended up
                      wrapped across two lines pretending to be one phrase. */}
                  <p className="text-white/35 text-[11px] leading-snug">
                    {t("finance.budgetFor", { month: monthLabel })}
                  </p>
                </div>
                <button onClick={() => setEditBudget(null)} className="text-white/40 hover:text-white shrink-0"><X size={16} /></button>
              </div>
              <input type="number" inputMode="decimal" autoFocus
                value={editBudget.value}
                onChange={e => setEditBudget(b => b && { ...b, value: e.target.value })}
                onKeyDown={e => { if (e.key === "Enter") handleSaveBudget(); }}
                placeholder={t("finance.budgetPH", { c: currencySymbol() })}
                className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-white text-lg font-bold placeholder-white/20 focus:outline-none focus:border-white/30 mb-3" />
              <button onClick={handleSaveBudget}
                className="w-full py-2.5 theme-btn rounded-xl text-white text-sm font-semibold">
                {t("finance.budgetSave")}
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Add goal sheet ───────────────────────────────────────────────── */}
      <AnimatePresence>
        {showAddGoal && isVisible && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
            onClick={() => setShowAddGoal(false)}>
            <motion.div initial={{ scale: 0.94, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.94, opacity: 0 }}
              onClick={e => e.stopPropagation()}
              className="bg-gray-900 border border-white/10 rounded-2xl p-4 w-full max-w-xs">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-white font-semibold text-sm">{t("finance.goalTitle")}</h3>
                <button onClick={() => setShowAddGoal(false)} className="text-white/40 hover:text-white"><X size={16} /></button>
              </div>
              <div className="space-y-2">
                <div className="flex gap-2">
                  <input value={goalForm.emoji}
                    onChange={e => setGoalForm(f => ({ ...f, emoji: e.target.value.slice(0, 2) }))}
                    className="w-12 bg-white/5 border border-white/10 rounded-xl px-2 py-2 text-center text-lg focus:outline-none" />
                  <input value={goalForm.name} autoFocus
                    onChange={e => setGoalForm(f => ({ ...f, name: e.target.value }))}
                    placeholder={t("finance.goalNamePH")}
                    className="flex-1 min-w-0 bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-white text-xs placeholder-white/25 focus:outline-none focus:border-white/30" />
                </div>
                <input type="number" inputMode="decimal" value={goalForm.target}
                  onChange={e => setGoalForm(f => ({ ...f, target: e.target.value }))}
                  placeholder={t("finance.goalAmtPH", { c: currencySymbol() })}
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-white text-xs placeholder-white/25 focus:outline-none focus:border-white/30" />
                <DatePicker
                  value={goalForm.deadline}
                  onChange={v => setGoalForm(f => ({ ...f, deadline: v }))}
                  placeholder={t("finance.goalDeadlinePH")} />
                <button onClick={handleAddGoal}
                  className="w-full py-2.5 theme-btn rounded-xl text-white text-sm font-semibold flex items-center justify-center gap-2">
                  <Target size={14} /> {t("finance.createGoalBtn")}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Edit expense sheet ───────────────────────────────────────────── */}
      <AnimatePresence>
        {editingExpense && isVisible && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
            onClick={() => setEditingExpense(null)}>
            <motion.div initial={{ scale: 0.94, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.94, opacity: 0 }}
              onClick={e => e.stopPropagation()}
              className="bg-gray-900 border border-white/10 rounded-2xl p-4 w-full max-w-sm">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-white font-semibold text-sm">{t("finance.editAmt")}</h3>
                <button onClick={() => setEditingExpense(null)} className="text-white/40 hover:text-white"><X size={16} /></button>
              </div>

              <div className="flex items-baseline gap-2 border-b border-white/15 pb-2 mb-3">
                <CurrencyPicker value={editingExpense.currency}
                  onChange={c => setEditingExpense(x => x && { ...x, currency: c })} />
                <input type="number" inputMode="decimal" autoFocus
                  value={editingExpense.amount}
                  onChange={e => setEditingExpense(x => x && { ...x, amount: e.target.value })}
                  onKeyDown={e => { if (e.key === "Enter") handleSaveExpenseEdit(); }}
                  className="flex-1 min-w-0 bg-transparent text-white text-2xl font-bold focus:outline-none" />
              </div>

              <div className="flex flex-wrap gap-1.5 pb-2 mb-2">
                {orderedCats.map(cat => (
                  <button key={cat.key}
                    onClick={() => setEditingExpense(x => x && { ...x, category: cat.key })}
                    className={`shrink-0 text-[11px] rounded-full px-3 py-1.5 border transition-colors whitespace-nowrap ${
                      editingExpense.category === cat.key
                        ? "theme-btn text-white border-transparent"
                        : "border-white/10 text-white/50 hover:text-white"
                    }`}>
                    {cat.emoji} {cat.label}
                  </button>
                ))}
              </div>

              <input value={editingExpense.note}
                onChange={e => setEditingExpense(x => x && { ...x, note: e.target.value })}
                onKeyDown={e => { if (e.key === "Enter") handleSaveExpenseEdit(); }}
                placeholder={t("finance.editNote")}
                className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-white text-xs placeholder-white/25 focus:outline-none focus:border-white/30 mb-2.5" />

              {/* The date was the one field this dialog could not change, and it
                  was not for want of plumbing: the state carried it and the save
                  wrote it back. Only the control was missing, so a receipt
                  entered on the wrong day had to be deleted and retyped.

                  Same three controls as the add form, deliberately. A dialog
                  that edits a row should not offer a different set of choices
                  than the one that created it. */}
              <div className="flex items-center gap-1.5 mb-3">
                {[
                  { label: t("finance.today"), value: todayDate },
                  { label: t("finance.yesterday"), value: shiftDay(todayDate, -1) },
                ].map(opt => (
                  <button key={opt.value}
                    onClick={() => setEditingExpense(x => x && { ...x, date: opt.value })}
                    className={`text-[11px] rounded-full px-3 py-1 border transition-colors ${
                      editingExpense.date === opt.value
                        ? "theme-btn text-white border-transparent"
                        : "border-white/10 text-white/50 hover:text-white"
                    }`}>
                    {opt.label}
                  </button>
                ))}
                <DatePicker compact
                  value={editingExpense.date !== todayDate && editingExpense.date !== shiftDay(todayDate, -1) ? editingExpense.date : ""}
                  onChange={v => v && setEditingExpense(x => x && { ...x, date: v })}
                  compactLabel={t("finance.pickDate")} />
              </div>

              <div className="flex gap-2">
                <button onClick={() => setEditingExpense(null)}
                  className="flex-1 py-2.5 rounded-xl border border-white/10 text-white/60 text-sm hover:text-white transition-colors">
                  {t("finance.editCancel")}
                </button>
                <button onClick={handleSaveExpenseEdit}
                  className="flex-1 py-2.5 theme-btn rounded-xl text-white text-sm font-semibold">
                  {t("finance.editSave")}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}