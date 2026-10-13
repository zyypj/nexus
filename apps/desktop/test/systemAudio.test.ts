import { describe, expect, it, vi } from "vitest";

// The module also holds the Tauri/AudioWorklet glue, not needed here.
vi.mock("@tauri-apps/api/core", () => ({ Channel: class {} }));
vi.mock("../src/call/pcmPlayer.worklet.js?url", () => ({ default: "" }));
vi.mock("../src/call/audioContext", () => ({}));

const { groupAudioApps } = await import("../src/call/systemAudio");

describe("groupAudioApps", () => {
  it("puts the processes of one program under one name", () => {
    const groups = groupAudioApps([
      { pid: 10, name: "chrome", active: false },
      { pid: 11, name: "Chrome", active: true },
      { pid: 20, name: "Spotify", active: false },
    ]);
    expect(groups).toEqual([
      { name: "chrome", pids: [10, 11], active: true },
      { name: "Spotify", pids: [20], active: false },
    ]);
  });

  it("lists what is playing first, then by name", () => {
    const groups = groupAudioApps([
      { pid: 1, name: "vlc", active: false },
      { pid: 2, name: "jogo", active: true },
      { pid: 3, name: "Discord", active: false },
    ]);
    expect(groups.map((g) => g.name)).toEqual(["jogo", "Discord", "vlc"]);
  });

  it("includes the shared window's application before it makes any sound", () => {
    expect(groupAudioApps([], { pid: 7, name: "jogo" })).toEqual([{ name: "jogo", pids: [7], active: false }]);
    // Same program as an audio session: one row with both processes.
    const groups = groupAudioApps([{ pid: 8, name: "jogo", active: true }], { pid: 7, name: "jogo" });
    expect(groups).toEqual([{ name: "jogo", pids: [7, 8], active: true }]);
  });
});
