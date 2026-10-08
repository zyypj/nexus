//! "Share computer audio" without echoing the call back to everyone.
//!
//! Uses WASAPI *process loopback* (Windows 10 build 20348+ / Windows 11):
//!
//! - `ExcludeSelf`: everything the PC plays EXCEPT the Nexus process tree.
//!   WebView2 (which plays the call audio) runs as child processes of
//!   Nexus.exe, so call voices are excluded at the source.
//! - `App { pid }`: only one application's process tree (game, Spotify...).
//!
//! No virtual cable or driver is needed. Captured audio is 48 kHz stereo f32
//! and is streamed to the WebView as raw bytes (no JSON) through a Tauri
//! channel, where an AudioWorklet turns it into a WebRTC track.

use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum CaptureMode {
    ExcludeSelf,
    App { pid: u32 },
}

#[derive(Debug, Clone, Serialize)]
pub struct AudioApp {
    pub pid: u32,
    pub name: String,
    pub active: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Support {
    pub supported: bool,
    pub build: u32,
    pub reason: Option<String>,
}

pub const SAMPLE_RATE: u32 = 48_000;
pub const CHANNELS: u16 = 2;
/// Frames per message sent to the WebView (20 ms).
const CHUNK_FRAMES: usize = 960;

#[cfg(windows)]
mod imp {
    use std::{
        collections::HashSet,
        sync::{
            Arc, Mutex,
            atomic::{AtomicBool, Ordering},
            mpsc,
        },
        time::Duration,
    };

    use tauri::ipc::{Channel, InvokeResponseBody};
    use windows::{
        Wdk::System::SystemServices::RtlGetVersion,
        Win32::{
            Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0},
            Media::Audio::{
                AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
                AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_LOOPBACK,
                AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, AUDIOCLIENT_ACTIVATION_PARAMS,
                AUDIOCLIENT_ACTIVATION_PARAMS_0, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
                AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS, ActivateAudioInterfaceAsync, AudioSessionStateActive,
                AudioSessionStateExpired, IActivateAudioInterfaceAsyncOperation,
                IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl,
                IAudioCaptureClient, IAudioClient, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator,
                MMDeviceEnumerator, PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
                PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE, VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, WAVEFORMATEX,
                eConsole, eRender,
            },
            System::{
                Com::{
                    BLOB, CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoUninitialize,
                    StructuredStorage::{PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0},
                },
                Diagnostics::ToolHelp::{
                    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
                },
                SystemInformation::OSVERSIONINFOW,
                Threading::{
                    CreateEventW, GetCurrentProcessId, OpenProcess, PROCESS_NAME_WIN32,
                    PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW, WaitForSingleObject,
                },
                Variant::VT_BLOB,
            },
        },
        core::{Interface, PWSTR, Ref, Result as WinResult},
    };
    use windows_core::implement;

    use super::{AudioApp, CHANNELS, CHUNK_FRAMES, CaptureMode, SAMPLE_RATE, Support};

    /// Process loopback shipped in Windows build 20348.
    const MIN_BUILD: u32 = 20_348;

    pub fn support() -> Support {
        let mut info = OSVERSIONINFOW {
            dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32,
            ..Default::default()
        };
        let _ = unsafe { RtlGetVersion(&mut info) };
        let build = info.dwBuildNumber;
        let supported = build >= MIN_BUILD;
        Support {
            supported,
            build,
            reason: (!supported).then(|| {
                format!(
                    "Compartilhar áudio requer Windows 11 ou Windows 10 build {MIN_BUILD}+ (este é o build {build})."
                )
            }),
        }
    }

    #[implement(IActivateAudioInterfaceCompletionHandler)]
    struct Completion {
        done: Mutex<Option<mpsc::SyncSender<()>>>,
    }

    impl IActivateAudioInterfaceCompletionHandler_Impl for Completion_Impl {
        fn ActivateCompleted(&self, _op: Ref<IActivateAudioInterfaceAsyncOperation>) -> WinResult<()> {
            if let Ok(mut d) = self.done.lock()
                && let Some(tx) = d.take()
            {
                let _ = tx.send(());
            }
            Ok(())
        }
    }

    fn activate(mode: &CaptureMode) -> Result<IAudioClient, String> {
        let (target, loopback_mode) = match mode {
            CaptureMode::ExcludeSelf => (
                unsafe { GetCurrentProcessId() },
                PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
            ),
            CaptureMode::App { pid } => (*pid, PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE),
        };
        let mut params = AUDIOCLIENT_ACTIVATION_PARAMS {
            ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
            Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
                ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                    TargetProcessId: target,
                    ProcessLoopbackMode: loopback_mode,
                },
            },
        };
        // The blob points at `params` on this stack frame. PROPVARIANT's drop
        // would run PropVariantClear and CoTaskMemFree that pointer (heap
        // corruption), so it must never be dropped.
        let prop = std::mem::ManuallyDrop::new(PROPVARIANT {
            Anonymous: PROPVARIANT_0 {
                Anonymous: std::mem::ManuallyDrop::new(PROPVARIANT_0_0 {
                    vt: VT_BLOB,
                    wReserved1: 0,
                    wReserved2: 0,
                    wReserved3: 0,
                    Anonymous: PROPVARIANT_0_0_0 {
                        blob: BLOB {
                            cbSize: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
                            pBlobData: &mut params as *mut _ as *mut u8,
                        },
                    },
                }),
            },
        });

        let (tx, rx) = mpsc::sync_channel(1);
        let handler: IActivateAudioInterfaceCompletionHandler = Completion {
            done: Mutex::new(Some(tx)),
        }
        .into();
        let op = unsafe {
            ActivateAudioInterfaceAsync(
                VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
                &IAudioClient::IID,
                Some(&*prop),
                &handler,
            )
        }
        .map_err(|e| format!("ActivateAudioInterfaceAsync: {e}"))?;
        rx.recv_timeout(Duration::from_secs(5))
            .map_err(|_| "audio activation timed out".to_string())?;

        let mut hr = windows::core::HRESULT(0);
        let mut unknown = None;
        unsafe { op.GetActivateResult(&mut hr, &mut unknown) }.map_err(|e| format!("GetActivateResult: {e}"))?;
        hr.ok()
            .map_err(|e| format!("process loopback activation failed: {e}"))?;
        unknown
            .ok_or("no audio interface returned")?
            .cast::<IAudioClient>()
            .map_err(|e| e.to_string())
    }

    pub struct Running {
        stop: Arc<AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    impl Running {
        pub fn stop(mut self) {
            self.stop.store(true, Ordering::SeqCst);
            if let Some(t) = self.thread.take() {
                let _ = t.join();
            }
        }
    }

    pub fn start(mode: CaptureMode, channel: Channel<InvokeResponseBody>) -> Result<Running, String> {
        let s = support();
        if !s.supported {
            return Err(s.reason.unwrap_or_default());
        }
        let stop = Arc::new(AtomicBool::new(false));
        let stop2 = stop.clone();
        let (ready_tx, ready_rx) = mpsc::sync_channel::<Result<(), String>>(1);
        let thread = std::thread::Builder::new()
            .name("nexus-system-audio".into())
            .spawn(move || {
                if let Err(e) = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.ok() {
                    let _ = ready_tx.send(Err(format!("CoInitializeEx: {e}")));
                    return;
                }
                let result = capture_loop(&mode, &channel, &stop2, &ready_tx);
                if let Err(e) = result {
                    // Startup errors were already reported through ready_tx.
                    let _ = ready_tx.try_send(Err(e));
                }
                unsafe { CoUninitialize() };
            })
            .map_err(|e| e.to_string())?;
        match ready_rx.recv_timeout(Duration::from_secs(10)) {
            Ok(Ok(())) => Ok(Running {
                stop,
                thread: Some(thread),
            }),
            Ok(Err(e)) => {
                let _ = thread.join();
                Err(e)
            }
            Err(_) => {
                stop.store(true, Ordering::SeqCst);
                Err("audio capture did not start".into())
            }
        }
    }

    fn capture_loop(
        mode: &CaptureMode,
        channel: &Channel<InvokeResponseBody>,
        stop: &AtomicBool,
        ready: &mpsc::SyncSender<Result<(), String>>,
    ) -> Result<(), String> {
        let client = activate(mode)?;
        let block_align = CHANNELS * 4;
        let format = WAVEFORMATEX {
            wFormatTag: 3, // WAVE_FORMAT_IEEE_FLOAT
            nChannels: CHANNELS,
            nSamplesPerSec: SAMPLE_RATE,
            nAvgBytesPerSec: SAMPLE_RATE * block_align as u32,
            nBlockAlign: block_align,
            wBitsPerSample: 32,
            cbSize: 0,
        };
        unsafe {
            client.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK
                    | AUDCLNT_STREAMFLAGS_EVENTCALLBACK
                    | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
                    | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                200_000, // 20 ms buffer (100 ns units)
                0,
                &format,
                None,
            )
        }
        .map_err(|e| format!("IAudioClient::Initialize: {e}"))?;

        let event: HANDLE = unsafe { CreateEventW(None, false, false, None) }.map_err(|e| e.to_string())?;
        let result = (|| {
            unsafe { client.SetEventHandle(event) }.map_err(|e| e.to_string())?;
            let capture: IAudioCaptureClient = unsafe { client.GetService() }.map_err(|e| e.to_string())?;
            unsafe { client.Start() }.map_err(|e| e.to_string())?;
            let _ = ready.send(Ok(()));

            let samples_per_chunk = CHUNK_FRAMES * CHANNELS as usize;
            let mut pending: Vec<f32> = Vec::with_capacity(samples_per_chunk * 2);
            while !stop.load(Ordering::Relaxed) {
                // Timeout so `stop` is observed even when nothing is playing.
                if unsafe { WaitForSingleObject(event, 100) } != WAIT_OBJECT_0 {
                    continue;
                }
                loop {
                    let packet = unsafe { capture.GetNextPacketSize() }.map_err(|e| e.to_string())?;
                    if packet == 0 {
                        break;
                    }
                    let mut data: *mut u8 = std::ptr::null_mut();
                    let mut frames = 0u32;
                    let mut flags = 0u32;
                    unsafe { capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None) }
                        .map_err(|e| e.to_string())?;
                    let n = frames as usize * CHANNELS as usize;
                    if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 || data.is_null() {
                        pending.resize(pending.len() + n, 0.0);
                    } else {
                        let slice = unsafe { std::slice::from_raw_parts(data as *const f32, n) };
                        pending.extend_from_slice(slice);
                    }
                    unsafe { capture.ReleaseBuffer(frames) }.map_err(|e| e.to_string())?;
                }
                while pending.len() >= samples_per_chunk {
                    let mut bytes = Vec::with_capacity(samples_per_chunk * 4);
                    for s in pending.drain(..samples_per_chunk) {
                        bytes.extend_from_slice(&s.to_le_bytes());
                    }
                    if channel.send(InvokeResponseBody::Raw(bytes)).is_err() {
                        // WebView went away (reload/close): stop capturing.
                        return Ok(());
                    }
                }
            }
            let _ = unsafe { client.Stop() };
            Ok(())
        })();
        unsafe {
            let _ = CloseHandle(event);
        }
        result
    }

    /// Our own process plus every descendant (WebView2 processes).
    fn own_process_tree() -> HashSet<u32> {
        let me = unsafe { GetCurrentProcessId() };
        let mut tree = HashSet::from([me]);
        let Ok(snapshot) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else {
            return tree;
        };
        let mut parents: Vec<(u32, u32)> = Vec::new();
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        unsafe {
            if Process32FirstW(snapshot, &mut entry).is_ok() {
                loop {
                    parents.push((entry.th32ProcessID, entry.th32ParentProcessID));
                    if Process32NextW(snapshot, &mut entry).is_err() {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snapshot);
        }
        loop {
            let before = tree.len();
            for (pid, parent) in &parents {
                if tree.contains(parent) {
                    tree.insert(*pid);
                }
            }
            if tree.len() == before {
                return tree;
            }
        }
    }

    fn process_name(pid: u32) -> Option<String> {
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut buf = [0u16; 520];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len);
            let _ = CloseHandle(handle);
            ok.ok()?;
            let path = String::from_utf16_lossy(&buf[..len as usize]);
            let file = path.rsplit('\\').next().unwrap_or(&path).to_string();
            Some(file.trim_end_matches(".exe").trim_end_matches(".EXE").to_string())
        }
    }

    /// Applications that currently have an audio session on the default output.
    pub fn apps() -> Result<Vec<AudioApp>, String> {
        let initialized = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok();
        let result = (|| -> Result<Vec<AudioApp>, String> {
            let enumerator: IMMDeviceEnumerator =
                unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }.map_err(|e| e.to_string())?;
            let device = unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eConsole) }.map_err(|e| e.to_string())?;
            let manager: IAudioSessionManager2 =
                unsafe { device.Activate(CLSCTX_ALL, None) }.map_err(|e| e.to_string())?;
            let sessions = unsafe { manager.GetSessionEnumerator() }.map_err(|e| e.to_string())?;
            let count = unsafe { sessions.GetCount() }.map_err(|e| e.to_string())?;
            let excluded = own_process_tree();
            let mut out: Vec<AudioApp> = Vec::new();
            for i in 0..count {
                let Ok(control) = (unsafe { sessions.GetSession(i) }) else {
                    continue;
                };
                let Ok(control2) = control.cast::<IAudioSessionControl2>() else {
                    continue;
                };
                if unsafe { control2.IsSystemSoundsSession() }.0 == 0 {
                    continue; // S_OK means "system sounds"
                }
                let Ok(state) = (unsafe { control2.GetState() }) else {
                    continue;
                };
                if state == AudioSessionStateExpired {
                    continue;
                }
                let Ok(pid) = (unsafe { control2.GetProcessId() }) else {
                    continue;
                };
                if pid == 0 || excluded.contains(&pid) {
                    continue;
                }
                let active = state == AudioSessionStateActive;
                if let Some(existing) = out.iter_mut().find(|a| a.pid == pid) {
                    existing.active |= active;
                    continue;
                }
                if let Some(name) = process_name(pid) {
                    out.push(AudioApp { pid, name, active });
                }
            }
            out.sort_by(|a, b| {
                b.active
                    .cmp(&a.active)
                    .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            });
            Ok(out)
        })();
        if initialized {
            unsafe { CoUninitialize() };
        }
        result
    }
}

/// Native entry points, also used by `examples/loopback_probe.rs`.
#[cfg(windows)]
pub use imp::{Running, apps as audio_apps, start as start_capture, support};

#[cfg(windows)]
static RUNNING: std::sync::Mutex<Option<imp::Running>> = std::sync::Mutex::new(None);

#[tauri::command]
pub fn system_audio_support() -> Support {
    #[cfg(windows)]
    return imp::support();
    #[cfg(not(windows))]
    Support {
        supported: false,
        build: 0,
        reason: Some("Windows only".into()),
    }
}

#[tauri::command]
pub async fn system_audio_apps() -> Result<Vec<AudioApp>, String> {
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(imp::apps)
        .await
        .map_err(|e| e.to_string())?;
    #[cfg(not(windows))]
    Ok(Vec::new())
}

/// Starts streaming captured PCM (f32 LE, 48 kHz, stereo, 20 ms chunks) to `channel`.
#[tauri::command]
pub async fn system_audio_start(mode: CaptureMode, channel: Channel<InvokeResponseBody>) -> Result<(), String> {
    #[cfg(windows)]
    {
        system_audio_stop();
        let running = tauri::async_runtime::spawn_blocking(move || imp::start(mode, channel))
            .await
            .map_err(|e| e.to_string())??;
        *RUNNING.lock().map_err(|e| e.to_string())? = Some(running);
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (mode, channel);
        Err("Windows only".into())
    }
}

#[tauri::command]
pub fn system_audio_stop() {
    #[cfg(windows)]
    if let Some(r) = RUNNING.lock().ok().and_then(|mut g| g.take()) {
        r.stop();
    }
}
