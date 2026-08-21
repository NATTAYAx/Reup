// ─── dataChanged.ts — writes the screen did not ask for ──────────────────────
//
// WHY THIS EXISTS AT ALL
//
// Every other write in this app is started by the person looking at it. They
// press a button, the handler writes, and the same handler calls refreshTasks
// on the way out. React never has to wonder whether the database moved,
// because nothing moves it except the code that just rendered.
//
// Sync broke that. It writes rows nobody on this screen asked for — a task
// ticked done on the phone half an hour ago — and there is no handler to hang
// the refresh off, because there was no interaction. The list stays as it was,
// correct as of the last time somebody pressed something, and the only way to
// see the truth is to reload the whole window.
//
// Reloading works and costs more than it looks: it tears down the webview,
// reopens the database, re-registers every listener, and restarts the notify
// loop. Doing that to see one changed row is the expensive way to answer a
// cheap question.
//
// WHY NOT A CONTEXT, A STORE, OR PROPS
//
// The emitter is the smallest thing that spans the gap. SyncCard lives inside
// SettingsModal, which is three levels below the component that owns the task
// list, and threading a callback down through a settings dialog so that a
// cloud folder can tell a countdown to redraw is a wire that says nothing
// about what it is for. A pub-sub with one publisher and a handful of
// subscribers is honest about the shape: something changed the data underneath
// you, and whoever is showing that data should look again.
//
// WHY IT NAMES TABLES
//
// A bare "something changed" makes every subscriber reload everything, so a
// sync that carried one budget would also re-run the cycle reconciliation for
// every task. The names cost nothing to pass and let each listener decide
// whether the news is about them.

export type ChangedTables = ReadonlySet<string>;

type Listener = (tables: ChangedTables) => void;

const listeners = new Set<Listener>();

/**
 * Listen for writes made by something other than this screen.
 *
 * Returns the unsubscribe, so an effect can hand it straight back to React.
 */
export function onDataChanged(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Rows landed in these tables.
 *
 * Copied before iterating, because a listener that unsubscribes itself while
 * being notified would otherwise change the set mid-loop — which is not a
 * hypothetical here, since a component unmounting is exactly the case where
 * one refresh triggers another.
 *
 * A listener that throws must not stop the ones after it. One view failing to
 * redraw is a bug in that view; all of them failing to redraw because the first
 * one threw is a bug in this file.
 */
export function dataChanged(tables: Iterable<string>): void {
  const named: ChangedTables = new Set(tables);
  if (named.size === 0) return;
  for (const fn of [...listeners]) {
    try {
      fn(named);
    } catch (err) {
      console.error("[dataChanged] listener failed:", err);
    }
  }
}