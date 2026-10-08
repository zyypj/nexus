//! Deterministic synthetic test signals at 48 kHz.
//!
//! These are *proxies*: a formant-filtered glottal pulse train for voice and
//! physically-motivated noise models. They make the benchmark reproducible
//! without shipping recordings. Real recordings can be dropped into
//! `tests/noise-bench/samples/` (see README) and are used instead.

use std::f32::consts::PI;

pub const SR: usize = 48_000;

/// xorshift64*: tiny deterministic PRNG.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed.max(1))
    }
    pub fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    /// Uniform in [-1, 1).
    pub fn uniform(&mut self) -> f32 {
        ((self.next_u64() >> 40) as f32 / (1u64 << 24) as f32) * 2.0 - 1.0
    }
    pub fn range(&mut self, lo: f32, hi: f32) -> f32 {
        lo + (self.uniform() * 0.5 + 0.5) * (hi - lo)
    }
}

/// Two-pole resonator (formant / resonance filter).
struct Resonator {
    a1: f32,
    a2: f32,
    gain: f32,
    y1: f32,
    y2: f32,
}

impl Resonator {
    fn new(freq: f32, bandwidth: f32) -> Self {
        let r = (-PI * bandwidth / SR as f32).exp();
        let theta = 2.0 * PI * freq / SR as f32;
        Self {
            a1: 2.0 * r * theta.cos(),
            a2: -r * r,
            gain: 1.0 - r,
            y1: 0.0,
            y2: 0.0,
        }
    }
    fn set(&mut self, freq: f32, bandwidth: f32) {
        let r = (-PI * bandwidth / SR as f32).exp();
        let theta = 2.0 * PI * freq / SR as f32;
        self.a1 = 2.0 * r * theta.cos();
        self.a2 = -r * r;
        self.gain = 1.0 - r;
    }
    fn tick(&mut self, x: f32) -> f32 {
        let y = self.gain * x + self.a1 * self.y1 + self.a2 * self.y2;
        self.y2 = self.y1;
        self.y1 = y;
        y
    }
}

/// Speech proxy: syllables (≈4/s) of vowels with intonation, plus pauses.
/// Returns (signal, voice-activity mask).
pub fn speech(seconds: f32, seed: u64) -> (Vec<f32>, Vec<bool>) {
    let n = (seconds * SR as f32) as usize;
    let mut rng = Rng::new(seed);
    // (F1, F2, F3) for a, e, i, o, u.
    const VOWELS: [(f32, f32, f32); 5] = [
        (730.0, 1090.0, 2440.0),
        (530.0, 1840.0, 2480.0),
        (270.0, 2290.0, 3010.0),
        (570.0, 840.0, 2410.0),
        (300.0, 870.0, 2240.0),
    ];
    let mut f = [
        Resonator::new(700.0, 90.0),
        Resonator::new(1200.0, 110.0),
        Resonator::new(2500.0, 160.0),
    ];
    let mut out = vec![0.0f32; n];
    let mut vad = vec![false; n];
    let mut phase = 0.0f32;
    let mut i = 0;
    while i < n {
        // A phrase of 4-10 syllables, then a pause of 0.4-1.2 s.
        let syllables = 4 + (rng.next_u64() % 7) as usize;
        let base_f0 = rng.range(105.0, 190.0);
        for s in 0..syllables {
            let len = (rng.range(0.16, 0.28) * SR as f32) as usize;
            let (f1, f2, f3) = VOWELS[(rng.next_u64() % 5) as usize];
            f[0].set(f1, 90.0);
            f[1].set(f2, 110.0);
            f[2].set(f3, 160.0);
            // Falling intonation across the phrase.
            let f0 = base_f0 * (1.0 - 0.15 * s as f32 / syllables as f32);
            for k in 0..len {
                if i >= n {
                    break;
                }
                let t = k as f32 / len as f32;
                let env = (PI * t).sin().powf(0.6);
                let vib = 1.0 + 0.01 * (2.0 * PI * 5.0 * i as f32 / SR as f32).sin();
                phase += f0 * vib / SR as f32;
                // Glottal pulse train with some aspiration noise.
                let pulse = if phase >= 1.0 {
                    phase -= 1.0;
                    1.0
                } else {
                    0.0
                };
                let src = pulse * 0.9 + rng.uniform() * 0.02;
                let v = f[0].tick(src) + 0.7 * f[1].tick(src) + 0.4 * f[2].tick(src);
                out[i] = v * env;
                vad[i] = env > 0.25;
                i += 1;
            }
        }
        i += (rng.range(0.4, 1.2) * SR as f32) as usize;
    }
    normalize(&mut out, 0.3);
    (out, vad)
}

pub fn normalize(x: &mut [f32], peak: f32) {
    let m = x.iter().fold(0.0f32, |a, v| a.max(v.abs()));
    if m > 0.0 {
        for v in x.iter_mut() {
            *v *= peak / m;
        }
    }
}

fn one_pole_lowpass(x: &mut [f32], cutoff: f32) {
    let a = (-2.0 * PI * cutoff / SR as f32).exp();
    let mut y = 0.0;
    for v in x.iter_mut() {
        y = (1.0 - a) * *v + a * y;
        *v = y;
    }
}

/// Pink noise (Paul Kellet's filter).
pub fn pink(n: usize, rng: &mut Rng) -> Vec<f32> {
    let (mut b0, mut b1, mut b2, mut b3, mut b4, mut b5, mut b6) = (0.0f32, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    (0..n)
        .map(|_| {
            let w = rng.uniform();
            b0 = 0.99886 * b0 + w * 0.0555179;
            b1 = 0.99332 * b1 + w * 0.0750759;
            b2 = 0.96900 * b2 + w * 0.1538520;
            b3 = 0.86650 * b3 + w * 0.3104856;
            b4 = 0.55000 * b4 + w * 0.5329522;
            b5 = -0.7616 * b5 - w * 0.0168980;
            let out = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
            b6 = w * 0.115926;
            out * 0.11
        })
        .collect()
}

/// Brown (red) noise: integrated white noise.
fn brown(n: usize, rng: &mut Rng) -> Vec<f32> {
    let mut y = 0.0f32;
    (0..n)
        .map(|_| {
            y = (y + rng.uniform() * 0.02) * 0.998;
            y
        })
        .collect()
}

/// Desk fan: broadband airflow + blade-pass tone + motor hum, slow wobble.
pub fn fan(n: usize, seed: u64) -> Vec<f32> {
    let mut rng = Rng::new(seed);
    let mut x = pink(n, &mut rng);
    one_pole_lowpass(&mut x, 3000.0);
    for (i, v) in x.iter_mut().enumerate() {
        let t = i as f32 / SR as f32;
        let wobble = 1.0 + 0.15 * (2.0 * PI * 0.7 * t).sin();
        *v = *v * wobble
            + 0.08 * (2.0 * PI * 87.0 * t).sin()
            + 0.04 * (2.0 * PI * 174.0 * t).sin()
            + 0.03 * (2.0 * PI * 120.0 * t).sin();
    }
    x
}

/// Air conditioner: low rumble + compressor hum + hiss.
pub fn air_conditioner(n: usize, seed: u64) -> Vec<f32> {
    let mut rng = Rng::new(seed);
    let rumble = brown(n, &mut rng);
    let mut hiss = pink(n, &mut rng);
    one_pole_lowpass(&mut hiss, 6000.0);
    (0..n)
        .map(|i| {
            let t = i as f32 / SR as f32;
            rumble[i] * 2.0 + hiss[i] * 0.5 + 0.05 * (2.0 * PI * 60.0 * t).sin() + 0.03 * (2.0 * PI * 180.0 * t).sin()
        })
        .collect()
}

/// A click: sharp attack, exponential decay, band-limited noise + body resonance.
fn add_click(x: &mut [f32], at: usize, amp: f32, decay_ms: f32, body_hz: f32, rng: &mut Rng) {
    let len = (decay_ms * 6.0 / 1000.0 * SR as f32) as usize;
    let mut res = Resonator::new(body_hz, body_hz * 0.3);
    for k in 0..len {
        let Some(slot) = x.get_mut(at + k) else { break };
        let env = (-(k as f32) / (decay_ms / 1000.0 * SR as f32)).exp();
        let s = rng.uniform();
        *slot += amp * env * (0.6 * s + 0.4 * res.tick(s) * 8.0);
    }
}

/// Mechanical keyboard typing: ~7 keys/s with press + release clicks, bursts.
pub fn keyboard(n: usize, seed: u64) -> Vec<f32> {
    let mut rng = Rng::new(seed);
    let mut x = vec![0.0f32; n];
    let mut i = 0usize;
    while i < n {
        let burst = 5 + (rng.next_u64() % 25) as usize;
        for _ in 0..burst {
            let amp = rng.range(0.4, 1.0);
            add_click(&mut x, i, amp, rng.range(2.0, 5.0), rng.range(1800.0, 4000.0), &mut rng);
            let release = i + (rng.range(0.05, 0.11) * SR as f32) as usize;
            add_click(&mut x, release, amp * 0.5, 2.0, 3000.0, &mut rng);
            i += (rng.range(0.08, 0.22) * SR as f32) as usize;
        }
        i += (rng.range(0.3, 1.5) * SR as f32) as usize;
    }
    x
}

/// Mouse: sparse double clicks and scroll-wheel ticks.
pub fn mouse(n: usize, seed: u64) -> Vec<f32> {
    let mut rng = Rng::new(seed);
    let mut x = vec![0.0f32; n];
    let mut i = (0.3 * SR as f32) as usize;
    while i < n {
        if rng.next_u64() % 3 == 0 {
            // Scroll: a run of soft ticks.
            for _ in 0..(6 + rng.next_u64() % 10) {
                add_click(&mut x, i, 0.25, 1.0, 5000.0, &mut rng);
                i += (0.035 * SR as f32) as usize;
            }
        } else {
            add_click(&mut x, i, 0.7, 1.5, 2500.0, &mut rng);
            add_click(&mut x, i + (0.09 * SR as f32) as usize, 0.5, 1.5, 2500.0, &mut rng);
        }
        i += (rng.range(0.4, 1.6) * SR as f32) as usize;
    }
    x
}

/// Room ambience: soft pink background + distant hum + occasional thump.
pub fn ambient(n: usize, seed: u64) -> Vec<f32> {
    let mut rng = Rng::new(seed);
    let mut x = pink(n, &mut rng);
    one_pole_lowpass(&mut x, 2000.0);
    for (i, v) in x.iter_mut().enumerate() {
        let t = i as f32 / SR as f32;
        *v += 0.01 * (2.0 * PI * 50.0 * t).sin();
    }
    let mut i = SR;
    while i < n {
        add_click(&mut x, i, 0.15, 25.0, 120.0, &mut rng);
        i += (rng.range(2.0, 5.0) * SR as f32) as usize;
    }
    x
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic() {
        assert_eq!(fan(1000, 7), fan(1000, 7));
        let (a, _) = speech(1.0, 3);
        let (b, _) = speech(1.0, 3);
        assert_eq!(a, b);
    }

    #[test]
    fn speech_has_pauses() {
        let (_, vad) = speech(10.0, 1);
        let active = vad.iter().filter(|v| **v).count() as f32 / vad.len() as f32;
        assert!(active > 0.2 && active < 0.9, "active ratio {active}");
    }
}
