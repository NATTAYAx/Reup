import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

// ─── windowActive.ts — is anybody actually looking at this window ─────────────
//
// THE PROBLEM THIS SOLVES
//
// The app sat at ~80% GPU with ~1.7% CPU, permanently, including while hidden
// in the tray. That ratio is the signature of compositing, not of work: nothing
// is being computed, a surface is simply being redrawn over and over.
//
// The cause is a combination that is individually harmless and jointly awful:
//
//   • The main window is `transparent: true` and undecorated. Chromium cannot
//     use its opaque fast path, so the window is composited against whatever is
//     behind it rather than blitted.
//   • Fourteen elements use backdrop-blur. Each one is its own render surface,
//     and a blur is re-sampled whenever its region is marked dirty.
//   • One 8px dot next to the assistant button has `animate-pulse` on it, with
//     no condition attached. It animates for as long as the app is running.
//
// That last item is the ignition. A permanently animating element means the
// frame is permanently dirty, which means the whole transparent-plus-blur stack
// is recomposited around sixty times a second, forever, whether or not the
// window is on screen. A pulsing dot is free. A pulsing dot on top of fourteen
// blur surfaces in a transparent window is not.
//
// Hiding to the tray does not save it: Chromium's occlusion detection is
// unreliable for a transparent, undecorated, skipTaskbar window — the same
// quirk the wallpaper feature has been fighting from the other direction.
//
// WHY NOT JUST DELETE THE ANIMATIONS
//
// Because the ask was that nothing look different. And nothing needs to: an
// animation nobody can see has no value to lose. So the animations stay exactly
// as they are while the window is in front, and stop when it is not.
//
// useCountdowns already works out this exact question for its render loop. It
// was never shared, so the CSS animations were never told. This is that same
// signal, in one place, for everyone.

/** Set on <html> while nothing should be animating. index.css does the rest. */
const IDLE_CLASS = "idle";

let active = true;
let installed = false;
const listeners = new Set<(v: boolean) => void>();

function apply(next: boolean) {
  if (next === active) return;
  active = next;
  document.documentElement.classList.toggle(IDLE_CLASS, !next);
  listeners.forEach(fn => fn(next));
}

export function isWindowActive(): boolean {
  return active;
}

/**
 * Call once, at startup.
 *
 * Deliberately biased towards ACTIVE. Every path that could mean "someone is
 * here" turns painting back on, and only an explicit blur or hide turns it off.
 * The failure that matters is a window that has frozen its own animations while
 * being looked at; wasting a few frames after the user has walked away does
 * not.
 */
export function installWindowActive() {
  if (installed) return;
  installed = true;

  const wake = () => apply(true);

  // Pointer or key activity means the window has focus in every practical
  // sense, whatever the events said. Passive listeners, so they cost nothing.
  window.addEventListener("focus", wake);
  window.addEventListener("pointerdown", wake, { passive: true });
  window.addEventListener("pointermove", wake, { passive: true });
  window.addEventListener("keydown", wake, { passive: true });

  window.addEventListener("blur", () => apply(false));

  document.addEventListener("visibilitychange", () => {
    apply(document.visibilityState === "visible");
  });

  // The Tauri-side signal. More reliable than the DOM one for a window that is
  // hidden to the tray rather than minimised, which is this app's normal state.
  (async () => {
    try {
      const win = getCurrentWindow();
      await win.onFocusChanged(({ payload: focused }) => {
        if (focused) { apply(true); return; }
        apply(false);
      });
    } catch {
      // No window events available — stay awake rather than risk freezing.
      apply(true);
    }
  })();
}

/** React view of the same signal, for animations that CSS cannot pause. */
export function useWindowActive(): boolean {
  const [value, setValue] = useState(active);
  useEffect(() => {
    listeners.add(setValue);
    setValue(active);
    return () => { listeners.delete(setValue); };
  }, []);
  return value;
}