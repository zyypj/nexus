import { type Room, Track } from "livekit-client";
import { sharedAudioContext } from "./audioContext";

/** RMS level (1 = full scale) above which someone is talking: about -36 dBFS. */
const SPEAKING_LEVEL = 0.016;
/** Keep the ring on between words instead of flickering. */
const HOLD_MS = 350;
const TICK_MS = 50;
/** ~21 ms of audio per reading. */
const WINDOW = 1024;

interface Meter {
  track: MediaStreamTrack;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
}

/**
 * Speaking indicator computed on this client, for everyone in the room: an
 * analyser on each mic track (yours as sent, after RNNoise when on; the others'
 * as decoded, before your volume for them). LiveKit's ActiveSpeakersChanged
 * comes from the SFU, smoothed and sent every few hundred ms, so the ring
 * lagged visibly behind the voice; the SFU also does not forward the
 * per-packet audio level, so reading it from the receiver is not an option.
 */
export class SpeakingDetector {
  private timer: ReturnType<typeof setInterval> | null = null;
  private meters = new Map<string, Meter>();
  private lastLoud = new Map<string, number>();
  private state = new Map<string, boolean>();
  private samples = new Float32Array(WINDOW);

  constructor(
    private room: Room,
    private onChange: () => void,
  ) {}

  start() {
    this.timer ??= setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const id of [...this.meters.keys()]) this.drop(id);
    this.state.clear();
    this.lastLoud.clear();
  }

  isSpeaking(identity: string): boolean {
    return this.state.get(identity) ?? false;
  }

  private tick() {
    const now = performance.now();
    let changed = false;
    const seen = new Set<string>();
    for (const p of [this.room.localParticipant, ...this.room.remoteParticipants.values()]) {
      seen.add(p.identity);
      const pub = p.getTrackPublication(Track.Source.Microphone);
      const level = this.level(p.identity, pub && !pub.isMuted ? pub.track?.mediaStreamTrack : undefined);
      if (level >= SPEAKING_LEVEL) this.lastLoud.set(p.identity, now);
      const speaking = now - (this.lastLoud.get(p.identity) ?? -Infinity) < HOLD_MS;
      if (speaking !== (this.state.get(p.identity) ?? false)) {
        this.state.set(p.identity, speaking);
        changed = true;
      }
    }
    for (const id of [...this.state.keys()]) {
      if (!seen.has(id)) {
        this.drop(id);
        this.state.delete(id);
        this.lastLoud.delete(id);
      }
    }
    if (changed) this.onChange();
  }

  /** RMS of the newest window of `track`; 0 (and the meter freed) without one. */
  private level(identity: string, track?: MediaStreamTrack): number {
    if (!track || track.readyState === "ended" || !track.enabled) {
      this.drop(identity);
      return 0;
    }
    let meter = this.meters.get(identity);
    if (meter?.track !== track) {
      // First reading, or a new track (device switch, noise mode, resubscribe).
      this.drop(identity);
      const ctx = sharedAudioContext();
      const source = ctx.createMediaStreamSource(new MediaStream([track]));
      const analyser = ctx.createAnalyser();
      analyser.fftSize = WINDOW;
      source.connect(analyser);
      meter = { track, source, analyser };
      this.meters.set(identity, meter);
    }
    meter.analyser.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (const s of this.samples) sum += s * s;
    return Math.sqrt(sum / WINDOW);
  }

  private drop(identity: string) {
    this.meters.get(identity)?.source.disconnect();
    this.meters.delete(identity);
  }
}
