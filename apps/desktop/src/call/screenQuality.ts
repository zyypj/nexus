import type { ScreenQuality } from "../lib/settings";

export interface QualityPreset {
  id: Exclude<ScreenQuality, "auto">;
  label: string;
  width: number;
  height: number;
  fps: number;
  /** Bits per second. */
  maxBitrate: number;
}

export const PRESETS: QualityPreset[] = [
  { id: "720p30", label: "720p 30 FPS", width: 1280, height: 720, fps: 30, maxBitrate: 2_500_000 },
  { id: "1080p30", label: "1080p 30 FPS", width: 1920, height: 1080, fps: 30, maxBitrate: 4_000_000 },
  // Twice the frames of 1080p30: at 6 Mbps fast content was visibly blocky.
  { id: "1080p60", label: "1080p 60 FPS", width: 1920, height: 1080, fps: 60, maxBitrate: 8_000_000 },
];

export const preset = (id: QualityPreset["id"]): QualityPreset => PRESETS.find((p) => p.id === id) ?? PRESETS[1]!;

/** Starting point for "Automático": conservative on small CPUs. */
export function autoStart(cores = navigator.hardwareConcurrency || 4): QualityPreset {
  return cores >= 4 ? preset("1080p30") : preset("720p30");
}

export type Limitation = "none" | "cpu" | "bandwidth" | "other";

/** What the encoder reported since the previous sample. */
export interface EncoderSample {
  /** WebRTC's `qualityLimitationReason`. Only "cpu" is taken at its word. */
  limitation: Limitation;
  /** Bitrate the congestion control allows the encoder right now, bps (0 = unknown). */
  targetBitrate: number;
  /** Bitrate actually sent since the previous sample, bps. */
  sentBitrate: number;
}

export interface QualityStep {
  preset: QualityPreset;
  /** Why it moved: the machine, the connection, or things are fine again. */
  why: "cpu" | "network" | "recovered";
}

/** Samples ignored at the start (the bandwidth estimate is still ramping up). */
const WARMUP = 3;
/** Limited samples in a row before stepping down (~15 s). */
const DOWN_AFTER = 3;
/**
 * Limited samples not held against a setting right after a step (~10 s): the
 * encoder still carries the restrictions it earned at the previous one.
 */
const SETTLE = 2;
/** Clean samples before trying the next quality up again (~20 s)... */
const FIRST_RETRY = 4;
/** ...doubling every time the try fails, up to this (~4 min). */
const MAX_RETRY = 48;
/** A step up that is undone within this many samples (~1 min) was a failed try. */
const TRY_WINDOW = 12;

/**
 * The connection is what holds the picture back: the network allows clearly
 * less than the preset is meant to use AND the encoder is using what it gets.
 * A still screen sends almost nothing whatever the network; that is not a
 * limit. Neither is WebRTC's "bandwidth" reason alone: it also means "the
 * picture is hard to encode at this bitrate", on a perfect link too, and a
 * lower preset (with a lower bitrate) would only make that worse.
 */
export function networkLimited(sample: EncoderSample, current: QualityPreset): boolean {
  return (
    sample.targetBitrate > 0 &&
    sample.targetBitrate < current.maxBitrate * 0.8 &&
    sample.sentBitrate >= sample.targetBitrate * 0.7
  );
}

/**
 * Decides quality steps from periodic sender stats. Pure so it can be unit
 * tested: feed it one sample every few seconds.
 *
 * - Ignores the first samples (~12 s): the bandwidth estimator is still
 *   ramping up.
 * - Steps DOWN after 3 limited samples in a row (~15 s), limited meaning the
 *   CPU cannot keep up or the connection really is short (`networkLimited`):
 *   never keep sending 1080p60 a machine or link cannot sustain. The first
 *   ~10 s after a step do not count against the new setting.
 * - Steps back UP after ~20 s without limits: a manual preset recovers up to
 *   the chosen quality (a short dip must not leave the stream at 720p), auto
 *   mode climbs to 1080p30, or 1080p60 for motion content on machines with
 *   8+ cores. A still screen recovers like any other: the frame rate says
 *   nothing when nothing moves. If the higher quality fails again right
 *   away, the next try waits twice as long (up to ~4 min), so a machine that
 *   cannot do 60 FPS is not pushed there every minute.
 */
export class QualityGovernor {
  private limited = 0;
  private clean = 0;
  private warmup = WARMUP;
  private settle = 0;
  private retryAfter = FIRST_RETRY;
  /** Samples since the last step up. */
  private sinceUp = Number.POSITIVE_INFINITY;
  private readonly ceiling: QualityPreset["id"];

  constructor(
    public current: QualityPreset,
    auto: boolean,
    private readonly allow60: boolean,
  ) {
    this.ceiling = auto ? (allow60 ? "1080p60" : "1080p30") : current.id;
  }

  sample(sample: EncoderSample): QualityStep | null {
    if (this.warmup > 0) {
      this.warmup--;
      return null;
    }
    const why = sample.limitation === "cpu" ? "cpu" : networkLimited(sample, this.current) ? "network" : null;
    this.sinceUp++;
    if (this.settle > 0) {
      this.settle--;
      if (why) return null;
    }
    if (why) {
      this.limited++;
      this.clean = 0;
    } else {
      this.limited = 0;
      this.clean++;
    }
    if (why && this.limited >= DOWN_AFTER) {
      this.limited = 0;
      const lower = this.lower();
      if (lower) {
        if (this.sinceUp <= TRY_WINDOW) this.retryAfter = Math.min(this.retryAfter * 2, MAX_RETRY);
        this.current = lower;
        this.settle = SETTLE;
        return { preset: lower, why };
      }
    }
    if (this.current.id === this.ceiling) {
      // Holding the wanted quality: the next problem is a new one.
      if (this.clean >= TRY_WINDOW) this.retryAfter = FIRST_RETRY;
    } else if (this.clean >= this.retryAfter) {
      const higher = this.higher();
      if (higher) {
        this.clean = 0;
        this.sinceUp = 0;
        this.settle = SETTLE;
        this.current = higher;
        return { preset: higher, why: "recovered" };
      }
    }
    return null;
  }

  private lower(): QualityPreset | null {
    if (this.current.id === "1080p60") return preset("1080p30");
    if (this.current.id === "1080p30") return preset("720p30");
    return null;
  }

  private higher(): QualityPreset | null {
    if (this.current.id === "720p30") return preset("1080p30");
    if (this.current.id === "1080p30" && (this.allow60 || this.ceiling === "1080p60")) return preset("1080p60");
    return null;
  }
}
