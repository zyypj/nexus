//! End-to-end check of the system-audio capture rules on a real Windows box.
//!
//!   cargo run --release --example loopback_probe
//!
//! Plays a short quiet tone three times and measures what the capture sees:
//! 1. tone from a CHILD process, mode `app` targeting that child  -> must be captured
//! 2. tone from a CHILD process, mode `exclude_self`              -> must NOT be captured
//!    (this is how call voices, played by WebView2 children of Nexus, stay out)
//! 3. tone from a process OUTSIDE our tree (WMI), `exclude_self`  -> must be captured
//!
//! Plays sound on the default output device.

#[cfg(windows)]
fn main() -> anyhow::Result<()> {
    use std::{
        process::Command,
        sync::{Arc, Mutex},
        time::Duration,
    };

    use nexus_desktop_lib::system_audio::{CaptureMode, start_capture, support};
    use tauri::ipc::{Channel, InvokeResponseBody};

    let s = support();
    println!("Windows build {}; process loopback supported: {}", s.build, s.supported);
    if !s.supported {
        anyhow::bail!("unsupported Windows build");
    }

    // 1.5 s, 660 Hz, quiet (-20 dBFS) 16-bit mono WAV.
    let wav = std::env::temp_dir().join("nexus-probe-tone.wav");
    {
        let sr = 48_000u32;
        let n = (sr as f32 * 1.5) as usize;
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
            let fade = (t / 0.05).min(1.0).min((1.5 - t) / 0.05);
            let v = (2.0 * std::f32::consts::PI * 660.0 * t).sin() * 0.1 * fade;
            data.extend_from_slice(&((v * 32767.0) as i16).to_le_bytes());
        }
        std::fs::write(&wav, data)?;
    }
    let play = format!("(New-Object Media.SoundPlayer '{}').PlaySync()", wav.display());

    // Captures `seconds` of audio in `mode` and returns the amplitude of the
    // 660 Hz probe tone (Goertzel), so other sounds playing on the PC do not
    // affect the verdict.
    let capture = |mode: CaptureMode, seconds: f32| -> anyhow::Result<f32> {
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
        let running = start_capture(mode, channel).map_err(anyhow::Error::msg)?;
        std::thread::sleep(Duration::from_secs_f32(seconds));
        running.stop();
        let s = samples.lock().unwrap();
        if s.is_empty() {
            return Ok(0.0);
        }
        let w = 2.0 * std::f64::consts::PI * 660.0 / 48_000.0;
        let coeff = 2.0 * w.cos();
        let (mut q1, mut q2) = (0.0f64, 0.0f64);
        for &x in s.iter() {
            let q0 = coeff * q1 - q2 + x as f64;
            q2 = q1;
            q1 = q0;
        }
        let power = q1 * q1 + q2 * q2 - coeff * q1 * q2;
        Ok((2.0 * power.sqrt() / s.len() as f64) as f32)
    };
    let db = |x: f32| 20.0 * x.max(1e-7).log10();

    let baseline = capture(CaptureMode::ExcludeSelf, 1.2)?;
    println!(
        "660 Hz level, nothing of ours playing:         {:7.1} dBFS",
        db(baseline)
    );

    // 1 + 2: child process plays the tone.
    let mut child = Command::new("powershell")
        .args(["-NoProfile", "-Command", &play])
        .spawn()?;
    std::thread::sleep(Duration::from_millis(500));
    let app_only = capture(CaptureMode::App { pid: child.id() }, 0.8)?;
    child.wait()?;
    let mut child = Command::new("powershell")
        .args(["-NoProfile", "-Command", &play])
        .spawn()?;
    std::thread::sleep(Duration::from_millis(500));
    let excluded = capture(CaptureMode::ExcludeSelf, 0.8)?;
    child.wait()?;
    println!(
        "child tone, mode app(child pid):              {:7.1} dBFS",
        db(app_only)
    );
    println!(
        "child tone, mode exclude_self:                {:7.1} dBFS",
        db(excluded)
    );

    // 3: same tone from a process that is NOT our descendant (created by WMI).
    let outside = format!(
        "Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{{CommandLine='powershell -NoProfile -WindowStyle Hidden -Command \"{}\"'}} | Out-Null",
        play.replace('\'', "''")
    );
    Command::new("powershell")
        .args(["-NoProfile", "-Command", &outside])
        .status()?;
    std::thread::sleep(Duration::from_millis(900));
    let foreign = capture(CaptureMode::ExcludeSelf, 0.8)?;
    println!("outside tone, mode exclude_self:              {:7.1} dBFS", db(foreign));

    let ok_app = db(app_only) > db(baseline) + 20.0;
    let ok_excluded = db(excluded) < db(baseline) + 6.0;
    let ok_foreign = db(foreign) > db(baseline) + 20.0;
    println!();
    println!(
        "[{}] app mode captures the target process",
        if ok_app { "PASS" } else { "FAIL" }
    );
    println!(
        "[{}] exclude_self drops our own process tree",
        if ok_excluded { "PASS" } else { "FAIL" }
    );
    println!(
        "[{}] exclude_self keeps other applications",
        if ok_foreign { "PASS" } else { "FAIL" }
    );
    let _ = std::fs::remove_file(&wav);
    if ok_app && ok_excluded && ok_foreign {
        Ok(())
    } else {
        anyhow::bail!("loopback probe failed")
    }
}

#[cfg(not(windows))]
fn main() {}
