import { useState } from "react";
import { Download, Upload, ShieldCheck, AlertTriangle, Loader2 } from "lucide-react";
import { save, open as openDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import {
  buildBackupJson, backupFileName, parseBackup, restoreBackup, type RestoreReport,
} from "../lib/backup";
import { t } from "../lib/i18n";

// ─── BackupCard ───────────────────────────────────────────────────────────────
// Two buttons. Everything interesting about this is in what happens around the
// restore button, not the export one.
//
// Restoring replaces everything. That is what restoring means, and pretending
// otherwise by silently merging would produce a database that is neither the
// backup nor what was there before. So it says so plainly, asks once, and — this
// is the part that matters — writes a snapshot of the current data into the
// app's own folder first, without being asked, every single time. The moment
// someone needs an undo is precisely the moment they did not think to make one.
// The path to that snapshot is then left on screen rather than in a log file.

type State =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "exported"; path: string }
  | { kind: "confirm"; path: string; text: string; exportedAt: string }
  | { kind: "restored"; report: RestoreReport; snapshot: string }
  | { kind: "error"; message: string };

export default function BackupCard() {
  const [state, setState] = useState<State>({ kind: "idle" });

  const handleExport = async () => {
    setState({ kind: "working" });
    try {
      const path = await save({
        defaultPath: backupFileName(),
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) { setState({ kind: "idle" }); return; }
      await invoke("write_text_file", { path, contents: await buildBackupJson() });
      setState({ kind: "exported", path });
    } catch (err: any) {
      setState({ kind: "error", message: String(err?.message ?? err) });
    }
  };

  // Read and validate first, and only then ask. Asking someone to confirm
  // wiping their data before knowing whether the file is even a backup is how
  // you end up wiping their data for a file that turns out to be a screenshot.
  const handlePick = async () => {
    setState({ kind: "working" });
    try {
      const path = await openDialog({
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path || typeof path !== "string") { setState({ kind: "idle" }); return; }
      const text = await invoke<string>("read_text_file", { path });
      const file = parseBackup(text);
      setState({ kind: "confirm", path, text, exportedAt: file.exportedAt });
    } catch (err: any) {
      const code = String(err?.message ?? err);
      const known: Record<string, string> = {
        notJson: t("backup.errNotJson"),
        notBackup: t("backup.errNotBackup"),
        tooNew: t("backup.errTooNew"),
      };
      setState({ kind: "error", message: known[code] ?? code });
    }
  };

  const handleRestore = async (text: string) => {
    setState({ kind: "working" });
    try {
      const snapshot = await invoke<string>("write_snapshot", {
        name: `before-restore-${backupFileName()}`,
        contents: await buildBackupJson(),
      });
      const report = await restoreBackup(parseBackup(text));
      setState({ kind: "restored", report, snapshot });
    } catch (err: any) {
      setState({ kind: "error", message: String(err?.message ?? err) });
    }
  };

  return (
    <div className="bg-white/5 border border-white/10 rounded-2xl p-4 space-y-3">
      <div className="flex items-center gap-3">
        <ShieldCheck size={18} className="text-purple-400 shrink-0" />
        <div className="min-w-0">
          <p className="text-white text-sm font-semibold">{t("backup.title")}</p>
          <p className="text-white/40 text-xs">{t("backup.sub")}</p>
        </div>
      </div>

      <div className="flex gap-2">
        <button
          onClick={handleExport}
          disabled={state.kind === "working"}
          className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 text-white text-sm font-semibold transition-all hover:brightness-110 disabled:opacity-50"
        >
          {state.kind === "working" ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
          {t("backup.export")}
        </button>
        <button
          onClick={handlePick}
          disabled={state.kind === "working"}
          className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl bg-white/5 border border-white/10 text-white/70 hover:text-white hover:border-white/25 text-sm font-semibold transition-colors disabled:opacity-50"
        >
          <Upload size={15} />
          {t("backup.restore")}
        </button>
      </div>

      <p className="text-white/25 text-[11px] leading-relaxed">{t("backup.note")}</p>

      {state.kind === "exported" && (
        <p className="text-green-300/80 text-[11px] break-all bg-green-500/10 border border-green-500/20 rounded-lg px-2.5 py-2">
          {t("backup.saved")} {state.path}
        </p>
      )}

      {state.kind === "confirm" && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 space-y-2.5">
          <div className="flex items-start gap-2">
            <AlertTriangle size={14} className="text-amber-300 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="text-amber-100 text-xs font-semibold">{t("backup.confirmTitle")}</p>
              <p className="text-white/50 text-[11px] mt-0.5 leading-relaxed">{t("backup.confirmBody")}</p>
              {state.exportedAt && (
                <p className="text-white/35 text-[11px] mt-1">
                  {t("backup.fileDate")} {new Date(state.exportedAt).toLocaleString()}
                </p>
              )}
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setState({ kind: "idle" })}
              className="flex-1 py-2 rounded-lg bg-white/5 border border-white/10 text-white/60 hover:text-white text-xs font-semibold transition-colors"
            >
              {t("common.cancel")}
            </button>
            <button
              onClick={() => handleRestore(state.text)}
              className="flex-1 py-2 rounded-lg bg-amber-500/80 hover:bg-amber-500 text-gray-900 text-xs font-bold transition-colors"
            >
              {t("backup.confirmGo")}
            </button>
          </div>
        </div>
      )}

      {state.kind === "restored" && (
        <div className="bg-green-500/10 border border-green-500/25 rounded-xl px-3 py-2.5 space-y-1.5">
          <p className="text-green-200 text-xs font-semibold">{t("backup.restored")}</p>
          <p className="text-white/50 text-[11px]">
            {Object.entries(state.report.tables).map(([name, n]) => `${name} ${n}`).join(" · ")}
          </p>
          {state.report.skipped.length > 0 && (
            <p className="text-amber-300/80 text-[11px]">
              {t("backup.skipped")} {state.report.skipped.join(", ")}
            </p>
          )}
          <p className="text-white/30 text-[11px] break-all">{t("backup.snapshot")} {state.snapshot}</p>
          <p className="text-white/50 text-[11px]">{t("backup.reloadHint")}</p>
          <button
            onClick={() => window.location.reload()}
            className="w-full py-2 mt-1 rounded-lg bg-white/10 hover:bg-white/20 text-white text-xs font-semibold transition-colors"
          >
            {t("backup.reload")}
          </button>
        </div>
      )}

      {state.kind === "error" && (
        <p className="text-red-300/90 text-[11px] bg-red-500/10 border border-red-500/25 rounded-lg px-2.5 py-2 break-all">
          {state.message}
        </p>
      )}
    </div>
  );
}
