use std::sync::{Arc, Mutex};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, WebviewWindow,
};
use tauri_plugin_autostart::MacosLauncher;

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
    Ok(())
}

#[tauri::command]
fn set_tray_icon(app: AppHandle, rgba: Vec<u8>, width: u32, height: u32) -> Result<(), String> {
    use tauri::image::Image;
    if let Some(tray) = app.tray_by_id("tray") {
        if rgba.is_empty() || width == 0 || height == 0 {
            // Reset to default bundled icon
            if let Some(icon) = app.default_window_icon() {
                let _ = tray.set_icon(Some(icon.clone()));
            }
        } else {
            let image = Image::new_owned(rgba, width, height);
            let _ = tray.set_icon(Some(image));
        }
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Arc::new(Mutex::new(Vec::<NotificationPayload>::new())) as PendingQueue)
        .plugin(tauri_plugin_opener::init())
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
                    "quit" => app.exit(0),
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
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            show_notification,
            close_notification_window,
            overlay_ready,
            set_tray_icon,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}