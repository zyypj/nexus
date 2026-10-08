//! Hides WebView2's "<origin> is sharing your screen" bar.
//!
//! WebView2 has no API for it (only cancelling the capture), but the bar is
//! an ordinary top-level window of our own WebView2 browser process, and its
//! "Hide" button does exactly this. Nexus shows its own sharing state in the
//! call strip, with its own stop button.

#[tauri::command]
pub fn capture_bar_hide() {
    #[cfg(windows)]
    std::thread::spawn(imp::hide_for_a_while);
}

#[cfg(windows)]
mod imp {
    use std::{collections::HashSet, time::Duration};
    use windows::{
        Win32::{
            Foundation::{HWND, LPARAM},
            UI::WindowsAndMessaging::{
                EnumWindows, GetClassNameW, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible, SW_HIDE,
                ShowWindow,
            },
        },
        core::BOOL,
    };

    /// The bar appears a moment after getDisplayMedia resolves; keep looking
    /// for a few seconds and hide every instance (one per captured surface).
    pub fn hide_for_a_while() {
        let tree = crate::system_audio::imp::own_process_tree();
        for _ in 0..25 {
            hide_bars(&tree);
            std::thread::sleep(Duration::from_millis(200));
        }
    }

    fn hide_bars(tree: &HashSet<u32>) {
        unsafe extern "system" fn visit(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let tree = unsafe { &*(lparam.0 as *const HashSet<u32>) };
            let mut pid = 0u32;
            unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
            if tree.contains(&pid) && unsafe { IsWindowVisible(hwnd) }.as_bool() && is_capture_bar(hwnd) {
                let _ = unsafe { ShowWindow(hwnd, SW_HIDE) };
            }
            true.into()
        }
        let _ = unsafe { EnumWindows(Some(visit), LPARAM(tree as *const _ as isize)) };
    }

    /// Chromium's bar is a top-level Chrome widget titled with the
    /// notification text, which always names our origin (tauri.localhost).
    fn is_capture_bar(hwnd: HWND) -> bool {
        let mut buf = [0u16; 256];
        let n = unsafe { GetClassNameW(hwnd, &mut buf) } as usize;
        if String::from_utf16_lossy(&buf[..n]) != "Chrome_WidgetWin_1" {
            return false;
        }
        let n = unsafe { GetWindowTextW(hwnd, &mut buf) } as usize;
        String::from_utf16_lossy(&buf[..n]).contains("tauri.localhost")
    }
}
