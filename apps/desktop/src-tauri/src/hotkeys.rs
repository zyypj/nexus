//! Global hotkeys (push-to-talk, mute, deafen, camera) that work while Nexus
//! is minimized or a game has focus.
//!
//! Uses low-level keyboard/mouse hooks instead of `RegisterHotKey` because:
//! - we need key *release* events for push-to-talk;
//! - `RegisterHotKey` swallows the key, so a PTT key could not be used in-game;
//! - mouse side buttons (very common PTT binds) are supported.
//!
//! The hooks never consume input (always `CallNextHookEx`). The callback only
//! compares a handful of integers and forwards matches through a channel.
//! Limitation: Windows does not deliver input from elevated (admin) windows
//! to a non-elevated hook (UIPI).

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Binding {
    pub action: String,
    /// Windows virtual-key code (mouse buttons: 0x04 middle, 0x05/0x06 side buttons).
    pub code: u32,
    #[serde(default)]
    pub ctrl: bool,
    #[serde(default)]
    pub alt: bool,
    #[serde(default)]
    pub shift: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct HotkeyEvent {
    pub action: String,
    pub pressed: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct CapturedKey {
    pub code: u32,
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub name: String,
}

#[cfg(windows)]
mod imp {
    use std::sync::{
        Mutex, OnceLock, RwLock,
        atomic::{AtomicBool, AtomicU32, Ordering},
        mpsc,
    };

    use windows::Win32::{
        Foundation::{LPARAM, LRESULT, WPARAM},
        System::LibraryLoader::GetModuleHandleW,
        UI::{
            Input::KeyboardAndMouse::{GetKeyNameTextW, MAPVK_VK_TO_VSC, MapVirtualKeyW},
            WindowsAndMessaging::{
                CallNextHookEx, DispatchMessageW, GetMessageW, HC_ACTION, KBDLLHOOKSTRUCT, MSG, MSLLHOOKSTRUCT,
                SetWindowsHookExW, TranslateMessage, WH_KEYBOARD_LL, WH_MOUSE_LL, WM_KEYDOWN, WM_KEYUP, WM_MBUTTONDOWN,
                WM_MBUTTONUP, WM_SYSKEYDOWN, WM_SYSKEYUP, WM_XBUTTONDOWN, WM_XBUTTONUP,
            },
        },
    };

    use super::{Binding, CapturedKey, HotkeyEvent};

    pub enum Signal {
        Hotkey(HotkeyEvent),
        Captured(CapturedKey),
    }

    static BINDINGS: RwLock<Vec<Binding>> = RwLock::new(Vec::new());
    static SENDER: OnceLock<Mutex<mpsc::Sender<Signal>>> = OnceLock::new();
    static CAPTURE: AtomicBool = AtomicBool::new(false);
    /// Bit 0 ctrl, 1 alt, 2 shift.
    static MODS: AtomicU32 = AtomicU32::new(0);
    /// Bindings currently held down (index bitmap; at most 32 bindings).
    static ACTIVE: AtomicU32 = AtomicU32::new(0);

    /// VK_CONTROL/VK_MENU/VK_SHIFT and their left/right variants.
    fn modifier_bit(vk: u32) -> u32 {
        match vk {
            0x11 | 0xA2 | 0xA3 => 1,
            0x12 | 0xA4 | 0xA5 => 2,
            0x10 | 0xA0 | 0xA1 => 4,
            _ => 0,
        }
    }

    fn send(sig: Signal) {
        if let Some(tx) = SENDER.get()
            && let Ok(tx) = tx.lock()
        {
            let _ = tx.send(sig);
        }
    }

    pub fn key_name(code: u32) -> String {
        match code {
            0x04 => return "Mouse 3".into(),
            0x05 => return "Mouse 4".into(),
            0x06 => return "Mouse 5".into(),
            _ => {}
        }
        let scan = unsafe { MapVirtualKeyW(code, MAPVK_VK_TO_VSC) };
        let mut lparam = (scan as i32) << 16;
        // Extended keys (arrows, ins/del, home/end...) need bit 24 for the right name.
        if matches!(code, 0x21..=0x2E | 0x5B | 0x5C | 0x6F | 0x90) {
            lparam |= 1 << 24;
        }
        let mut buf = [0u16; 64];
        let len = unsafe { GetKeyNameTextW(lparam, &mut buf) };
        if len > 0 {
            String::from_utf16_lossy(&buf[..len as usize])
        } else {
            format!("Key {code:#04x}")
        }
    }

    fn handle(code: u32, down: bool) {
        let bit = modifier_bit(code);
        if bit != 0 {
            if down {
                MODS.fetch_or(bit, Ordering::Relaxed);
            } else {
                MODS.fetch_and(!bit, Ordering::Relaxed);
            }
        }

        if CAPTURE.load(Ordering::Relaxed) {
            // Modifiers alone are not a binding; wait for the main key.
            if down && bit == 0 {
                CAPTURE.store(false, Ordering::Relaxed);
                let mods = MODS.load(Ordering::Relaxed);
                send(Signal::Captured(CapturedKey {
                    code,
                    ctrl: mods & 1 != 0,
                    alt: mods & 2 != 0,
                    shift: mods & 4 != 0,
                    name: key_name(code),
                }));
            }
            return;
        }

        let Ok(bindings) = BINDINGS.try_read() else { return };
        let mods = MODS.load(Ordering::Relaxed);
        for (i, b) in bindings.iter().enumerate().take(32) {
            let mask = 1u32 << i;
            if b.code != code {
                continue;
            }
            let active = ACTIVE.load(Ordering::Relaxed) & mask != 0;
            if down {
                // Required modifiers must be held; extra ones are fine (Shift+PTT while running in a game).
                let ok = (!b.ctrl || mods & 1 != 0) && (!b.alt || mods & 2 != 0) && (!b.shift || mods & 4 != 0);
                if ok && !active {
                    ACTIVE.fetch_or(mask, Ordering::Relaxed);
                    send(Signal::Hotkey(HotkeyEvent {
                        action: b.action.clone(),
                        pressed: true,
                    }));
                }
            } else if active {
                ACTIVE.fetch_and(!mask, Ordering::Relaxed);
                send(Signal::Hotkey(HotkeyEvent {
                    action: b.action.clone(),
                    pressed: false,
                }));
            }
        }
    }

    unsafe extern "system" fn keyboard_proc(n_code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if n_code == HC_ACTION as i32 {
            let info = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
            let msg = wparam.0 as u32;
            let down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
            let up = msg == WM_KEYUP || msg == WM_SYSKEYUP;
            if down || up {
                handle(info.vkCode, down);
            }
        }
        unsafe { CallNextHookEx(None, n_code, wparam, lparam) }
    }

    unsafe extern "system" fn mouse_proc(n_code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if n_code == HC_ACTION as i32 {
            let msg = wparam.0 as u32;
            match msg {
                WM_MBUTTONDOWN | WM_MBUTTONUP => handle(0x04, msg == WM_MBUTTONDOWN),
                WM_XBUTTONDOWN | WM_XBUTTONUP => {
                    let info = unsafe { &*(lparam.0 as *const MSLLHOOKSTRUCT) };
                    let button = (info.mouseData >> 16) & 0xFFFF;
                    let code = if button == 1 { 0x05 } else { 0x06 };
                    handle(code, msg == WM_XBUTTONDOWN);
                }
                _ => {}
            }
        }
        unsafe { CallNextHookEx(None, n_code, wparam, lparam) }
    }

    /// Starts the hook thread once; returns the receiver for hotkey signals.
    pub fn start() -> Option<mpsc::Receiver<Signal>> {
        let (tx, rx) = mpsc::channel();
        if SENDER.set(Mutex::new(tx)).is_err() {
            return None;
        }
        std::thread::Builder::new()
            .name("nexus-hotkeys".into())
            .spawn(|| unsafe {
                let module = GetModuleHandleW(None).ok();
                let hinstance = module.map(|m| m.into());
                let kb = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), hinstance, 0);
                let ms = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), hinstance, 0);
                if kb.is_err() || ms.is_err() {
                    eprintln!("nexus: failed to install input hooks: {kb:?} {ms:?}");
                }
                // LL hooks are serviced by this thread's message loop.
                let mut msg = MSG::default();
                while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            })
            .ok()?;
        Some(rx)
    }

    pub fn set_bindings(bindings: Vec<Binding>) {
        if let Ok(mut b) = BINDINGS.write() {
            *b = bindings.into_iter().take(32).collect();
        }
        ACTIVE.store(0, Ordering::Relaxed);
    }

    pub fn capture() {
        CAPTURE.store(true, Ordering::Relaxed);
    }

    pub fn cancel_capture() {
        CAPTURE.store(false, Ordering::Relaxed);
    }
}

#[cfg(windows)]
pub use imp::Signal;

use tauri::{AppHandle, Emitter};

pub fn start(app: AppHandle) {
    #[cfg(windows)]
    if let Some(rx) = imp::start() {
        std::thread::Builder::new()
            .name("nexus-hotkey-events".into())
            .spawn(move || {
                while let Ok(sig) = rx.recv() {
                    match sig {
                        Signal::Hotkey(ev) => {
                            let _ = app.emit("hotkey", ev);
                        }
                        Signal::Captured(key) => {
                            let _ = app.emit("hotkey-captured", key);
                        }
                    }
                }
            })
            .ok();
    }
    #[cfg(not(windows))]
    let _ = app;
}

#[tauri::command]
pub fn hotkeys_set(bindings: Vec<Binding>) {
    #[cfg(windows)]
    imp::set_bindings(bindings);
    #[cfg(not(windows))]
    let _ = bindings;
}

#[tauri::command]
pub fn hotkeys_capture(enable: bool) {
    #[cfg(windows)]
    if enable {
        imp::capture()
    } else {
        imp::cancel_capture()
    }
    #[cfg(not(windows))]
    let _ = enable;
}

#[tauri::command]
pub fn hotkey_name(code: u32) -> String {
    #[cfg(windows)]
    return imp::key_name(code);
    #[cfg(not(windows))]
    format!("Key {code}")
}
