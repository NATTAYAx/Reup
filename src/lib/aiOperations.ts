import {
  createTask, deleteTask, updateTask, getTaskById,
  markTaskCompleted, unmarkTaskCompleted,
  togglePriority, toggleUrgent,
  pauseTask, resumeTask, restoreTask, addIncome,
} from "./database";
import { aiLogExpense, aiDeleteExpenseByKeyword, aiEditExpenseByKeyword } from "./financeDatabase";
import { getNextReset } from "./countdown";
import { PAUSE_FOREVER } from "../types";
import { t } from "./i18n";

// ─── aiOperations.ts — the vocabulary the assistant speaks ────────────────────
//
// WHY THIS FILE EXISTS
//
// The model was never the limit. Given "พักงาน Honkai ไว้ก่อน" it understands
// perfectly well what is being asked — and then has no word for it, because the
// schema it answers in offered four verbs for tasks and three for money. Seven
// verbs, against an app that can do eighteen things. Sharpening the offline
// parser could not move that ceiling by a single millimetre, because the ceiling
// was never about understanding. It was about what could be said back.
//
// So the verbs live here now, in one list, and the executor below is the only
// thing that turns a verb into a database call. Teaching the assistant something
// new is adding an entry to this file. It is not touching the parser, the
// prompt's grammar, or the chat component.
//
// ADDRESSING BY ID, NOT BY NAME
//
// Every task operation takes an `id`. That is the second half of the point.
//
// The old path sent the model a list of task NAMES, got a name back, and ran a
// LIKE query to find the row again — so two tasks with similar names meant the
// wrong one was edited, and a name spelled slightly differently meant nothing
// was found at all. The same weakness on the money side produced three separate
// rounds of the same bug in one afternoon, under three different field names.
//
// The context now carries ids, the model answers with an id, and the guessing
// stops. `keyword` survives only for expenses, which have no stable identity to
// point at.
//
// CONFIRMATION IS PART OF THE VOCABULARY
//
// A model that can reach every corner of the app can also delete things in every
// corner of it. So each verb declares whether it is destructive, and the caller
// is expected to ask first for the ones that are. That flag lives here rather
// than in the UI on purpose: a new verb should have to state its own danger at
// the moment it is written, not wait for someone to remember later.

export type OpKind =
  // ── tasks ──
  | "create_task"
  | "update_task"        // any editable field: name, time, category, min_step, notes…
  | "delete_task"
  | "restore_task"
  | "complete_task"
  | "uncomplete_task"
  | "pause_task"
  | "resume_task"
  | "set_priority"
  | "set_urgent"
  // ── money ──
  | "log_expense"
  | "edit_expense"
  | "delete_expense"
  | "log_income";

export interface Operation {
  kind: OpKind;
  /** Which task. Required by everything that is not create_task or money. */
  id?: number;
  /** For create_task, and for update_task's changed fields. */
  task?: Record<string, any>;
  /** Expenses only — they have no id the model can see. */
  keyword?: string;
  amount?: number;
  category?: string;
  note?: string;
  date?: string;
  source?: string;
  value?: boolean;
  /** pause_task: ISO datetime, or absent for no end date. */
  until?: string;
}

/** Verbs that destroy or overwrite. The caller must confirm these first. */
const DESTRUCTIVE = new Set<OpKind>([
  "delete_task", "delete_expense", "update_task", "edit_expense",
]);

export const isDestructive = (op: Operation) => DESTRUCTIVE.has(op.kind);

/** Everything the model is allowed to emit, for validating its output. */
export const KNOWN_OPS = new Set<OpKind>([
  "create_task", "update_task", "delete_task", "restore_task",
  "complete_task", "uncomplete_task", "pause_task", "resume_task",
  "set_priority", "set_urgent",
  "log_expense", "edit_expense", "delete_expense", "log_income",
]);

/**
 * One line a person can read, describing exactly what will happen.
 *
 * Written from the operation rather than from the model's own sentence, because
 * the model's sentence is a claim and this is the thing that will actually run.
 * The two disagreed often enough today — "แก้ไขเรียบร้อยแล้วค่ะ" arriving before
 * anything had been saved — that the confirmation should be built from the plan,
 * not from the description of it.
 */
export function describe(op: Operation, taskName?: string): string {
  const who = taskName ? `"${taskName}"` : `#${op.id}`;
  switch (op.kind) {
    case "create_task":     return `${t("op.create")} "${op.task?.name ?? "?"}"`;
    case "update_task":     return `${t("op.update")} ${who}`;
    case "delete_task":     return `${t("op.delete")} ${who}`;
    case "restore_task":    return `${t("op.restore")} ${who}`;
    case "complete_task":   return `${t("op.complete")} ${who}`;
    case "uncomplete_task": return `${t("op.uncomplete")} ${who}`;
    case "pause_task":      return `${t("op.pause")} ${who}`;
    case "resume_task":     return `${t("op.resume")} ${who}`;
    case "set_priority":    return `${op.value ? t("op.starOn") : t("op.starOff")} ${who}`;
    case "set_urgent":      return `${op.value ? t("op.urgentOn") : t("op.urgentOff")} ${who}`;
    case "log_expense":     return `${t("op.expense")} ${op.note ?? ""} ${op.amount ?? "?"}`;
    case "edit_expense":    return `${t("op.editExpense")} "${op.keyword ?? "?"}" → ${op.amount ?? "?"}`;
    case "delete_expense":  return `${t("op.deleteExpense")} "${op.keyword ?? "?"}"`;
    case "log_income":      return `${t("op.income")} ${op.source ?? ""} ${op.amount ?? "?"}`;
    default:                return String((op as Operation).kind);
  }
}

/**
 * Run one operation.
 *
 * Throws with a readable sentence rather than returning a flag, so a failure
 * reaches the chat as something a person can act on instead of as a red
 * TypeError. Every id is checked before it is used: the model can hallucinate a
 * number as easily as it can hallucinate a name, and an id that does not exist
 * must say so rather than silently update nothing.
 */
export async function runOperation(op: Operation): Promise<void> {
  const needsId = async () => {
    if (typeof op.id !== "number") throw new Error(t("op.errNoId"));
    const row = await getTaskById(op.id);
    if (!row) throw new Error(t("op.errNotFound"));
    return row;
  };

  switch (op.kind) {
    case "create_task": {
      if (!op.task?.name) throw new Error(t("op.errNoName"));
      await createTask({
        description: "", category: "personal", reset_type: "daily",
        reset_time: null, reset_day: null, reset_interval_days: null,
        anchor_date: null, event_start: null, event_end: null,
        specific_date: null, is_priority: 0, is_urgent: 0,
        cover_image: null, min_step: null, time_zone: null, intent: null,
        ...op.task,
      });
      return;
    }

    case "update_task": {
      const row = await needsId();
      if (!op.task || !Object.keys(op.task).length) throw new Error(t("op.errNoChange"));
      await updateTask(row.id, op.task);
      return;
    }

    case "delete_task":   { const r = await needsId(); await deleteTask(r.id); return; }
    case "restore_task":  { const r = await needsId(); await restoreTask(r.id); return; }

    case "complete_task": {
      const row = await needsId();
      // Recurring tasks are done until the next reset; one-offs until the end of
      // today, so they stay visible as finished and archive themselves tomorrow.
      // This mirrors TaskCard exactly — the same action must not mean two
      // different things depending on which button was used.
      const recurring = ["daily", "weekly", "biweekly", "custom_days"].includes(row.reset_type);
      let until: string;
      if (recurring) {
        const next = getNextReset(row);
        if (!next) throw new Error(t("op.errNoCycle"));
        until = next.toISOString();
      } else {
        const end = new Date();
        end.setHours(23, 59, 59, 999);
        until = end.toISOString();
      }
      await markTaskCompleted(row.id, until);
      return;
    }

    case "uncomplete_task": { const r = await needsId(); await unmarkTaskCompleted(r.id); return; }
    case "pause_task":      { const r = await needsId(); await pauseTask(r.id, op.until || PAUSE_FOREVER); return; }
    case "resume_task":     { const r = await needsId(); await resumeTask(r.id); return; }
    case "set_priority":    { const r = await needsId(); await togglePriority(r.id, op.value !== false); return; }
    case "set_urgent":      { const r = await needsId(); await toggleUrgent(r.id, op.value !== false); return; }

    case "log_expense": {
      if (typeof op.amount !== "number") throw new Error(t("op.errNoAmount"));
      await aiLogExpense(op.amount, op.category || "other", op.note || "");
      return;
    }

    case "edit_expense": {
      if (!op.keyword?.trim()) throw new Error(t("op.errNoKeyword"));
      await aiEditExpenseByKeyword(op.keyword.trim(), {
        amount: op.amount,
        category: op.category,
        note: op.note,
      });
      return;
    }

    case "delete_expense": {
      if (!op.keyword?.trim()) throw new Error(t("op.errNoKeyword"));
      await aiDeleteExpenseByKeyword(op.keyword.trim());
      return;
    }

    case "log_income": {
      // Was declared in the schema and had no code behind it at all: the model
      // recognised "ได้เงินค่าแปล 3000" correctly, answered that it had been
      // saved, and nothing was written. Of the whole missing vocabulary this is
      // the one worth having most — expenses can be typed in seconds while
      // income had no fast path, and irregular freelance income is exactly what
      // needs recording the moment it lands.
      if (typeof op.amount !== "number") throw new Error(t("op.errNoAmount"));
      await addIncome({
        amount: op.amount,
        source: op.source || op.note || t("op.incomeDefault"),
        note: op.note || "",
        date: op.date || new Date().toISOString().slice(0, 10),
      });
      return;
    }

    default:
      throw new Error(t("op.errUnknown"));
  }
}

/** Run a list in order, stopping at the first failure so nothing runs on top of
 *  a broken state. Returns how many completed, for an honest report. */
export async function runOperations(ops: Operation[]): Promise<number> {
  let done = 0;
  for (const op of ops) {
    await runOperation(op);
    done++;
  }
  return done;
}