import { Channel } from "@tauri-apps/api/core";
import { invoke, isTauri } from "../lib/platform";

/** A monitor or window offered by the share picker (src-tauri/src/screen_capture.rs). */
export interface CaptureSource {
  id: string;
  kind: "screen" | "window";
  name: string;
  app: string | null;
  pid: number | null;
  thumbnail: string | null;
  width: number;
  height: number;
  primary: boolean;
}

export interface CaptureTarget {
  fps: number;
  maxWidth: number;
  maxHeight: number;
}

type CaptureEvent =
  | { type: "frame"; generation: number; slot: number; width: number; height: number; timestamp: number }
  | { type: "closed" };

interface SharedBufferEvent extends Event {
  additionalData: { nexusCapture?: number; slot?: number } | null;
  getBuffer(): ArrayBuffer;
}

interface WebView2Bridge {
  addEventListener(type: "sharedbufferreceived", fn: (e: SharedBufferEvent) => void): void;
  removeEventListener(type: "sharedbufferreceived", fn: (e: SharedBufferEvent) => void): void;
  releaseBuffer(buffer: ArrayBuffer): void;
}

interface TrackGenerator extends MediaStreamTrack {
  writable: WritableStream<VideoFrame>;
}
declare const MediaStreamTrackGenerator: { new (init: { kind: "video" }): TrackGenerator } | undefined;

const bridge = (): WebView2Bridge | undefined => (window as unknown as { chrome?: { webview?: WebView2Bridge } }).chrome?.webview;

/** Slot header: u32 state (1 = frame ready, we write 0 when done), width, height. */
const HEADER = 16;

export function nativeCaptureAvailable(): boolean {
  return isTauri && !!bridge() && typeof MediaStreamTrackGenerator !== "undefined";
}

export async function nativeCaptureSupported(): Promise<boolean> {
  return nativeCaptureAvailable() && (await invoke<boolean>("capture_supported").catch(() => false));
}

export function listCaptureSources(): Promise<CaptureSource[]> {
  return invoke<CaptureSource[]>("capture_sources");
}

/**
 * Screen/window capture without getDisplayMedia: Rust writes frames into
 * WebView2 shared memory and we turn them into a video track. No browser
 * picker and no "sharing your screen" bar.
 */
export class NativeScreenCapture {
  track?: MediaStreamTrack;
  /** Called when the captured window closes. */
  onEnded?: () => void;
  /** Size of the last frame (the encoder scales it to the target). */
  size = { width: 0, height: 0 };

  private writer?: WritableStreamDefaultWriter<VideoFrame>;
  private buffers = new Map<number, Map<number, ArrayBuffer>>();
  private last?: VideoFrame;
  private lastWrite = 0;
  private repeat?: ReturnType<typeof setInterval>;
  private stopped = false;

  async start(sourceId: string, target: CaptureTarget, contentHint: "motion" | "detail"): Promise<MediaStreamTrack> {
    if (!MediaStreamTrackGenerator) throw new Error("MediaStreamTrackGenerator indisponível");
    const generator = new MediaStreamTrackGenerator({ kind: "video" });
    generator.contentHint = contentHint;
    this.writer = generator.writable.getWriter();
    this.track = generator;
    bridge()?.addEventListener("sharedbufferreceived", this.onBuffer);

    const channel = new Channel<CaptureEvent>();
    channel.onmessage = (e) => {
      if (e.type === "closed") this.onEnded?.();
      else this.consume(e.generation, e.slot);
    };
    await invoke("capture_start", { sourceId, cursor: true, target, channel });
    // A static screen produces no new frames; repeat the last one so people
    // who join later (and the encoder's keyframes) still get a picture.
    this.repeat = setInterval(() => {
      if (this.last && performance.now() - this.lastWrite > 900) {
        const ts = this.last.timestamp + Math.round((performance.now() - this.lastWrite) * 1000);
        this.write(new VideoFrame(this.last, { timestamp: ts }), false);
      }
    }, 1000);
    return generator;
  }

  configure(target: CaptureTarget): Promise<void> {
    return invoke("capture_configure", { target });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.repeat);
    await invoke("capture_stop").catch(() => undefined);
    bridge()?.removeEventListener("sharedbufferreceived", this.onBuffer);
    for (const gen of this.buffers.values()) for (const buf of gen.values()) bridge()?.releaseBuffer(buf);
    this.buffers.clear();
    this.last?.close();
    this.last = undefined;
    await this.writer?.close().catch(() => undefined);
    this.track?.stop();
  }

  private onBuffer = (e: SharedBufferEvent) => {
    const meta = e.additionalData;
    if (!meta || typeof meta.nexusCapture !== "number" || typeof meta.slot !== "number") return;
    const generation = meta.nexusCapture;
    // A new generation replaces (and frees) the previous buffers.
    for (const [gen, slots] of this.buffers) {
      if (gen < generation) {
        for (const buf of slots.values()) bridge()?.releaseBuffer(buf);
        this.buffers.delete(gen);
      }
    }
    let slots = this.buffers.get(generation);
    if (!slots) {
      slots = new Map();
      this.buffers.set(generation, slots);
    }
    slots.set(meta.slot, e.getBuffer());
    // The frame message may have arrived before the buffer itself.
    this.consume(generation, meta.slot);
  };

  private consume(generation: number, slot: number) {
    const buf = this.buffers.get(generation)?.get(slot);
    if (!buf || this.stopped) return;
    const header = new Uint32Array(buf, 0, 4);
    if (header[0] !== 1) return;
    const width = header[1] ?? 0;
    const height = header[2] ?? 0;
    if (!width || !height || HEADER + width * height * 4 > buf.byteLength) {
      header[0] = 0;
      return;
    }
    const frame = new VideoFrame(new Uint8Array(buf, HEADER, width * height * 4), {
      format: "BGRX",
      codedWidth: width,
      codedHeight: height,
      timestamp: Math.round(performance.now() * 1000),
    });
    header[0] = 0; // slot free again: VideoFrame copied the pixels
    this.size = { width, height };
    this.write(frame, true);
  }

  private write(frame: VideoFrame, keep: boolean) {
    const writer = this.writer;
    // Encoder behind: drop instead of queueing (keeps latency low).
    if (!writer || this.stopped || (writer.desiredSize ?? 1) <= 0) {
      frame.close();
      return;
    }
    if (keep) {
      this.last?.close();
      this.last = frame.clone();
    }
    this.lastWrite = performance.now();
    void writer.write(frame).catch(() => frame.close());
  }
}
