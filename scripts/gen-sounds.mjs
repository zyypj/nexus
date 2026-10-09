#!/usr/bin/env node
// Synthesizes the UI sounds (no third-party assets) as small mono WAV files
// shared by both apps:
//   apps/desktop/public/sounds/<name>.wav
//   apps/android/android/app/src/main/res/raw/<name>.wav
// Usage: node scripts/gen-sounds.mjs   (deterministic; commit the output)
//
// Sound design: soft, rounded "bloops" in the mid register (notes between
// A3 and A5, where the ear is least sensitive to harshness), with a pitch scoop
// at the onset, a short FM "pop" instead of a hard click, a low-pass on top, a
// small room reverb, and loudness-matched levels well below full scale.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = [join(ROOT, "apps/desktop/public/sounds"), join(ROOT, "apps/android/android/app/src/main/res/raw")];
const RATE = 48_000;
const TAU = 2 * Math.PI;

/** Deterministic PRNG (mulberry32) for noise and dither. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const db = (x) => 10 ** (x / 20);

/**
 * One tone added to `out` at `start` seconds. The pitch scoops in from
 * `freq * glide` with time constant `glideTime` (a bubble or a struck bar
 * settling); an FM modulator gives a bright onset that fades in `fmDecay`
 * ("pop") over a sine body; `partials` are [ratio, gain, decay] overtones.
 */
function tone(out, start, freq, o) {
  const { gain = 1, attack = 0.002, decay = 0.1, glide = 1, glideTime = 0.015 } = o;
  const { fm = 0, fmRatio = 1, fmDecay = 0.02, partials = [] } = o;
  const from = Math.round(start * RATE);
  const len = Math.min(out.length - from, Math.ceil((attack + decay * 9.2) * RATE));
  let phase = 0;
  let mod = 0;
  for (let i = 0; i < len; i++) {
    const t = i / RATE;
    const f = freq * (1 + (glide - 1) * Math.exp(-t / glideTime));
    phase += (TAU * f) / RATE;
    mod += (TAU * f * fmRatio) / RATE;
    const env = (t < attack ? 0.5 - 0.5 * Math.cos((Math.PI * t) / attack) : 1) * Math.exp(-t / decay);
    let s = Math.sin(phase + fm * Math.exp(-t / fmDecay) * Math.sin(mod));
    for (const [r, g, d] of partials) s += g * Math.exp(-t / d) * Math.sin(phase * r);
    out[from + i] += s * env * gain;
  }
}

/** Band-passed noise sweeping from f0 to f1 Hz: an airy "whoosh". */
function swoosh(out, start, len, f0, f1, { gain = 0.3, q = 1.4, seed = 7 } = {}) {
  const rand = rng(seed);
  const from = Math.round(start * RATE);
  const n = Math.min(out.length - from, Math.round(len * RATE));
  let low = 0;
  let band = 0;
  for (let i = 0; i < n; i++) {
    const x = i / n;
    const fc = f0 * (f1 / f0) ** x;
    const k = 2 * Math.sin((Math.PI * fc) / RATE);
    low += k * band;
    const high = rand() * 2 - 1 - low - band / q;
    band += k * high;
    out[from + i] += band * Math.sin(Math.PI * x) ** 2 * gain;
  }
}

/** RBJ biquad, in place. */
function biquad(x, type, fc, q = 0.707) {
  const w = (TAU * fc) / RATE;
  const cs = Math.cos(w);
  const al = Math.sin(w) / (2 * q);
  const [b0, b1, b2] = type === "lp" ? [(1 - cs) / 2, 1 - cs, (1 - cs) / 2] : [(1 + cs) / 2, -(1 + cs), (1 + cs) / 2];
  const a0 = 1 + al;
  const a1 = -2 * cs;
  const a2 = 1 - al;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = y;
    x[i] = y;
  }
}

/** Small mono room (Freeverb topology), mixed in place. */
function room(x, wet) {
  const k = RATE / 44_100;
  const combs = [1116, 1188, 1277, 1356, 1422, 1491].map((n) => ({ buf: new Float32Array(Math.round(n * k)), i: 0, z: 0 }));
  const passes = [556, 441, 341].map((n) => ({ buf: new Float32Array(Math.round(n * k)), i: 0 }));
  const pre = Math.round(0.01 * RATE);
  const tail = new Float32Array(x.length);
  for (let n = 0; n < x.length; n++) {
    const input = (n >= pre ? x[n - pre] : 0) * 0.05;
    let y = 0;
    for (const c of combs) {
      const v = c.buf[c.i];
      c.z = v * 0.6 + c.z * 0.4; // damping: highs die first
      c.buf[c.i] = input + c.z * 0.74;
      c.i = (c.i + 1) % c.buf.length;
      y += v;
    }
    for (const p of passes) {
      const v = p.buf[p.i];
      p.buf[p.i] = y + v * 0.5;
      p.i = (p.i + 1) % p.buf.length;
      y = v - y;
    }
    tail[n] = y;
  }
  biquad(tail, "hp", 300);
  for (let n = 0; n < x.length; n++) x[n] += tail[n] * wet;
}

/** Highest RMS over 30 ms windows: a simple short-term loudness. */
function loudness(x) {
  const w = Math.round(0.03 * RATE);
  let sum = 0;
  let best = 0;
  for (let i = 0; i < x.length; i++) {
    sum += x[i] * x[i];
    if (i >= w) sum -= x[i - w] * x[i - w];
    best = Math.max(best, sum);
  }
  return Math.sqrt(Math.max(best, 0) / w);
}

/**
 * Renders one sound: `seconds` long, `draw(buffer)` adds the tones, then
 * filtering, reverb, loudness matching (`level` dBFS short-term RMS, peaks
 * capped at -3 dBFS) and edge fades. Loops are rendered with extra time and
 * the reverb tail is folded back onto the start, so they repeat seamlessly.
 */
function render(seconds, draw, { level = -15, wet = 0.14, bright = 6500, loop = false } = {}) {
  const len = Math.round(seconds * RATE);
  let x = new Float32Array(len + Math.round((loop ? 1.5 : 0.05) * RATE));
  draw(x);
  biquad(x, "hp", 110);
  biquad(x, "lp", bright, 0.6);
  room(x, wet);
  if (loop) {
    const folded = new Float32Array(len);
    for (let i = 0; i < x.length; i++) folded[i % len] += x[i];
    x = folded;
  } else {
    x = x.subarray(0, len);
    const fade = Math.round(0.03 * RATE);
    for (let i = 0; i < fade; i++) x[len - 1 - i] *= i / fade;
  }
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  const scale = Math.min(db(level) / loudness(x), db(-3) / peak);
  for (let i = 0; i < x.length; i++) x[i] *= scale;
  return x;
}

function wav(samples) {
  const rand = rng(1);
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => {
    const dither = rand() - rand(); // TPDF, ±1 LSB
    const v = Math.round(s * 32767 + dither);
    data.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i * 2);
  });
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

// Notes (Hz).
const A3 = 220, D4 = 293.66, A4 = 440, B4 = 493.88, Cs5 = 554.37, D5 = 587.33, E5 = 659.25, Fs5 = 739.99, Gs5 = 830.61, A5 = 880;

// Timbres.
/** Rounded "bloop": sine body, quick FM pop, scoops up into pitch, sub-octave warmth. */
const BLOOP = { attack: 0.0025, decay: 0.075, glide: 0.8, glideTime: 0.012, fm: 1.1, fmDecay: 0.016, partials: [[2, 0.1, 0.025], [0.5, 0.22, 0.06]] };
/** Wooden bar (marimba-like): the bar's ~4x overtone and a little click die fast. */
const MALLET = { attack: 0.0015, decay: 0.26, fm: 0.3, fmRatio: 1, fmDecay: 0.01, partials: [[3.93, 0.2, 0.022], [9.2, 0.04, 0.007]] };
/** Soft, slow-attack tone for the bass and the ringback. */
const SOFT = { attack: 0.012, decay: 0.32, fm: 0.45, fmRatio: 2, fmDecay: 0.06, partials: [[2, 0.08, 0.12]] };

const with_ = (base, o) => ({ ...base, ...o });

const SOUNDS = {
  // Two bloops a fifth apart, up (join) or down, softer and darker (leave).
  join: [0.55, (x) => {
    tone(x, 0, D5, with_(BLOOP, { gain: 0.75, decay: 0.09 }));
    tone(x, 0.085, A5, with_(BLOOP, { decay: 0.11 }));
  }],
  leave: [0.55, (x) => {
    tone(x, 0, A5, with_(BLOOP, { gain: 0.85, decay: 0.09, glide: 1.12 }));
    tone(x, 0.085, D5, with_(BLOOP, { decay: 0.12, glide: 1.12 }));
  }, { bright: 4500 }],
  // One short bloop that slides down (mute) or up (unmute).
  mute: [0.3, (x) => tone(x, 0, B4, with_(BLOOP, { decay: 0.06, glide: 1.4, glideTime: 0.03 })), { level: -17 }],
  unmute: [0.3, (x) => tone(x, 0, Fs5, with_(BLOOP, { decay: 0.06, glide: 0.68, glideTime: 0.025 })), { level: -17 }],
  // Two lower steps closing (deafen) or opening (undeafen).
  deafen: [0.4, (x) => {
    tone(x, 0, E5, with_(BLOOP, { gain: 0.85, decay: 0.06, glide: 1.1 }));
    tone(x, 0.075, A4, with_(BLOOP, { decay: 0.08, glide: 1.1 }));
  }, { level: -16, bright: 5000 }],
  undeafen: [0.4, (x) => {
    tone(x, 0, A4, with_(BLOOP, { gain: 0.85, decay: 0.06 }));
    tone(x, 0.075, E5, with_(BLOOP, { decay: 0.08 }));
  }, { level: -16 }],
  // Whoosh plus a quick wooden arpeggio, rising (start) or falling (stop).
  screen_start: [0.75, (x) => {
    swoosh(x, 0, 0.34, 350, 2600, { gain: 0.12 });
    [A4, E5, A5].forEach((f, i) => tone(x, 0.13 + i * 0.065, f, with_(MALLET, { gain: 0.8 + i * 0.1, decay: 0.18 })));
  }],
  screen_stop: [0.65, (x) => {
    swoosh(x, 0, 0.3, 2600, 350, { gain: 0.1, seed: 11 });
    [A5, E5, A4].forEach((f, i) => tone(x, i * 0.065, f, with_(MALLET, { gain: 0.9, decay: 0.16 })));
  }, { bright: 5000 }],
  // A single water-drop "bloop" with a wide upward scoop.
  message: [0.45, (x) => tone(x, 0, Gs5, with_(BLOOP, { decay: 0.085, glide: 0.62, glideTime: 0.02, fm: 0.8, partials: [[0.5, 0.2, 0.07], [2, 0.06, 0.02]] }))],
  // Loops. Incoming: a calm marimba phrase over a soft I-IV bass, then a rest.
  ring: [2.8, (x) => {
    const phrase = [[0, Cs5], [0.13, E5], [0.26, A5], [0.39, E5], [0.65, Fs5, 0.9], [0.78, E5, 1, 0.5]];
    for (const [t, f, g = 0.85, d = 0.26] of phrase) tone(x, t, f, with_(MALLET, { gain: g, decay: d }));
    tone(x, 0.78, Cs5, with_(MALLET, { gain: 0.35, decay: 0.5 }));
    tone(x, 0, A3, with_(SOFT, { gain: 0.45, decay: 0.45 }));
    tone(x, 0.65, D4, with_(SOFT, { gain: 0.4, decay: 0.55 }));
  }, { loop: true, level: -14, wet: 0.18, bright: 5500 }],
  // Outgoing ringback: a gentle two-note "doo-doo" every 2.4 s.
  calling: [2.4, (x) => {
    tone(x, 0, E5, with_(SOFT, { gain: 0.8 }));
    tone(x, 0, A4, with_(SOFT, { gain: 0.35 }));
    tone(x, 0.32, Cs5, with_(SOFT, { gain: 0.7, decay: 0.4 }));
    tone(x, 0.32, A4, with_(SOFT, { gain: 0.3, decay: 0.4 }));
  }, { loop: true, level: -19, wet: 0.2, bright: 4000 }],
};

for (const dir of OUT) mkdirSync(dir, { recursive: true });
for (const [name, [seconds, draw, opts]] of Object.entries(SOUNDS)) {
  const file = wav(render(seconds, draw, opts));
  for (const dir of OUT) writeFileSync(join(dir, `${name}.wav`), file);
  console.log(`${name}.wav ${(file.length / 1024).toFixed(0)} KB`);
}
