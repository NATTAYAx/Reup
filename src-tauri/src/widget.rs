// widget.rs — the board on the desktop.
//
// WHAT IT IS
//
// The phone's home-screen widget, at desktop size: the clock, what is next, the
// rest of the day, how much of it is done, and the longer rounds still open.
// One transparent window, sitting above the desktop icons and under every
// application window, still there after Win+D. How it stays in that layer is
// desk_layer.rs.
//
// Clicks go through it. The half of the screen it covers is still desktop, so
// icons under it still open and the desktop's right-click menu still works.
// The app opens from the tray, as it always has. The one time the board takes
// the mouse is while it is being moved, which the tray and the settings both
// offer.
//
// WHERE ITS DATA COMES FROM
//
// Not from here, and not from the database. The main window's script is awake
// all day already - it runs the notifier - and it already loads the task list;
// every time it does, it hands a copy to the board. The board works out what to
// say from that once a minute. See src/lib/widgetFeed.ts and widgetFace.ts.
//
// WHAT IT COSTS
//
// One more WebView2 renderer, on the order of 40-60 MB. Past that, close to
// nothing: the page has no animation and repaints once a minute, and the layer
// check is a few window lookups four times a second.
//
// WHAT IS KEPT
//
// widget.json in the app's config folder: whether it is on, and where it was
// left, in physical pixels. Its look (how dark the backing is, whether the
// month's money is shown) lives with the other display settings in the page's
// storage, where the settings screen can change it live.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::menu::CheckMenuItem;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, Wry,
};

pub const LABEL: &str = "widget";

/// Small enough for a corner, big enough that nothing on it overlaps.
const MIN_W: f64 = 300.0;
const MIN_H: f64 = 260.0;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
struct Rect {
    x: i32,
    y: i32,
    w: u32,
    h: u32,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct Saved {
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    rect: Option<Rect>,
}

pub struct WidgetState {
    saved: Mutex<Saved>,
    arranging: AtomicBool,
    /// Building a window takes a moment; a second click in that moment must
    /// not build a second one.
    opening: AtomicBool,
    menu: Mutex<Option<CheckMenuItem<Wry>>>,
}

#[derive(Clone, Serialize)]
pub struct WidgetStatus {
    enabled: bool,
    arranging: bool,
}

// ─── the file ───────────────────────────────────────────────────────────────

fn file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("widget.json"))
}

fn load(app: &AppHandle) -> Saved {
    file(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn store(app: &AppHandle, saved: &Saved) {
    let Some(path) = file(app) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(text) = serde_json::to_string_pretty(saved) {
        let _ = std::fs::write(path, text);
    }
}

fn state(app: &AppHandle) -> Option<tauri::State<'_, WidgetState>> {
    app.try_state::<WidgetState>()
}

fn status(app: &AppHandle) -> WidgetStatus {
    match state(app) {
        Some(s) => WidgetStatus {
            enabled: s.saved.lock().map(|g| g.enabled).unwrap_or(false),
            arranging: s.arranging.load(Ordering::SeqCst),
        },
        None => WidgetStatus { enabled: false, arranging: false },
    }
}

fn set_saved(app: &AppHandle, f: impl FnOnce(&mut Saved)) {
    let Some(s) = state(app) else { return };
    let copy = {
        let Ok(mut g) = s.saved.lock() else { return };
        f(&mut g);
        g.clone()
    };
    store(app, &copy);
}

// ─── where it goes ──────────────────────────────────────────────────────────

/// The right half of the main screen, inside the taskbar: most of the space a
/// desktop usually leaves empty.
fn default_rect(app: &AppHandle) -> Rect {
    let area = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| {
            let a = m.work_area();
            (a.position.x, a.position.y, a.size.width, a.size.height)
        })
        .unwrap_or((0, 0, 1920, 1040));
    let (ax, ay, aw, ah) = area;
    let w = ((aw as f64) * 0.46).round() as u32;
    let h = ((ah as f64) * 0.90).round() as u32;
    let margin = ((aw as f64) * 0.03).round() as i32;
    Rect {
        x: ax + aw as i32 - w as i32 - margin,
        y: ay + (ah as i32 - h as i32) / 2,
        w,
        h,
    }
}

/// A saved place is only used while a good piece of it is on some screen. A
/// monitor unplugged since, or a resolution changed, would otherwise leave the
/// board somewhere nobody can see or reach.
fn on_screen(app: &AppHandle, r: Rect) -> bool {
    let Ok(monitors) = app.available_monitors() else { return true };
    monitors.iter().any(|m| {
        let p = m.position();
        let s = m.size();
        let left = r.x.max(p.x);
        let top = r.y.max(p.y);
        let right = (r.x + r.w as i32).min(p.x + s.width as i32);
        let bottom = (r.y + r.h as i32).min(p.y + s.height as i32);
        right - left >= 160 && bottom - top >= 120
    })
}

fn rect_for(app: &AppHandle) -> Rect {
    let saved = state(app).and_then(|s| s.saved.lock().ok().and_then(|g| g.rect));
    match saved {
        Some(r) if r.w as f64 >= MIN_W * 0.5 && r.h as f64 >= MIN_H * 0.5 && on_screen(app, r) => r,
        _ => default_rect(app),
    }
}

fn put(win: &WebviewWindow, r: Rect) {
    let _ = win.set_position(PhysicalPosition::new(r.x, r.y));
    let _ = win.set_size(PhysicalSize::new(r.w, r.h));
}

// ─── open and close ─────────────────────────────────────────────────────────

/// Build the board and put it in its layer.
///
/// Building a webview window from a synchronous command or an event handler
/// deadlocks on Windows (the tauri docs say so, and say why), so this is only
/// ever called from setup, from an async command, or from a thread of its own.
fn open(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window(LABEL).is_some() {
        return Ok(());
    }
    let Some(s) = state(app) else { return Err("widget state missing".into()) };
    if s.opening.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let built = build(app);
    s.opening.store(false, Ordering::SeqCst);
    built
}

fn build(app: &AppHandle) -> Result<(), String> {
    let rect = rect_for(app);
    let win = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("widget.html".into()))
        .title("Reup")
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .skip_taskbar(true)
        .resizable(true)
        .maximizable(false)
        .minimizable(false)
        // Never takes the focus away from what is being typed into, not even
        // when it appears or is clicked while being moved.
        .focused(false)
        .focusable(false)
        .visible(false)
        .min_inner_size(MIN_W, MIN_H)
        .build()
        .map_err(|e| e.to_string())?;

    put(&win, rect);
    let _ = win.set_ignore_cursor_events(true);

    #[cfg(target_os = "windows")]
    let handle = win.hwnd().map(|h| h.0 as isize).map_err(|e| e.to_string())?;

    let shown = win.clone();
    app.run_on_main_thread(move || {
        #[cfg(target_os = "windows")]
        if let Err(e) = crate::desk_layer::attach(handle) {
            eprintln!("[widget] could not take the desktop layer: {e}");
        }
        let _ = shown.show();
    })
    .map_err(|e| e.to_string())
}

fn close(app: &AppHandle) {
    if let Some(s) = state(app) {
        s.arranging.store(false, Ordering::SeqCst);
    }
    if let Some(win) = app.get_webview_window(LABEL) {
        // destroy() on the main thread, as the overlay does: close() from off
        // it is what was silently killing this app once before.
        let _ = app.run_on_main_thread(move || {
            #[cfg(target_os = "windows")]
            crate::desk_layer::detach();
            let _ = win.destroy();
        });
    }
}

fn sync_menu(app: &AppHandle, on: bool) {
    if let Some(s) = state(app) {
        if let Ok(g) = s.menu.lock() {
            if let Some(item) = g.as_ref() {
                let _ = item.set_checked(on);
            }
        }
    }
}

/// Tells every window where the board stands: the board itself shows or drops
/// its handles, and the settings screen keeps its switch and button honest when
/// the change came from the tray.
fn announce(app: &AppHandle) {
    let _ = app.emit("widget-status", status(app));
}

fn enable(app: &AppHandle, on: bool) -> Result<(), String> {
    set_saved(app, |s| s.enabled = on);
    sync_menu(app, on);
    let done = if on {
        open(app)
    } else {
        close(app);
        Ok(())
    };
    announce(app);
    done
}

/// Into or out of the mode where it can be moved.
fn arrange(app: &AppHandle, on: bool) -> Result<(), String> {
    let Some(s) = state(app) else { return Err("widget state missing".into()) };
    if on && app.get_webview_window(LABEL).is_none() {
        enable(app, true)?;
    }
    let Some(win) = app.get_webview_window(LABEL) else {
        return Err("widget is not open".into());
    };
    s.arranging.store(on, Ordering::SeqCst);

    if !on {
        // Where it was left is where it stays.
        if let (Ok(p), Ok(z)) = (win.outer_position(), win.inner_size()) {
            set_saved(app, |s| s.rect = Some(Rect { x: p.x, y: p.y, w: z.width, h: z.height }));
        }
    }

    let w = win.clone();
    app.run_on_main_thread(move || {
        let _ = w.set_ignore_cursor_events(!on);
        #[cfg(target_os = "windows")]
        crate::desk_layer::set_arranging(on);
    })
    .map_err(|e| e.to_string())?;

    announce(app);
    Ok(())
}

// ─── wiring ─────────────────────────────────────────────────────────────────

/// From setup: read the file, and bring the board up if it was on.
pub fn setup(app: &AppHandle) {
    let saved = load(app);
    let enabled = saved.enabled;
    app.manage(WidgetState {
        saved: Mutex::new(saved),
        arranging: AtomicBool::new(false),
        opening: AtomicBool::new(false),
        menu: Mutex::new(None),
    });
    if enabled {
        if let Err(e) = open(app) {
            eprintln!("[widget] could not open: {e}");
        }
    }
}

pub fn is_enabled(app: &AppHandle) -> bool {
    status(app).enabled
}

/// The tray's check item, so turning the board on from settings ticks it too.
pub fn remember_menu(app: &AppHandle, item: CheckMenuItem<Wry>) {
    if let Some(s) = state(app) {
        if let Ok(mut g) = s.menu.lock() {
            *g = Some(item);
        }
    }
}

/// Tray handlers run on the main thread, where building a window deadlocks;
/// both hand their work to a thread of their own.
pub fn tray_toggle(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let on = !is_enabled(&app);
        if let Err(e) = enable(&app, on) {
            eprintln!("[widget] {e}");
        }
    });
}

pub fn tray_arrange(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let on = !status(&app).arranging;
        if let Err(e) = arrange(&app, on) {
            eprintln!("[widget] {e}");
        }
    });
}

// ─── commands ───────────────────────────────────────────────────────────────
//
// All async, for the deadlock above: an async command runs off the main thread.

#[tauri::command]
pub async fn widget_status(app: AppHandle) -> WidgetStatus {
    status(&app)
}

#[tauri::command]
pub async fn widget_enable(app: AppHandle, on: bool) -> Result<WidgetStatus, String> {
    enable(&app, on)?;
    Ok(status(&app))
}

#[tauri::command]
pub async fn widget_arrange(app: AppHandle, on: bool) -> Result<WidgetStatus, String> {
    arrange(&app, on)?;
    Ok(status(&app))
}

/// Back to the right half of the main screen.
#[tauri::command]
pub async fn widget_reset(app: AppHandle) -> Result<WidgetStatus, String> {
    let r = default_rect(&app);
    set_saved(&app, |s| s.rect = Some(r));
    if let Some(win) = app.get_webview_window(LABEL) {
        put(&win, r);
    }
    Ok(status(&app))
}
