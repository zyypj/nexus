import { describe, expect, it } from "vitest";
import { SILENT_VIRTUAL_MIC, isDeviceError, micDeviceId } from "../src/lib/settings";

describe("micDeviceId", () => {
  it("asks for the chosen mic exactly, never as a preference", () => {
    expect(micDeviceId("abc123")).toEqual({ exact: "abc123" });
  });

  it("leaves the default aliases to the system", () => {
    expect(micDeviceId("default")).toBeUndefined();
    expect(micDeviceId("communications")).toBeUndefined();
    expect(micDeviceId("")).toBeUndefined();
  });
});

describe("mic helpers", () => {
  it("recognizes device errors that should fall back to the default mic", () => {
    expect(isDeviceError({ name: "OverconstrainedError" })).toBe(true);
    expect(isDeviceError({ name: "NotFoundError" })).toBe(true);
    expect(isDeviceError({ name: "NotAllowedError" })).toBe(false);
  });

  it("flags the Steam virtual mic", () => {
    expect(SILENT_VIRTUAL_MIC.test("Microfone (Steam Streaming Microphone)")).toBe(true);
    expect(SILENT_VIRTUAL_MIC.test("Grupo de microfones (Realtek(R) Audio)")).toBe(false);
  });
});
