import { RnnoiseWorkletNode, loadRnnoise } from "@sapphi-red/web-noise-suppressor";
import rnnoiseWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseSimdWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";
import rnnoiseWorkletUrl from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import type { AudioProcessorOptions, Track, TrackProcessor } from "livekit-client";
import { addWorkletOnce } from "./audioContext";

let wasmBinary: Promise<ArrayBuffer> | null = null;

/**
 * "Enhanced" noise suppression: RNNoise (a small recurrent network,
 * 10 ms frames at 48 kHz) running in an AudioWorklet via WASM SIMD.
 * Chosen over heavier models (e.g. DeepFilterNet) because it measured
 * ~0.5% of one core with 10 ms latency; see docs/AUDIO.md.
 *
 * Browser NS is turned off when this is active so the signal is not
 * processed twice; echo cancellation and AGC stay in WebRTC.
 */
export class RnnoiseProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  name = "nexus-rnnoise";
  processedTrack?: MediaStreamTrack;
  private source?: MediaStreamAudioSourceNode;
  private node?: RnnoiseWorkletNode;
  private dest?: MediaStreamAudioDestinationNode;
  private ctx?: AudioContext;

  async init(opts: AudioProcessorOptions): Promise<void> {
    // LiveKit passes the context to init() but not to restart() (device
    // switch), so keep the one from init.
    const ctx = opts.audioContext ?? this.ctx;
    if (!ctx) throw new Error("RNNoise: no AudioContext");
    this.ctx = ctx;
    await addWorkletOnce(ctx, rnnoiseWorkletUrl);
    wasmBinary ??= loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl });
    const binary = await wasmBinary;
    this.source = ctx.createMediaStreamSource(new MediaStream([opts.track]));
    this.node = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary: binary });
    this.dest = ctx.createMediaStreamDestination();
    this.source.connect(this.node).connect(this.dest);
    this.processedTrack = this.dest.stream.getAudioTracks()[0];
  }

  async restart(opts: AudioProcessorOptions): Promise<void> {
    await this.destroy();
    await this.init(opts);
  }

  async destroy(): Promise<void> {
    this.source?.disconnect();
    this.node?.disconnect();
    this.node?.destroy();
    this.dest?.disconnect();
    this.source = undefined;
    this.node = undefined;
    this.dest = undefined;
    this.processedTrack = undefined;
  }
}
