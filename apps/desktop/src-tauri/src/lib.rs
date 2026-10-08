mod hotkeys;
mod secrets;
mod system_audio;

use std::{
    sync::{
        OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Instant,
};

use tauri::{
    Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::{PermissionKind, PermissionResponse},
};

static PROCESS_START: OnceLock<Instant> = OnceLock::new();
static CLOSE_TO_TRAY: AtomicBool = AtomicBool::new(true);
static QUITTING: AtomicBool = AtomicBool::new(false);

/// Chromium flags for the WebView2 process:
/// - keep wry's defaults (no Edge OOUI / SmartScreen helpers);
/// - disable intensive timer throttling so the gateway heartbeat keeps
///   running while the window is hidden in the tray;
/// - run the GPU service inside the browser process: measured -20 MB private
///   memory and -80 ms startup (docs/BENCHMARKS.md), hardware decode intact.
const BROWSER_ARGS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,IntensiveWakeUpThrottling --in-process-gpu";

/// `NEXUS_WEBVIEW_ARGS` appends Chromium flags (benchmarking experiments).
fn browser_args() -> String {
    match std::env::var("NEXUS_WEBVIEW_ARGS") {
        Ok(extra) if !extra.trim().is_empty() => format!("{BROWSER_ARGS} {}", extra.trim()),
        _ => BROWSER_ARGS.to_string(),
    }
}

#[tauri::command]
fn set_close_to_tray(enabled: bool) {
    CLOSE_TO_TRAY.store(enabled, Ordering::Relaxed);
}

/// Called by the UI after its first render. Reports time-to-interactive for
/// the benchmark tool (`NEXUS_BENCH_STARTUP_FILE`).
#[tauri::command]
fn app_ready() -> u128 {
    let ms = PROCESS_START.get().map(|t| t.elapsed().as_millis()).unwrap_or(0);
    if let Ok(path) = std::env::var("NEXUS_BENCH_STARTUP_FILE") {
        let _ = std::fs::write(path, ms.to_string());
    }
    ms
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

pub fn run() {
    PROCESS_START.get_or_init(Instant::now);

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            app_ready,
            set_close_to_tray,
            secrets::secret_get,
            secrets::secret_set,
            secrets::secret_delete,
            hotkeys::hotkeys_set,
            hotkeys::hotkeys_capture,
            hotkeys::hotkey_name,
            system_audio::system_audio_support,
            system_audio::system_audio_apps,
            system_audio::system_audio_start,
            system_audio::system_audio_stop,
        ])
        .setup(|app| {
            let title = app.config().product_name.clone().unwrap_or_else(|| "Nexus".into());
            WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title(&title)
                .inner_size(1180.0, 760.0)
                .min_inner_size(820.0, 520.0)
                .additional_browser_args(&browser_args())
                // The WebView only ever loads our bundled UI, so media
                // permissions are granted without WebView2's own prompt.
                .on_permission_request(|_webview, kind| match kind {
                    PermissionKind::Microphone
                    | PermissionKind::Camera
                    | PermissionKind::DisplayCapture
                    | PermissionKind::Notifications
                    | PermissionKind::Autoplay => PermissionResponse::Allow,
                    _ => PermissionResponse::Default,
                })
                .build()?;

            let open = MenuItem::with_id(app, "open", "Abrir", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Sair", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            let mut tray = TrayIconBuilder::with_id("main")
                .tooltip(&title)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main(app),
                    "quit" => {
                        QUITTING.store(true, Ordering::SeqCst);
                        system_audio::system_audio_stop();
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            hotkeys::start(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event
                && CLOSE_TO_TRAY.load(Ordering::Relaxed)
                && !QUITTING.load(Ordering::SeqCst)
            {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Nexus");
}
