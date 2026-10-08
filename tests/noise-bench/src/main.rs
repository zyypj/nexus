//! Objective benchmark for Nexus "Enhanced" noise suppression (RNNoise, via
//! its Rust port nnnoiseless — the same algorithm and weights the desktop app
//! runs as WASM in an AudioWorklet).
//!
//! For each noise type and SNR it mixes voice + noise, denoises, and reports:
//! - SI-SDR before/after (dB): overall quality vs the clean voice;
//! - noise reduction in pauses (dB): how much noise is removed when nobody talks;
//! - voice preservation (dB): level change of the voice while talking
//!   (0 dB = untouched, negative = voice attenuated);
//! - CPU per 10 ms frame and real-time factor;
//! - added latency (measured by cross-correlation);
//! - memory allocated per denoiser instance.
//!
//! Usage: cargo run --release -p nexus-noise-bench [-- --out <dir>]

mod signals;

use std::{
    alloc::{GlobalAlloc, Layout, System},
    path::{Path, PathBuf},
    sync::atomic::{AtomicUsize, Ordering},
    time::Instant,
};

use nnnoiseless::DenoiseState;
use signals::SR;

/// Counts heap bytes so the memory cost of one denoiser can be measured exactly.
struct Counting;
static ALLOCATED: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        ALLOCATED.fetch_add(layout.size(), Ordering::Relaxed);
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        ALLOCATED.fetch_sub(layout.size(), Ordering::Relaxed);
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

const SECONDS: f32 = 30.0;
const FRAME: usize = DenoiseState::FRAME_SIZE;

fn rms(x: &[f32]) -> f32 {
    (x.iter().map(|v| v * v).sum::<f32>() / x.len().max(1) as f32).sqrt()
}

fn db(x: f32) -> f32 {
    10.0 * x.max(1e-12).log10()
}

/// Scale-invariant signal-to-distortion ratio.
fn si_sdr(estimate: &[f32], reference: &[f32]) -> f32 {
    let dot: f64 = estimate.iter().zip(reference).map(|(a, b)| *a as f64 * *b as f64).sum();
    let ref_energy: f64 = reference.iter().map(|v| (*v as f64).powi(2)).sum();
    let alpha = dot / ref_energy.max(1e-12);
    let (mut target, mut residual) = (0.0f64, 0.0f64);
    for (e, r) in estimate.iter().zip(reference) {
        let t = alpha * *r as f64;
        target += t * t;
        residual += (*e as f64 - t).powi(2);
    }
    db((target / residual.max(1e-12)) as f32)
}

/// Delay (samples) that maximises correlation between `y` and `x`.
fn estimate_delay(y: &[f32], x: &[f32], max_lag: usize) -> usize {
    let n = x.len().min(y.len()).min(SR * 5);
    (0..max_lag)
        .max_by(|&a, &b| {
            let ca: f32 = (0..n - max_lag).map(|i| x[i] * y[i + a]).sum();
            let cb: f32 = (0..n - max_lag).map(|i| x[i] * y[i + b]).sum();
            ca.total_cmp(&cb)
        })
        .unwrap_or(0)
}

struct Denoised {
    out: Vec<f32>,
    micros_per_frame: f64,
}

/// Gate driven by RNNoise's own voice-activity probability: transients the
/// network leaves behind (keyboard, mouse) are attenuated between words.
/// Opens instantly, holds 200 ms, closes over ~50 ms to `floor`.
pub struct VadGate {
    gain: f32,
    hold: usize,
    pub floor: f32,
    pub threshold: f32,
}

impl VadGate {
    pub fn new() -> Self {
        Self {
            gain: 1.0,
            hold: 0,
            floor: 0.1,
            threshold: 0.6,
        }
    }

    pub fn apply(&mut self, frame: &mut [f32], vad: f32) {
        const HOLD_FRAMES: usize = 20;
        let target = if vad >= self.threshold {
            self.hold = HOLD_FRAMES;
            1.0
        } else if self.hold > 0 {
            self.hold -= 1;
            1.0
        } else {
            self.floor
        };
        let n = frame.len() as f32;
        let start = self.gain;
        // Fast attack (1 frame), slower release (~5 frames).
        let end = if target > start { target } else { start + (target - start) * 0.2 };
        for (k, v) in frame.iter_mut().enumerate() {
            *v *= start + (end - start) * (k as f32 / n);
        }
        self.gain = end;
    }
}

fn denoise(input: &[f32]) -> Denoised {
    denoise_with(input, None)
}

fn denoise_with(input: &[f32], mut gate: Option<VadGate>) -> Denoised {
    let mut state = DenoiseState::new();
    let mut out = vec![0.0f32; input.len()];
    let mut buf_in = [0.0f32; FRAME];
    let mut buf_out = [0.0f32; FRAME];
    let frames = input.len() / FRAME;
    let t0 = Instant::now();
    for f in 0..frames {
        // RNNoise works on int16-scaled floats.
        for (k, v) in buf_in.iter_mut().enumerate() {
            *v = input[f * FRAME + k] * 32768.0;
        }
        let vad = state.process_frame(&mut buf_out, &buf_in);
        if let Some(g) = gate.as_mut() {
            g.apply(&mut buf_out, vad);
        }
        for (k, v) in buf_out.iter().enumerate() {
            out[f * FRAME + k] = v / 32768.0;
        }
    }
    let elapsed = t0.elapsed().as_secs_f64();
    Denoised {
        out,
        micros_per_frame: elapsed * 1e6 / frames.max(1) as f64,
    }
}

fn write_wav(path: &Path, x: &[f32]) -> anyhow::Result<()> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: SR as u32,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut w = hound::WavWriter::create(path, spec)?;
    for v in x {
        w.write_sample((v.clamp(-1.0, 1.0) * 32767.0) as i16)?;
    }
    w.finalize()?;
    Ok(())
}

/// Loads a mono/stereo WAV and resamples (linearly) to 48 kHz.
fn read_wav(path: &Path) -> anyhow::Result<Vec<f32>> {
    let mut r = hound::WavReader::open(path)?;
    let spec = r.spec();
    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => r.samples::<f32>().collect::<Result<_, _>>()?,
        hound::SampleFormat::Int => {
            let scale = (1i64 << (spec.bits_per_sample - 1)) as f32;
            r.samples::<i32>().map(|s| s.map(|v| v as f32 / scale)).collect::<Result<_, _>>()?
        }
    };
    let ch = spec.channels as usize;
    let mono: Vec<f32> = samples.chunks(ch).map(|c| c.iter().sum::<f32>() / ch as f32).collect();
    if spec.sample_rate as usize == SR {
        return Ok(mono);
    }
    let ratio = spec.sample_rate as f64 / SR as f64;
    let n = (mono.len() as f64 / ratio) as usize;
    Ok((0..n)
        .map(|i| {
            let p = i as f64 * ratio;
            let j = p as usize;
            let frac = (p - j as f64) as f32;
            let a = mono[j.min(mono.len() - 1)];
            let b = mono[(j + 1).min(mono.len() - 1)];
            a + (b - a) * frac
        })
        .collect())
}

fn fit_len(mut x: Vec<f32>, n: usize) -> Vec<f32> {
    if x.is_empty() {
        return vec![0.0; n];
    }
    let orig = x.len();
    while x.len() < n {
        let take = (n - x.len()).min(orig);
        let copy: Vec<f32> = x[..take].to_vec();
        x.extend(copy);
    }
    x.truncate(n);
    x
}

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let out_dir = args
        .iter()
        .position(|a| a == "--out")
        .and_then(|i| args.get(i + 1))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("tests/noise-bench/out"));
    std::fs::create_dir_all(&out_dir)?;
    let samples_dir = PathBuf::from("tests/noise-bench/samples");

    let n = (SECONDS * SR as f32) as usize;
    let (mut voice, mut vad) = signals::speech(SECONDS, 42);
    let real_voice = samples_dir.join("speech.wav");
    let voice_source = if real_voice.exists() {
        voice = fit_len(read_wav(&real_voice)?, n);
        // Energy-based VAD for real recordings (20 ms windows, -35 dB from peak).
        let win = SR / 50;
        let peak = voice.chunks(win).map(rms).fold(0.0, f32::max);
        vad = voice
            .chunks(win)
            .flat_map(|c| {
                let active = rms(c) > peak * 0.018;
                std::iter::repeat_n(active, c.len())
            })
            .collect();
        "samples/speech.wav (real recording)"
    } else {
        "synthetic formant voice"
    };

    let noises: Vec<(&str, Vec<f32>)> = ["fan", "keyboard", "mouse", "air_conditioner", "ambient"]
        .iter()
        .map(|name| {
            let file = samples_dir.join(format!("{name}.wav"));
            let sig = if file.exists() {
                read_wav(&file).map(|x| fit_len(x, n)).unwrap_or_default()
            } else {
                match *name {
                    "fan" => signals::fan(n, 11),
                    "keyboard" => signals::keyboard(n, 12),
                    "mouse" => signals::mouse(n, 13),
                    "air_conditioner" => signals::air_conditioner(n, 14),
                    _ => signals::ambient(n, 15),
                }
            };
            (*name, sig)
        })
        .collect();

    // Memory of one denoiser instance.
    let before = ALLOCATED.load(Ordering::Relaxed);
    let probe = DenoiseState::new();
    let state_bytes = ALLOCATED.load(Ordering::Relaxed) - before;
    drop(probe);

    println!("# Nexus noise suppression benchmark (RNNoise / nnnoiseless)\n");
    println!("voice: {voice_source}; {SECONDS} s per case; 48 kHz mono; frame {FRAME} samples (10 ms)\n");
    println!(
        "| noise | input SNR | SI-SDR in | SI-SDR out | Δ SI-SDR | noise reduction in pauses | voice level change | µs / 10 ms frame |"
    );
    println!("|---|---|---|---|---|---|---|---|");

    let mut worst_frame = 0.0f64;
    let mut total_frame = 0.0f64;
    let mut cases = 0;
    let mut measured_delay = 0;
    for (name, noise) in &noises {
        let noise_rms = rms(noise).max(1e-9);
        let speech_rms = {
            let active: Vec<f32> = voice.iter().zip(&vad).filter(|(_, a)| **a).map(|(v, _)| *v).collect();
            rms(&active)
        };
        for snr in [0.0f32, 5.0, 10.0] {
            let gain = speech_rms / (noise_rms * 10f32.powf(snr / 20.0));
            let scaled: Vec<f32> = noise.iter().map(|v| v * gain).collect();
            let noisy: Vec<f32> = voice.iter().zip(&scaled).map(|(v, s)| v + s).collect();
            let result = if std::env::var_os("NEXUS_BENCH_GATE").is_some() {
                denoise_with(&noisy, Some(VadGate::new()))
            } else {
                denoise(&noisy)
            };
            if measured_delay == 0 {
                measured_delay = estimate_delay(&result.out, &voice, 2 * FRAME);
            }
            // Align output to the input timeline before comparing.
            let d = measured_delay;
            let out: Vec<f32> = result.out[d..].to_vec();
            let m = out.len();
            let clean = &voice[..m];
            let noisy_aligned = &noisy[..m];
            let (pause_in, pause_out): (Vec<f32>, Vec<f32>) = (0..m)
                .filter(|&i| !vad[i])
                .map(|i| (noisy_aligned[i], out[i]))
                .unzip();
            let (talk_clean, talk_out): (Vec<f32>, Vec<f32>) =
                (0..m).filter(|&i| vad[i]).map(|i| (clean[i], out[i])).unzip();
            let si_in = si_sdr(noisy_aligned, clean);
            let si_out = si_sdr(&out, clean);
            let reduction = db(rms(&pause_in).powi(2)) - db(rms(&pause_out).powi(2));
            let voice_change = db(rms(&talk_out).powi(2)) - db(rms(&talk_clean).powi(2));
            println!(
                "| {name} | {snr:.0} dB | {si_in:.1} dB | {si_out:.1} dB | {:+.1} dB | {reduction:.1} dB | {voice_change:+.1} dB | {:.1} |",
                si_out - si_in,
                result.micros_per_frame
            );
            worst_frame = worst_frame.max(result.micros_per_frame);
            total_frame += result.micros_per_frame;
            cases += 1;
            if snr == 5.0 {
                write_wav(&out_dir.join(format!("{name}_snr5_noisy.wav")), &noisy)?;
                write_wav(&out_dir.join(format!("{name}_snr5_denoised.wav")), &result.out)?;
            }
        }
    }
    write_wav(&out_dir.join("voice_clean.wav"), &voice)?;
    let avg = total_frame / cases as f64;
    println!();
    println!("CPU: avg {avg:.1} µs per 10 ms frame (worst case {worst_frame:.1} µs)");
    println!(
        "   = {:.2}% of one core in real time (real-time factor {:.4})",
        avg / 10_000.0 * 100.0,
        avg / 10_000.0
    );
    println!(
        "Latency added by the algorithm: {measured_delay} samples = {:.1} ms (plus up to 10 ms of frame buffering in the AudioWorklet)",
        measured_delay as f32 * 1000.0 / SR as f32
    );
    println!("Memory per denoiser instance: {:.1} KiB of heap", state_bytes as f64 / 1024.0);
    println!("\nWAV files for listening were written to {}", out_dir.display());
    Ok(())
}
