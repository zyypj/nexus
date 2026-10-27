//! Attended Windows input. Global shortcuts, drag/held keys and clipboard are not supported.
//! Native enforcement is independent of React and of the requesting client.
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Capabilities {
    pub pointer: bool,
    pub click: bool,
    pub scroll: bool,
    pub text: bool,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Area {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
impl Area {
    fn valid(self) -> bool {
        [self.x, self.y, self.width, self.height].iter().all(|v| v.is_finite())
            && self.x >= 0.0
            && self.y >= 0.0
            && self.width > 0.0
            && self.height > 0.0
            && self.x + self.width <= 1.0
            && self.y + self.height <= 1.0
    }
    fn contains(self, x: f64, y: f64) -> bool {
        x.is_finite()
            && y.is_finite()
            && x >= self.x
            && y >= self.y
            && x < self.x + self.width
            && y < self.y + self.height
    }
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Input {
    Move { x: f64, y: f64 },
    Click { x: f64, y: f64, button: u8 },
    Scroll { x: f64, y: f64, delta: i32 },
    Text { text: String },
}

#[derive(Serialize)]
pub struct Status {
    pub active: bool,
    pub epoch: u64,
    pub paused_ms: u64,
}

fn pause_remaining(now: u64, last: u64) -> u64 {
    3000u64.saturating_sub(now.saturating_sub(last))
}

/// Packets carry the epoch of the owner's last heartbeat, which the server
/// learns one round trip after this device advances it. Accepting the current
/// and the previous epoch keeps in-flight packets from being dropped at every
/// heartbeat, while `floor` (the epoch right after the last local input or
/// revocation) still refuses anything sent before it.
fn epoch_accepted(epoch: u64, current: u64, floor: u64) -> bool {
    epoch >= floor && (epoch == current || epoch.wrapping_add(1) == current)
}

/// Tolerance between Windows recording an input and our hook running.
const INPUT_SLACK_MS: i32 = 50;

/// `GetLastInputInfo` saw input later than the last one our hooks observed
/// (both are `GetTickCount` values): some input bypassed the hooks, for
/// example because Windows removed a hook that timed out.
fn unseen_input(last_input: u32, observed: u32) -> bool {
    (last_input.wrapping_sub(observed) as i32) > INPUT_SLACK_MS
}

fn main_only(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Janela não autorizada.".into());
    }
    Ok(())
}

#[tauri::command]
pub fn remote_control_start(
    window: tauri::WebviewWindow,
    source_id: String,
    request_id: String,
    permissions: Capabilities,
    area: Area,
) -> Result<(), String> {
    main_only(&window)?;
    #[cfg(windows)]
    return imp::start(&source_id, request_id, permissions, area);
    #[cfg(not(windows))]
    Err("Controle disponível somente no Windows.".into())
}

#[tauri::command]
pub fn remote_control_status(window: tauri::WebviewWindow, renew: bool, advance: bool) -> Result<Status, String> {
    main_only(&window)?;
    #[cfg(windows)]
    {
        if advance {
            imp::advance_epoch();
        }
        imp::status(renew)
    }
    #[cfg(not(windows))]
    Ok(Status {
        active: false,
        epoch: 0,
        paused_ms: 0,
    })
}

#[tauri::command]
pub fn remote_control_input(
    window: tauri::WebviewWindow,
    request_id: String,
    epoch: u64,
    sequence: u64,
    input: Input,
) -> Result<bool, String> {
    main_only(&window)?;
    #[cfg(windows)]
    return imp::input(&request_id, epoch, sequence, input);
    #[cfg(not(windows))]
    Ok(false)
}

#[tauri::command]
pub fn remote_control_stop() {
    stop();
}

pub fn stop() {
    #[cfg(windows)]
    imp::stop();
}
pub fn capture_source(source: Option<String>) {
    #[cfg(windows)]
    imp::capture_source(source);
}

#[cfg(windows)]
pub(crate) mod imp {
    use super::*;
    use std::{
        ffi::c_void,
        mem::size_of,
        sync::{
            Mutex,
            atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
        },
        time::{Duration, Instant},
    };
    use windows::{
        Win32::{
            Foundation::{CloseHandle, FILETIME, HANDLE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
            Graphics::{
                Dwm::{DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute},
                Gdi::ClientToScreen,
            },
            Security::{GetTokenInformation, TOKEN_ELEVATION, TOKEN_QUERY, TokenElevation, TokenUIAccess},
            System::{
                LibraryLoader::GetModuleHandleW,
                StationsAndDesktops::{
                    CloseDesktop, DESKTOP_CONTROL_FLAGS, DESKTOP_READOBJECTS, GetUserObjectInformationW,
                    OpenInputDesktop, UOI_NAME,
                },
                SystemInformation::GetTickCount64,
                Threading::{
                    GetCurrentProcess, GetProcessTimes, OpenProcess, OpenProcessToken,
                    PROCESS_QUERY_LIMITED_INFORMATION,
                },
            },
            UI::{Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
        },
        core::w,
    };

    pub const MARKER: usize = 0x4E585243;
    pub static HOOKS_READY: AtomicBool = AtomicBool::new(false);
    static ACTIVE: AtomicBool = AtomicBool::new(false);
    static LAST_LOCAL: AtomicU64 = AtomicU64::new(0);
    static EPOCH: AtomicU64 = AtomicU64::new(1);
    /// Lowest epoch still accepted: set right after each local input and revocation.
    static FLOOR: AtomicU64 = AtomicU64::new(1);
    static REVOCATION: AtomicU64 = AtomicU64::new(1);
    pub static OBSERVED_INPUT: AtomicU32 = AtomicU32::new(0);
    static SOURCE: Mutex<Option<String>> = Mutex::new(None);
    static SESSION: Mutex<Option<Session>> = Mutex::new(None);
    struct Session {
        hwnd: isize,
        pid: u32,
        created: u64,
        request: String,
        permissions: Capabilities,
        area: Area,
        expires: Instant,
        lease: Instant,
        sequence: u64,
        generation: u64,
        /// Last full check of the target process (blocked apps, elevation, Nexus tree).
        checked: Instant,
    }
    /// The full process check is costly (it walks every process); in between,
    /// inputs only confirm that the window still belongs to the same process.
    const FULL_CHECK_EVERY: Duration = Duration::from_secs(1);
    fn ticks() -> u64 {
        unsafe { GetTickCount64() }
    }
    pub fn advance_epoch() {
        EPOCH.fetch_add(1, Ordering::SeqCst);
    }
    /// New epoch that nothing sent before it can use.
    fn raise_floor() {
        let epoch = EPOCH.fetch_add(1, Ordering::SeqCst) + 1;
        FLOOR.fetch_max(epoch, Ordering::SeqCst);
    }
    fn epoch_ok(epoch: u64) -> bool {
        epoch_accepted(epoch, EPOCH.load(Ordering::SeqCst), FLOOR.load(Ordering::SeqCst))
    }
    pub fn stop() {
        REVOCATION.fetch_add(1, Ordering::SeqCst);
        ACTIVE.store(false, Ordering::SeqCst);
        raise_floor();
    }
    pub fn capture_source(source: Option<String>) {
        let mut current = SOURCE.lock().unwrap_or_else(|e| e.into_inner());
        stop();
        *current = source;
    }

    // Called synchronously by the existing global hooks, before local input is dispatched.
    // No key content is stored. Injected input from OTHER programs also suspends control.
    pub fn local_input(escape: bool) {
        // Pause first: a check that reads the new epoch also sees the pause.
        LAST_LOCAL.store(ticks(), Ordering::SeqCst);
        raise_floor();
        if escape {
            stop();
        }
    }

    /// Every input event the hooks see (ours included), as a `GetTickCount` value.
    pub fn observe_input() {
        OBSERVED_INPUT.store(ticks() as u32, Ordering::SeqCst);
    }

    /// Same window, same process (PID + creation time): cheap enough per input.
    fn same_process(s: &Session) -> bool {
        unsafe {
            let window = hwnd(s);
            if !IsWindow(Some(window)).as_bool() || !IsWindowVisible(window).as_bool() || IsIconic(window).as_bool() {
                return false;
            }
            let mut pid = 0;
            GetWindowThreadProcessId(window, Some(&mut pid));
            if pid != s.pid {
                return false;
            }
            let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                return false;
            };
            let process = OwnedHandle(process);
            let (mut created, mut exit, mut kernel, mut user) = Default::default();
            GetProcessTimes(process.0, &mut created, &mut exit, &mut kernel, &mut user).is_ok()
                && filetime(created) == s.created
        }
    }
    fn filetime(t: FILETIME) -> u64 {
        ((t.dwHighDateTime as u64) << 32) | t.dwLowDateTime as u64
    }

    fn default_desktop() -> bool {
        unsafe {
            let Ok(desktop) = OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS) else {
                return false;
            };
            let mut name = [0u16; 64];
            let ok = GetUserObjectInformationW(
                HANDLE(desktop.0),
                UOI_NAME,
                Some(name.as_mut_ptr() as *mut c_void),
                (name.len() * 2) as u32,
                None,
            )
            .is_ok();
            let _ = CloseDesktop(desktop);
            ok && String::from_utf16_lossy(&name[..name.iter().position(|v| *v == 0).unwrap_or(name.len())])
                == "Default"
        }
    }

    struct OwnedHandle(HANDLE);
    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            let _ = unsafe { CloseHandle(self.0) };
        }
    }
    fn non_admin(process: HANDLE) -> Result<(), String> {
        unsafe {
            let mut token = HANDLE::default();
            OpenProcessToken(process, TOKEN_QUERY, &mut token).map_err(|e| e.to_string())?;
            let token = OwnedHandle(token);
            let mut needed = 0;
            let mut elevation = TOKEN_ELEVATION::default();
            GetTokenInformation(
                token.0,
                TokenElevation,
                Some(&mut elevation as *mut _ as *mut c_void),
                size_of::<TOKEN_ELEVATION>() as u32,
                &mut needed,
            )
            .map_err(|e| e.to_string())?;
            let mut ui_access = 0u32;
            GetTokenInformation(
                token.0,
                TokenUIAccess,
                Some(&mut ui_access as *mut _ as *mut c_void),
                4,
                &mut needed,
            )
            .map_err(|e| e.to_string())?;
            if elevation.TokenIsElevated != 0 || ui_access != 0 {
                return Err("Aplicativos administrativos ou com UIAccess estão bloqueados.".into());
            }
        }
        Ok(())
    }
    fn identity(hwnd: HWND) -> Result<(u32, u64), String> {
        unsafe {
            if !IsWindow(Some(hwnd)).as_bool() || !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
                return Err("Janela indisponível.".into());
            }
            let mut pid = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if crate::system_audio::imp::own_process_tree().contains(&pid) {
                return Err("O Nexus está sempre bloqueado.".into());
            }
            let name = crate::system_audio::imp::process_name(pid)
                .ok_or("Não foi possível verificar o aplicativo.")?
                .to_lowercase();
            // Defense in depth, not an application sandbox: renamed tools and actions inside an allowed app remain a risk.
            if [
                "taskmgr",
                "consent",
                "cmd",
                "powershell",
                "pwsh",
                "windowsterminal",
                "conhost",
                "regedit",
                "mmc",
                "control",
                "systemsettings",
                "explorer",
                "rundll32",
                "mshta",
                "wscript",
                "cscript",
                "computerdefaults",
                "utilman",
                "osk",
                "processhacker",
                "procexp",
                "procexp64",
            ]
            .contains(&name.trim_end_matches(".exe"))
            {
                return Err("Ferramentas do sistema e terminais estão bloqueados.".into());
            }
            let process =
                OwnedHandle(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).map_err(|e| e.to_string())?);
            non_admin(process.0)?;
            let mut created = FILETIME::default();
            let mut exit = FILETIME::default();
            let mut kernel = FILETIME::default();
            let mut user = FILETIME::default();
            GetProcessTimes(process.0, &mut created, &mut exit, &mut kernel, &mut user).map_err(|e| e.to_string())?;
            Ok((pid, filetime(created)))
        }
    }
    fn hwnd(s: &Session) -> HWND {
        HWND(s.hwnd as *mut c_void)
    }
    fn bounds(s: &Session) -> Option<RECT> {
        let mut r = RECT::default();
        unsafe {
            DwmGetWindowAttribute(
                hwnd(s),
                DWMWA_EXTENDED_FRAME_BOUNDS,
                &mut r as *mut _ as *mut c_void,
                size_of::<RECT>() as u32,
            )
            .ok()?;
        }
        (r.right > r.left && r.bottom > r.top).then_some(r)
    }
    fn point_allowed(s: &Session, p: POINT) -> bool {
        let Some(r) = bounds(s) else { return false };
        if !s.area.contains(
            (p.x - r.left) as f64 / (r.right - r.left) as f64,
            (p.y - r.top) as f64 / (r.bottom - r.top) as f64,
        ) {
            return false;
        }
        unsafe {
            let mut client = RECT::default();
            if GetClientRect(hwnd(s), &mut client).is_err() {
                return false;
            }
            let mut origin = POINT::default();
            if !ClientToScreen(hwnd(s), &mut origin).as_bool() {
                return false;
            }
            p.x >= origin.x
                && p.y >= origin.y
                && p.x < origin.x + client.right
                && p.y < origin.y + client.bottom
                && GetAncestor(WindowFromPoint(p), GA_ROOT) == hwnd(s)
        }
    }
    fn gate(s: &Session) -> bool {
        ACTIVE.load(Ordering::SeqCst) && HOOKS_READY.load(Ordering::SeqCst)
            && s.generation == REVOCATION.load(Ordering::SeqCst)
            && s.lease > Instant::now() && s.expires > Instant::now()
            && pause_remaining(ticks(), LAST_LOCAL.load(Ordering::SeqCst)) == 0
            && unsafe { GetForegroundWindow() } == hwnd(s)
            // Physical modifiers/buttons could turn a harmless click/text into a shortcut.
            && [VK_CONTROL, VK_MENU, VK_SHIFT, VK_LWIN, VK_RWIN].iter()
                .all(|k| unsafe { GetAsyncKeyState(k.0 as i32) } >= 0)
    }
    fn focus_allowed(s: &Session) -> bool {
        unsafe {
            let thread = GetWindowThreadProcessId(hwnd(s), None);
            let mut info = GUITHREADINFO {
                cbSize: size_of::<GUITHREADINFO>() as u32,
                ..Default::default()
            };
            if GetGUIThreadInfo(thread, &mut info).is_err() || GetAncestor(info.hwndFocus, GA_ROOT) != hwnd(s) {
                return false;
            }
            let mut rect = RECT::default();
            GetWindowRect(info.hwndFocus, &mut rect).is_ok()
                && point_allowed(
                    s,
                    POINT {
                        x: rect.left + 1,
                        y: rect.top + 1,
                    },
                )
                && point_allowed(
                    s,
                    POINT {
                        x: rect.right - 1,
                        y: rect.bottom - 1,
                    },
                )
        }
    }
    // Runs again on EACH injected event, closing the foreground/local-input race.
    pub fn injected_allowed(point: Option<POINT>) -> bool {
        let Ok(guard) = SESSION.try_lock() else { return false };
        let Some(s) = guard.as_ref() else { return false };
        gate(s)
            && point.map_or_else(
                || {
                    let mut p = POINT::default();
                    unsafe { GetCursorPos(&mut p) }.is_ok() && point_allowed(s, p) && focus_allowed(s)
                },
                |p| point_allowed(s, p),
            )
    }
    pub fn start(source_id: &str, request: String, permissions: Capabilities, area: Area) -> Result<(), String> {
        stop();
        let generation = REVOCATION.load(Ordering::SeqCst);
        if !area.valid() || request.is_empty() || request.len() > 128 || !HOOKS_READY.load(Ordering::SeqCst) {
            return Err("Proteções de entrada indisponíveis.".into());
        }
        // Serialize capture replacement against activation, including native Closed callbacks.
        let current_source = SOURCE.lock().map_err(|_| "Captura indisponível")?;
        if current_source.as_deref() != Some(source_id) {
            return Err("A janela precisa estar sendo compartilhada.".into());
        }
        let raw: isize = source_id
            .strip_prefix("window:")
            .ok_or("Compartilhe somente uma janela, nunca o monitor inteiro.")?
            .parse()
            .map_err(|_| "Janela inválida")?;
        let target = HWND(raw as *mut c_void);
        unsafe {
            non_admin(GetCurrentProcess())?;
        }
        if !default_desktop() {
            return Err("Área de trabalho protegida: controle bloqueado.".into());
        }
        let (pid, created) = identity(target)?;
        *SESSION.lock().map_err(|_| "Controle indisponível")? = Some(Session {
            hwnd: raw,
            pid,
            created,
            request,
            permissions,
            area,
            expires: Instant::now() + Duration::from_secs(300),
            lease: Instant::now() + Duration::from_secs(2),
            sequence: 0,
            generation,
            checked: Instant::now(),
        });
        LAST_LOCAL.store(ticks(), Ordering::SeqCst);
        ACTIVE.store(true, Ordering::SeqCst);
        drop(current_source);
        if generation != REVOCATION.load(Ordering::SeqCst) {
            stop();
            return Err("A autorização foi cancelada.".into());
        }
        if let Err(e) = show_bar(generation) {
            stop();
            return Err(e);
        }
        Ok(())
    }
    pub fn status(renew: bool) -> Result<Status, String> {
        let mut guard = SESSION.lock().map_err(|_| "Controle indisponível")?;
        if let Some(s) = guard.as_mut() {
            if s.lease <= Instant::now()
                || s.expires <= Instant::now()
                || s.generation != REVOCATION.load(Ordering::SeqCst)
            {
                stop();
            }
            if renew && ACTIVE.load(Ordering::SeqCst) {
                s.lease = Instant::now() + Duration::from_secs(2);
            }
        }
        Ok(Status {
            active: ACTIVE.load(Ordering::SeqCst),
            epoch: EPOCH.load(Ordering::SeqCst),
            paused_ms: pause_remaining(ticks(), LAST_LOCAL.load(Ordering::SeqCst)),
        })
    }
    pub fn input(request: &str, epoch: u64, sequence: u64, input: Input) -> Result<bool, String> {
        // Detect local input that a hook did not see (e.g. another desktop or a removed hook).
        let mut last = LASTINPUTINFO {
            cbSize: size_of::<LASTINPUTINFO>() as u32,
            ..Default::default()
        };
        if !unsafe { GetLastInputInfo(&mut last) }.as_bool()
            || unseen_input(last.dwTime, OBSERVED_INPUT.load(Ordering::SeqCst))
        {
            local_input(false);
            return Ok(false);
        }
        if !default_desktop() {
            stop();
            return Ok(false);
        }
        let events = {
            let mut guard = SESSION.lock().map_err(|_| "Controle indisponível")?;
            let Some(s) = guard.as_mut() else { return Ok(false) };
            if request != s.request || sequence <= s.sequence {
                return Ok(false);
            }
            s.sequence = sequence; // Consume rejected packets too. Never replay queued input after local activity.
            if !epoch_ok(epoch)
                || [VK_LBUTTON, VK_RBUTTON]
                    .iter()
                    .any(|k| unsafe { GetAsyncKeyState(k.0 as i32) } < 0)
                || !gate(s)
            {
                return Ok(false);
            }
            if s.checked.elapsed() >= FULL_CHECK_EVERY {
                if identity(hwnd(s))? != (s.pid, s.created) {
                    stop();
                    return Ok(false);
                }
                s.checked = Instant::now();
            } else if !same_process(s) {
                stop();
                return Ok(false);
            }
            let mouse = |flags, data, dx, dy| INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 {
                    mi: MOUSEINPUT {
                        dx,
                        dy,
                        mouseData: data,
                        dwFlags: flags,
                        time: 0,
                        dwExtraInfo: MARKER,
                    },
                },
            };
            match input {
                Input::Text { text } => {
                    if !s.permissions.text || text.is_empty() || text.len() > 64 || text.chars().any(char::is_control) {
                        return Ok(false);
                    }
                    let mut p = POINT::default();
                    if unsafe { GetCursorPos(&mut p) }.is_err() || !point_allowed(s, p) {
                        return Ok(false);
                    }
                    if !focus_allowed(s) {
                        return Ok(false);
                    }
                    text.encode_utf16()
                        .flat_map(|unit| {
                            [KEYEVENTF_UNICODE, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP].map(|flags| INPUT {
                                r#type: INPUT_KEYBOARD,
                                Anonymous: INPUT_0 {
                                    ki: KEYBDINPUT {
                                        wVk: VIRTUAL_KEY(0),
                                        wScan: unit,
                                        dwFlags: flags,
                                        time: 0,
                                        dwExtraInfo: MARKER,
                                    },
                                },
                            })
                        })
                        .collect::<Vec<_>>()
                }
                other => {
                    let (x, y, allowed) = match &other {
                        Input::Move { x, y } => (*x, *y, s.permissions.pointer),
                        // Left button only: a right click opens a menu, a separate
                        // window the guard refuses, and leaves it open on the owner's screen.
                        Input::Click { x, y, button } => (*x, *y, s.permissions.click && *button == 0),
                        Input::Scroll { x, y, delta } => (*x, *y, s.permissions.scroll && delta.abs_diff(0) <= 480),
                        _ => unreachable!(),
                    };
                    if !allowed || !s.area.contains(x, y) {
                        return Ok(false);
                    }
                    let Some(r) = bounds(s) else { return Ok(false) };
                    let p = POINT {
                        x: r.left + (x * (r.right - r.left) as f64) as i32,
                        y: r.top + (y * (r.bottom - r.top) as f64) as i32,
                    };
                    if !point_allowed(s, p) {
                        return Ok(false);
                    }
                    let vx = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) };
                    let vy = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) };
                    let vw = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) };
                    let vh = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) };
                    if vw <= 1 || vh <= 1 {
                        return Ok(false);
                    }
                    let mut events = vec![mouse(
                        MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
                        0,
                        ((p.x - vx) as i64 * 65535 / (vw - 1) as i64) as i32,
                        ((p.y - vy) as i64 * 65535 / (vh - 1) as i64) as i32,
                    )];
                    match other {
                        Input::Click { .. } => {
                            events.push(mouse(MOUSEEVENTF_LEFTDOWN, 0, 0, 0));
                            events.push(mouse(MOUSEEVENTF_LEFTUP, 0, 0, 0));
                        }
                        Input::Scroll { delta, .. } => events.push(mouse(MOUSEEVENTF_WHEEL, delta as u32, 0, 0)),
                        _ => {}
                    }
                    events
                }
            }
        }; // Release lock before SendInput: the hooks synchronously recheck it.
        if !epoch_ok(epoch) {
            return Ok(false);
        }
        let sent = unsafe { SendInput(&events, size_of::<INPUT>() as i32) };
        if sent != events.len() as u32 {
            stop();
            // A partially inserted batch must not leave a button or Unicode packet held.
            // The hooks allow these releases even after revocation.
            let releases = emergency_releases(&events[..(sent as usize).min(events.len())]);
            if !releases.is_empty() {
                unsafe { SendInput(&releases, size_of::<INPUT>() as i32) };
            }
            return Err("O Windows bloqueou a entrada. Controle encerrado.".into());
        }
        Ok(true)
    }

    fn emergency_releases(inserted: &[INPUT]) -> Vec<INPUT> {
        let mut releases = Vec::new();
        for event in inserted {
            let mut release = *event;
            unsafe {
                if event.r#type == INPUT_KEYBOARD
                    && event.Anonymous.ki.dwFlags & KEYEVENTF_KEYUP == KEYBD_EVENT_FLAGS(0)
                {
                    release.Anonymous.ki.dwFlags |= KEYEVENTF_KEYUP;
                    releases.push(release);
                } else if event.r#type == INPUT_MOUSE {
                    let flags = event.Anonymous.mi.dwFlags;
                    let up = if flags & MOUSEEVENTF_LEFTDOWN != MOUSE_EVENT_FLAGS(0) {
                        MOUSEEVENTF_LEFTUP
                    } else if flags & MOUSEEVENTF_RIGHTDOWN != MOUSE_EVENT_FLAGS(0) {
                        MOUSEEVENTF_RIGHTUP
                    } else {
                        continue;
                    };
                    release.Anonymous.mi.dwFlags = up;
                    release.Anonymous.mi.dx = 0;
                    release.Anonymous.mi.dy = 0;
                    releases.push(release);
                }
            }
        }
        releases
    }

    fn show_bar(generation: u64) -> Result<(), String> {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || unsafe {
            let result = (|| -> Result<HWND, String> {
                let instance = GetModuleHandleW(None).map_err(|e| e.to_string())?;
                let class = w!("NexusAttendedControl");
                let wc = WNDCLASSW {
                    lpfnWndProc: Some(bar_proc),
                    hInstance: instance.into(),
                    lpszClassName: class,
                    ..Default::default()
                };
                RegisterClassW(&wc);
                let window = CreateWindowExW(
                    WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
                    class,
                    w!("CONTROLE REMOTO ATIVO — Esc encerra"),
                    WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_VISIBLE,
                    20,
                    20,
                    540,
                    90,
                    None,
                    None,
                    Some(instance.into()),
                    None,
                )
                .map_err(|e| e.to_string())?;
                CreateWindowExW(
                    WINDOW_EX_STYLE::default(),
                    w!("BUTTON"),
                    w!("ENCERRAR CONTROLE AGORA (Esc)"),
                    WS_CHILD | WS_VISIBLE,
                    8,
                    8,
                    500,
                    28,
                    Some(window),
                    None,
                    Some(instance.into()),
                    None,
                )
                .map_err(|e| e.to_string())?;
                SetWindowLongPtrW(window, GWLP_USERDATA, generation as isize);
                if SetTimer(Some(window), 1, 100, None) == 0 {
                    let _ = DestroyWindow(window);
                    return Err("Temporizador de emergência indisponível.".into());
                }
                Ok(window)
            })();
            let ok = result.is_ok();
            if tx.send(result.map(|_| ())).is_err() {
                stop();
            }
            if ok {
                let mut msg = MSG::default();
                while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
        });
        rx.recv_timeout(Duration::from_secs(1))
            .map_err(|_| "Não foi possível mostrar o botão de emergência.".to_string())?
    }
    unsafe extern "system" fn bar_proc(window: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
        match msg {
            WM_COMMAND | WM_CLOSE => {
                stop();
                let _ = unsafe { DestroyWindow(window) };
                LRESULT(0)
            }
            WM_TIMER => {
                let live = unsafe { GetWindowLongPtrW(window, GWLP_USERDATA) } as u64
                    == REVOCATION.load(Ordering::SeqCst)
                    && status(false).is_ok_and(|s| s.active);
                if !live {
                    let _ = unsafe { DestroyWindow(window) };
                } else {
                    let paused = ticks().saturating_sub(LAST_LOCAL.load(Ordering::SeqCst)) < 3000;
                    let title = if paused {
                        w!("CONTROLE PAUSADO — você tem prioridade por 3 segundos")
                    } else {
                        w!("CONTROLE REMOTO ATIVO — Esc encerra")
                    };
                    let _ = unsafe { SetWindowTextW(window, title) };
                }
                LRESULT(0)
            }
            WM_DESTROY => {
                unsafe { PostQuitMessage(0) };
                LRESULT(0)
            }
            _ => unsafe { DefWindowProcW(window, msg, wp, lp) },
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn a_stop_during_activation_cannot_revive_the_old_grant() {
            let generation = REVOCATION.load(Ordering::SeqCst);
            stop();
            *SESSION.lock().unwrap() = Some(Session {
                hwnd: 0,
                pid: 0,
                created: 0,
                request: "test".into(),
                permissions: Capabilities::default(),
                area: Area {
                    x: 0.0,
                    y: 0.0,
                    width: 1.0,
                    height: 1.0,
                },
                expires: Instant::now() + Duration::from_secs(300),
                lease: Instant::now() + Duration::from_secs(2),
                sequence: 0,
                generation,
                checked: Instant::now(),
            });
            ACTIVE.store(true, Ordering::SeqCst); // Simulate a stale activation finishing after cancellation.
            assert!(!status(true).unwrap().active);
            *SESSION.lock().unwrap() = None;
        }
        #[test]
        fn partial_input_cleanup_only_releases_never_moves_or_presses() {
            let events = [
                INPUT {
                    r#type: INPUT_MOUSE,
                    Anonymous: INPUT_0 {
                        mi: MOUSEINPUT {
                            dwFlags: MOUSEEVENTF_LEFTDOWN,
                            dwExtraInfo: MARKER,
                            ..Default::default()
                        },
                    },
                },
                INPUT {
                    r#type: INPUT_MOUSE,
                    Anonymous: INPUT_0 {
                        mi: MOUSEINPUT {
                            dwFlags: MOUSEEVENTF_MOVE,
                            dx: 50,
                            ..Default::default()
                        },
                    },
                },
            ];
            let cleanup = emergency_releases(&events);
            assert_eq!(cleanup.len(), 1);
            unsafe {
                assert_eq!(cleanup[0].Anonymous.mi.dwFlags, MOUSEEVENTF_LEFTUP);
                assert_eq!(cleanup[0].Anonymous.mi.dx, 0);
            }
            assert!(emergency_releases(&[]).is_empty());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn area_rejects_escape_and_non_finite_values() {
        let a = Area {
            x: 0.2,
            y: 0.1,
            width: 0.5,
            height: 0.6,
        };
        assert!(a.valid());
        assert!(a.contains(0.3, 0.3));
        assert!(!a.contains(0.1, 0.3));
        assert!(!a.contains(f64::NAN, 0.3));
        assert!(
            !Area {
                width: f64::INFINITY,
                ..a
            }
            .valid()
        );
        assert!(!Area { width: 0.9, ..a }.valid());
    }
    #[test]
    fn heartbeat_epochs_keep_in_flight_packets_but_never_older_than_local_input() {
        // Heartbeat advanced 5 -> 6 while packets stamped 5 were on their way.
        assert!(epoch_accepted(6, 6, 1));
        assert!(epoch_accepted(5, 6, 1));
        assert!(!epoch_accepted(4, 6, 1), "two heartbeats old");
        assert!(!epoch_accepted(7, 6, 1), "from the future");
        // Local input raised the floor to 6: packets stamped 5 predate it.
        assert!(!epoch_accepted(5, 6, 6));
        assert!(epoch_accepted(6, 7, 6));
    }
    #[test]
    fn input_the_hooks_did_not_see_is_detected_across_tick_wraparound() {
        assert!(!unseen_input(1_000, 1_000));
        assert!(!unseen_input(1_000, 1_020), "hook ran after Windows recorded it");
        assert!(!unseen_input(1_040, 1_000), "within the slack");
        assert!(unseen_input(1_200, 1_000));
        assert!(unseen_input(100, u32::MAX - 100), "tick count wrapped");
        assert!(!unseen_input(u32::MAX - 10, 5), "observed after a wrap");
    }
    #[test]
    fn owner_priority_lasts_three_seconds_from_the_latest_input() {
        assert_eq!(pause_remaining(10_000, 10_000), 3000);
        assert_eq!(pause_remaining(12_999, 10_000), 1);
        assert_eq!(pause_remaining(13_000, 10_000), 0);
        assert_eq!(pause_remaining(13_000, 12_500), 2500);
    }
}
