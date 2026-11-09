//! Attended Windows input. Mouse gestures and key presses are bounded batches.
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
#[serde(deny_unknown_fields)]
pub struct ControlPoint {
    x: f64,
    y: f64,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Input {
    Move { x: f64, y: f64 },
    Click { x: f64, y: f64, button: u8 },
    Drag { from: ControlPoint, to: ControlPoint },
    Scroll { x: f64, y: f64, delta: i32 },
    Text { text: String },
    Key { key: String },
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
                Gdi::{ClientToScreen, GetMonitorInfoW, HMONITOR, MONITORINFO, MONITORINFOEXW},
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
    static SOURCE: Mutex<Option<SharedSource>> = Mutex::new(None);
    static SESSION: Mutex<Option<Session>> = Mutex::new(None);
    // A concurrent request must not change the route while Windows checks a batch.
    static INJECTION: Mutex<()> = Mutex::new(());
    static BATCH_CANCELLED: AtomicBool = AtomicBool::new(false);

    #[derive(Clone, Copy)]
    struct WindowTarget {
        handle: isize,
        pid: u32,
        created: u64,
    }
    impl WindowTarget {
        fn hwnd(self) -> HWND {
            HWND(self.handle as *mut c_void)
        }
    }

    #[derive(Clone, Copy, PartialEq)]
    struct MonitorTarget {
        handle: isize,
        rect: RECT,
        device: [u16; 32],
    }

    struct SharedSource {
        id: String,
        monitor: Option<MonitorTarget>,
    }

    struct InputRoute {
        window: WindowTarget,
        points: Vec<POINT>,
        epoch: u64,
        foreground: bool,
    }

    enum Scope {
        Window(WindowTarget),
        Monitor(MonitorTarget),
    }

    struct Session {
        scope: Scope,
        input_route: Option<InputRoute>,
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
        *current = source.map(|id| {
            let monitor = id
                .strip_prefix("screen:")
                .and_then(|raw| raw.parse().ok())
                .and_then(monitor);
            SharedSource { id, monitor }
        });
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
    fn same_process(target: WindowTarget) -> bool {
        unsafe {
            let window = target.hwnd();
            if !IsWindow(Some(window)).as_bool() || !IsWindowVisible(window).as_bool() || IsIconic(window).as_bool() {
                return false;
            }
            let mut pid = 0;
            GetWindowThreadProcessId(window, Some(&mut pid));
            if pid != target.pid {
                return false;
            }
            let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                return false;
            };
            let process = OwnedHandle(process);
            let (mut created, mut exit, mut kernel, mut user) = Default::default();
            GetProcessTimes(process.0, &mut created, &mut exit, &mut kernel, &mut user).is_ok()
                && filetime(created) == target.created
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
    fn identity(hwnd: HWND) -> Result<WindowTarget, String> {
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
                "shellexperiencehost",
                "startmenuexperiencehost",
                "searchhost",
                "textinputhost",
                "credentialuibroker",
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
            Ok(WindowTarget {
                handle: hwnd.0 as isize,
                pid,
                created: filetime(created),
            })
        }
    }

    fn monitor(handle: isize) -> Option<MonitorTarget> {
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = size_of::<MONITORINFOEXW>() as u32;
        unsafe {
            GetMonitorInfoW(HMONITOR(handle as *mut c_void), &mut info as *mut _ as *mut MONITORINFO)
                .as_bool()
                .then_some(MonitorTarget {
                    handle,
                    rect: info.monitorInfo.rcMonitor,
                    device: info.szDevice,
                })
        }
    }

    fn bounds(s: &Session) -> Option<RECT> {
        let r = match s.scope {
            Scope::Window(target) => {
                let mut rect = RECT::default();
                unsafe {
                    DwmGetWindowAttribute(
                        target.hwnd(),
                        DWMWA_EXTENDED_FRAME_BOUNDS,
                        &mut rect as *mut _ as *mut c_void,
                        size_of::<RECT>() as u32,
                    )
                    .ok()?;
                }
                rect
            }
            Scope::Monitor(target) => (monitor(target.handle) == Some(target)).then_some(target.rect)?,
        };
        (r.right > r.left && r.bottom > r.top).then_some(r)
    }

    fn in_area(s: &Session, p: POINT) -> bool {
        let Some(r) = bounds(s) else { return false };
        s.area.contains(
            (p.x - r.left) as f64 / (r.right - r.left) as f64,
            (p.y - r.top) as f64 / (r.bottom - r.top) as f64,
        )
    }

    fn belongs_to(target: WindowTarget, child: HWND) -> bool {
        let mut pid = 0;
        unsafe {
            GetWindowThreadProcessId(child, Some(&mut pid));
        }
        pid == target.pid && unsafe { GetAncestor(child, GA_ROOT) } == target.hwnd()
    }

    fn point_allowed(s: &Session, target: WindowTarget, p: POINT) -> bool {
        if !in_area(s, p) {
            return false;
        }
        unsafe {
            let mut client = RECT::default();
            if GetClientRect(target.hwnd(), &mut client).is_err() {
                return false;
            }
            let mut origin = POINT::default();
            if !ClientToScreen(target.hwnd(), &mut origin).as_bool() {
                return false;
            }
            p.x >= origin.x
                && p.y >= origin.y
                && p.x < origin.x + client.right
                && p.y < origin.y + client.bottom
                && belongs_to(target, WindowFromPoint(p))
        }
    }
    fn gate(s: &Session) -> bool {
        ACTIVE.load(Ordering::SeqCst) && HOOKS_READY.load(Ordering::SeqCst)
            && s.generation == REVOCATION.load(Ordering::SeqCst)
            && s.lease > Instant::now() && s.expires > Instant::now()
            && pause_remaining(ticks(), LAST_LOCAL.load(Ordering::SeqCst)) == 0
            // Physical modifiers/buttons could turn a harmless click/text into a shortcut.
            && [VK_CONTROL, VK_MENU, VK_SHIFT, VK_LWIN, VK_RWIN].iter()
                .all(|k| unsafe { GetAsyncKeyState(k.0 as i32) } >= 0)
    }
    fn focus_allowed(s: &Session, target: WindowTarget) -> bool {
        unsafe {
            let thread = GetWindowThreadProcessId(target.hwnd(), None);
            let mut info = GUITHREADINFO {
                cbSize: size_of::<GUITHREADINFO>() as u32,
                ..Default::default()
            };
            if GetGUIThreadInfo(thread, &mut info).is_err() || !belongs_to(target, info.hwndFocus) {
                return false;
            }
            if belongs_to(target, info.hwndCaret) {
                let mut caret = POINT {
                    x: info.rcCaret.left,
                    y: info.rcCaret.top,
                };
                return ClientToScreen(info.hwndCaret, &mut caret).as_bool() && in_area(s, caret);
            }
            // A top-level window can own keyboard focus. Use the client area,
            // excluding borders and title bar, when the app has no native caret.
            let mut rect = RECT::default();
            let mut origin = POINT::default();
            GetClientRect(info.hwndFocus, &mut rect).is_ok()
                && rect.right > 0
                && rect.bottom > 0
                && ClientToScreen(info.hwndFocus, &mut origin).as_bool()
                && in_area(s, origin)
                && in_area(
                    s,
                    POINT {
                        x: origin.x + rect.right - 1,
                        y: origin.y + rect.bottom - 1,
                    },
                )
        }
    }

    fn window_class(hwnd: HWND, name: &str) -> bool {
        let mut class = [0u16; 32];
        let len = unsafe { GetClassNameW(hwnd, &mut class) } as usize;
        len > 0 && name.encode_utf16().eq(class[..len].iter().copied())
    }

    fn monitor_window(hwnd: HWND) -> bool {
        // Route application menus through their real owner. Dialogs and
        // arbitrary owned windows do not become new destinations.
        unsafe {
            IsWindow(Some(hwnd)).as_bool()
                && !window_class(hwnd, "#32768")
                && !window_class(hwnd, "#32770")
                && GetWindow(hwnd, GW_OWNER).is_err()
        }
    }

    fn foreground_info() -> Option<GUITHREADINFO> {
        let mut info = GUITHREADINFO {
            cbSize: size_of::<GUITHREADINFO>() as u32,
            ..Default::default()
        };
        unsafe {
            GetGUIThreadInfo(0, &mut info).ok()?;
        }
        Some(info)
    }

    fn is_application_menu(info: &GUITHREADINFO) -> bool {
        (info.flags & (GUI_INMENUMODE | GUI_POPUPMENUMODE)).0 != 0 && (info.flags & GUI_SYSTEMMENUMODE).0 == 0
    }

    fn menu_belongs_to(window: HWND, target: WindowTarget) -> bool {
        let mut pid = 0;
        unsafe {
            GetWindowThreadProcessId(window, Some(&mut pid));
        }
        pid == target.pid && window_class(window, "#32768")
    }

    fn route_allowed(s: &Session, route: &InputRoute, point: Option<POINT>) -> bool {
        let target = route.window;
        if !epoch_ok(route.epoch) || (matches!(s.scope, Scope::Monitor(_)) && !monitor_window(target.hwnd())) {
            return false;
        }
        let Some(info) = foreground_info() else { return false };
        if (info.flags & (GUI_SYSTEMMENUMODE | GUI_INMOVESIZE)).0 != 0 {
            return false;
        }
        let menu = is_application_menu(&info);
        if (menu && !belongs_to(target, info.hwndMenuOwner))
            || (!info.hwndCapture.0.is_null()
                && !belongs_to(target, info.hwndCapture)
                && !(menu && menu_belongs_to(info.hwndCapture, target)))
            || (route.foreground && unsafe { GetForegroundWindow() } != target.hwnd())
        {
            return false;
        }
        match point {
            Some(p) if menu => in_area(s, p) && menu_belongs_to(unsafe { WindowFromPoint(p) }, target),
            Some(p) => point_allowed(s, target, p),
            None => !menu && focus_allowed(s, target),
        }
    }

    fn destination_root(point: Option<POINT>) -> HWND {
        let Some(point) = point else {
            return unsafe { GetForegroundWindow() };
        };
        let hit = unsafe { WindowFromPoint(point) };
        if window_class(hit, "#32768") {
            let Some(info) = foreground_info().filter(is_application_menu) else {
                return HWND::default();
            };
            return unsafe { GetAncestor(info.hwndMenuOwner, GA_ROOT) };
        }
        unsafe { GetAncestor(hit, GA_ROOT) }
    }

    fn authorize_destination(s: &mut Session, point: Option<POINT>, epoch: u64, foreground: bool) -> Option<()> {
        if point.is_some_and(|point| !in_area(s, point)) {
            return None;
        }
        let (window, fresh) = match s.scope {
            Scope::Window(target) => (target, false),
            Scope::Monitor(_) => {
                let root = destination_root(point);
                if !monitor_window(root) {
                    return None;
                }
                let cached = s.input_route.as_ref().map(|route| route.window).filter(|target| {
                    target.hwnd() == root && s.checked.elapsed() < FULL_CHECK_EVERY && same_process(*target)
                });
                if let Some(target) = cached {
                    (target, false)
                } else {
                    (identity(root).ok()?, true)
                }
            }
        };
        let route = InputRoute {
            window,
            points: point.into_iter().collect(),
            epoch,
            foreground,
        };
        if !route_allowed(s, &route, point) {
            return None;
        }
        if fresh {
            s.checked = Instant::now();
        }
        s.input_route = Some(route);
        Some(())
    }

    // Cancel the rest of the batch when a destination changes. The hooks
    // still pass paired key/button releases so no input can stay held.
    pub fn injected_allowed(point: Option<POINT>) -> bool {
        if BATCH_CANCELLED.load(Ordering::SeqCst) {
            return false;
        }
        let allowed = check_injected_destination(point);
        if !allowed {
            BATCH_CANCELLED.store(true, Ordering::SeqCst);
        }
        allowed
    }

    fn check_injected_destination(point: Option<POINT>) -> bool {
        let Ok(guard) = SESSION.try_lock() else { return false };
        let Some(s) = guard.as_ref() else { return false };
        let Some(route) = &s.input_route else { return false };
        gate(s)
            && point.map_or(route.points.is_empty(), |p| {
                route
                    .points
                    .iter()
                    .any(|q| p.x.abs_diff(q.x) <= 1 && p.y.abs_diff(q.y) <= 1)
            })
            && route_allowed(s, route, point)
    }
    pub fn start(source_id: &str, request: String, permissions: Capabilities, area: Area) -> Result<(), String> {
        stop();
        let generation = REVOCATION.load(Ordering::SeqCst);
        if !area.valid() || request.is_empty() || request.len() > 128 || !HOOKS_READY.load(Ordering::SeqCst) {
            return Err("Proteções de entrada indisponíveis.".into());
        }
        // Serialize capture replacement against activation, including native Closed callbacks.
        let current_source = SOURCE.lock().map_err(|_| "Captura indisponível")?;
        let source = current_source
            .as_ref()
            .filter(|source| source.id == source_id)
            .ok_or("A tela ou janela precisa estar sendo compartilhada.")?;
        let (kind, handle) = source_id.split_once(':').ok_or("Fonte inválida.")?;
        let raw = handle.parse::<isize>().map_err(|_| "Fonte inválida.")?;
        unsafe {
            non_admin(GetCurrentProcess())?;
        }
        if !default_desktop() {
            return Err("Área de trabalho protegida: controle bloqueado.".into());
        }
        let scope = match kind {
            "window" => Scope::Window(identity(HWND(raw as *mut c_void))?),
            "screen" => Scope::Monitor(
                source
                    .monitor
                    .filter(|target| monitor(raw) == Some(*target))
                    .ok_or("A configuração da tela mudou. Compartilhe a tela novamente.")?,
            ),
            _ => return Err("Fonte inválida.".into()),
        };
        *SESSION.lock().map_err(|_| "Controle indisponível")? = Some(Session {
            scope,
            input_route: None,
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
                || (matches!(s.scope, Scope::Monitor(_)) && bounds(s).is_none())
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

    fn mouse(flags: MOUSE_EVENT_FLAGS, data: u32, dx: i32, dy: i32) -> INPUT {
        INPUT {
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
        }
    }

    fn mouse_move(point: POINT) -> Option<INPUT> {
        let (left, top, width, height) = unsafe {
            (
                GetSystemMetrics(SM_XVIRTUALSCREEN),
                GetSystemMetrics(SM_YVIRTUALSCREEN),
                GetSystemMetrics(SM_CXVIRTUALSCREEN),
                GetSystemMetrics(SM_CYVIRTUALSCREEN),
            )
        };
        let (x, y) = (point.x - left, point.y - top);
        if !(0..width).contains(&x) || !(0..height).contains(&y) {
            return None;
        }
        let absolute =
            |value: i32, span: i32| ((i64::from(value) * 65536 + i64::from(span) - 1) / i64::from(span)) as i32;
        Some(mouse(
            MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK | MOUSEEVENTF_MOVE_NOCOALESCE,
            0,
            absolute(x, width),
            absolute(y, height),
        ))
    }

    fn screen_point(s: &Session, x: f64, y: f64) -> Option<POINT> {
        if !s.area.contains(x, y) {
            return None;
        }
        let r = bounds(s)?;
        Some(POINT {
            x: r.left + (x * (r.right - r.left) as f64) as i32,
            y: r.top + (y * (r.bottom - r.top) as f64) as i32,
        })
    }

    fn keyboard_pair(key: VIRTUAL_KEY, scan: u16, flags: KEYBD_EVENT_FLAGS) -> [INPUT; 2] {
        [flags, flags | KEYEVENTF_KEYUP].map(|dw_flags| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: key,
                    wScan: scan,
                    dwFlags: dw_flags,
                    time: 0,
                    dwExtraInfo: MARKER,
                },
            },
        })
    }

    fn editing_key(name: &str) -> Option<[INPUT; 2]> {
        let (key, extended) = match name {
            "Enter" => (VK_RETURN, false),
            "Tab" => (VK_TAB, false),
            "Backspace" => (VK_BACK, false),
            "Delete" => (VK_DELETE, true),
            "ArrowUp" => (VK_UP, true),
            "ArrowDown" => (VK_DOWN, true),
            "ArrowLeft" => (VK_LEFT, true),
            "ArrowRight" => (VK_RIGHT, true),
            "Home" => (VK_HOME, true),
            "End" => (VK_END, true),
            "PageUp" => (VK_PRIOR, true),
            "PageDown" => (VK_NEXT, true),
            _ => return None,
        };
        Some(keyboard_pair(
            key,
            0,
            if extended {
                KEYEVENTF_EXTENDEDKEY
            } else {
                KEYBD_EVENT_FLAGS(0)
            },
        ))
    }

    fn drag_events(s: &mut Session, from: ControlPoint, to: ControlPoint, epoch: u64) -> Option<Vec<INPUT>> {
        let start = screen_point(s, from.x, from.y)?;
        let end = screen_point(s, to.x, to.y)?;
        authorize_destination(s, Some(start), epoch, false)?;
        let route = s.input_route.as_ref()?;
        // Verify the complete path before pressing the button. One batch always
        // includes its release, even if a hook rejects an intermediate move.
        const STEPS: i32 = 12;
        let path = (0..=STEPS)
            .map(|step| POINT {
                x: start.x + (end.x - start.x) * step / STEPS,
                y: start.y + (end.y - start.y) * step / STEPS,
            })
            .collect::<Vec<_>>();
        if !path
            .iter()
            .all(|point| point_allowed(s, route.window, *point) && route_allowed(s, route, Some(*point)))
        {
            return None;
        }
        let mut events = path.iter().copied().map(mouse_move).collect::<Option<Vec<_>>>()?;
        events.insert(1, mouse(MOUSEEVENTF_LEFTDOWN, 0, 0, 0));
        events.push(mouse(MOUSEEVENTF_LEFTUP, 0, 0, 0));
        s.input_route.as_mut()?.points = path;
        Some(events)
    }

    pub fn input(request: &str, epoch: u64, sequence: u64, input: Input) -> Result<bool, String> {
        let Ok(_injection) = INJECTION.try_lock() else {
            return Ok(false);
        };
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
            if let Scope::Window(target) = s.scope {
                if s.checked.elapsed() >= FULL_CHECK_EVERY {
                    let current = identity(target.hwnd())?;
                    if current.pid != target.pid || current.created != target.created {
                        stop();
                        return Ok(false);
                    }
                    s.checked = Instant::now();
                } else if !same_process(target) {
                    stop();
                    return Ok(false);
                }
            }
            match input {
                Input::Text { text } => {
                    if !s.permissions.text || text.is_empty() || text.len() > 64 || text.chars().any(char::is_control) {
                        return Ok(false);
                    }
                    if authorize_destination(s, None, epoch, true).is_none() {
                        return Ok(false);
                    }
                    text.encode_utf16()
                        .flat_map(|unit| keyboard_pair(VIRTUAL_KEY(0), unit, KEYEVENTF_UNICODE))
                        .collect::<Vec<_>>()
                }
                Input::Key { key } => {
                    let Some(events) = editing_key(&key) else {
                        return Ok(false);
                    };
                    if !s.permissions.text || authorize_destination(s, None, epoch, true).is_none() {
                        return Ok(false);
                    }
                    events.to_vec()
                }
                Input::Drag { from, to } => {
                    if !s.permissions.pointer || !s.permissions.click {
                        return Ok(false);
                    }
                    let Some(events) = drag_events(s, from, to, epoch) else {
                        return Ok(false);
                    };
                    events
                }
                other => {
                    let (x, y, allowed) = match &other {
                        Input::Move { x, y } => (*x, *y, s.permissions.pointer),
                        Input::Click { x, y, button } => (*x, *y, s.permissions.click && *button <= 1),
                        Input::Scroll { x, y, delta } => (*x, *y, s.permissions.scroll && delta.abs_diff(0) <= 480),
                        _ => unreachable!(),
                    };
                    if !allowed {
                        return Ok(false);
                    }
                    let Some(p) = screen_point(s, x, y) else {
                        return Ok(false);
                    };
                    if authorize_destination(s, Some(p), epoch, matches!(other, Input::Scroll { .. })).is_none() {
                        return Ok(false);
                    }
                    let Some(movement) = mouse_move(p) else {
                        return Ok(false);
                    };
                    let mut events = vec![movement];
                    match other {
                        Input::Click { button, .. } => {
                            let (down, up) = if button == 0 {
                                (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP)
                            } else {
                                (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP)
                            };
                            events.push(mouse(down, 0, 0, 0));
                            events.push(mouse(up, 0, 0, 0));
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
        BATCH_CANCELLED.store(false, Ordering::SeqCst);
        let sent = unsafe { SendInput(&events, size_of::<INPUT>() as i32) };
        if sent != events.len() as u32 {
            stop();
            // A partially inserted batch must not leave a button or key held.
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
                    WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
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
                scope: Scope::Window(WindowTarget {
                    handle: 0,
                    pid: 0,
                    created: 0,
                }),
                input_route: None,
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
