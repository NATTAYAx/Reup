import { useState, useEffect, useCallback } from "react";
import { Clock3, Check, X, MoreHorizontal, Plus } from "lucide-react";
import {
  listWaiting, markReceived, markCancelled, pushBack, addExpectation,
  type Expectation, type ExpectRepeat,
} from "../lib/expectedIncome";
import { formatMoney, getCurrency } from "../lib/money";
import CurrencyPicker from "./CurrencyPicker";
import { todayLocal } from "../lib/dateUtil";
import { t } from "../lib/i18n";
import DatePicker from "./DatePicker";

/**
 * Money that should arrive and has not.
 *
 * Nothing here writes to the ledger except pressing "received", and that opens
 * a field with the expected figure filled in rather than accepting it. What was
 * expected and what turned up are different questions; only the second one is
 * an income row.
 *
 * The card is absent, not empty, when nothing is waiting. An empty state that
 * says "no expected income — add one" is an advertisement for a feature, and
 * this screen already has enough that wants attention.
 */
export default function ExpectedIncomeCard({ onChanged }: { onChanged?: () => void }) {
  const [rows, setRows] = useState<Expectation[]>([]);
  const [menu, setMenu] = useState<number | null>(null);
  const [confirming, setConfirming] = useState<Expectation | null>(null);
  const [amt, setAmt] = useState("");
  // What ARRIVED, which is a different question from what was invoiced. Work
  // priced in dollars is paid into a bank in baht at a rate nobody here needs
  // to know: the bank already applied it, and the figure it produced is the one
  // being typed. So this is not a conversion, it is a second reading.
  const [recvCur, setRecvCur] = useState(getCurrency());
  const [when, setWhen] = useState(todayLocal());
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({
    source: "", amount: "", date: todayLocal(), repeat: null as ExpectRepeat,
    currency: getCurrency(),
  });

  const reload = useCallback(() => { listWaiting().then(setRows); }, []);
  useEffect(() => { reload(); }, [reload]);

  const openConfirm = (e: Expectation) => {
    setMenu(null);
    setConfirming(e);
    setAmt(e.amount != null ? String(e.amount) : "");
    // Defaults to the unit it was expected in, because most of the time that is
    // also the unit it turns up in. One tap changes it when it is not.
    setRecvCur(e.currency || getCurrency());
    setWhen(todayLocal());
  };

  const confirm = async () => {
    if (!confirming) return;
    const n = parseFloat(amt);
    if (!Number.isFinite(n) || n <= 0) return;
    await markReceived(confirming.id, { amount: n, date: when, currency: recvCur });
    setConfirming(null);
    reload();
    onChanged?.();
  };

  const save = async () => {
    if (!form.source.trim()) return;
    const n = parseFloat(form.amount);
    await addExpectation({
      source: form.source.trim(),
      amount: Number.isFinite(n) && n > 0 ? n : null,
      expect_date: form.date,
      repeat: form.repeat,
      currency: form.currency,
    });
    setForm({ source: "", amount: "", date: todayLocal(), repeat: null, currency: getCurrency() });
    setAdding(false);
    reload();
  };

  const today = todayLocal();

  /**
   * "Waiting since the 15th", never "7 days overdue".
   *
   * The difference is not politeness. A number that counts up is a number that
   * gets watched, and this one measures something the person cannot do anything
   * about — a platform's payment run. Saying when it was due is the same
   * information without the counter.
   */
  const label = (e: Expectation) => {
    if (e.expect_date > today) return t("expect.due", { d: e.expect_date.slice(8) + "/" + e.expect_date.slice(5, 7) });
    if (e.expect_date === today) return t("expect.dueToday");
    return t("expect.waitingSince", { d: e.expect_date.slice(8) + "/" + e.expect_date.slice(5, 7) });
  };

  if (rows.length === 0 && !adding) {
    return (
      <button onClick={() => setAdding(true)}
        className="w-full rounded-xl border border-dashed border-white/10 py-2 text-white/25 text-[11px] hover:text-white/50 hover:border-white/20 transition-colors flex items-center justify-center gap-1.5">
        <Plus size={12} />{t("expect.addShort")}
      </button>
    );
  }

  return (
    <div className="rounded-xl border border-white/8 p-3">
      <div className="flex items-center gap-2 mb-2">
        <Clock3 size={13} className="text-emerald-400/70" />
        <span className="text-white/70 text-xs font-semibold">{t("expect.title")}</span>
        <button onClick={() => setAdding(a => !a)}
          className="ml-auto text-white/30 hover:text-white text-[11px]"><Plus size={13} /></button>
      </div>

      {adding && (
        <div className="mb-2 rounded-lg bg-white/4 p-2 space-y-1.5">
          <input value={form.source} autoFocus
            onChange={e => setForm(f => ({ ...f, source: e.target.value }))}
            placeholder={t("expect.sourcePH")}
            className="w-full bg-transparent border-b border-white/10 text-white text-xs px-0.5 py-1 placeholder-white/25 focus:outline-none focus:border-white/40" />
          <div className="flex items-center gap-2">
            <CurrencyPicker size="sm" value={form.currency}
              onChange={c => setForm(f => ({ ...f, currency: c }))} />
            <input type="number" inputMode="decimal" value={form.amount}
              onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
              placeholder={t("expect.amountUnknown")}
              className="w-24 bg-transparent border-b border-white/10 text-white text-xs px-0.5 py-1 placeholder-white/25 focus:outline-none focus:border-white/40" />
            <DatePicker compact value={form.date}
              onChange={v => v && setForm(f => ({ ...f, date: v }))}
              compactLabel={t("finance.pickDate")} />
          </div>
          <div className="flex items-center gap-1">
            {([null, "monthly", "biweekly", "weekly"] as ExpectRepeat[]).map(r => (
              <button key={String(r)} onClick={() => setForm(f => ({ ...f, repeat: r }))}
                className={`text-[10px] px-1.5 py-0.5 rounded-md border transition-colors ${
                  form.repeat === r
                    ? "theme-btn text-white border-transparent"
                    : "border-white/10 text-white/35 hover:text-white/70"
                }`}>
                {t(r === null ? "expect.once" : r === "monthly" ? "expect.monthly" : r === "biweekly" ? "expect.biweekly" : "expect.weekly")}
              </button>
            ))}
            <button onClick={save}
              className="ml-auto text-emerald-300/90 text-[11px] font-semibold px-2 py-0.5 rounded-md hover:bg-emerald-400/10">
              {t("expect.save")}
            </button>
          </div>
        </div>
      )}

      <div className="space-y-1">
        {rows.map(e => (
          <div key={e.id} className="flex items-center gap-2 py-1">
            <div className="min-w-0 flex-1">
              <p className="text-white text-xs truncate">{e.source}</p>
              <p className="text-white/30 text-[10px]">{label(e)}</p>
            </div>
            <span className="text-white/50 text-xs tabular-nums">
              {e.amount != null ? formatMoney(e.amount, e.currency) : "—"}
            </span>
            <button onClick={() => openConfirm(e)} title={t("expect.received")}
              className="text-emerald-400/70 hover:text-emerald-300 p-1"><Check size={13} /></button>
            <div className="relative">
              <button onClick={() => setMenu(m => m === e.id ? null : e.id)}
                className="text-white/25 hover:text-white p-1"><MoreHorizontal size={13} /></button>
              {menu === e.id && (
                <div className="absolute right-0 top-6 z-20 bg-gray-900 border border-white/12 rounded-lg py-1 w-32 shadow-xl">
                  <button onClick={async () => { await pushBack(e.id, 7); setMenu(null); reload(); }}
                    className="w-full text-left px-2.5 py-1 text-white/60 hover:text-white hover:bg-white/5 text-[11px]">
                    {t("expect.push7")}
                  </button>
                  <button onClick={async () => { await markCancelled(e.id); setMenu(null); reload(); }}
                    className="w-full text-left px-2.5 py-1 text-white/40 hover:text-white hover:bg-white/5 text-[11px]">
                    {t("expect.cancel")}
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Confirming is a form, not a yes/no. The expected figure is filled in
          because it is usually right, and it is editable because the times it
          is wrong are exactly the times that matter. */}
      {confirming && (
        <div className="mt-2 rounded-lg bg-emerald-400/8 border border-emerald-400/25 p-2">
          <p className="text-white/60 text-[11px] mb-1.5">
            {t("expect.howMuch", { s: confirming.source })}
            {/* Only when the two differ, which is when the invoice and the
                deposit are genuinely two different facts and the one being
                recorded here is the deposit. */}
            {confirming.amount != null && recvCur !== confirming.currency && (
              <span className="text-white/30">
                {" · "}{t("expect.expectedWas", { a: formatMoney(confirming.amount, confirming.currency) })}
              </span>
            )}
          </p>
          <div className="flex items-center gap-2">
            <CurrencyPicker size="md" value={recvCur} tone="text-emerald-400/60"
              onChange={setRecvCur} />
            <input type="number" inputMode="decimal" autoFocus value={amt}
              onChange={e => setAmt(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") confirm(); }}
              className="w-24 bg-transparent border-b border-emerald-400/30 text-white text-sm font-semibold px-0.5 py-0.5 focus:outline-none" />
            <DatePicker compact value={when} onChange={v => v && setWhen(v)}
              compactLabel={t("finance.pickDate")} />
            <button onClick={confirm}
              className="ml-auto text-emerald-300 text-[11px] font-semibold px-2 py-1 rounded-md hover:bg-emerald-400/10">
              {t("expect.save")}
            </button>
            <button onClick={() => setConfirming(null)} className="text-white/30 hover:text-white p-1">
              <X size={13} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}