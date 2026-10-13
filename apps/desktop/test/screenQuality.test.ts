import { describe, expect, it } from "vitest";
import { type EncoderSample, QualityGovernor, autoStart, networkLimited, preset } from "../src/call/screenQuality";

/** Nothing wrong: the network allows the full bitrate, whatever is sent. */
const fine: EncoderSample = { limitation: "none", targetBitrate: 8_000_000, sentBitrate: 3_000_000 };
const cpu: EncoderSample = { ...fine, limitation: "cpu" };
/** A link that carries 1.5 Mbps, all of it in use. */
const slowLink: EncoderSample = { limitation: "bandwidth", targetBitrate: 1_500_000, sentBitrate: 1_450_000 };

/** Skips the ramp-up samples the governor ignores. */
function warm(g: QualityGovernor) {
  for (let i = 0; i < 3; i++) expect(g.sample(slowLink)).toBeNull();
  return g;
}

function feed(g: QualityGovernor, sample: EncoderSample, times: number) {
  let step = null;
  for (let i = 0; i < times; i++) step = g.sample(sample) ?? step;
  return step;
}

describe("networkLimited", () => {
  const p = preset("1080p30"); // 4 Mbps

  it("is a link that allows clearly less than the preset, all of it used", () => {
    expect(networkLimited(slowLink, p)).toBe(true);
    expect(networkLimited({ limitation: "none", targetBitrate: 3_000_000, sentBitrate: 2_900_000 }, p)).toBe(true);
  });

  it("is not a hard picture on a good link (WebRTC still calls it bandwidth)", () => {
    expect(networkLimited({ limitation: "bandwidth", targetBitrate: 4_000_000, sentBitrate: 3_950_000 }, p)).toBe(false);
  });

  it("is not a still screen, which sends almost nothing", () => {
    expect(networkLimited({ limitation: "none", targetBitrate: 1_500_000, sentBitrate: 5_000 }, p)).toBe(false);
  });

  it("needs to know the target", () => {
    expect(networkLimited({ limitation: "bandwidth", targetBitrate: 0, sentBitrate: 0 }, p)).toBe(false);
  });
});

describe("QualityGovernor", () => {
  it("ignores limitations while the bandwidth estimate ramps up", () => {
    const g = new QualityGovernor(preset("1080p30"), false, false);
    warm(g);
    expect(g.current.id).toBe("1080p30");
  });

  it("drops 1080p60 after sustained CPU limitation", () => {
    const g = warm(new QualityGovernor(preset("1080p60"), false, true));
    expect(g.sample(cpu)).toBeNull();
    expect(g.sample(cpu)).toBeNull();
    expect(g.sample(cpu)).toEqual({ preset: preset("1080p30"), why: "cpu" });
  });

  it("drops on a link that really is short, and says so", () => {
    const g = warm(new QualityGovernor(preset("1080p30"), false, false));
    expect(feed(g, slowLink, 3)).toEqual({ preset: preset("720p30"), why: "network" });
  });

  it("keeps the quality when the picture is just hard to encode", () => {
    const g = warm(new QualityGovernor(preset("1080p60"), false, true));
    const busy: EncoderSample = { limitation: "bandwidth", targetBitrate: 8_000_000, sentBitrate: 7_900_000 };
    expect(feed(g, busy, 40)).toBeNull();
    expect(g.current.id).toBe("1080p60");
  });

  it("does not react to a single bad sample", () => {
    const g = warm(new QualityGovernor(preset("1080p30"), true, false));
    expect(g.sample(slowLink)).toBeNull();
    expect(g.sample(fine)).toBeNull();
    expect(g.sample(slowLink)).toBeNull();
    expect(g.current.id).toBe("1080p30");
  });

  it("manual presets recover to the chosen quality in ~20 s, never above it", () => {
    const g = warm(new QualityGovernor(preset("1080p30"), false, true));
    expect(feed(g, slowLink, 3)?.preset.id).toBe("720p30");
    expect(feed(g, fine, 3)).toBeNull();
    expect(g.sample(fine)).toEqual({ preset: preset("1080p30"), why: "recovered" });
    expect(feed(g, fine, 60)).toBeNull();
  });

  it("recovers on a still screen too (nothing moving is not a limit)", () => {
    const g = warm(new QualityGovernor(preset("1080p30"), false, false));
    feed(g, slowLink, 3);
    const still: EncoderSample = { limitation: "none", targetBitrate: 1_500_000, sentBitrate: 4_000 };
    expect(feed(g, still, 4)?.preset.id).toBe("1080p30");
  });

  it("gives a new setting ~10 s before holding limits against it", () => {
    const g = warm(new QualityGovernor(preset("1080p60"), false, true));
    expect(feed(g, cpu, 3)?.preset.id).toBe("1080p30");
    // The encoder still reports the restrictions earned at 60 FPS.
    expect(feed(g, cpu, 4)).toBeNull();
    expect(g.sample(cpu)).toEqual({ preset: preset("720p30"), why: "cpu" });
  });

  it("waits longer after every failed try at the higher quality", () => {
    const g = warm(new QualityGovernor(preset("1080p60"), false, true));
    expect(feed(g, cpu, 3)?.preset.id).toBe("1080p30");
    // First try after 4 clean samples; it fails at once (2 settling + 3 limited).
    expect(feed(g, fine, 4)?.preset.id).toBe("1080p60");
    expect(feed(g, cpu, 5)?.preset.id).toBe("1080p30");
    // Second try only after 8.
    expect(feed(g, fine, 7)).toBeNull();
    expect(g.sample(fine)?.preset.id).toBe("1080p60");
    expect(feed(g, cpu, 5)?.preset.id).toBe("1080p30");
    // Third after 16.
    expect(feed(g, fine, 15)).toBeNull();
    expect(g.sample(fine)?.preset.id).toBe("1080p60");
  });

  it("forgets the failed tries once the wanted quality holds", () => {
    const g = warm(new QualityGovernor(preset("1080p60"), false, true));
    feed(g, cpu, 3);
    feed(g, fine, 4); // up
    feed(g, cpu, 5); // failed: next wait is 8
    feed(g, fine, 8); // up again
    feed(g, fine, 12); // holds for a minute
    expect(feed(g, cpu, 3)?.preset.id).toBe("1080p30");
    expect(feed(g, fine, 4)?.preset.id).toBe("1080p60");
  });

  it("auto mode climbs only as far as it is allowed", () => {
    const g = warm(new QualityGovernor(preset("720p30"), true, false));
    expect(feed(g, fine, 4)?.preset.id).toBe("1080p30");
    expect(feed(g, fine, 60)).toBeNull(); // 60 fps not allowed
    const motion = warm(new QualityGovernor(preset("1080p30"), true, true));
    expect(feed(motion, fine, 4)?.preset.id).toBe("1080p60");
  });

  it("auto start is conservative on small machines", () => {
    expect(autoStart(2).id).toBe("720p30");
    expect(autoStart(8).id).toBe("1080p30");
  });
});
