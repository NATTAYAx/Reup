use std::sync::{Arc, Mutex};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WebviewWindow,
};
use tauri_plugin_autostart::MacosLauncher;

mod wallpaper;

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct NotificationPayload {
    task_name: String,
    urgency: String,
    time_left: String,
    category: String,
}

type PendingQueue = Arc<Mutex<Vec<NotificationPayload>>>;

fn get_pending_queue(app: &AppHandle) -> PendingQueue {
    app.state::<PendingQueue>().inner().clone()
}

const TOAST_W:     f64 = 356.0;
const TOAST_H_ONE: f64 = 104.0;

/// How long the overlay may sit hidden before it is torn down.
///
/// Hiding rather than closing was a deliberate fix: the React "new-toast"
/// listener has to survive between notifications, and rebuilding the window per
/// toast reintroduced blank frames. That reasoning still holds for the gap
/// between two toasts a minute apart.
///
/// It does not hold for the twenty-three hours between one game reset and the
/// next. Over that stretch a whole WebView2 renderer sits resident — tens of
/// megabytes — so that a toast can appear half a second sooner, a handful of
/// times a day. After this long the window is destroyed and the next
/// notification takes the cold path, which is the same path the first
/// notification of every session already takes and is therefore the
/// best-tested one in this file.
const OVERLAY_IDLE_SECS: u64 = 300;

/// Guards the teardown against the obvious race: a notification arriving in the
/// moment between the timer expiring and the window being destroyed. Every
/// show or hide bumps the counter, and a teardown only proceeds if the counter
/// still matches the value it was scheduled with.
pub struct OverlayGeneration(pub std::sync::Mutex<u64>);

fn bump_overlay_generation(app: &AppHandle) -> u64 {
    if let Some(state) = app.try_state::<OverlayGeneration>() {
        if let Ok(mut g) = state.0.lock() {
            *g += 1;
            return *g;
        }
    }
    0
}

/// Destroy the overlay if nothing has happened to it since `scheduled_at`.
fn schedule_overlay_teardown(app: AppHandle, scheduled_at: u64) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(OVERLAY_IDLE_SECS));

        // Anything at all touched the overlay in the meantime? Then this
        // teardown is stale and must not run.
        let still_idle = app
            .try_state::<OverlayGeneration>()
            .and_then(|s| s.0.lock().ok().map(|g| *g == scheduled_at))
            .unwrap_or(false);
        if !still_idle {
            return;
        }

        // destroy() rather than close(): close() from off the main thread is the
        // call that was silently killing this app earlier in development.
        // The clone is required, not tidiness — the closure moves the handle
        // while the method call still needs it.
        let inner = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(win) = inner.get_webview_window("notification-overlay") {
                // Checked again on the main thread: this is the last instant
                // before destruction and the only place the answer is certain.
                if !win.is_visible().unwrap_or(false) {
                    let _ = win.destroy();
                }
            }
        });
    });
}

fn build_overlay_window(app: &AppHandle) -> Option<WebviewWindow> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    const LABEL: &str = "notification-overlay";

    let (screen_w, screen_h) = if let Some(m) = app.primary_monitor().ok().flatten() {
        let size  = m.size();
        let scale = m.scale_factor();
        (size.width as f64 / scale, size.height as f64 / scale)
    } else {
        (1920.0, 1080.0)
    };

    let x = screen_w - TOAST_W - 16.0;
    let y = screen_h - TOAST_H_ONE - 56.0;

    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("notification.html".into()))
        .title("")
        .inner_size(TOAST_W, TOAST_H_ONE)
        .position(x, y)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(true)
        .focused(false)
        .visible(false)
        .shadow(false)
        .build()
        .ok()
        .map(|w| {
            #[cfg(debug_assertions)]
            w.open_devtools();
            w
        })
}

/// Called by React on mount — returns any toasts queued before JS was ready.
/// Also shows the window here (after React is mounted) to avoid blank-frame race.
// ─── Backup file IO ───────────────────────────────────────────────────────────
// Three small commands rather than pulling in tauri-plugin-fs. The plugin is
// built for granting a web page broad access to the disk under a permission
// scope; all that is needed here is to put one string at one path the user
// picked from a save dialog, and read one back. std::fs already does that, and
// adding a dependency and a permission surface to avoid ten lines would be the
// wrong trade.
//
// ON THE GUARD BELOW
// As first written these two took any path at all and did as they were told.
// That was safe only because the paths happened to come from a file dialog the
// user had just clicked through — a property of today's calling code, not a
// property of the command. Any future caller that builds a path from data
// arriving over the network would turn these into an arbitrary-file-write and
// an arbitrary-file-read, and nothing here would have objected.
//
// So the rule is enforced where it cannot be forgotten: these commands handle
// .json and nothing else. That is all a backup file ever is. It cannot overwrite
// a DLL, a startup script, or the app's own database, and it cannot read a
// private key back out.

/// Backups are JSON. Anything else is not this command's business.
fn check_json_path(path: &str) -> Result<(), String> {
    let ok = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("json"))
        .unwrap_or(false);
    if ok {
        Ok(())
    } else {
        Err("only .json files are allowed".into())
    }
}

#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    check_json_path(&path)?;
    std::fs::write(&path, contents).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    check_json_path(&path)?;
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Writes a copy of the current data into the app's own folder and returns where
/// it went. Restoring replaces everything, so this runs first, every time, with
/// nothing asked of the user — the moment someone needs an undo is exactly the
/// moment they will not have thought to make one.
#[tauri::command]
fn write_snapshot(app: AppHandle, name: String, contents: String) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("snapshots");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // `name` arrives from the front end. Taking only the final component stops
    // a value like "..\\..\\Startup\\evil.json" from climbing out of the
    // snapshots folder, and the extension check keeps it a backup file.
    let leaf = std::path::Path::new(&name)
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "invalid snapshot name".to_string())?
        .to_string();
    check_json_path(&leaf)?;
    let path = dir.join(leaf);
    std::fs::write(&path, contents).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn overlay_ready(app: AppHandle) -> Vec<NotificationPayload> {
    let queue = get_pending_queue(&app);
    let pending: Vec<NotificationPayload> = {
        let mut q = queue.lock().unwrap();
        q.drain(..).collect()
    };
    if !pending.is_empty() {
        if let Some(win) = app.get_webview_window("notification-overlay") {
            std::thread::spawn(move || {
                // Small delay so React finishes first paint before we show
                std::thread::sleep(std::time::Duration::from_millis(350));
                let _ = win.show();
                std::thread::sleep(std::time::Duration::from_millis(80));
                let _ = win.set_ignore_cursor_events(true);
            });
        }
    }
    pending
}

#[tauri::command]
fn show_notification(
    app: AppHandle,
    task_name: String,
    urgency: String,
    time_left: String,
    category: String,
) -> Result<(), String> {
    use tauri::Emitter;
    const LABEL: &str = "notification-overlay";

    let payload = NotificationPayload { task_name, urgency, time_left, category };

    // Invalidates any teardown already counting down, so a toast arriving at
    // 4:59 cannot be met with the window vanishing at 5:00.
    bump_overlay_generation(&app);

    if let Some(win) = app.get_webview_window(LABEL) {
        // WebView2 suspends JS execution while the window is hidden.
        // After win.show(), the compositor needs time to wake up — 32ms is
        // not reliable when the window was hidden for a longer period (e.g.
        // the gap between the first toast auto-dismissing and the next
        // notification arriving).
        //
        // FIX: push the payload into the pending queue AND call show().
        // The React "new-toast" listener calls overlay_ready() on mount,
        // but after the first mount it stays alive. Instead, we emit
        // a "wake-and-drain" signal: first emit triggers JS to call
        // overlay_ready() again via a new "drain-queue" event, which
        // lets us drain any queued payloads safely after the window is warm.
        //
        // Simpler reliable approach: show() → wait 200ms (covers even a cold
        // WebView2 wake), then emit. 200ms is imperceptible to the user but
        // ensures JS is running before we try to push the toast.
        std::thread::spawn(move || {
            let _ = win.show();
            // WebView2 needs time to resume JS after hide→show.
            // 32ms was too short on slower machines or after longer idle periods.
            // We use a staggered retry: emit at 150ms, 400ms, and 900ms.
            // The JS side deduplicates by toast ID, so duplicate emits are harmless.
            // In practice the first emit at 150ms will succeed on warm windows,
            // and the retries cover cold-wake scenarios.
            for &delay_ms in &[150u64, 400, 900] {
                std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                let _ = win.emit("new-toast", payload.clone());
            }
            // Re-apply cursor pass-through AFTER showing (resets on hide→show)
            std::thread::sleep(std::time::Duration::from_millis(80));
            let _ = win.set_ignore_cursor_events(true);
        });
        return Ok(());
    }

    // First-ever notification: build window and queue payload for overlay_ready()
    {
        let queue = get_pending_queue(&app);
        let mut q = queue.lock().unwrap();
        q.push(payload);
    }

    let app_clone = app.clone();
    std::thread::spawn(move || {
        let _ = build_overlay_window(&app_clone);
    });

    Ok(())
}

/// Called by JS when all toasts have auto-dismissed.
/// We HIDE (not close/destroy) the window so the React app and its
/// "new-toast" listener stay alive for the next notification.
#[tauri::command]
fn close_notification_window(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("notification-overlay") {
        let _ = win.hide();
    }
    // Hidden now, gone in a few minutes if nothing else arrives. Kept as two
    // separate steps on purpose: a toast following a minute later still gets
    // the fast warm path, and only a genuinely idle overlay pays with a
    // rebuild.
    let generation = bump_overlay_generation(&app);
    schedule_overlay_teardown(app, generation);
    Ok(())
}

#[tauri::command]
/// Sets the icon everywhere it CAN be set at runtime.
///
/// There are three separate icons in a Windows app and only two of them are
/// ours to change once it is running:
///
///   tray icon      settable, and was the only one being set — which is why
///                  the picture appeared there and nowhere else
///   window icon    settable, and Windows uses it for the taskbar button and
///                  the Alt-Tab card too, so it covers most of "everywhere
///                  else" in one call
///   the .exe icon  NOT settable. It is compiled into the binary from
///                  tauri.conf.json and is what Explorer, the Start menu and
///                  the desktop shortcut read. Changing it needs a rebuild,
///                  because the file on disk has to physically change.
fn set_tray_icon(app: AppHandle, rgba: Vec<u8>, width: u32, height: u32) -> Result<(), String> {
    use tauri::image::Image;

    let custom = if rgba.is_empty() || width == 0 || height == 0 {
        None
    } else {
        Some(Image::new_owned(rgba, width, height))
    };

    if let Some(tray) = app.tray_by_id("tray") {
        match &custom {
            Some(img) => { let _ = tray.set_icon(Some(img.clone())); }
            None => {
                if let Some(icon) = app.default_window_icon() {
                    let _ = tray.set_icon(Some(icon.clone()));
                }
            }
        }
    }

    // The taskbar button follows the window icon on Windows, so this one call
    // covers the places the user actually looks at all day.
    if let Some(win) = app.get_webview_window("main") {
        match &custom {
            Some(img) => { let _ = win.set_icon(img.clone()); }
            None => {
                if let Some(icon) = app.default_window_icon() {
                    let _ = win.set_icon(icon.clone());
                }
            }
        }
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let ctx = tauri::generate_context!();

    // `game-scheduler.exe --wallpaper <path>` = the wallpaper child process.
    // It runs a separate Tauri app with one window and nothing else, so
    // parenting that window to explorer's WorkerW can never freeze this app.
    let args: Vec<String> = std::env::args().collect();
    if let Some(i) = args.iter().position(|a| a == "--wallpaper") {
        let path = args.get(i + 1).cloned().unwrap_or_default();
        wallpaper::run_wallpaper_process(ctx, path);
        return;
    }

    tauri::Builder::default()
        // MUST be registered first — the plugin docs are explicit that plugins
        // run in registration order, and this one has to win the race before
        // anything else in the app starts.
        //
        // Without it a second double-click started a whole second copy: two tray
        // icons, two notifiers firing the same reminders twice, two SQLite
        // handles on one file, and two wallpaper children fighting over WorkerW.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // Launching again should surface the copy already running.
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }))
        .manage(Arc::new(Mutex::new(Vec::<NotificationPayload>::new())) as PendingQueue)
        .manage(wallpaper::WallpaperProc::new())
        .manage(OverlayGeneration(std::sync::Mutex::new(0)))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_wallpaper::init())
        .plugin(tauri_plugin_sql::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![])))
        .setup(|app| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.hide();
            }

            #[cfg(debug_assertions)]
            if let Some(win) = app.get_webview_window("main") {
                win.open_devtools();
            }

            let show = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
            let hide = MenuItem::with_id(app, "hide", "Hide", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &hide, &quit])?;

            TrayIconBuilder::with_id("tray")
                .menu(&menu)
                .icon(app.default_window_icon().unwrap().clone())
                .on_menu_event(|app: &AppHandle, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                    "hide" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.hide();
                        }
                    }
                    "quit" => {
                        wallpaper::kill_wallpaper_process(app);
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray: &tauri::tray::TrayIcon, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(win) = app.get_webview_window("main") {
                            let win: WebviewWindow = win;
                            if win.is_visible().unwrap_or(false) {
                                let _ = win.hide();
                            } else {
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            // Bring the wallpaper back if its process dies on its own.
            wallpaper::spawn_wallpaper_guard(app.handle().clone());

            // NOTE: the fullscreen watcher now lives inside the wallpaper
            // child process (see wallpaper.rs) — it owns that window, so it
            // can pause playback itself with no cross-process IPC.

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    // Pressing X hides the window instead of quitting, which is
                    // not what the button normally means. Say so once, and say
                    // it in the window rather than in a settings page nobody
                    // reads before the fact. Emitted before hiding; the front
                    // end holds the message until the window is next shown.
                    let _ = window.emit("closed-to-tray", ());
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            show_notification,
            close_notification_window,
            overlay_ready,
            write_text_file,
            read_text_file,
            write_snapshot,
            set_tray_icon,
            wallpaper::attach_wallpaper,
            wallpaper::start_wallpaper,
            wallpaper::stop_wallpaper,
            wallpaper::swap_wallpaper,
            wallpaper::pick_video,
        ])
        .run(ctx)
        .expect("error while running tauri application");
}