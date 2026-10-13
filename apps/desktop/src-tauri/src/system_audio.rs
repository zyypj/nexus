//! "Share computer audio" without echoing the call back to everyone.
//!
//! Uses WASAPI *process loopback* (Windows 10 build 20348+ / Windows 11):
//!
//! - `ExcludeSelf`: everything the PC plays EXCEPT Nexus.
//! - `Apps { pids }`: only these applications (game, Spotify, browser...),
//!   mixed together. Nexus is never among them.
//!
//! Windows calls the unit a "process tree", but it only follows a process and
//! its DIRECT children (measured with `examples/loopback_probe.rs`: a
//! grandchild's sound is neither excluded nor included). The call is played by
//! WebView2's audio service: Nexus.exe -> msedgewebview2 (browser process) ->
//! audio service, a grandchild of ours. Excluding our own process therefore
//! left the call voices in the stream; the tree to leave out is the one of the
//! WebView2 browser process (`exclusion_root`). For the same reason an
//! application is captured through several targets (`app_targets`).
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
    Apps { pids: Vec<u32> },
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
pub(crate) mod imp {
    use std::{
        collections::{HashSet, VecDeque},
        sync::{
            Arc, Mutex,
            atomic::{AtomicBool, AtomicU32, Ordering},
            mpsc,
        },
        time::{Duration, Instant},
    };

    use tauri::ipc::{Channel, InvokeResponseBody};
    use windows::{
        Wdk::System::SystemServices::RtlGetVersion,
        Win32::{
            Foundation::{CloseHandle, HANDLE},
            Media::Audio::{
                AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
                AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_LOOPBACK,
                AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, AUDIOCLIENT_ACTIVATION_PARAMS,
                AUDIOCLIENT_ACTIVATION_PARAMS_0, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
                AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS, ActivateAudioInterfaceAsync, AudioSessionStateActive,
                AudioSessionStateExpired, IActivateAudioInterfaceAsyncOperation,
                IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl,
                IAudioCaptureClient, IAudioClient, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator,
                MMDeviceEnumerator, PROCESS_LOOPBACK_MODE, PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
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
                    PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW, WaitForMultipleObjects,
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
    /// Applications mixed at once (well under WaitForMultipleObjects' 64 handles).
    const MAX_APPS: usize = 16;
    /// A source that sent nothing for this long has stopped playing.
    const STALL: Duration = Duration::from_millis(40);

    /// The WebView2 browser process showing our UI (0 = not known yet).
    static WEBVIEW_PID: AtomicU32 = AtomicU32::new(0);

    pub fn set_webview_pid(pid: u32) {
        WEBVIEW_PID.store(pid, Ordering::Relaxed);
    }

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

    fn activate(target: u32, loopback_mode: PROCESS_LOOPBACK_MODE) -> Result<IAudioClient, String> {
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
        let me = unsafe { GetCurrentProcessId() };
        start_with(mode, me, WEBVIEW_PID.load(Ordering::Relaxed), channel)
    }

    /// `me` = the Nexus process, `webview` = the WebView2 browser process that
    /// plays its audio (0 = not known). Parameters so the probe can stand in.
    pub fn start_with(
        mode: CaptureMode,
        me: u32,
        webview: u32,
        channel: Channel<InvokeResponseBody>,
    ) -> Result<Running, String> {
        let s = support();
        if !s.supported {
            return Err(s.reason.unwrap_or_default());
        }
        let parents = process_parents();
        let targets: Vec<(u32, PROCESS_LOOPBACK_MODE)> = match mode {
            CaptureMode::ExcludeSelf => vec![(
                exclusion_root(me, webview, &parents),
                PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
            )],
            CaptureMode::Apps { pids } => {
                let own = tree_of(&[me, webview], &parents);
                let playing: HashSet<u32> = audio_sessions()
                    .unwrap_or_default()
                    .into_iter()
                    .map(|(pid, _)| pid)
                    .collect();
                capture_targets(&pids, &own, &parents, &playing)
                    .into_iter()
                    .map(|pid| (pid, PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE))
                    .collect()
            }
        };
        if targets.is_empty() {
            return Err("Nenhum aplicativo para capturar o som.".into());
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
                let result = capture_loop(&targets, &channel, &stop2, &ready_tx);
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

    /// One process-loopback stream (an application, or everything but Nexus).
    struct Source {
        client: IAudioClient,
        capture: IAudioCaptureClient,
        event: HANDLE,
        /// Interleaved samples not mixed yet.
        queue: VecDeque<f32>,
        /// Buffered enough to be mixed without gaps.
        primed: bool,
        last_data: Instant,
    }

    impl Drop for Source {
        fn drop(&mut self) {
            unsafe {
                let _ = self.client.Stop();
                let _ = CloseHandle(self.event);
            }
        }
    }

    impl Source {
        fn open(target: u32, mode: PROCESS_LOOPBACK_MODE) -> Result<Self, String> {
            let client = activate(target, mode)?;
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
            let started = (|| {
                unsafe { client.SetEventHandle(event) }.map_err(|e| e.to_string())?;
                let capture: IAudioCaptureClient = unsafe { client.GetService() }.map_err(|e| e.to_string())?;
                unsafe { client.Start() }.map_err(|e| e.to_string())?;
                Ok::<_, String>(capture)
            })();
            match started {
                Ok(capture) => Ok(Self {
                    client,
                    capture,
                    event,
                    queue: VecDeque::new(),
                    primed: false,
                    last_data: Instant::now(),
                }),
                Err(e) => {
                    unsafe {
                        let _ = CloseHandle(event);
                    }
                    Err(e)
                }
            }
        }

        /// Moves every packet the engine has ready into the queue.
        fn drain(&mut self) -> Result<(), String> {
            loop {
                let packet = unsafe { self.capture.GetNextPacketSize() }.map_err(|e| e.to_string())?;
                if packet == 0 {
                    return Ok(());
                }
                let mut data: *mut u8 = std::ptr::null_mut();
                let mut frames = 0u32;
                let mut flags = 0u32;
                unsafe { self.capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None) }
                    .map_err(|e| e.to_string())?;
                let n = frames as usize * CHANNELS as usize;
                if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 || data.is_null() {
                    self.queue.extend(std::iter::repeat_n(0.0, n));
                } else {
                    self.queue
                        .extend(unsafe { std::slice::from_raw_parts(data as *const f32, n) });
                }
                unsafe { self.capture.ReleaseBuffer(frames) }.map_err(|e| e.to_string())?;
                self.last_data = Instant::now();
                // Nobody reading (mix stalled): keep at most 1 s.
                let cap = SAMPLE_RATE as usize * CHANNELS as usize;
                if self.queue.len() > cap {
                    self.queue.drain(..self.queue.len() - cap);
                }
            }
        }
    }

    /// The next 20 ms of the mix, or None while there is nothing (complete) to
    /// send. One source: its audio as it comes. Several: each one is mixed only
    /// after buffering a little (they deliver their packets a few ms apart),
    /// and a source that went quiet is flushed instead of holding the others.
    fn next_chunk(sources: &mut [Source], samples: usize, now: Instant) -> Option<Vec<f32>> {
        let (prime, cushion) = if sources.len() > 1 {
            (samples * 2, samples)
        } else {
            (samples, 0)
        };
        let mut fullest = 0;
        let mut waiting = false;
        for s in sources.iter_mut() {
            if s.queue.is_empty() {
                s.primed = false;
                continue;
            }
            let stalled = now.duration_since(s.last_data) > STALL;
            if !s.primed && (s.queue.len() >= prime || stalled) {
                s.primed = true;
            }
            if s.primed {
                // Stalled sources are flushed whatever the others have.
                fullest = fullest.max(if stalled { usize::MAX } else { s.queue.len() });
                waiting |= s.queue.len() < samples && !stalled;
            }
        }
        if waiting || fullest < samples + cushion {
            return None;
        }
        let mut out = vec![0f32; samples];
        let mut mixed = 0;
        for s in sources.iter_mut().filter(|s| s.primed) {
            let n = s.queue.len().min(samples);
            for (o, x) in out.iter_mut().zip(s.queue.drain(..n)) {
                *o += x;
            }
            mixed += 1;
        }
        if mixed > 1 {
            for o in &mut out {
                *o = o.clamp(-1.0, 1.0);
            }
        }
        Some(out)
    }

    fn capture_loop(
        targets: &[(u32, PROCESS_LOOPBACK_MODE)],
        channel: &Channel<InvokeResponseBody>,
        stop: &AtomicBool,
        ready: &mpsc::SyncSender<Result<(), String>>,
    ) -> Result<(), String> {
        // An application that closed meanwhile is skipped; the rest still plays.
        let mut sources = Vec::new();
        let mut error = String::new();
        for (target, mode) in targets {
            match Source::open(*target, *mode) {
                Ok(s) => sources.push(s),
                Err(e) => error = e,
            }
        }
        if sources.is_empty() {
            return Err(error);
        }
        let _ = ready.send(Ok(()));

        let samples = CHUNK_FRAMES * CHANNELS as usize;
        // Timeout so `stop` (and a source going quiet) is noticed while nothing plays.
        let timeout = if sources.len() > 1 { 20 } else { 100 };
        while !stop.load(Ordering::Relaxed) && !sources.is_empty() {
            let events: Vec<HANDLE> = sources.iter().map(|s| s.event).collect();
            unsafe { WaitForMultipleObjects(&events, false, timeout) };
            // Whichever fired, take what every source has: they share one clock.
            sources.retain_mut(|s| s.drain().is_ok());
            while let Some(chunk) = next_chunk(&mut sources, samples, Instant::now()) {
                let mut bytes = Vec::with_capacity(samples * 4);
                for s in chunk {
                    bytes.extend_from_slice(&s.to_le_bytes());
                }
                if channel.send(InvokeResponseBody::Raw(bytes)).is_err() {
                    // WebView went away (reload/close): stop capturing.
                    return Ok(());
                }
            }
        }
        Ok(())
    }

    /// (pid, parent pid) of every running process.
    fn process_parents() -> Vec<(u32, u32)> {
        let mut parents: Vec<(u32, u32)> = Vec::new();
        let Ok(snapshot) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else {
            return parents;
        };
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
        parents
    }

    /// `roots` plus every descendant of theirs.
    pub(crate) fn tree_of(roots: &[u32], parents: &[(u32, u32)]) -> HashSet<u32> {
        let mut tree: HashSet<u32> = roots.iter().copied().filter(|pid| *pid != 0).collect();
        loop {
            let before = tree.len();
            for (pid, parent) in parents {
                if *pid != 0 && tree.contains(parent) {
                    tree.insert(*pid);
                }
            }
            if tree.len() == before {
                return tree;
            }
        }
    }

    /// The process whose tree is left out of "computer audio": the WebView2
    /// browser process, whose direct child (the audio service) plays everything
    /// Nexus plays. Nexus.exe itself is silent, and excluding it would not
    /// reach that far (see the module docs). Not told which one yet: it is the
    /// process we started.
    pub(crate) fn exclusion_root(me: u32, webview: u32, parents: &[(u32, u32)]) -> u32 {
        if webview != 0 {
            return webview;
        }
        let mut children = parents
            .iter()
            .filter(|(pid, parent)| *parent == me && *pid != me && *pid != 0);
        match (children.next(), children.next()) {
            (Some((only, _)), None) => *only,
            _ => me,
        }
    }

    /// Targets that capture the application of `root` whole. One target covers
    /// a process and its direct children, so the tree is covered two levels at
    /// a time: the root, then the processes two levels down, and so on. Below
    /// the root only where sound is coming from (`playing` = processes with an
    /// audio session), e.g. the audio service of a WebView2 the app embeds.
    pub(crate) fn app_targets(root: u32, parents: &[(u32, u32)], playing: &HashSet<u32>) -> Vec<u32> {
        let children = |of: &[u32]| -> Vec<u32> {
            parents
                .iter()
                .filter(|(pid, parent)| *pid != 0 && pid != parent && of.contains(parent))
                .map(|(pid, _)| *pid)
                .collect()
        };
        let mut targets = vec![root];
        let mut level = vec![root];
        for depth in 1..=8 {
            level = children(&level);
            if level.is_empty() {
                break;
            }
            if depth % 2 == 0 {
                for pid in &level {
                    if playing.contains(pid) || children(&[*pid]).iter().any(|c| playing.contains(c)) {
                        targets.push(*pid);
                    }
                }
            }
        }
        targets
    }

    /// What to capture for the chosen applications: never Nexus (`own`), and
    /// nothing twice (a target's direct children are already in its capture).
    pub(crate) fn capture_targets(
        pids: &[u32],
        own: &HashSet<u32>,
        parents: &[(u32, u32)],
        playing: &HashSet<u32>,
    ) -> Vec<u32> {
        let mut targets: Vec<u32> = Vec::new();
        for pid in pids.iter().filter(|pid| **pid != 0 && !own.contains(pid)) {
            for target in app_targets(*pid, parents, playing) {
                if !own.contains(&target) && !targets.contains(&target) {
                    targets.push(target);
                }
            }
        }
        let parent_of = |pid: u32| parents.iter().find(|(p, _)| *p == pid).map(|(_, parent)| *parent);
        let all = targets.clone();
        targets.retain(|t| parent_of(*t).is_none_or(|parent| parent == *t || !all.contains(&parent)));
        targets.truncate(MAX_APPS);
        targets
    }

    /// Every process of Nexus: ours, the WebView2 ones and their descendants.
    pub(crate) fn own_process_tree() -> HashSet<u32> {
        let me = unsafe { GetCurrentProcessId() };
        tree_of(&[me, WEBVIEW_PID.load(Ordering::Relaxed)], &process_parents())
    }

    pub(crate) fn process_name(pid: u32) -> Option<String> {
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

    /// (pid, playing now) of every audio session on the default output, the
    /// Windows system sounds aside.
    fn audio_sessions() -> Result<Vec<(u32, bool)>, String> {
        let initialized = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok();
        let result = (|| -> Result<Vec<(u32, bool)>, String> {
            let enumerator: IMMDeviceEnumerator =
                unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }.map_err(|e| e.to_string())?;
            let device = unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eConsole) }.map_err(|e| e.to_string())?;
            let manager: IAudioSessionManager2 =
                unsafe { device.Activate(CLSCTX_ALL, None) }.map_err(|e| e.to_string())?;
            let sessions = unsafe { manager.GetSessionEnumerator() }.map_err(|e| e.to_string())?;
            let count = unsafe { sessions.GetCount() }.map_err(|e| e.to_string())?;
            let mut out: Vec<(u32, bool)> = Vec::new();
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
                if pid == 0 {
                    continue;
                }
                let active = state == AudioSessionStateActive;
                match out.iter_mut().find(|(p, _)| *p == pid) {
                    Some(existing) => existing.1 |= active,
                    None => out.push((pid, active)),
                }
            }
            Ok(out)
        })();
        if initialized {
            unsafe { CoUninitialize() };
        }
        result
    }

    /// Name to show for the process that owns an audio session. A WebView2
    /// (msedgewebview2) is whatever application embeds it: name that one.
    fn app_name(pid: u32, parents: &[(u32, u32)]) -> Option<String> {
        let mut name = process_name(pid)?;
        let mut current = pid;
        for _ in 0..8 {
            if !name.eq_ignore_ascii_case("msedgewebview2") {
                break;
            }
            let Some(parent) = parents.iter().find(|(p, _)| *p == current).map(|(_, parent)| *parent) else {
                break;
            };
            let Some(host) = process_name(parent) else { break };
            name = host;
            current = parent;
        }
        Some(name)
    }

    /// Applications that currently have an audio session on the default output
    /// (Nexus aside). `pid` is the process playing; several may share a name.
    pub fn apps() -> Result<Vec<AudioApp>, String> {
        let me = unsafe { GetCurrentProcessId() };
        let parents = process_parents();
        let own = tree_of(&[me, WEBVIEW_PID.load(Ordering::Relaxed)], &parents);
        let mut out: Vec<AudioApp> = audio_sessions()?
            .into_iter()
            .filter(|(pid, _)| !own.contains(pid))
            .filter_map(|(pid, active)| {
                Some(AudioApp {
                    pid,
                    name: app_name(pid, &parents)?,
                    active,
                })
            })
            .collect();
        out.sort_by(|a, b| {
            b.active
                .cmp(&a.active)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(out)
    }
}

/// Native entry points, also used by `examples/loopback_probe.rs`.
#[cfg(windows)]
pub use imp::{Running, apps as audio_apps, start as start_capture, start_with as start_capture_with, support};

/// Remembers which WebView2 browser process plays our audio (see
/// `imp::exclusion_root`). Does not wait: for app startup.
pub fn remember_webview(window: &tauri::WebviewWindow) {
    #[cfg(windows)]
    let _ = window.with_webview(|wv| {
        let mut pid = 0u32;
        let read = unsafe {
            wv.controller()
                .CoreWebView2()
                .and_then(|core| core.BrowserProcessId(&mut pid))
        };
        if read.is_ok() {
            #[cfg(debug_assertions)]
            eprintln!(
                "[audio] WebView2 browser process: {pid} (Nexus is {})",
                std::process::id()
            );
            imp::set_webview_pid(pid);
        }
    });
    #[cfg(not(windows))]
    let _ = window;
}

/// Same, waiting for the answer (WebView2 restarts its processes after a
/// crash). Never call from the main thread, which is the one that answers.
#[cfg(windows)]
fn refresh_webview(window: &tauri::WebviewWindow) {
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    let asked = window.with_webview(move |wv| {
        let mut pid = 0u32;
        let read = unsafe {
            wv.controller()
                .CoreWebView2()
                .and_then(|core| core.BrowserProcessId(&mut pid))
        };
        let _ = tx.send(if read.is_ok() { pid } else { 0 });
    });
    if asked.is_ok()
        && let Ok(pid) = rx.recv_timeout(std::time::Duration::from_secs(2))
        && pid != 0
    {
        imp::set_webview_pid(pid);
    }
}

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
pub async fn system_audio_apps(window: tauri::WebviewWindow) -> Result<Vec<AudioApp>, String> {
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(move || {
        refresh_webview(&window);
        imp::apps()
    })
    .await
    .map_err(|e| e.to_string())?;
    #[cfg(not(windows))]
    {
        let _ = window;
        Ok(Vec::new())
    }
}

/// Starts streaming captured PCM (f32 LE, 48 kHz, stereo, 20 ms chunks) to
/// `channel`, replacing a capture already running (changing what is shared).
#[tauri::command]
pub async fn system_audio_start(
    window: tauri::WebviewWindow,
    mode: CaptureMode,
    channel: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        system_audio_stop();
        let running = tauri::async_runtime::spawn_blocking(move || {
            refresh_webview(&window);
            imp::start(mode, channel)
        })
        .await
        .map_err(|e| e.to_string())??;
        *RUNNING.lock().map_err(|e| e.to_string())? = Some(running);
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (window, mode, channel);
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

#[cfg(all(test, windows))]
mod tests {
    use std::collections::HashSet;

    use super::imp::{app_targets, capture_targets, exclusion_root, tree_of};

    /// explorer(10) -> nexus(20) -> webview(30) -> audio service(31), renderer(32);
    /// a game(40) with a helper(41); a browser(50) -> audio(51);
    /// an app embedding a WebView2: host(60) -> webview(61) -> audio(62), renderer(63).
    const PROCESSES: &[(u32, u32)] = &[
        (10, 4),
        (20, 10),
        (30, 20),
        (31, 30),
        (32, 30),
        (40, 10),
        (41, 40),
        (50, 10),
        (51, 50),
        (60, 10),
        (61, 60),
        (62, 61),
        (63, 61),
    ];

    fn set(pids: &[u32]) -> HashSet<u32> {
        pids.iter().copied().collect()
    }

    #[test]
    fn tree_holds_every_descendant() {
        assert_eq!(tree_of(&[20], PROCESSES), set(&[20, 30, 31, 32]));
        assert!(tree_of(&[0], PROCESSES).is_empty(), "pid 0 is not a root");
    }

    #[test]
    fn computer_audio_leaves_out_the_webview_not_nexus() {
        // Excluding Nexus (20) would not reach the audio service (31), its grandchild.
        assert_eq!(exclusion_root(20, 30, PROCESSES), 30);
        assert_eq!(exclusion_root(20, 0, PROCESSES), 30, "not told: the process we started");
        assert_eq!(exclusion_root(99, 0, PROCESSES), 99, "no child at all");
    }

    #[test]
    fn an_application_is_its_process_and_direct_children() {
        assert_eq!(app_targets(40, PROCESSES, &set(&[40])), vec![40]);
        assert_eq!(
            app_targets(50, PROCESSES, &set(&[51])),
            vec![50],
            "audio service is a child"
        );
    }

    #[test]
    fn sound_two_levels_down_needs_its_own_target() {
        assert_eq!(app_targets(60, PROCESSES, &set(&[62])), vec![60, 62]);
        assert_eq!(app_targets(60, PROCESSES, &set(&[])), vec![60], "nothing playing there");
    }

    #[test]
    fn chosen_applications_never_include_nexus_nor_repeat() {
        let own = tree_of(&[20, 30], PROCESSES);
        let playing = set(&[31, 40, 51, 62]);
        // The browser by its window (50) and by its audio process (51): once.
        assert_eq!(capture_targets(&[50, 51, 40], &own, PROCESSES, &playing), vec![50, 40]);
        // The audio process alone is a target by itself.
        assert_eq!(capture_targets(&[51], &own, PROCESSES, &playing), vec![51]);
        assert_eq!(capture_targets(&[62, 60], &own, PROCESSES, &playing), vec![62, 60]);
        // Nexus's own processes are dropped, also from under what started it (Explorer).
        assert!(capture_targets(&[20, 30, 31, 0], &own, PROCESSES, &playing).is_empty());
        assert_eq!(capture_targets(&[10], &own, PROCESSES, &playing), vec![10, 51, 61]);
    }
}
