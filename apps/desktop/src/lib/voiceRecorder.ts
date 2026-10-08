import { isDeviceError, micDeviceId } from "./settings";

/** Longest voice message (stops by itself). */
export const MAX_VOICE_MS = 10 * 60 * 1000;

/**
 * Records a voice message from the microphone chosen in the settings, with the
 * same echo cancellation / noise suppression as the calls. Opus in WebM, 48
 * kbps: ~360 KB per minute.
 */
export class VoiceRecorder {
  private recorder?: MediaRecorder;
  private stream?: MediaStream;
  private chunks: Blob[] = [];
  private started = 0;
  private timer?: ReturnType<typeof setTimeout>;
  onAutoStop?: () => void;

  async start(): Promise<void> {
    const audio = (deviceId: ConstrainDOMString | undefined) => ({
      deviceId,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    });
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: audio(micDeviceId()) });
    } catch (e) {
      // Chosen mic unplugged: record from the system default instead.
      if (!micDeviceId() || !isDeviceError(e)) throw e;
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: audio(undefined) });
    }
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "";
    this.recorder = new MediaRecorder(this.stream, { mimeType, audioBitsPerSecond: 48_000 });
    this.chunks = [];
    this.recorder.ondataavailable = (e) => {
      if (e.data.size) this.chunks.push(e.data);
    };
    this.recorder.start(1000);
    this.started = performance.now();
    this.timer = setTimeout(() => this.onAutoStop?.(), MAX_VOICE_MS);
  }

  elapsedMs(): number {
    return this.started ? performance.now() - this.started : 0;
  }

  /** Stops and returns the recording as a file ready to upload. */
  async stop(): Promise<File | null> {
    const rec = this.recorder;
    if (!rec) return null;
    const done = new Promise<void>((r) => rec.addEventListener("stop", () => r(), { once: true }));
    if (rec.state !== "inactive") rec.stop();
    await done;
    this.release();
    const blob = new Blob(this.chunks, { type: "audio/webm" });
    this.chunks = [];
    if (!blob.size) return null;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    return new File([blob], `mensagem-de-voz-${stamp}.webm`, { type: "audio/webm" });
  }

  cancel(): void {
    if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
    this.chunks = [];
    this.release();
  }

  private release() {
    clearTimeout(this.timer);
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = undefined;
    this.recorder = undefined;
    this.started = 0;
  }
}
