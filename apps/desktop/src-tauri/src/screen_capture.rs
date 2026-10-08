//! Native screen/window capture for screen sharing (Discord-style picker).
//!
//! Instead of getDisplayMedia (whose WebView2 picker asks again after our own
//! dialog and shows a "<origin> is sharing your screen" bar), Nexus lists the
//! monitors and windows itself (with thumbnails) and captures the chosen one
//! with Windows.Graphics.Capture:
//!
//! 1. frames arrive as D3D11 textures; large sources are halved on the GPU
//!    with a mip chain until they are just above the target size;
//! 2. the result is read back once and written into WebView2 shared memory
//!    (`ICoreWebView2SharedBuffer`, 3 slots), so no pixels go through IPC;
//! 3. a tiny channel message tells the page which slot is ready; the page
//!    wraps it in a `VideoFrame` and feeds a `MediaStreamTrackGenerator` that
//!    LiveKit publishes (final scaling is done by the WebRTC encoder).
//!
//! Slot header (16 bytes, little endian): u32 state (0 free / 1 ready, the
//! page writes 0 after copying), u32 width, u32 height, u32 reserved.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{State, WebviewWindow, ipc::Channel};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSource {
    pub id: String,
    pub kind: &'static str,
    pub name: String,
    /// Executable name (windows only).
    pub app: Option<String>,
    /// Owning process (windows only), used to share that app's audio.
    pub pid: Option<u32>,
    /// Small JPEG data URL.
    pub thumbnail: Option<String>,
    pub width: i32,
    pub height: i32,
    pub primary: bool,
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct CaptureTarget {
    pub fps: u32,
    pub max_width: u32,
    pub max_height: u32,
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CaptureEvent {
    #[serde(rename_all = "camelCase")]
    Frame {
        generation: u32,
        slot: u32,
        width: u32,
        height: u32,
        timestamp: u64,
    },
    /// The captured window was closed (or the monitor went away).
    Closed,
}

#[derive(Default)]
pub struct CaptureState(Mutex<Option<imp::Running>>);

#[tauri::command]
pub fn capture_supported() -> bool {
    #[cfg(windows)]
    return imp::supported();
    #[cfg(not(windows))]
    false
}

#[tauri::command]
pub async fn capture_sources() -> Result<Vec<CaptureSource>, String> {
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(imp::list_sources)
        .await
        .map_err(|e| e.to_string())?;
    #[cfg(not(windows))]
    Err("not supported".into())
}

#[tauri::command]
pub async fn capture_start(
    window: WebviewWindow,
    state: State<'_, CaptureState>,
    source_id: String,
    cursor: bool,
    target: CaptureTarget,
    channel: Channel<CaptureEvent>,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        let old = state.0.lock().map_err(|e| e.to_string())?.take();
        if let Some(old) = old {
            old.stop();
        }
        let running = tauri::async_runtime::spawn_blocking(move || {
            imp::Running::start(window, &source_id, cursor, target, channel)
        })
        .await
        .map_err(|e| e.to_string())??;
        *state.0.lock().map_err(|e| e.to_string())? = Some(running);
        Ok(())
    }
    #[cfg(not(windows))]
    Err("not supported".into())
}

#[tauri::command]
pub fn capture_configure(state: State<'_, CaptureState>, target: CaptureTarget) -> Result<(), String> {
    if let Some(r) = state.0.lock().map_err(|e| e.to_string())?.as_ref() {
        r.configure(target);
    }
    Ok(())
}

#[tauri::command]
pub fn capture_stop(state: State<'_, CaptureState>) -> Result<(), String> {
    if let Some(r) = state.0.lock().map_err(|e| e.to_string())?.take() {
        r.stop();
    }
    Ok(())
}

#[cfg(not(windows))]
mod imp {
    pub struct Running;
    impl Running {
        pub fn configure(&self, _: super::CaptureTarget) {}
        pub fn stop(self) {}
    }
}

#[cfg(windows)]
mod imp {
    use super::{CaptureEvent, CaptureSource, CaptureTarget};
    use base64::Engine;
    use std::{
        ffi::c_void,
        sync::{
            Arc, Mutex,
            atomic::{AtomicU32, Ordering},
        },
        time::{Duration, Instant},
    };
    use tauri::{WebviewWindow, ipc::Channel};
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_WRITE, ICoreWebView2_17, ICoreWebView2Environment12,
        ICoreWebView2SharedBuffer,
    };
    use windows::{
        Foundation::{TimeSpan, TypedEventHandler},
        Graphics::{
            Capture::{
                Direct3D11CaptureFramePool, GraphicsCaptureAccess, GraphicsCaptureAccessKind, GraphicsCaptureItem,
                GraphicsCaptureSession,
            },
            DirectX::{Direct3D11::IDirect3DDevice, DirectXPixelFormat},
            SizeInt32,
        },
        Win32::{
            Foundation::{HMODULE, HWND, LPARAM, RECT},
            Graphics::{
                Direct3D::D3D_DRIVER_TYPE_HARDWARE,
                Direct3D11::{
                    D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_BOX, D3D11_CPU_ACCESS_READ,
                    D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAP_READ, D3D11_MAPPED_SUBRESOURCE,
                    D3D11_RESOURCE_MISC_GENERATE_MIPS, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
                    D3D11_USAGE_STAGING, D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext,
                    ID3D11ShaderResourceView, ID3D11Texture2D,
                },
                Dwm::{DWMWA_CLOAKED, DwmGetWindowAttribute},
                Dxgi::{Common::DXGI_FORMAT_B8G8R8A8_UNORM, Common::DXGI_SAMPLE_DESC, IDXGIDevice},
                Gdi::{
                    BI_RGB, BITMAPINFO, BITMAPINFOHEADER, CreateCompatibleBitmap, CreateCompatibleDC, DIB_RGB_COLORS,
                    DeleteDC, DeleteObject, EnumDisplayMonitors, GetDC, GetDIBits, GetMonitorInfoW, HALFTONE, HDC,
                    HMONITOR, MONITORINFO, MONITORINFOEXW, ReleaseDC, SRCCOPY, SelectObject, SetBrushOrgEx,
                    SetStretchBltMode, StretchBlt,
                },
            },
            Storage::Xps::{PRINT_WINDOW_FLAGS, PrintWindow},
            System::WinRT::{
                Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess},
                Graphics::Capture::IGraphicsCaptureItemInterop,
            },
            UI::WindowsAndMessaging::{
                EnumWindows, GW_OWNER, GWL_EXSTYLE, GetClassNameW, GetWindow, GetWindowLongW, GetWindowRect,
                GetWindowTextW, GetWindowThreadProcessId, IsHungAppWindow, IsIconic, IsWindowVisible, WS_EX_TOOLWINDOW,
            },
        },
        core::{BOOL, IInspectable, Interface, PCWSTR},
    };

    const SLOTS: u32 = 3;
    const HEADER: usize = 16;
    const THUMB_WIDTH: i32 = 320;

    pub fn supported() -> bool {
        GraphicsCaptureSession::IsSupported().unwrap_or(false)
    }

    // ---------------------------------------------------------------- sources

    pub fn list_sources() -> Result<Vec<CaptureSource>, String> {
        let mut out = monitors();
        out.extend(windows());
        Ok(out)
    }

    fn monitors() -> Vec<CaptureSource> {
        unsafe extern "system" fn visit(m: HMONITOR, _: HDC, _: *mut RECT, data: LPARAM) -> BOOL {
            let list = unsafe { &mut *(data.0 as *mut Vec<(HMONITOR, RECT, bool)>) };
            let mut info = MONITORINFOEXW::default();
            info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
            if unsafe { GetMonitorInfoW(m, &mut info as *mut _ as *mut MONITORINFO) }.as_bool() {
                list.push((m, info.monitorInfo.rcMonitor, info.monitorInfo.dwFlags & 1 == 1));
            }
            true.into()
        }
        let mut found: Vec<(HMONITOR, RECT, bool)> = Vec::new();
        unsafe {
            let _ = EnumDisplayMonitors(None, None, Some(visit), LPARAM(&mut found as *mut _ as isize));
        }
        found.sort_by_key(|(_, r, primary)| (!primary, r.left, r.top));
        let screen = unsafe { GetDC(None) };
        let list = found
            .iter()
            .enumerate()
            .map(|(i, (m, r, primary))| {
                let (w, h) = (r.right - r.left, r.bottom - r.top);
                CaptureSource {
                    id: format!("screen:{}", m.0 as isize),
                    kind: "screen",
                    name: if found.len() == 1 {
                        "Tela inteira".into()
                    } else {
                        format!("Tela {}", i + 1)
                    },
                    app: None,
                    pid: None,
                    thumbnail: unsafe { thumbnail(screen, r.left, r.top, w, h) },
                    width: w,
                    height: h,
                    primary: *primary,
                }
            })
            .collect();
        unsafe { ReleaseDC(None, screen) };
        list
    }

    fn windows() -> Vec<CaptureSource> {
        unsafe extern "system" fn visit(hwnd: HWND, data: LPARAM) -> BOOL {
            unsafe { (*(data.0 as *mut Vec<HWND>)).push(hwnd) };
            true.into()
        }
        let mut handles: Vec<HWND> = Vec::new();
        unsafe {
            let _ = EnumWindows(Some(visit), LPARAM(&mut handles as *mut _ as isize));
        }
        let own = crate::system_audio::imp::own_process_tree();
        let screen = unsafe { GetDC(None) };
        let mut out = Vec::new();
        for hwnd in handles {
            let Some((pid, title, rect)) = shareable(hwnd, &own) else {
                continue;
            };
            let (w, h) = (rect.right - rect.left, rect.bottom - rect.top);
            let thumbnail = if unsafe { IsHungAppWindow(hwnd) }.as_bool() {
                None
            } else {
                unsafe { window_thumbnail(screen, hwnd, w, h) }
            };
            out.push(CaptureSource {
                id: format!("window:{}", hwnd.0 as isize),
                kind: "window",
                name: title,
                app: crate::system_audio::imp::process_name(pid),
                pid: Some(pid),
                thumbnail,
                width: w,
                height: h,
                primary: false,
            });
        }
        unsafe { ReleaseDC(None, screen) };
        out
    }

    /// Top-level, visible, titled application windows of other processes.
    fn shareable(hwnd: HWND, own: &std::collections::HashSet<u32>) -> Option<(u32, String, RECT)> {
        unsafe {
            if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
                return None;
            }
            if GetWindow(hwnd, GW_OWNER).is_ok_and(|o| !o.is_invalid()) {
                return None;
            }
            if GetWindowLongW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW.0 != 0 {
                return None;
            }
            let mut cloaked = 0u32;
            if DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut cloaked as *mut _ as *mut c_void, 4).is_ok()
                && cloaked != 0
            {
                return None;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if own.contains(&pid) {
                return None;
            }
            let mut buf = [0u16; 256];
            let n = GetClassNameW(hwnd, &mut buf) as usize;
            let class = String::from_utf16_lossy(&buf[..n]);
            if matches!(
                class.as_str(),
                "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd"
            ) {
                return None;
            }
            let mut title = [0u16; 512];
            let n = GetWindowTextW(hwnd, &mut title) as usize;
            let title = String::from_utf16_lossy(&title[..n]).trim().to_string();
            if title.is_empty() {
                return None;
            }
            let mut rect = RECT::default();
            GetWindowRect(hwnd, &mut rect).ok()?;
            if rect.right - rect.left < 80 || rect.bottom - rect.top < 60 {
                return None;
            }
            Some((pid, title, rect))
        }
    }

    unsafe fn window_thumbnail(screen: HDC, hwnd: HWND, w: i32, h: i32) -> Option<String> {
        unsafe {
            let mem = CreateCompatibleDC(Some(screen));
            let bmp = CreateCompatibleBitmap(screen, w, h);
            let old = SelectObject(mem, bmp.into());
            // PW_RENDERFULLCONTENT: also works for GPU-rendered windows.
            let ok = PrintWindow(hwnd, mem, PRINT_WINDOW_FLAGS(2)).as_bool();
            let thumb = if ok { thumbnail(mem, 0, 0, w, h) } else { None };
            SelectObject(mem, old);
            let _ = DeleteObject(bmp.into());
            let _ = DeleteDC(mem);
            thumb
        }
    }

    /// Scales a region of `src` down to THUMB_WIDTH and encodes it as JPEG.
    unsafe fn thumbnail(src: HDC, x: i32, y: i32, w: i32, h: i32) -> Option<String> {
        if w <= 0 || h <= 0 {
            return None;
        }
        let tw = THUMB_WIDTH;
        let th = (h * tw / w).clamp(1, 400);
        let mut pixels = vec![0u8; (tw * th * 4) as usize];
        unsafe {
            let mem = CreateCompatibleDC(Some(src));
            let bmp = CreateCompatibleBitmap(src, tw, th);
            let old = SelectObject(mem, bmp.into());
            SetStretchBltMode(mem, HALFTONE);
            let _ = SetBrushOrgEx(mem, 0, 0, None);
            let _ = StretchBlt(mem, 0, 0, tw, th, Some(src), x, y, w, h, SRCCOPY);
            SelectObject(mem, old);
            let mut info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: tw,
                    biHeight: -th, // top-down
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let lines = GetDIBits(
                mem,
                bmp,
                0,
                th as u32,
                Some(pixels.as_mut_ptr() as *mut c_void),
                &mut info,
                DIB_RGB_COLORS,
            );
            let _ = DeleteObject(bmp.into());
            let _ = DeleteDC(mem);
            if lines == 0 {
                return None;
            }
        }
        let mut jpeg = Vec::new();
        jpeg_encoder::Encoder::new(&mut jpeg, 72)
            .encode(&pixels, tw as u16, th as u16, jpeg_encoder::ColorType::Bgra)
            .ok()?;
        Some(format!(
            "data:image/jpeg;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(jpeg)
        ))
    }

    // ---------------------------------------------------------------- capture

    /// Shared-memory slots handed to the page. The COM objects may only be
    /// touched on the WebView2 (main) thread; the capture thread only uses the
    /// raw pointers, which stay valid until the buffers are closed.
    struct Ring {
        generation: u32,
        capacity: usize,
        ptrs: Vec<usize>,
    }

    struct SendBuffer(ICoreWebView2SharedBuffer);
    // SAFETY: only created, used and closed inside `with_webview` callbacks,
    // which run on the WebView2 UI thread.
    unsafe impl Send for SendBuffer {}

    static BUFFERS: Mutex<Vec<SendBuffer>> = Mutex::new(Vec::new());
    static GENERATION: AtomicU32 = AtomicU32::new(0);

    struct Pipeline {
        device: ID3D11Device,
        ctx: ID3D11DeviceContext,
        winrt_device: IDirect3DDevice,
        pool: Direct3D11CaptureFramePool,
        pool_size: SizeInt32,
        mips: Option<(ID3D11Texture2D, ID3D11ShaderResourceView, u32, u32, u32)>,
        staging: Option<(ID3D11Texture2D, u32, u32)>,
        target: CaptureTarget,
        last_frame: Option<Instant>,
        ring: Option<Ring>,
        allocating: bool,
        /// None in the probe (examples/capture_probe.rs): plain memory instead
        /// of WebView2 shared buffers, slots released right away.
        window: Option<WebviewWindow>,
        local: Vec<Vec<u8>>,
        sink: Sink,
        stopped: bool,
    }

    pub type Sink = Box<dyn Fn(CaptureEvent) + Send>;

    // SAFETY: D3D11 devices/contexts are free-threaded here (the immediate
    // context is only used under the pipeline mutex) and the WinRT capture
    // objects are agile.
    unsafe impl Send for Pipeline {}

    pub struct Running {
        pipeline: Arc<Mutex<Pipeline>>,
        session: GraphicsCaptureSession,
    }

    // SAFETY: GraphicsCaptureSession is an agile WinRT object.
    unsafe impl Send for Running {}

    fn err(e: impl std::fmt::Display) -> String {
        e.to_string()
    }

    impl Running {
        pub fn start(
            window: WebviewWindow,
            source_id: &str,
            cursor: bool,
            target: CaptureTarget,
            channel: Channel<CaptureEvent>,
        ) -> Result<Running, String> {
            let sink: Sink = Box::new(move |e| {
                let _ = channel.send(e);
            });
            Self::start_with(Some(window), source_id, cursor, target, sink)
        }

        pub fn start_with(
            window: Option<WebviewWindow>,
            source_id: &str,
            cursor: bool,
            target: CaptureTarget,
            sink: Sink,
        ) -> Result<Running, String> {
            let (kind, raw) = source_id.split_once(':').ok_or("bad source id")?;
            let raw: isize = raw.parse().map_err(err)?;
            let interop = windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>().map_err(err)?;
            let item: GraphicsCaptureItem = unsafe {
                match kind {
                    "screen" => interop.CreateForMonitor(HMONITOR(raw as *mut c_void)),
                    "window" => interop.CreateForWindow(HWND(raw as *mut c_void)),
                    _ => return Err("bad source id".into()),
                }
            }
            .map_err(|e| format!("Não foi possível capturar esta fonte: {e}"))?;

            let mut device = None;
            let mut ctx = None;
            unsafe {
                D3D11CreateDevice(
                    None,
                    D3D_DRIVER_TYPE_HARDWARE,
                    HMODULE::default(),
                    D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                    None,
                    D3D11_SDK_VERSION,
                    Some(&mut device),
                    None,
                    Some(&mut ctx),
                )
                .map_err(err)?;
            }
            let device: ID3D11Device = device.ok_or("no D3D11 device")?;
            let ctx: ID3D11DeviceContext = ctx.ok_or("no D3D11 context")?;
            let dxgi: IDXGIDevice = device.cast().map_err(err)?;
            let winrt_device: IDirect3DDevice = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi) }
                .map_err(err)?
                .cast()
                .map_err(err)?;

            let size = item.Size().map_err(err)?;
            let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
                &winrt_device,
                DirectXPixelFormat::B8G8R8A8UIntNormalized,
                2,
                size,
            )
            .map_err(err)?;
            let session = pool.CreateCaptureSession(&item).map_err(err)?;
            let _ = session.SetIsCursorCaptureEnabled(cursor);
            // Borderless capture (Windows 11): no yellow frame around the source.
            if let Ok(op) = GraphicsCaptureAccess::RequestAccessAsync(GraphicsCaptureAccessKind::Borderless) {
                let _ = op.join();
            }
            let _ = session.SetIsBorderRequired(false);
            let _ = session.SetMinUpdateInterval(timespan(interval(target.fps)));

            let pipeline = Arc::new(Mutex::new(Pipeline {
                device,
                ctx,
                winrt_device,
                pool: pool.clone(),
                pool_size: size,
                mips: None,
                staging: None,
                target,
                last_frame: None,
                ring: None,
                allocating: false,
                window,
                local: Vec::new(),
                sink,
                stopped: false,
            }));

            let p = Arc::clone(&pipeline);
            pool.FrameArrived(&TypedEventHandler::<Direct3D11CaptureFramePool, IInspectable>::new(
                move |_, _| {
                    Pipeline::on_frame(&p);
                    Ok(())
                },
            ))
            .map_err(err)?;
            let p = Arc::clone(&pipeline);
            item.Closed(&TypedEventHandler::<GraphicsCaptureItem, IInspectable>::new(
                move |_, _| {
                    if let Ok(p) = p.lock() {
                        (p.sink)(CaptureEvent::Closed);
                    }
                    Ok(())
                },
            ))
            .map_err(err)?;
            // Buffers before the first frame (25% headroom for window
            // growth): a static screen may not send another one for a while.
            {
                let (_, w, h) = output_size(size.Width as u32, size.Height as u32, target);
                let (tx, rx) = std::sync::mpsc::channel();
                if let Ok(mut p) = pipeline.lock() {
                    Pipeline::request_buffers(&pipeline, &mut p, slot_bytes(w, h) * 5 / 4, Some(tx));
                }
                let _ = rx.recv_timeout(Duration::from_secs(3));
            }
            session.StartCapture().map_err(err)?;
            Ok(Running { pipeline, session })
        }

        /// Probe only: pixels (BGRA) of a slot written by the pipeline.
        pub fn local_frame(&self) -> Option<(u32, u32, Vec<u8>)> {
            let p = self.pipeline.lock().ok()?;
            p.local.iter().find_map(|b| {
                let w = u32::from_le_bytes(b[4..8].try_into().ok()?);
                let h = u32::from_le_bytes(b[8..12].try_into().ok()?);
                (w > 0).then(|| (w, h, b[HEADER..HEADER + (w * h * 4) as usize].to_vec()))
            })
        }

        pub fn configure(&self, target: CaptureTarget) {
            if let Ok(mut p) = self.pipeline.lock() {
                p.target = target;
            }
            let _ = self.session.SetMinUpdateInterval(timespan(interval(target.fps)));
        }

        pub fn stop(self) {
            let window = {
                let mut p = match self.pipeline.lock() {
                    Ok(p) => p,
                    Err(e) => e.into_inner(),
                };
                p.stopped = true;
                let _ = p.pool.Close();
                p.ring = None;
                p.window.clone()
            };
            let _ = self.session.Close();
            if let Some(window) = window {
                close_buffers(&window);
            }
        }
    }

    /// Mip level and output size: halve on the GPU while the result still
    /// covers the target (the encoder does the final scaling).
    fn output_size(w0: u32, h0: u32, target: CaptureTarget) -> (u32, u32, u32) {
        let mut level = 0u32;
        while level < 4 && (w0 >> (level + 1)) >= target.max_width && (h0 >> (level + 1)) >= target.max_height {
            level += 1;
        }
        (level, (w0 >> level).max(2) & !1, (h0 >> level).max(2) & !1)
    }

    fn slot_bytes(w: u32, h: u32) -> usize {
        HEADER + (w * h * 4) as usize
    }

    fn interval(fps: u32) -> Duration {
        Duration::from_micros(1_000_000 / u64::from(fps.clamp(1, 120)))
    }

    fn timespan(d: Duration) -> TimeSpan {
        TimeSpan {
            Duration: (d.as_nanos() / 100) as i64,
        }
    }

    fn close_buffers(window: &WebviewWindow) {
        let _ = window.with_webview(|_| {
            if let Ok(mut list) = BUFFERS.lock() {
                for b in list.drain(..) {
                    let _ = unsafe { b.0.Close() };
                }
            }
        });
    }

    impl Pipeline {
        fn on_frame(this: &Arc<Mutex<Pipeline>>) {
            let Ok(mut p) = this.lock() else { return };
            if p.stopped {
                return;
            }
            let Ok(frame) = p.pool.TryGetNextFrame() else { return };
            let result = p.process(&frame);
            let _ = frame.Close();
            if let Err(Need::Buffers(bytes)) = result {
                Self::request_buffers(this, &mut p, bytes, None);
            }
        }

        /// Gets a ring of at least `bytes` per slot: plain memory in the probe,
        /// WebView2 shared buffers (created on the UI thread) otherwise.
        fn request_buffers(
            this: &Arc<Mutex<Pipeline>>,
            p: &mut Pipeline,
            bytes: usize,
            done: Option<std::sync::mpsc::Sender<()>>,
        ) {
            if p.allocating {
                return;
            }
            match p.window.clone() {
                Some(window) => {
                    p.allocating = true;
                    allocate(Arc::clone(this), window, bytes, done);
                }
                None => {
                    p.local = (0..SLOTS).map(|_| vec![0u8; bytes]).collect();
                    let ptrs = p.local.iter_mut().map(|b| b.as_mut_ptr() as usize).collect();
                    p.ring = Some(Ring {
                        generation: 0,
                        capacity: bytes,
                        ptrs,
                    });
                    if let Some(done) = done {
                        let _ = done.send(());
                    }
                }
            }
        }

        fn process(&mut self, frame: &windows::Graphics::Capture::Direct3D11CaptureFrame) -> Result<(), Need> {
            let now = Instant::now();
            if let Some(last) = self.last_frame
                && now.duration_since(last) < interval(self.target.fps).mul_f32(0.9)
            {
                return Ok(());
            }
            let size = frame.ContentSize().map_err(|_| Need::Skip)?;
            if size.Width <= 0 || size.Height <= 0 {
                return Ok(());
            }
            if size != self.pool_size {
                // Window resized: new buffers at the new size, skip this frame.
                self.pool_size = size;
                let _ = self
                    .pool
                    .Recreate(&self.winrt_device, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, size);
                return Ok(());
            }
            let texture: ID3D11Texture2D = frame
                .Surface()
                .and_then(|s| s.cast::<IDirect3DDxgiInterfaceAccess>())
                .and_then(|a| unsafe { a.GetInterface() })
                .map_err(|_| Need::Skip)?;
            let mut desc = D3D11_TEXTURE2D_DESC::default();
            unsafe { texture.GetDesc(&mut desc) };
            let w0 = (size.Width as u32).min(desc.Width);
            let h0 = (size.Height as u32).min(desc.Height);

            let (level, w, h) = output_size(w0, h0, self.target);
            let need = slot_bytes(w, h);
            let (slot, ptr, generation) = match &self.ring {
                Some(r) if r.capacity >= need => {
                    let free = r
                        .ptrs
                        .iter()
                        .enumerate()
                        .find(|(_, p)| unsafe { &*(**p as *const AtomicU32) }.load(Ordering::Acquire) == 0);
                    match free {
                        Some((i, p)) => (i as u32, *p, r.generation),
                        // The page is still copying every slot: drop this frame.
                        None => return Ok(()),
                    }
                }
                _ => return Err(Need::Buffers(need * 5 / 4)),
            };
            self.last_frame = Some(now);

            let src_box = D3D11_BOX {
                left: 0,
                top: 0,
                front: 0,
                right: w0,
                bottom: h0,
                back: 1,
            };
            let staging = self.staging(w, h).map_err(|_| Need::Skip)?;
            unsafe {
                if level == 0 {
                    self.ctx
                        .CopySubresourceRegion(&staging, 0, 0, 0, 0, &texture, 0, Some(&src_box));
                } else {
                    let (mips, srv) = self.mips(w0, h0, level + 1).map_err(|_| Need::Skip)?;
                    self.ctx
                        .CopySubresourceRegion(&mips, 0, 0, 0, 0, &texture, 0, Some(&src_box));
                    self.ctx.GenerateMips(&srv);
                    let mip_box = D3D11_BOX {
                        left: 0,
                        top: 0,
                        front: 0,
                        right: w,
                        bottom: h,
                        back: 1,
                    };
                    self.ctx
                        .CopySubresourceRegion(&staging, 0, 0, 0, 0, &mips, level, Some(&mip_box));
                }
                let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
                self.ctx
                    .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
                    .map_err(|_| Need::Skip)?;
                let row = (w * 4) as usize;
                let dst = (ptr as *mut u8).add(HEADER);
                for y in 0..h as usize {
                    std::ptr::copy_nonoverlapping(
                        (mapped.pData as *const u8).add(y * mapped.RowPitch as usize),
                        dst.add(y * row),
                        row,
                    );
                }
                self.ctx.Unmap(&staging, 0);
                let header = ptr as *mut u32;
                header.add(1).write_volatile(w);
                header.add(2).write_volatile(h);
                (*(ptr as *const AtomicU32)).store(1, Ordering::Release);
            }
            let timestamp = frame
                .SystemRelativeTime()
                .map(|t| (t.Duration / 10) as u64)
                .unwrap_or(0);
            if self.window.is_none() {
                unsafe { (*(ptr as *const AtomicU32)).store(0, Ordering::Release) };
            }
            (self.sink)(CaptureEvent::Frame {
                generation,
                slot,
                width: w,
                height: h,
                timestamp,
            });
            Ok(())
        }

        fn staging(&mut self, w: u32, h: u32) -> windows::core::Result<ID3D11Texture2D> {
            if let Some((t, sw, sh)) = &self.staging
                && *sw == w
                && *sh == h
            {
                return Ok(t.clone());
            }
            let desc = D3D11_TEXTURE2D_DESC {
                Width: w,
                Height: h,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                Usage: D3D11_USAGE_STAGING,
                BindFlags: 0,
                CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                MiscFlags: 0,
            };
            let mut tex = None;
            unsafe { self.device.CreateTexture2D(&desc, None, Some(&mut tex))? };
            let tex = tex.ok_or_else(windows::core::Error::empty)?;
            self.staging = Some((tex.clone(), w, h));
            Ok(tex)
        }

        fn mips(
            &mut self,
            w: u32,
            h: u32,
            levels: u32,
        ) -> windows::core::Result<(ID3D11Texture2D, ID3D11ShaderResourceView)> {
            if let Some((t, v, mw, mh, ml)) = &self.mips
                && (*mw, *mh, *ml) == (w, h, levels)
            {
                return Ok((t.clone(), v.clone()));
            }
            let desc = D3D11_TEXTURE2D_DESC {
                Width: w,
                Height: h,
                MipLevels: levels,
                ArraySize: 1,
                Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
                CPUAccessFlags: 0,
                MiscFlags: D3D11_RESOURCE_MISC_GENERATE_MIPS.0 as u32,
            };
            let mut tex = None;
            unsafe { self.device.CreateTexture2D(&desc, None, Some(&mut tex))? };
            let tex = tex.ok_or_else(windows::core::Error::empty)?;
            let mut srv = None;
            unsafe { self.device.CreateShaderResourceView(&tex, None, Some(&mut srv))? };
            let srv = srv.ok_or_else(windows::core::Error::empty)?;
            self.mips = Some((tex.clone(), srv.clone(), w, h, levels));
            Ok((tex, srv))
        }
    }

    enum Need {
        Skip,
        Buffers(usize),
    }

    /// Creates SLOTS shared buffers on the WebView2 thread, posts them to the
    /// page and hands the raw pointers to the pipeline.
    fn allocate(
        pipeline: Arc<Mutex<Pipeline>>,
        window: WebviewWindow,
        bytes: usize,
        done: Option<std::sync::mpsc::Sender<()>>,
    ) {
        let _ = window.with_webview(move |wv| {
            let generation = GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
            let created = (|| -> windows::core::Result<Vec<usize>> {
                let env: ICoreWebView2Environment12 = wv.environment().cast()?;
                let core: ICoreWebView2_17 = unsafe { wv.controller().CoreWebView2()? }.cast()?;
                let mut list = BUFFERS.lock().map_err(|_| windows::core::Error::empty())?;
                for b in list.drain(..) {
                    let _ = unsafe { b.0.Close() };
                }
                let mut ptrs = Vec::new();
                for slot in 0..SLOTS {
                    let buffer = unsafe { env.CreateSharedBuffer(bytes as u64)? };
                    let mut ptr: *mut u8 = std::ptr::null_mut();
                    unsafe { buffer.Buffer(&mut ptr)? };
                    let meta: Vec<u16> = format!(r#"{{"nexusCapture":{generation},"slot":{slot}}}"#)
                        .encode_utf16()
                        .chain(std::iter::once(0))
                        .collect();
                    unsafe {
                        core.PostSharedBufferToScript(
                            &buffer,
                            COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_WRITE,
                            PCWSTR(meta.as_ptr()),
                        )?
                    };
                    ptrs.push(ptr as usize);
                    list.push(SendBuffer(buffer));
                }
                Ok(ptrs)
            })();
            if let Ok(mut p) = pipeline.lock() {
                p.allocating = false;
                if let (Ok(ptrs), false) = (created, p.stopped) {
                    p.ring = Some(Ring {
                        generation,
                        capacity: bytes,
                        ptrs,
                    });
                }
            }
            if let Some(done) = done {
                let _ = done.send(());
            }
        });
    }
}

/// Used by `examples/capture_probe.rs`.
#[cfg(windows)]
pub fn probe_sources() -> Result<Vec<CaptureSource>, String> {
    imp::list_sources()
}

/// Used by `examples/capture_probe.rs`: captures without a WebView and
/// returns (frames, last width, last height, BGRA pixels of one frame).
#[cfg(windows)]
pub struct ProbeResult {
    pub frames: u32,
    pub width: u32,
    pub height: u32,
    /// BGRA pixels of one captured frame.
    pub pixels: Option<Vec<u8>>,
}

#[cfg(windows)]
pub fn probe_capture(source_id: &str, target: CaptureTarget, seconds: u64) -> Result<ProbeResult, String> {
    use std::sync::{
        Arc,
        atomic::{AtomicU32, Ordering},
    };
    let frames = Arc::new(AtomicU32::new(0));
    let size = Arc::new(std::sync::Mutex::new((0u32, 0u32)));
    let (f, sz) = (Arc::clone(&frames), Arc::clone(&size));
    let sink: imp::Sink = Box::new(move |e| {
        if let CaptureEvent::Frame { width, height, .. } = e {
            f.fetch_add(1, Ordering::Relaxed);
            *sz.lock().unwrap() = (width, height);
        }
    });
    let running = imp::Running::start_with(None, source_id, true, target, sink)?;
    std::thread::sleep(std::time::Duration::from_secs(seconds));
    let pixels = running.local_frame().map(|(_, _, px)| px);
    running.stop();
    let (w, h) = *size.lock().unwrap();
    Ok(ProbeResult {
        frames: frames.load(Ordering::Relaxed),
        width: w,
        height: h,
        pixels,
    })
}
