import { describe, expect, it } from "vitest";
import { type StageState, clampCallSize, gridLayout, syncStage, watchStream } from "../src/call/stageLayout";

const person = (identity: string, hasScreen = false, isLocal = false) => ({ identity, hasScreen, isLocal });
const empty: StageState = { watching: [], focus: null };

describe("syncStage", () => {
  it("opens the first stream of a call by itself", () => {
    const people = [person("me", false, true), person("ana", true)];
    expect(syncStage(empty, people, new Set())).toEqual({ watching: ["ana"], focus: "screen:ana" });
  });

  it("leaves a second stream waiting for a click", () => {
    const prev = { watching: ["ana"], focus: "screen:ana" };
    const people = [person("me", false, true), person("ana", true), person("bia", true)];
    expect(syncStage(prev, people, new Set(["ana"]))).toBe(prev);
  });

  it("does not reopen a stream the user stopped watching", () => {
    const people = [person("me", false, true), person("ana", true)];
    expect(syncStage(empty, people, new Set(["ana"]))).toBe(empty);
  });

  it("does not open or enlarge your own stream", () => {
    expect(syncStage(empty, [person("me", true, true)], new Set())).toBe(empty);
  });

  it("keeps an enlarged camera when a stream starts", () => {
    const prev = { watching: [], focus: "cam:bia" };
    const people = [person("me", false, true), person("ana", true), person("bia")];
    expect(syncStage(prev, people, new Set())).toEqual({ watching: ["ana"], focus: "cam:bia" });
  });

  it("moves to another watched stream, or the grid, when the enlarged one ends", () => {
    const prev = { watching: ["ana", "bia"], focus: "screen:ana" };
    const people = [person("me", false, true), person("ana"), person("bia", true)];
    expect(syncStage(prev, people, new Set(["ana", "bia"]))).toEqual({ watching: ["bia"], focus: "screen:bia" });
    expect(syncStage(prev, [person("me", false, true)], new Set(["ana", "bia"]))).toEqual(empty);
  });

  it("drops the enlarged tile of someone who left", () => {
    expect(syncStage({ watching: [], focus: "cam:ana" }, [person("me", false, true)], new Set())).toEqual(empty);
  });
});

describe("watchStream", () => {
  it("enlarges the stream being opened", () => {
    expect(watchStream({ watching: ["ana"], focus: "screen:ana" }, "bia", true)).toEqual({
      watching: ["ana", "bia"],
      focus: "screen:bia",
    });
  });

  it("falls back to another watched stream when closing the enlarged one", () => {
    const prev = { watching: ["ana", "bia"], focus: "screen:bia" };
    expect(watchStream(prev, "bia", false)).toEqual({ watching: ["ana"], focus: "screen:ana" });
    expect(watchStream({ watching: ["ana"], focus: "screen:ana" }, "ana", false)).toEqual(empty);
  });

  it("keeps the enlarged tile when closing another stream", () => {
    expect(watchStream({ watching: ["ana", "bia"], focus: "cam:me" }, "bia", false)).toEqual({
      watching: ["ana"],
      focus: "cam:me",
    });
  });
});

describe("gridLayout", () => {
  it("fills the box with a single tile, limited by the shorter side", () => {
    expect(gridLayout(1, 1600, 900, 8)).toEqual({ cols: 1, tileWidth: 1600 });
    expect(gridLayout(1, 1600, 450, 8)).toEqual({ cols: 1, tileWidth: 800 });
  });

  it("puts two tiles side by side in a wide box and stacked in a tall one", () => {
    expect(gridLayout(2, 1600, 450, 8).cols).toBe(2);
    expect(gridLayout(2, 500, 900, 8).cols).toBe(1);
  });

  it("uses a 2x2 grid for four tiles in a 16:9 box", () => {
    const { cols, tileWidth } = gridLayout(4, 1608, 908, 8);
    expect(cols).toBe(2);
    expect(tileWidth).toBe(800);
  });

  it("never overflows the box", () => {
    for (let n = 1; n <= 12; n++) {
      const { cols, tileWidth } = gridLayout(n, 1000, 420, 8);
      const rows = Math.ceil(n / cols);
      expect(cols * tileWidth + (cols - 1) * 8).toBeLessThanOrEqual(1000);
      expect(rows * (tileWidth / (16 / 9)) + (rows - 1) * 8).toBeLessThanOrEqual(420 + 1);
    }
  });
});

describe("clampCallSize", () => {
  it("keeps room for the call and for the chat", () => {
    expect(clampCallSize(0.05, 1000)).toBeCloseTo(0.18);
    expect(clampCallSize(0.99, 1000)).toBeCloseTo(0.85);
    expect(clampCallSize(0.5, 1000)).toBe(0.5);
  });

  it("prefers the call when the window is too short for both", () => {
    expect(clampCallSize(0.5, 250)).toBeCloseTo(0.72);
  });
});
