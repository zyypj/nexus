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
  { id: "1080p60", label: "1080p 60 FPS", width: 1920, height: 1080, fps: 60, maxBitrate: 6_000_000 },
];

export const preset = (id: QualityPreset["id"]): QualityPreset => PRESETS.find((p) => p.id === id) ?? PRESETS[1]!;

/** Starting point for "Automático": conservative on small CPUs. */
export function autoStart(cores = navigator.hardwareConcurrency || 4): QualityPreset {
  return cores >= 4 ? preset("1080p30") : preset("720p30");
}

export type Limitation = "none" | "cpu" | "bandwidth" | "other";

/**
 * Decides quality steps from periodic sender stats. Pure so it can be unit
 * tested: feed it one sample every few seconds.
 *
 * - Steps DOWN after 3 consecutive limited samples (~15 s): never keep
 *   sending 1080p60 a machine or link cannot sustain.
 * - In auto mode, steps UP after 12 clean samples (~60 s) with the encoder
 *   hitting its frame rate, but only to 1080p60 for motion content on
 *   machines with 8+ logical cores.
 */
export class QualityGovernor {
  private limited = 0;
  private clean = 0;

  constructor(
    public current: QualityPreset,
    private readonly auto: boolean,
    private readonly allow60: boolean,
  ) {}

  sample(limitation: Limitation, fps: number): QualityPreset | null {
    if (limitation === "cpu" || limitation === "bandwidth") {
      this.limited++;
      this.clean = 0;
    } else {
      this.limited = 0;
      this.clean++;
    }
    if (this.limited >= 3) {
      this.limited = 0;
      const lower = this.lower();
      if (lower) {
        this.current = lower;
        return lower;
      }
    }
    if (this.auto && this.clean >= 12 && fps >= this.current.fps * 0.9) {
      this.clean = 0;
      const higher = this.higher();
      if (higher) {
        this.current = higher;
        return higher;
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
    if (this.current.id === "1080p30" && this.allow60) return preset("1080p60");
    return null;
  }
}
