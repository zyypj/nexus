import { describe, expect, it } from "vitest";
import { QualityGovernor, autoStart, preset } from "../src/call/screenQuality";

/** Skips the ramp-up samples the governor ignores. */
function warm(g: QualityGovernor) {
  for (let i = 0; i < 3; i++) expect(g.sample("bandwidth", 5)).toBeNull();
  return g;
}

describe("QualityGovernor", () => {
  it("ignores limitations while the bandwidth estimate ramps up", () => {
    const g = new QualityGovernor(preset("1080p30"), false, false);
    warm(g);
    expect(g.current.id).toBe("1080p30");
  });

  it("drops 1080p60 after sustained CPU limitation", () => {
    const g = warm(new QualityGovernor(preset("1080p60"), false, true));
    expect(g.sample("cpu", 40)).toBeNull();
    expect(g.sample("cpu", 40)).toBeNull();
    expect(g.sample("cpu", 40)?.id).toBe("1080p30");
  });

  it("manual presets recover to the chosen quality, never above it", () => {
    const g = warm(new QualityGovernor(preset("1080p30"), false, true));
    for (let i = 0; i < 2; i++) g.sample("bandwidth", 20);
    expect(g.sample("bandwidth", 20)?.id).toBe("720p30");
    let step = null;
    for (let i = 0; i < 12; i++) step = g.sample("none", 30);
    expect(step?.id).toBe("1080p30");
    for (let i = 0; i < 30; i++) expect(g.sample("none", 30)).toBeNull();
  });

  it("does not react to a single bad sample", () => {
    const g = warm(new QualityGovernor(preset("1080p30"), true, false));
    expect(g.sample("bandwidth", 20)).toBeNull();
    expect(g.sample("none", 30)).toBeNull();
    expect(g.sample("bandwidth", 20)).toBeNull();
    expect(g.current.id).toBe("1080p30");
  });

  it("auto mode climbs only when allowed and the encoder keeps up", () => {
    const g = warm(new QualityGovernor(preset("720p30"), true, false));
    let step = null;
    for (let i = 0; i < 12; i++) step = g.sample("none", 30);
    expect(step?.id).toBe("1080p30");
    for (let i = 0; i < 24; i++) expect(g.sample("none", 30)).toBeNull(); // 60 fps not allowed
  });

  it("auto start is conservative on small machines", () => {
    expect(autoStart(2).id).toBe("720p30");
    expect(autoStart(8).id).toBe("1080p30");
  });
});
