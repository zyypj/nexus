//! End-to-end check of the system-audio capture rules on a real Windows box.
//!
//!   cargo run --release --example loopback_probe
//!
//! Plays short quiet tones and measures what the capture sees. The probe
//! stands in for Nexus.exe: a `--relay` child for the WebView2 browser process
//! and its `--play` child for the audio service, which is what plays a call.
//! 1. relay's tone, mode `apps` targeting the relay               -> captured
//! 2. relay's tone, `exclude_self` leaving the relay's tree out   -> NOT captured
//!    (how the call stays out of "computer audio")
//! 3. relay's tone, `exclude_self` leaving OUR OWN tree out       -> captured: Windows
//!    only follows direct children, and the player is our grandchild. This is
//!    why the WebView2 browser process, not Nexus.exe, has to be the one left
//!    out. Reported, not judged.
//! 4. tone from a process OUTSIDE our tree (WMI), `exclude_self`  -> captured
//! 5. two children with different tones, mode `apps` with both    -> both captured (mix);
//!    with only the first                                         -> only its tone
//!
//! `--pid <pid>` instead measures a running application playing a 660 Hz tone
//! (e.g. each process of a real Nexus): what is captured with that process's
//! tree left out, and with it as the target.
//!
//! Plays sound on the default output device. The tones are played by this
//! same executable (`--play <wav>`), started as a child or through WMI, so
//! they begin as soon as the process does.

#[cfg(windows)]
fn main() -> anyhow::Result<()> {
    use std::{
        path::PathBuf,
        process::{Child, Command},
        sync::{Arc, Mutex},
        time::Duration,
    };

    use nexus_desktop_lib::system_audio::{CaptureMode, start_capture_with, support};
    use tauri::ipc::{Channel, InvokeResponseBody};

    const LOW: f64 = 660.0;
    const HIGH: f64 = 990.0;
    /// Length of each tone.
    const TONE_SECS: f32 = 2.5;

    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--play") {
        use windows::{
            Win32::Media::Audio::{PlaySoundW, SND_FILENAME, SND_SYNC},
            core::HSTRING,
        };
        let wav = args.get(2).ok_or_else(|| anyhow::anyhow!("--play <wav>"))?;
        let _ = unsafe { PlaySoundW(&HSTRING::from(wav.as_str()), None, SND_FILENAME | SND_SYNC) };
        return Ok(());
    }
    // `--relay <wav>`: plays it from a child of this process (a grandchild of the probe).
    if args.get(1).map(String::as_str) == Some("--relay") {
        let wav = args.get(2).ok_or_else(|| anyhow::anyhow!("--relay <wav>"))?;
        Command::new(std::env::current_exe()?).arg("--play").arg(wav).status()?;
        return Ok(());
    }
    let exe = std::env::current_exe()?;

    let s = support();
    println!("Windows build {}; process loopback supported: {}", s.build, s.supported);
    if !s.supported {
        anyhow::bail!("unsupported Windows build");
    }

    // Quiet (-20 dBFS) 16-bit mono WAV.
    let tone = |hz: f64| -> anyhow::Result<PathBuf> {
        let wav = std::env::temp_dir().join(format!("nexus-probe-tone-{hz}.wav"));
        let sr = 48_000u32;
        let n = (sr as f32 * TONE_SECS) as usize;
        let mut data = Vec::with_capacity(44 + n * 2);
        data.extend_from_slice(b"RIFF");
        data.extend_from_slice(&(36 + n as u32 * 2).to_le_bytes());
        data.extend_from_slice(b"WAVEfmt ");
        data.extend_from_slice(&16u32.to_le_bytes());
        data.extend_from_slice(&1u16.to_le_bytes());
        data.extend_from_slice(&1u16.to_le_bytes());
        data.extend_from_slice(&sr.to_le_bytes());
        data.extend_from_slice(&(sr * 2).to_le_bytes());
        data.extend_from_slice(&2u16.to_le_bytes());
        data.extend_from_slice(&16u16.to_le_bytes());
        data.extend_from_slice(b"data");
        data.extend_from_slice(&(n as u32 * 2).to_le_bytes());
        for i in 0..n {
            let t = i as f32 / sr as f32;
            let fade = (t / 0.05).min(1.0).min((TONE_SECS - t) / 0.05);
            let v = (2.0 * std::f32::consts::PI * hz as f32 * t).sin() * 0.1 * fade;
            data.extend_from_slice(&((v * 32767.0) as i16).to_le_bytes());
        }
        std::fs::write(&wav, data)?;
        Ok(wav)
    };
    let (low_wav, high_wav) = (tone(LOW)?, tone(HIGH)?);
    let child = |wav: &PathBuf| -> anyhow::Result<Child> { Ok(Command::new(&exe).arg("--play").arg(wav).spawn()?) };
    let wait_tone = || std::thread::sleep(Duration::from_secs_f32(TONE_SECS));

    // Captures `seconds` of audio in `mode` and returns the amplitude of the
    // probe tones (Goertzel), so other sounds playing on the PC do not affect
    // the verdict. `webview` = the process standing in for Nexus's WebView2
    // browser process: the tree `exclude_self` leaves out. No process stands
    // in for Nexus itself, so `apps` may target our own children.
    let capture = |mode: CaptureMode, webview: u32, seconds: f32| -> anyhow::Result<(f32, f32)> {
        let samples: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = samples.clone();
        let channel: Channel<InvokeResponseBody> = Channel::new(move |body| {
            if let InvokeResponseBody::Raw(bytes) = body {
                let mut s = sink.lock().unwrap();
                for frame in bytes.as_chunks::<8>().0 {
                    let l = f32::from_le_bytes([frame[0], frame[1], frame[2], frame[3]]);
                    let r = f32::from_le_bytes([frame[4], frame[5], frame[6], frame[7]]);
                    s.push((l + r) * 0.5);
                }
            }
            Ok(())
        });
        let running = start_capture_with(mode, 0, webview, channel).map_err(anyhow::Error::msg)?;
        std::thread::sleep(Duration::from_secs_f32(seconds));
        running.stop();
        let s = samples.lock().unwrap();
        let level = |hz: f64| -> f32 {
            if s.is_empty() {
                return 0.0;
            }
            let w = 2.0 * std::f64::consts::PI * hz / 48_000.0;
            let coeff = 2.0 * w.cos();
            let (mut q1, mut q2) = (0.0f64, 0.0f64);
            for &x in s.iter() {
                let q0 = coeff * q1 - q2 + x as f64;
                q2 = q1;
                q1 = q0;
            }
            let power = q1 * q1 + q2 * q2 - coeff * q1 * q2;
            (2.0 * power.sqrt() / s.len() as f64) as f32
        };
        Ok((level(LOW), level(HIGH)))
    };

    let db = |x: f32| 20.0 * x.max(1e-7).log10();

    // `--pid <pid>`: how much of a 660 Hz tone is captured with that process's
    // tree left out, and with it as the target.
    if args.get(1).map(String::as_str) == Some("--pid") {
        let pid: u32 = args.get(2).ok_or_else(|| anyhow::anyhow!("--pid <pid>"))?.parse()?;
        let excluded = capture(CaptureMode::ExcludeSelf, pid, 1.5)?.0;
        let included = capture(CaptureMode::Apps { pids: vec![pid] }, 0, 1.5)?.0;
        println!("tone with {pid}'s tree left out:   {:7.1} dBFS", db(excluded));
        println!("tone with {pid} as the target:     {:7.1} dBFS", db(included));
        return Ok(());
    }

    let me = std::process::id();
    let (baseline, baseline_high) = capture(CaptureMode::ExcludeSelf, me, 1.2)?;
    println!(
        "660 Hz level, nothing of ours playing:        {:7.1} dBFS",
        db(baseline)
    );

    // 1-3: the tone comes from a grandchild (probe -> relay -> player).
    let relay = || -> anyhow::Result<Child> {
        let c = Command::new(&exe).arg("--relay").arg(&low_wav).spawn()?;
        std::thread::sleep(Duration::from_millis(400));
        Ok(c)
    };
    let mut c = relay()?;
    let app_only = capture(CaptureMode::Apps { pids: vec![c.id()] }, 0, 0.8)?.0;
    c.wait()?;
    let mut c = relay()?;
    let excluded = capture(CaptureMode::ExcludeSelf, c.id(), 0.8)?.0;
    let own_tree = capture(CaptureMode::ExcludeSelf, me, 0.8)?.0;
    c.wait()?;
    println!(
        "relay's tone, mode apps(relay):               {:7.1} dBFS",
        db(app_only)
    );
    println!(
        "relay's tone, relay's tree left out:          {:7.1} dBFS",
        db(excluded)
    );
    println!(
        "relay's tone, our own tree left out:          {:7.1} dBFS",
        db(own_tree)
    );

    // 4: same tone from a process that is NOT our descendant (created by WMI).
    let create = format!(
        "(Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{{CommandLine='\"{}\" --play \"{}\"'}}).ProcessId",
        exe.display(),
        low_wav.display()
    );
    Command::new("powershell")
        .args(["-NoProfile", "-Command", &create])
        .output()?;
    let foreign = capture(CaptureMode::ExcludeSelf, me, 0.8)?.0;
    println!("outside tone, mode exclude_self:              {:7.1} dBFS", db(foreign));
    wait_tone();

    // 5: two applications at once.
    let (mut a, mut b) = (child(&low_wav)?, child(&high_wav)?);
    std::thread::sleep(Duration::from_millis(300));
    let both = capture(
        CaptureMode::Apps {
            pids: vec![a.id(), b.id()],
        },
        0,
        0.7,
    )?;
    a.wait()?;
    b.wait()?;
    let (mut a, mut b) = (child(&low_wav)?, child(&high_wav)?);
    std::thread::sleep(Duration::from_millis(300));
    let first = capture(CaptureMode::Apps { pids: vec![a.id()] }, 0, 0.7)?;
    a.wait()?;
    b.wait()?;
    println!(
        "two apps, both chosen (660 / 990 Hz):         {:7.1} / {:7.1} dBFS",
        db(both.0),
        db(both.1)
    );
    println!(
        "two apps, only the first chosen:              {:7.1} / {:7.1} dBFS",
        db(first.0),
        db(first.1)
    );

    let heard = |x: f32, base: f32| db(x) > db(base) + 20.0;
    let silent = |x: f32, base: f32| db(x) < db(base) + 6.0;
    let checks = [
        (
            heard(app_only, baseline),
            "apps mode captures the target and its children",
        ),
        (
            silent(excluded, baseline),
            "exclude_self drops what the WebView's children play (the call)",
        ),
        (heard(foreign, baseline), "exclude_self keeps other applications"),
        (
            heard(both.0, baseline) && heard(both.1, baseline_high),
            "apps mode mixes every chosen application",
        ),
        (
            // Next to a loud tone the other bin only shows its leakage.
            heard(first.0, baseline) && db(first.1) < db(first.0) - 40.0,
            "apps mode leaves out the applications not chosen",
        ),
    ];
    println!();
    println!(
        "[INFO] a grandchild's sound {} with our own tree left out{}",
        if heard(own_tree, baseline) {
            "IS captured"
        } else {
            "is not captured"
        },
        if heard(own_tree, baseline) {
            " (Windows only follows direct children)"
        } else {
            ""
        }
    );
    for (ok, what) in checks {
        println!("[{}] {what}", if ok { "PASS" } else { "FAIL" });
    }
    let _ = std::fs::remove_file(&low_wav);
    let _ = std::fs::remove_file(&high_wav);
    if checks.iter().all(|c| c.0) {
        Ok(())
    } else {
        anyhow::bail!("loopback probe failed")
    }
}

#[cfg(not(windows))]
fn main() {}
