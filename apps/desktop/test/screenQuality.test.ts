import { describe, expect, it } from "vitest";
import { QualityGovernor, autoStart, preset } from "../src/call/screenQuality";

describe("QualityGovernor", () => {
  it("drops 1080p60 after sustained CPU limitation", () => {
    const g = new QualityGovernor(preset("1080p60"), false, true);
    expect(g.sample("cpu", 40)).toBeNull();
    expect(g.sample("cpu", 40)).toBeNull();
    expect(g.sample("cpu", 40)?.id).toBe("1080p30");
    // Manual presets never climb back up on their own.
    for (let i = 0; i < 20; i++) expect(g.sample("none", 30)).toBeNull();
  });

  it("does not react to a single bad sample", () => {
    const g = new QualityGovernor(preset("1080p30"), true, false);
    expect(g.sample("bandwidth", 20)).toBeNull();
    expect(g.sample("none", 30)).toBeNull();
    expect(g.sample("bandwidth", 20)).toBeNull();
    expect(g.current.id).toBe("1080p30");
  });

  it("auto mode climbs only when allowed and the encoder keeps up", () => {
    const g = new QualityGovernor(preset("720p30"), true, false);
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
