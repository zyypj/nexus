#!/usr/bin/env node
// Synthesizes the UI sounds (no third-party assets) as small mono WAV files
// shared by both apps:
//   apps/desktop/public/sounds/<name>.wav
//   apps/android/android/app/src/main/res/raw/<name>.wav
// Usage: node scripts/gen-sounds.mjs   (deterministic; commit the output)
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = [join(ROOT, "apps/desktop/public/sounds"), join(ROOT, "apps/android/android/app/src/main/res/raw")];
const RATE = 32_000;

/** A note: frequency (Hz), start and length (s), gain, decay time constant (s). */
const note = (freq, start, len, { gain = 0.5, decay = 0.12, bell = 0 } = {}) => ({ freq, start, len, gain, decay, bell });

function render(totalSeconds, notes) {
  const out = new Float32Array(Math.ceil(totalSeconds * RATE));
  for (const n of notes) {
    const from = Math.floor(n.start * RATE);
    const count = Math.floor(n.len * RATE);
    for (let i = 0; i < count && from + i < out.length; i++) {
      const t = i / RATE;
      const attack = Math.min(1, t / 0.006);
      const release = Math.min(1, (n.len - t) / 0.02);
      const env = attack * release * Math.exp(-t / n.decay);
      let s = Math.sin(2 * Math.PI * n.freq * t) + 0.18 * Math.sin(4 * Math.PI * n.freq * t);
      // Inharmonic partial gives a soft bell colour.
      if (n.bell) s += n.bell * Math.sin(2 * Math.PI * n.freq * 2.76 * t) * Math.exp(-t / (n.decay / 3));
      out[from + i] += s * env * n.gain;
    }
  }
  return out;
}

function wav(samples) {
  const peak = Math.max(1e-9, ...samples.map(Math.abs));
  const scale = Math.min(1, 0.85 / peak);
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(Math.round(s * scale * 32767), i * 2));
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

const seq = (freqs, step, opts) => freqs.map((f, i) => note(f, i * step, step + 0.12, opts));
const C5 = 523.25, E5 = 659.25, G5 = 783.99, A4 = 440, A5 = 880, B5 = 987.77, E6 = 1318.5, D5 = 587.33;

const ringBurst = (start) =>
  [0, 0.11, 0.22, 0.33].flatMap((d, i) => [
    note(i % 2 ? E5 : G5, start + d, 0.12, { gain: 0.35, decay: 0.2 }),
    note(i % 2 ? B5 : A5 * 1.06, start + d, 0.12, { gain: 0.2, decay: 0.2 }),
  ]);

const SOUNDS = {
  join: [0.32, seq([E5, A5], 0.09, { gain: 0.5, decay: 0.12 })],
  leave: [0.32, seq([A5, E5], 0.09, { gain: 0.5, decay: 0.12 })],
  mute: [0.22, seq([A4 * 1.5, A4], 0.06, { gain: 0.45, decay: 0.06 })],
  unmute: [0.22, seq([A4, A4 * 1.5], 0.06, { gain: 0.45, decay: 0.06 })],
  deafen: [0.3, seq([E5, C5, A4], 0.06, { gain: 0.45, decay: 0.06 })],
  undeafen: [0.3, seq([A4, C5, E5], 0.06, { gain: 0.45, decay: 0.06 })],
  screen_start: [0.4, seq([C5, E5, G5], 0.07, { gain: 0.4, decay: 0.1 })],
  screen_stop: [0.4, seq([G5, E5, C5], 0.07, { gain: 0.4, decay: 0.1 })],
  message: [0.6, [note(B5, 0, 0.5, { gain: 0.45, decay: 0.14, bell: 0.25 }), note(E6, 0.09, 0.5, { gain: 0.4, decay: 0.18, bell: 0.25 })]],
  // Loops: incoming ring (two bursts, then a pause) and outgoing ringback.
  ring: [2.6, [...ringBurst(0), ...ringBurst(0.6)]],
  calling: [3, [note(D5, 0, 1, { gain: 0.25, decay: 5 }), note(D5 * 1.19, 0, 1, { gain: 0.2, decay: 5 })]],
};

for (const dir of OUT) mkdirSync(dir, { recursive: true });
for (const [name, [seconds, notes]] of Object.entries(SOUNDS)) {
  const file = wav(render(seconds, notes));
  for (const dir of OUT) writeFileSync(join(dir, `${name}.wav`), file);
  console.log(`${name}.wav ${(file.length / 1024).toFixed(0)} KB`);
}
