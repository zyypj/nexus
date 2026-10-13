import { Channel } from "@tauri-apps/api/core";
import { invoke, isTauri } from "../lib/platform";
import { addWorkletOnce, sharedAudioContext } from "./audioContext";
import workletUrl from "./pcmPlayer.worklet.js?url";

export interface AudioApp {
  pid: number;
  name: string;
  active: boolean;
}

export interface SystemAudioSupport {
  supported: boolean;
  build: number;
  reason: string | null;
}

/** Everything the computer plays except Nexus, or only the chosen applications (mixed). */
export type CaptureMode = { mode: "exclude_self" } | { mode: "apps"; pids: number[] };

/** Applications of the picker: the processes of one program under one name. */
export interface AudioAppGroup {
  name: string;
  pids: number[];
  /** Playing something right now. */
  active: boolean;
}

/**
 * Audio sessions grouped by program (a browser has several processes), those
 * playing now first. `extra` = the application of the shared window, listed
 * even before it makes any sound.
 */
export function groupAudioApps(apps: AudioApp[], extra?: { pid: number; name: string } | null): AudioAppGroup[] {
  const groups = new Map<string, AudioAppGroup>();
  const add = (pid: number, name: string, active: boolean) => {
    const key = name.toLowerCase();
    const group = groups.get(key) ?? { name, pids: [], active: false };
    if (!group.pids.includes(pid)) group.pids.push(pid);
    group.active ||= active;
    groups.set(key, group);
  };
  if (extra) add(extra.pid, extra.name, false);
  for (const app of apps) add(app.pid, app.name, app.active);
  return [...groups.values()].sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
}

export async function systemAudioSupport(): Promise<SystemAudioSupport> {
  if (!isTauri) return { supported: false, build: 0, reason: "Disponível apenas no app Windows." };
  return invoke<SystemAudioSupport>("system_audio_support");
}

export async function listAudioApps(): Promise<AudioApp[]> {
  if (!isTauri) return [];
  return invoke<AudioApp[]>("system_audio_apps");
}

/**
 * Live system-audio track. Rust captures with WASAPI process loopback (never
 * Nexus itself, so call voices are not re-sent) and streams raw PCM over a
 * Tauri channel; an AudioWorklet turns it into a MediaStreamTrack that LiveKit
 * publishes as `screen_share_audio`.
 */
export class SystemAudioCapture {
  private node?: AudioWorkletNode;
  private dest?: MediaStreamAudioDestinationNode;
  track?: MediaStreamTrack;

  async start(mode: CaptureMode): Promise<MediaStreamTrack> {
    const ctx = sharedAudioContext();
    await addWorkletOnce(ctx, workletUrl);
    this.node = new AudioWorkletNode(ctx, "nexus-pcm-player", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    this.dest = ctx.createMediaStreamDestination();
    this.dest.channelCount = 2;
    this.node.connect(this.dest);
    await this.setMode(mode);
    const track = this.dest.stream.getAudioTracks()[0];
    if (!track) throw new Error("no audio track");
    this.track = track;
    return track;
  }

  /** Changes what is captured; the track (and its publication) stays the same. */
  async setMode(mode: CaptureMode): Promise<void> {
    const port = this.node?.port;
    if (!port) throw new Error("capture not started");
    const channel = new Channel<ArrayBuffer>();
    channel.onmessage = (buf) => {
      // Transfer, don't copy: the buffer is not used again on this side.
      port.postMessage(buf, [buf]);
    };
    // Starting replaces the capture that was running.
    await invoke("system_audio_start", { mode, channel });
  }

  async stop(): Promise<void> {
    if (isTauri) await invoke("system_audio_stop").catch(() => undefined);
    this.node?.port.postMessage("reset");
    this.node?.disconnect();
    this.dest?.disconnect();
    this.track?.stop();
    this.node = undefined;
    this.dest = undefined;
    this.track = undefined;
  }
}
