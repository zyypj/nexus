//! Windows toasts with a click handler. tauri-plugin-notification shows
//! toasts through notify-rust, which ignores activation on Windows, so
//! clicking a message notification did nothing. Here a click brings the
//! window back and tells the UI which conversation to open
//! (`notification-clicked`, payload: conversation id).

use tauri::AppHandle;

#[cfg(windows)]
#[tauri::command]
pub fn notify_show(app: AppHandle, title: String, body: String, conversation_id: Option<String>) -> Result<(), String> {
    use tauri::Emitter;
    use tauri_winrt_notification::Toast;

    // Same rule as the plugin: the AppUserModelID only exists for the
    // installed app; dev builds borrow PowerShell's.
    let exe = tauri::utils::platform::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().map(|d| d.display().to_string()).unwrap_or_default();
    let sep = std::path::MAIN_SEPARATOR;
    let dev = dir.ends_with(&format!("{sep}target{sep}debug")) || dir.ends_with(&format!("{sep}target{sep}release"));
    let app_id = if dev {
        Toast::POWERSHELL_APP_ID.to_string()
    } else {
        app.config().identifier.clone()
    };

    std::thread::spawn(move || {
        let handle = app.clone();
        let result = Toast::new(&app_id)
            .title(&title)
            .text1(&body)
            // The app plays its own message sound.
            .sound(None)
            .on_activated(move |_| {
                crate::show_main(&handle);
                let _ = handle.emit("notification-clicked", conversation_id.clone());
                Ok(())
            })
            .show();
        if let Err(e) = result {
            eprintln!("notification failed: {e}");
        }
    });
    Ok(())
}

#[cfg(not(windows))]
#[tauri::command]
pub fn notify_show(
    _app: AppHandle,
    _title: String,
    _body: String,
    _conversation_id: Option<String>,
) -> Result<(), String> {
    Err("unsupported".into())
}
