import { describe, expect, it } from "vitest";
import { compareVersions, isNewer, parseVersion } from "../src/version";

describe("versions", () => {
  it("parses tags", () => {
    expect(parseVersion("v1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion("0.10.0-beta.1")).toEqual([0, 10, 0]);
    expect(parseVersion("nope")).toBeNull();
  });
  it("compares numerically, not lexically", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
    expect(isNewer("0.2.0", "0.1.9")).toBe(true);
    expect(isNewer("0.1.0", "0.1.0")).toBe(false);
    expect(isNewer("garbage", "0.1.0")).toBe(false);
  });
});
