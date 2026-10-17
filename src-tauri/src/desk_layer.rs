// desk_layer.rs — keeps one window between the desktop icons and everything else.
//
// WHAT THE BOARD NEEDS FROM WINDOWS
//
// Above the icons, below every application window, and still there after Win+D.
// None of those is a window style. "Always on bottom" puts a window under the
// desktop itself on most machines, "always on top" covers the work, and Win+D
// does not minimise anything on a current Windows: it raises the window that
// holds the icons above all the others, so anything sitting just above that
// window vanishes with them.
//
// WHERE THIS COMES FROM
//
// Rainmeter has kept skins in exactly this layer for over a decade, across
// every Windows since 7, and its handling is the one this file follows
// (Library/System.cpp and Skin.cpp in rainmeter/rainmeter):
//
//   normal      SetWindowPos(HWND_BOTTOM). The shell's desktop windows are
//               bottom-most, so a window sent to the bottom lands just above
//               them - above the icons, under everything else.
//
//   Win+D       detected with a hidden probe window that is also kept at the
//               bottom. Normally the probe is above the icons' window; when the
//               desktop is raised, the probe is suddenly below it. That one
//               lookup is the whole test.
//
//               While it lasts the board turns topmost and is slotted in at the
//               bottom of the topmost band: above the raised desktop, under the
//               taskbar and any real always-on-top window. When the desktop
//               drops back, the board goes back to the bottom.
//
//   in between  nothing may raise the board. Every WM_WINDOWPOSCHANGING not
//               sent by this file gets SWP_NOZORDER added, and this file's own
//               moves carry SWP_NOSENDCHANGING, which skips that message, so the
//               two never fight.
//
// The check runs from a timer on the probe, four times a second (ten while the
// desktop is up, so the way back is quick), and from a foreground hook, which
// catches Win+D the moment the desktop takes the foreground so the board does
// not blink. Each check is a handful of window lookups.
//
// WHICH WINDOW HOLDS THE ICONS
//
// Windows 11 24H2 moved them. Before it, the icons sat in a top-level WorkerW
// next to Progman; from 24H2 on, Progman holds them directly. Rainmeter tells
// the two apart by whether user32 exports GetCurrentMonitorTopologyId, which
// arrived with the same build, and so does this.
//
// WHY NOT PARENT THE BOARD TO THE DESKTOP
//
// That is what the live wallpaper does, and it is why the wallpaper lives in a
// process of its own: a window parented to explorer's ties this app's input
// queue to explorer's, and a stall on either side froze both. Nothing here
// parents anything. It only orders windows that stay top-level.
//
// THREADS
//
// Everything public here is called on the main thread. SetWindowSubclass has to
// be called by the thread that owns the window, and the timer and the hook
// deliver to the thread that set them up, which must pump messages - the main
// thread's event loop does.

use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU32, Ordering};
use std::sync::OnceLock;

use windows::core::{s, w, PCWSTR};
use windows::Win32::Foundation::{HINSTANCE, HMODULE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
use windows::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, FindWindowExW, GetClassNameW, GetShellWindow, GetWindow,
    GetWindowLongPtrW, GetWindowThreadProcessId, IsWindow, IsWindowVisible, KillTimer,
    RegisterClassW, SetTimer, SetWindowLongPtrW, SetWindowPos, EVENT_SYSTEM_FOREGROUND,
    GWL_EXSTYLE, GW_HWNDNEXT, GW_HWNDPREV, HWND_BOTTOM, HWND_TOPMOST, MA_NOACTIVATE,
    SET_WINDOW_POS_FLAGS, STYLESTRUCT, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE,
    SWP_NOOWNERZORDER, SWP_NOSENDCHANGING, SWP_NOSIZE, SWP_NOZORDER, WINDOWPOS,
    WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS, WM_MOUSEACTIVATE, WM_NCDESTROY,
    WM_STYLECHANGING, WM_TIMER, WM_WINDOWPOSCHANGING, WNDCLASSW, WS_DISABLED, WS_EX_APPWINDOW,
    WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
};

/// Rainmeter's ZPOS_FLAGS. SWP_NOSENDCHANGING is the important one: it is what
/// lets this file move the board past its own WM_WINDOWPOSCHANGING guard.
const ZPOS: SET_WINDOW_POS_FLAGS = SET_WINDOW_POS_FLAGS(
    SWP_NOMOVE.0 | SWP_NOSIZE.0 | SWP_NOOWNERZORDER.0 | SWP_NOACTIVATE.0 | SWP_NOSENDCHANGING.0,
);

const PROBE_CLASS: PCWSTR = w!("ReupDeskProbe");
const PROBE_TITLE: PCWSTR = w!("ReupDeskProbe");

const TIMER_ID: usize = 1;
/// Normal check interval, as Rainmeter's INTERVAL_SHOWDESKTOP.
const TICK_MS: u32 = 250;
/// While the desktop is up, so the board drops back promptly when it does.
const TICK_RAISED_MS: u32 = 100;
/// Every this many ticks, also make sure the board has not ended up under the
/// icons - after explorer restarts, for one.
const SINK_CHECK_EVERY: u32 = 4;

const SUBCLASS_ID: usize = 0x5245_5550; // "REUP"

static BOARD: AtomicIsize = AtomicIsize::new(0);
static PROBE: AtomicIsize = AtomicIsize::new(0);
static HOST: AtomicIsize = AtomicIsize::new(0);
static ARRANGING: AtomicBool = AtomicBool::new(false);
static RAISED: AtomicBool = AtomicBool::new(false);
static HOOKED: AtomicBool = AtomicBool::new(false);
static TICKS: AtomicU32 = AtomicU32::new(0);

fn hwnd(raw: isize) -> HWND {
    HWND(raw as *mut core::ffi::c_void)
}

fn raw(h: HWND) -> isize {
    h.0 as isize
}

fn board() -> Option<HWND> {
    match BOARD.load(Ordering::SeqCst) {
        0 => None,
        v => Some(hwnd(v)),
    }
}

fn probe() -> Option<HWND> {
    match PROBE.load(Ordering::SeqCst) {
        0 => None,
        v => Some(hwnd(v)),
    }
}

// ─── public ─────────────────────────────────────────────────────────────────

/// Take charge of the board's layer. Call before it is first shown.
///
/// Whatever fails, the board still ends up at the bottom: without the probe it
/// only loses Win+D, and without the subclass it can still not be activated
/// (it is click-through and never focusable), so nothing would raise it.
pub fn attach(board_raw: isize) -> Result<(), String> {
    if board_raw == 0 {
        return Err("no window handle".into());
    }
    let h = hwnd(board_raw);
    BOARD.store(board_raw, Ordering::SeqCst);
    let probe_ok = ensure_probe();
    unsafe {
        if !SetWindowSubclass(h, Some(board_proc), SUBCLASS_ID, 0).as_bool() {
            place();
            return Err("SetWindowSubclass failed".into());
        }

        // A tool window is left out of Alt+Tab and Task View. The window code
        // underneath rewrites the extended style whenever one of its own flags
        // changes, which is why board_proc also re-adds this on every change.
        let ex = GetWindowLongPtrW(h, GWL_EXSTYLE);
        let want = (ex | WS_EX_TOOLWINDOW.0 as isize) & !(WS_EX_APPWINDOW.0 as isize);
        if want != ex {
            SetWindowLongPtrW(h, GWL_EXSTYLE, want);
            let _ = SetWindowPos(
                h,
                HWND::default(),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED | SWP_NOSENDCHANGING,
            );
        }
    }
    RAISED.store(desktop_raised(), Ordering::SeqCst);
    place();
    retime();
    probe_ok
}

/// Let go of the board, before it is destroyed. The probe and the hook stay -
/// they cost nothing idle - but the timer stops, so a switched-off board means
/// no work at all.
pub fn detach() {
    let old = BOARD.swap(0, Ordering::SeqCst);
    ARRANGING.store(false, Ordering::SeqCst);
    unsafe {
        if old != 0 {
            let _ = RemoveWindowSubclass(hwnd(old), Some(board_proc), SUBCLASS_ID);
        }
        if let Some(p) = probe() {
            let _ = KillTimer(p, TIMER_ID);
        }
    }
}

/// While it is being moved and resized: on top of everything, so it can be seen
/// and grabbed. Back in its layer when this is turned off.
pub fn set_arranging(on: bool) {
    ARRANGING.store(on, Ordering::SeqCst);
    if !on {
        RAISED.store(desktop_raised(), Ordering::SeqCst);
    }
    place();
}

// ─── where the board goes ───────────────────────────────────────────────────

fn place() {
    let Some(b) = board() else { return };
    unsafe {
        if ARRANGING.load(Ordering::SeqCst) {
            let _ = SetWindowPos(b, HWND_TOPMOST, 0, 0, 0, 0, ZPOS);
            return;
        }
        if RAISED.load(Ordering::SeqCst) {
            if let Some(host) = icons_host() {
                let _ = SetWindowPos(b, HWND_TOPMOST, 0, 0, 0, 0, ZPOS);
                // Down to the bottom of the topmost band: walk up from the
                // desktop and slot in under the first topmost window met.
                let mut w = host;
                for _ in 0..512 {
                    w = match GetWindow(w, GW_HWNDPREV) {
                        Ok(x) if !x.is_invalid() => x,
                        _ => break,
                    };
                    if w == b {
                        continue;
                    }
                    if GetWindowLongPtrW(w, GWL_EXSTYLE) & WS_EX_TOPMOST.0 as isize != 0
                        && SetWindowPos(b, w, 0, 0, 0, 0, ZPOS).is_ok()
                    {
                        break;
                    }
                }
                return;
            }
        }
        // HWND_BOTTOM also clears topmost, which is how the board comes back
        // down after Win+D.
        let _ = SetWindowPos(b, HWND_BOTTOM, 0, 0, 0, 0, ZPOS);
    }
}

/// Re-read the desktop's state; returns whether it changed.
fn check() -> bool {
    if board().is_none() || ARRANGING.load(Ordering::SeqCst) {
        return false;
    }
    let raised = desktop_raised();
    if raised == RAISED.load(Ordering::SeqCst) {
        return false;
    }
    RAISED.store(raised, Ordering::SeqCst);
    // As Rainmeter's PrepareHelperWindow: the probe goes back to the bottom on
    // every change, so the next test starts from the same place.
    if let Some(p) = probe() {
        unsafe {
            let _ = SetWindowPos(p, HWND_BOTTOM, 0, 0, 0, 0, ZPOS);
        }
    }
    place();
    retime();
    true
}

/// The desktop has been raised over everything: the probe, which is kept at
/// the bottom, is now below the window holding the icons.
fn desktop_raised() -> bool {
    if probe().is_none() {
        return false;
    }
    let Some(host) = icons_host() else { return false };
    unsafe {
        if !IsWindowVisible(host).as_bool() {
            return false;
        }
        matches!(FindWindowExW(HWND::default(), host, PROBE_CLASS, PROBE_TITLE), Ok(h) if !h.is_invalid())
    }
}

/// The board somehow under the icons - explorer restarted and its new desktop
/// windows landed on top of it, say. Looks only below the icons' window, where
/// there are a few windows at most.
fn sunk(b: HWND) -> bool {
    let Some(host) = icons_host() else { return false };
    unsafe {
        let mut w = host;
        for _ in 0..64 {
            w = match GetWindow(w, GW_HWNDNEXT) {
                Ok(x) if !x.is_invalid() => x,
                _ => return false,
            };
            if w == b {
                return true;
            }
        }
    }
    false
}

fn retime() {
    let Some(p) = probe() else { return };
    if board().is_none() {
        return;
    }
    let ms = if RAISED.load(Ordering::SeqCst) { TICK_RAISED_MS } else { TICK_MS };
    unsafe {
        // Same id: replaces the running timer rather than adding one.
        SetTimer(p, TIMER_ID, ms, None);
    }
}

// ─── the desktop's own windows ──────────────────────────────────────────────

/// From Windows 11 24H2 the icons live in Progman itself.
fn icons_in_progman() -> bool {
    static ANSWER: OnceLock<bool> = OnceLock::new();
    *ANSWER.get_or_init(|| unsafe {
        match GetModuleHandleW(w!("user32.dll")) {
            Ok(m) => GetProcAddress(m, s!("GetCurrentMonitorTopologyId")).is_some(),
            Err(_) => false,
        }
    })
}

fn class_is(h: HWND, name: &str) -> bool {
    let mut buf = [0u16; 64];
    let n = unsafe { GetClassNameW(h, &mut buf) };
    n > 0 && String::from_utf16_lossy(&buf[..n as usize]) == name
}

fn same_process(a: HWND, b: HWND) -> bool {
    let (mut pa, mut pb) = (0u32, 0u32);
    unsafe {
        GetWindowThreadProcessId(a, Some(&mut pa));
        GetWindowThreadProcessId(b, Some(&mut pb));
    }
    pa != 0 && pa == pb
}

fn has_defview(parent: HWND) -> bool {
    unsafe {
        matches!(
            FindWindowExW(parent, HWND::default(), w!("SHELLDLL_DefView"), PCWSTR::null()),
            Ok(h) if !h.is_invalid()
        )
    }
}

/// Progman, when it is explorer's and not something else's.
fn shell_window() -> Option<HWND> {
    let s = unsafe { GetShellWindow() };
    if s.is_invalid() || !class_is(s, "Progman") {
        None
    } else {
        Some(s)
    }
}

/// The window holding the desktop icons, or None when explorer is not running
/// or the icons are still in Progman on a build before 24H2 (Win+D moves them
/// out into a WorkerW, so that case resolves itself the moment it matters).
fn icons_host() -> Option<HWND> {
    let shell = shell_window()?;
    if icons_in_progman() {
        return has_defview(shell).then_some(shell);
    }

    let cached = HOST.load(Ordering::SeqCst);
    if cached != 0 {
        let c = hwnd(cached);
        if unsafe { IsWindow(c).as_bool() } && has_defview(c) {
            return Some(c);
        }
        HOST.store(0, Ordering::SeqCst);
    }

    if has_defview(shell) {
        return None;
    }
    unsafe {
        let mut worker = HWND::default();
        for _ in 0..256 {
            worker = match FindWindowExW(HWND::default(), worker, w!("WorkerW"), PCWSTR::null()) {
                Ok(h) if !h.is_invalid() => h,
                _ => return None,
            };
            if IsWindowVisible(worker).as_bool() && same_process(shell, worker) && has_defview(worker) {
                HOST.store(raw(worker), Ordering::SeqCst);
                return Some(worker);
            }
        }
    }
    None
}

// ─── the probe ──────────────────────────────────────────────────────────────

fn ensure_probe() -> Result<(), String> {
    if probe().is_some() {
        return Ok(());
    }
    unsafe {
        let module: HMODULE = GetModuleHandleW(PCWSTR::null()).map_err(|e| e.to_string())?;
        let instance = HINSTANCE(module.0);
        let class = WNDCLASSW {
            lpfnWndProc: Some(probe_proc),
            hInstance: instance,
            lpszClassName: PROBE_CLASS,
            ..Default::default()
        };
        // Zero is also what a second registration returns; CreateWindowExW
        // below is the real test.
        RegisterClassW(&class);
        let p = CreateWindowExW(
            WS_EX_TOOLWINDOW,
            PROBE_CLASS,
            PROBE_TITLE,
            WS_POPUP | WS_DISABLED,
            0,
            0,
            0,
            0,
            HWND::default(),
            None,
            instance,
            None,
        )
        .map_err(|e| e.to_string())?;
        PROBE.store(raw(p), Ordering::SeqCst);
        let _ = SetWindowPos(p, HWND_BOTTOM, 0, 0, 0, 0, ZPOS);

        if !HOOKED.swap(true, Ordering::SeqCst) {
            let hook = SetWinEventHook(
                EVENT_SYSTEM_FOREGROUND,
                EVENT_SYSTEM_FOREGROUND,
                HMODULE::default(),
                Some(on_foreground),
                0,
                0,
                WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
            );
            if hook.is_invalid() {
                // The timer still catches Win+D, a quarter of a second later.
                HOOKED.store(false, Ordering::SeqCst);
            }
        }
    }
    Ok(())
}

unsafe extern "system" fn probe_proc(h: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match msg {
        // Nothing moves the probe but this file: it has to stay at the bottom
        // for the test above to mean anything.
        WM_WINDOWPOSCHANGING => {
            let pos = &mut *(lp.0 as *mut WINDOWPOS);
            pos.flags |= SWP_NOZORDER;
            return LRESULT(0);
        }
        WM_TIMER if wp.0 == TIMER_ID => {
            if let Some(b) = board() {
                if !check() && !ARRANGING.load(Ordering::SeqCst) && !RAISED.load(Ordering::SeqCst) {
                    let n = TICKS.fetch_add(1, Ordering::Relaxed);
                    if n % SINK_CHECK_EVERY == 0 && sunk(b) {
                        place();
                    }
                }
            }
            return LRESULT(0);
        }
        _ => {}
    }
    DefWindowProcW(h, msg, wp, lp)
}

/// Win+D hands the foreground to the desktop. Catching that here means the
/// board is back above it before the timer would have noticed.
unsafe extern "system" fn on_foreground(
    _hook: HWINEVENTHOOK,
    event: u32,
    h: HWND,
    _object: i32,
    _child: i32,
    _thread: u32,
    _time: u32,
) {
    if event != EVENT_SYSTEM_FOREGROUND || board().is_none() || RAISED.load(Ordering::SeqCst) {
        return;
    }
    let Some(shell) = shell_window() else { return };
    let is_desktop = if icons_in_progman() {
        h == shell
    } else {
        class_is(h, "WorkerW") && same_process(shell, h)
    };
    if !is_desktop {
        return;
    }
    // The desktop can take the foreground a moment before it is raised, and
    // before 24H2 a moment before the icons move into it. Rainmeter waits the
    // same way: a few short tries, then the timer has it.
    if !icons_in_progman() {
        let mut tries = 0;
        while tries < 5 && !has_defview(h) {
            std::thread::sleep(std::time::Duration::from_millis(2));
            tries += 1;
        }
        if tries == 5 {
            return;
        }
    }
    for _ in 0..5 {
        if check() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
}

// ─── the board ──────────────────────────────────────────────────────────────

unsafe extern "system" fn board_proc(
    h: HWND,
    msg: u32,
    wp: WPARAM,
    lp: LPARAM,
    _id: usize,
    _data: usize,
) -> LRESULT {
    match msg {
        // Activation, a click, the window code showing it: none of them may
        // change where it sits. This file's own moves skip this message.
        WM_WINDOWPOSCHANGING => {
            if !ARRANGING.load(Ordering::SeqCst) {
                let pos = &mut *(lp.0 as *mut WINDOWPOS);
                pos.flags |= SWP_NOZORDER;
            }
        }
        // Clicked while being arranged: take the click, never the focus.
        WM_MOUSEACTIVATE => return LRESULT(MA_NOACTIVATE as isize),
        WM_STYLECHANGING if wp.0 as i32 == GWL_EXSTYLE.0 => {
            let s = &mut *(lp.0 as *mut STYLESTRUCT);
            s.styleNew = (s.styleNew | WS_EX_TOOLWINDOW.0) & !WS_EX_APPWINDOW.0;
        }
        WM_NCDESTROY => {
            let _ = BOARD.compare_exchange(raw(h), 0, Ordering::SeqCst, Ordering::SeqCst);
            let _ = RemoveWindowSubclass(h, Some(board_proc), SUBCLASS_ID);
        }
        _ => {}
    }
    DefSubclassProc(h, msg, wp, lp)
}
