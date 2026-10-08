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

export type CaptureMode = { mode: "exclude_self" } | { mode: "app"; pid: number };

export async function systemAudioSupport(): Promise<SystemAudioSupport> {
  if (!isTauri) return { supported: false, build: 0, reason: "Disponível apenas no app Windows." };
  return invoke<SystemAudioSupport>("system_audio_support");
}

export async function listAudioApps(): Promise<AudioApp[]> {
  if (!isTauri) return [];
  return invoke<AudioApp[]>("system_audio_apps");
}

/**
 * Live system-audio track. Rust captures with WASAPI process loopback
 * (excluding Nexus itself, so call voices are never re-sent) and streams raw
 * PCM over a Tauri channel; an AudioWorklet turns it into a MediaStreamTrack
 * that LiveKit publishes as `screen_share_audio`.
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
    const port = this.node.port;
    const channel = new Channel<ArrayBuffer>();
    channel.onmessage = (buf) => {
      // Transfer, don't copy: the buffer is not used again on this side.
      port.postMessage(buf, [buf]);
    };
    await invoke("system_audio_start", { mode, channel });
    const track = this.dest.stream.getAudioTracks()[0];
    if (!track) throw new Error("no audio track");
    this.track = track;
    return track;
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
