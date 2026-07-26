// wallpaper.rs — Live wallpaper, running in a SEPARATE PROCESS.
//
// REVISION MARKER
// ---------------
// REV is written to the log by both processes on every start. If the log does
// not say the revision you just built, you are running an older binary — that
// mistake has cost real hours on this feature.
//
// WHY A SEPARATE PROCESS
// ---------------------
// Making a window a live wallpaper means SetParent(our_hwnd, WorkerW), where
// WorkerW belongs to explorer.exe. Windows then ties the two threads' input
// queues together, so anything that stalls one side stalls the other. That was
// the freeze: app dead, taskbar dead, only Win / alt-tab gets input back.
// tauri-plugin-wallpaper does not help there — its attach() is just
// FindWindow + EnumWindows + SetParent. Lively and Wallpaper Engine put the
// wallpaper in its own process, and so do we.
//
//   main process   spawns / talks to / kills the child
//   child process  the same .exe launched with `--wallpaper <path>`; one
//                  borderless window parented to WorkerW, playing a video
//
// HOW THE VIDEO GETS SET AND CHANGED
// ----------------------------------
// A state file in %TEMP% holds the current path. The child polls it twice a
// second and pushes the path into the page with eval(), which depends on
// nothing — not the event system, not listener registration, not whether the
// URL query survived. For the first ten seconds it re-pushes on every tick, so
// the clip lands no matter when the page finishes loading. The page de-dupes,
// so repeats cost nothing.
//
// The stdin pipe is only a death signal: EOF means the parent is gone and the
// child shuts down rather than leaving a video running on the desktop.
//
// DO NOT ADD additional_browser_args
// ----------------------------------
// A previous revision passed WebView2 flags here to stop it pausing paint on an
// occluded window (CalculateNativeWinOcclusion, backgrounding-occluded-windows
// and friends). From that build on, the video stopped appearing at all — the
// webview never came up and the log stopped right after "child process
// starting". If the frozen-frame problem returns, the JS watchdog in
// wallpaper.html is the first line of defence; flags only go back in one at a
// time, each verified on its own.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

/// Bump this whenever this file changes, so the log identifies the build.
const REV: &str = "rev7 pause-when-covered";

// ── Fullscreen detection imports (Windows only) ─────────────────────────────
#[cfg(target_os = "windows")]
use windows::Win32::{
    Foundation::RECT,
    UI::WindowsAndMessaging::{
        GetDesktopWindow, GetForegroundWindow, GetShellWindow, GetSystemMetrics, GetWindowRect,
        SM_CXSCREEN, SM_CYSCREEN,
    },
};

// ════════════════════════════════════════════════════════════════════════════
//  SHARED: log file + state file
// ════════════════════════════════════════════════════════════════════════════

fn log_file() -> PathBuf {
    std::env::temp_dir().join("game-scheduler-wallpaper.log")
}

fn state_file() -> PathBuf {
    std::env::temp_dir().join("game-scheduler-wallpaper.txt")
}

fn log(who: &str, msg: &str) {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_file())
    {
        let _ = writeln!(f, "[{}] {:<6} {}", secs, who, msg);
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  MAIN PROCESS SIDE
// ════════════════════════════════════════════════════════════════════════════

/// Holds the running wallpaper child process. Managed by the main app only.
pub struct WallpaperProc(pub Mutex<Option<Child>>);

impl WallpaperProc {
    pub fn new() -> Self {
        Self(Mutex::new(None))
    }
}

/// Kill the wallpaper child if one is running. Safe to call any time.
pub fn kill_wallpaper_process(app: &AppHandle) {
    if let Some(state) = app.try_state::<WallpaperProc>() {
        if let Ok(mut slot) = state.0.lock() {
            if let Some(mut child) = slot.take() {
                log("parent", "killing wallpaper child");
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

/// Ask Windows to repaint the desktop so the real wallpaper comes back after
/// our child window disappears. Runs on a worker thread because the plugin
/// unwraps internally and we do not want a panic reaching the UI thread.
fn refresh_desktop(app: &AppHandle) {
    #[cfg(target_os = "windows")]
    {
        use tauri_plugin_wallpaper::WallpaperExt;
        let app2 = app.clone();
        std::thread::spawn(move || {
            let _ = app2.wallpaper().reset();
        });
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
    }
}

/// Is a child process currently alive?
fn child_alive(app: &AppHandle) -> bool {
    if let Some(state) = app.try_state::<WallpaperProc>() {
        if let Ok(mut slot) = state.0.lock() {
            if let Some(child) = slot.as_mut() {
                if matches!(child.try_wait(), Ok(None)) {
                    return true;
                }
                log("parent", "child had already exited");
                *slot = None;
            }
        }
    }
    false
}

/// Start (or restart) the wallpaper with the given video.
#[tauri::command]
pub fn start_wallpaper(app: AppHandle, path: String) -> Result<String, String> {
    // Auto-restore on launch means a path saved weeks ago can point at a file
    // that has since been moved or deleted. Without this check the child starts
    // fine and paints a black desktop with no explanation anywhere.
    if !std::path::Path::new(&path).exists() {
        log("parent", &format!("video file missing: {}", path));
        return Err(format!("video file not found: {}", path));
    }

    kill_wallpaper_process(&app);

    match std::fs::write(state_file(), &path) {
        Ok(_) => log("parent", &format!("state file written: {}", path)),
        Err(e) => log("parent", &format!("state file write FAILED: {}", e)),
    }

    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    log("parent", &format!("[{}] exe = {}", REV, exe.display()));

    let mut cmd = Command::new(exe);
    cmd.arg("--wallpaper").arg(&path).stdin(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    let child = cmd.spawn().map_err(|e| {
        log("parent", &format!("spawn FAILED: {}", e));
        e.to_string()
    })?;
    log("parent", &format!("spawned child pid={}", child.id()));

    if let Some(state) = app.try_state::<WallpaperProc>() {
        if let Ok(mut slot) = state.0.lock() {
            *slot = Some(child);
        }
    }
    Ok("started".into())
}

/// Stop the wallpaper.
#[tauri::command]
pub fn stop_wallpaper(app: AppHandle) -> Result<String, String> {
    kill_wallpaper_process(&app);
    let _ = std::fs::remove_file(state_file());
    refresh_desktop(&app);
    Ok("stopped".into())
}

/// Change the video without restarting the child, which leaves WorkerW alone.
#[tauri::command]
pub fn swap_wallpaper(app: AppHandle, path: String) -> Result<String, String> {
    if !child_alive(&app) {
        log("parent", "swap requested with no live child, restarting");
        return start_wallpaper(app, path).map(|_| "restarted".to_string());
    }
    if !std::path::Path::new(&path).exists() {
        log("parent", &format!("video file missing: {}", path));
        return Err(format!("video file not found: {}", path));
    }
    log("parent", &format!("swap -> {}", path));
    std::fs::write(state_file(), &path).map_err(|e| {
        log("parent", &format!("state file write FAILED: {}", e));
        e.to_string()
    })?;
    Ok("swapped".into())
}

/// If the state file exists the wallpaper is meant to be running. The child can
/// still die on its own — explorer restarting takes WorkerW and our window with
/// it, and the child exits on purpose in that case so a fresh one can attach
/// cleanly. Nothing was bringing that fresh one back, so the wallpaper simply
/// vanished until the switch was toggled by hand. This closes that.
pub fn spawn_wallpaper_guard(app: AppHandle) {
    std::thread::spawn(move || {
        let mut restarts = 0u32;
        loop {
            std::thread::sleep(std::time::Duration::from_secs(20));
            let want = match std::fs::read_to_string(state_file()) {
                Ok(s) => s.trim().to_string(),
                Err(_) => continue, // no state file means it is meant to be off
            };
            if want.is_empty() || child_alive(&app) {
                continue;
            }
            // A child that keeps dying is a bug, not something to paper over
            // forever with restarts, so give up after a few and say so.
            if restarts >= 5 {
                log("parent", "child keeps dying, guard giving up");
                return;
            }
            restarts += 1;
            log("parent", &format!("child gone, guard restarting ({})", restarts));
            let _ = start_wallpaper(app.clone(), want);
        }
    });
}

/// Kept so any older front-end call still resolves.
#[tauri::command]
pub fn attach_wallpaper(_app: AppHandle) -> Result<(), String> {
    Ok(())
}

/// Native file picker.
#[tauri::command]
pub async fn pick_video(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("Video", &["mp4", "webm", "mkv", "mov"])
            .blocking_pick_file()
            .map(|p| p.to_string())
    })
    .await
    .map_err(|e| e.to_string())
}

// ════════════════════════════════════════════════════════════════════════════
//  CHILD PROCESS SIDE  (`game-scheduler.exe --wallpaper <path>`)
// ════════════════════════════════════════════════════════════════════════════

/// JS pushed into the page to set the clip. Independent of the event system,
/// of listener registration and of whether the module script ran at all.
const SET_JS: &str = r#"(function(p){try{
var v=document.getElementById('wp');
if(v&&v.dataset&&v.dataset.wpPath===p){return;}
if(window.__setWallpaper){window.__setWallpaper(p);return;}
if(!v){return;}
var s=(window.__TAURI__&&window.__TAURI__.core)?window.__TAURI__.core.convertFileSrc(p):p;
v.dataset.wpPath=p;v.src=s;v.load();
var q=v.play();if(q&&q.catch){q.catch(function(){});}
}catch(e){}})(__PATH__)"#;

/// Entry point for the wallpaper-only process. Blocks until the process exits.
pub fn run_wallpaper_process(mut ctx: tauri::Context, path: String) {
    // Do not create the windows declared in tauri.conf.json — this process
    // must not boot a second copy of the React app, the DB or the notifier.
    ctx.config_mut().app.windows.clear();

    log("child", "──────── child process starting ────────");
    log("child", &format!("[{}] initial path = {}", REV, path));

    tauri::Builder::default()
        .plugin(tauri_plugin_wallpaper::init())
        .setup(move |app| {
            use tauri::{Emitter, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

            let url = format!("wallpaper.html?path={}", urlencode(&path));
            log("child", &format!("webview url = {}", url));

            // NOTE: no .additional_browser_args() here. See the header comment.
            let win = match WebviewWindowBuilder::new(app, "wallpaper", WebviewUrl::App(url.into()))
                .title("wallpaper")
                .decorations(false)
                .shadow(false)
                .skip_taskbar(true)
                .resizable(false)
                .focused(false)
                .visible(false) // show only once it is behind the icons
                .inner_size(1920.0, 1080.0)
                .build()
            {
                Ok(w) => {
                    log("child", "window built");
                    w
                }
                Err(e) => {
                    log("child", &format!("window build FAILED: {}", e));
                    return Err(Box::new(e) as Box<dyn std::error::Error>);
                }
            };

            // Parent to WorkerW on the MAIN thread. SetParent from a worker
            // thread is unreliable — the plugin's own example does it here.
            #[cfg(target_os = "windows")]
            {
                use tauri_plugin_wallpaper::WallpaperExt;
                match app.handle().wallpaper().attach_window(&win) {
                    Ok(_) => log("child", "attach ok"),
                    Err(e) => log("child", &format!("attach FAILED: {}", e)),
                }
            }

            // After SetParent the coordinates are relative to WorkerW, so pin
            // the window to the desktop origin at full monitor size.
            match win.primary_monitor() {
                Ok(Some(monitor)) => {
                    let size = *monitor.size();
                    log("child", &format!("monitor {}x{}", size.width, size.height));
                    let _ = win.set_position(PhysicalPosition::new(0i32, 0i32));
                    let _ = win.set_size(PhysicalSize::new(size.width, size.height));
                }
                Ok(None) => log("child", "no primary monitor reported"),
                Err(e) => log("child", &format!("primary_monitor FAILED: {}", e)),
            }

            match win.show() {
                Ok(_) => log("child", "window shown"),
                Err(e) => log("child", &format!("show FAILED: {}", e)),
            }

            spawn_state_poller(app.handle().clone());
            spawn_stdin_reader();

            // Pause decoding while a fullscreen app (a game) is in front.
            let win2 = win.clone();
            std::thread::spawn(move || {
                let mut was_fullscreen = false;
                loop {
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    let now_covered = desktop_is_covered();
                    if now_covered != was_fullscreen {
                        was_fullscreen = now_covered;
                        let evt = if now_covered {
                            "wallpaper-pause"
                        } else {
                            "wallpaper-resume"
                        };
                        log("child", &format!("emit {}", evt));
                        let _ = win2.emit(evt, ());
                    }
                }
            });

            Ok(())
        })
        .run(ctx)
        .expect("error while running wallpaper process");
}

/// Push a clip into the page. `loud` keeps the log readable during the first
/// few seconds, when we deliberately re-push on every tick.
fn apply_path(handle: &AppHandle, path: &str, loud: bool) {
    let win = match handle.get_webview_window("wallpaper") {
        Some(w) => w,
        None => {
            // Our window is gone (explorer restarted and took WorkerW with it).
            // Exit so the next swap spawns a fresh, correctly attached process.
            log("child", "window missing, exiting");
            std::process::exit(0);
        }
    };

    let literal = serde_json::to_string(path).unwrap_or_else(|_| "\"\"".to_string());
    let js = SET_JS.replace("__PATH__", &literal);
    match win.eval(js) {
        Ok(_) => {
            if loud {
                log("child", &format!("eval sent for {}", path));
            }
        }
        Err(e) => log("child", &format!("eval FAILED: {}", e)),
    }
}

/// Watch the state file the parent writes. This is the only channel that
/// actually sets the video, initial clip included.
fn spawn_state_poller(handle: AppHandle) {
    std::thread::spawn(move || {
        let mut current = String::new();
        let mut ticks: u32 = 0;
        let mut warned = false;

        loop {
            std::thread::sleep(std::time::Duration::from_millis(500));
            ticks += 1;

            let want = match std::fs::read_to_string(state_file()) {
                Ok(s) => s.trim().to_string(),
                Err(e) => {
                    if !warned {
                        warned = true;
                        log("child", &format!("state file unreadable: {}", e));
                    }
                    continue;
                }
            };
            if want.is_empty() {
                continue;
            }

            let changed = want != current;
            // First ten seconds: re-push every tick, because the page may still
            // be loading. The page de-dupes, so repeats are free.
            if !changed && ticks > 20 {
                continue;
            }
            if changed {
                log("child", &format!("state -> {}", want));
                current = want.clone();
            }
            apply_path(&handle, &want, changed || ticks == 1);
        }
    });
}

/// The stdin pipe is only a death signal: EOF means the parent is gone.
fn spawn_stdin_reader() {
    std::thread::spawn(|| {
        use std::io::BufRead;
        let stdin = std::io::stdin();
        let mut reader = stdin.lock();
        let mut line = String::new();
        log("child", "stdin reader started");
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => {
                    log("child", "stdin EOF, parent gone, exiting");
                    std::process::exit(0);
                }
                Ok(_) => {}
                Err(e) => {
                    log("child", &format!("stdin unreadable ({}), reader stopping", e));
                    return;
                }
            }
        }
    });
}

/// Minimal percent-encoding for the path query parameter.
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => {
                out.push('%');
                out.push_str(&format!("{:02X}", b));
            }
        }
    }
    out
}

// ── Should the wallpaper bother decoding right now? ─────────────────────────
// The old test was exact fullscreen only, which meant a maximised browser or
// editor — the desktop's state for most of a working day — still had us
// decoding sixty frames a second for pixels nobody can see. A maximised window
// does not report exact screen bounds either: Windows gives it invisible
// borders and stops above the taskbar, so `height >= screen height` was never
// true for it.
//
// Measuring covered area instead catches both cases with one number. 85% is
// deliberately below a maximised window's ~97% and well above a half-screen
// window's 50%.
#[cfg(target_os = "windows")]
pub fn desktop_is_covered() -> bool {
    unsafe {
        let fg = GetForegroundWindow();
        if fg.is_invalid() {
            return false;
        }
        let desktop = GetDesktopWindow();
        let shell = GetShellWindow();
        if fg == desktop || fg == shell {
            return false; // looking at the desktop itself
        }
        let mut rc = RECT::default();
        if GetWindowRect(fg, &mut rc).is_err() {
            return false;
        }
        let sw = GetSystemMetrics(SM_CXSCREEN) as f64;
        let sh = GetSystemMetrics(SM_CYSCREEN) as f64;
        if sw <= 0.0 || sh <= 0.0 {
            return false;
        }
        // Clip to the screen so a window hanging off an edge is not over-counted.
        let left = (rc.left.max(0)) as f64;
        let top = (rc.top.max(0)) as f64;
        let right = (rc.right as f64).min(sw);
        let bottom = (rc.bottom as f64).min(sh);
        let w = (right - left).max(0.0);
        let h = (bottom - top).max(0.0);
        (w * h) / (sw * sh) >= 0.85
    }
}

#[cfg(not(target_os = "windows"))]
pub fn desktop_is_covered() -> bool {
    false
}