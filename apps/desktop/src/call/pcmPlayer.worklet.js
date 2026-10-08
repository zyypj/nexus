// AudioWorklet that plays interleaved stereo f32 PCM pushed from the main
// thread (system audio captured natively by Rust). Fixed-size ring buffer,
// no allocation in process().
const CAPACITY = 48000; // 1 s of stereo frames
const TARGET = 2880; // 60 ms: latency we aim to keep
const MAX = 9600; // 200 ms: drop old audio beyond this (clock drift / stalls)

class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.left = new Float32Array(CAPACITY);
    this.right = new Float32Array(CAPACITY);
    this.read = 0;
    this.write = 0;
    this.size = 0;
    this.primed = false;
    this.port.onmessage = (e) => {
      if (e.data === "reset") {
        this.read = this.write = this.size = 0;
        this.primed = false;
        return;
      }
      this.push(new Float32Array(e.data));
    };
  }

  push(interleaved) {
    const frames = interleaved.length >> 1;
    for (let i = 0; i < frames; i++) {
      this.left[this.write] = interleaved[2 * i];
      this.right[this.write] = interleaved[2 * i + 1];
      this.write = (this.write + 1) % CAPACITY;
    }
    this.size += frames;
    if (this.size > MAX) {
      // Catch up after a stall instead of accumulating latency forever.
      const drop = this.size - TARGET;
      this.read = (this.read + drop) % CAPACITY;
      this.size = TARGET;
    }
    if (this.size >= TARGET) this.primed = true;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const l = out[0];
    const r = out[1] || out[0];
    const n = l.length;
    if (!this.primed || this.size < n) {
      l.fill(0);
      if (r !== l) r.fill(0);
      if (this.size < n) this.primed = false;
      return true;
    }
    for (let i = 0; i < n; i++) {
      l[i] = this.left[this.read];
      r[i] = this.right[this.read];
      this.read = (this.read + 1) % CAPACITY;
    }
    this.size -= n;
    return true;
  }
}

registerProcessor("nexus-pcm-player", PcmPlayer);
