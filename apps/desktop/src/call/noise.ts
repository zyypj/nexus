import { RnnoiseWorkletNode, loadRnnoise } from "@sapphi-red/web-noise-suppressor";
import rnnoiseWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseSimdWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";
import rnnoiseWorkletUrl from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import type { AudioProcessorOptions, Track, TrackProcessor } from "livekit-client";
import { addWorkletOnce } from "./audioContext";

let wasmBinary: Promise<ArrayBuffer> | null = null;

/**
 * Mic processing in WebAudio, output always mono.
 *
 * - `denoise`: "Enhanced" noise suppression, RNNoise (a small recurrent
 *   network, 10 ms frames at 48 kHz) running in an AudioWorklet via WASM
 *   SIMD. Chosen over heavier models (e.g. DeepFilterNet) because it
 *   measured ~0.5% of one core with 10 ms latency; see docs/AUDIO.md.
 *   Browser NS is turned off when this is active so the signal is not
 *   processed twice; echo cancellation and AGC stay in WebRTC.
 * - otherwise only a downmix, for mics that open in stereo (Chromium does
 *   that with echo cancellation and AGC off). The SFU accepts stereo Opus on
 *   every audio track and the encoder sends as many channels as the track
 *   has, so an unbalanced mic reached listeners in one ear.
 */
export class MicProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  name: string;
  processedTrack?: MediaStreamTrack;
  private source?: MediaStreamAudioSourceNode;
  private node?: AudioNode;
  private dest?: MediaStreamAudioDestinationNode;
  private ctx?: AudioContext;

  constructor(readonly denoise: boolean) {
    this.name = denoise ? "nexus-rnnoise" : "nexus-mono";
  }

  async init(opts: AudioProcessorOptions): Promise<void> {
    // LiveKit passes the context to init() but not to restart() (device
    // switch), so keep the one from init.
    const ctx = opts.audioContext ?? this.ctx;
    if (!ctx) throw new Error("Mic processor: no AudioContext");
    this.ctx = ctx;
    if (this.denoise) {
      await addWorkletOnce(ctx, rnnoiseWorkletUrl);
      wasmBinary ??= loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl });
      this.node = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary: await wasmBinary });
    } else {
      this.node = ctx.createGain();
    }
    // Mix L+R into one channel at the input. RNNoise in particular filters
    // the first channel only and leaves the second silent: left ear only.
    this.node.channelCount = 1;
    this.node.channelCountMode = "explicit";
    this.node.channelInterpretation = "speakers";
    this.source = ctx.createMediaStreamSource(new MediaStream([opts.track]));
    this.dest = ctx.createMediaStreamDestination();
    this.dest.channelCount = 1;
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
    if (this.node instanceof RnnoiseWorkletNode) this.node.destroy();
    this.dest?.disconnect();
    this.source = undefined;
    this.node = undefined;
    this.dest = undefined;
    this.processedTrack = undefined;
  }
}
