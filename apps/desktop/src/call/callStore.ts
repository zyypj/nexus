import type { Id } from "@nexus/protocol";
import { create } from "zustand";
import { listen } from "../lib/platform";
import type { ScreenQuality } from "../lib/settings";
import type { CaptureMode } from "./systemAudio";
import type { CaptureSource } from "./nativeScreen";

export interface ParticipantView {
  identity: Id;
  name: string;
  isLocal: boolean;
  speaking: boolean;
  micMuted: boolean;
  hasCamera: boolean;
  hasScreen: boolean;
  hasScreenAudio: boolean;
  quality: string;
}

export interface CallUiState {
  status: "idle" | "connecting" | "connected" | "reconnecting";
  callId: Id | null;
  conversationId: Id | null;
  error: string | null;
  muted: boolean;
  deafened: boolean;
  pttHeld: boolean;
  cameraOn: boolean;
  screenOn: boolean;
  screenAudioOn: boolean;
  screenQuality: string | null;
  screenNotice: string | null;
  participants: ParticipantView[];
  /**
   * Other people's screen shares being watched: only these are decoded and
   * heard. The first stream of a call opens by itself, more wait for a click.
   */
  watching: Id[];
  /** Tile enlarged on the stage (see camTile/screenTile); null = grid of everyone. */
  focus: string | null;
  /** Call area covering the chat below it. */
  stageExpanded: boolean;
  /** Bumped whenever tracks change, so video tiles re-attach. */
  trackVersion: number;
}

export const idleCall: CallUiState = {
  status: "idle",
  callId: null,
  conversationId: null,
  error: null,
  muted: false,
  deafened: false,
  pttHeld: false,
  cameraOn: false,
  screenOn: false,
  screenAudioOn: false,
  screenQuality: null,
  screenNotice: null,
  participants: [],
  watching: [],
  focus: null,
  stageExpanded: false,
  trackVersion: 0,
};

export const useCall = create<CallUiState>()(() => ({ ...idleCall }));
export const setCallUi = (patch: Partial<CallUiState>) => useCall.setState(patch);

/** Attachable media track (subset of LiveKit's Track used by the UI). */
export interface AttachableTrack {
  attach(el: HTMLMediaElement): HTMLMediaElement;
  detach(el: HTMLMediaElement): HTMLMediaElement;
}

type Manager = import("./callManager").CallManager;

let manager: Manager | null = null;
let loading: Promise<Manager> | null = null;

/**
 * LiveKit (~500 KB of JS) is only downloaded/parsed when the user first
 * joins a call, keeping idle startup time and memory low.
 */
function load(): Promise<Manager> {
  loading ??= import("./callManager").then((m) => {
    manager = new m.CallManager();
    // Dev builds only: lets end-to-end tests inspect the LiveKit room.
    if (import.meta.env.DEV) (globalThis as { __nexusCall?: unknown }).__nexusCall = manager;
    return manager;
  });
  return loading;
}

export const calls = {
  start: async (conversationId: Id) => (await load()).start(conversationId),
  join: async (callId: Id) => (await load()).join(callId),
  leave: async () => manager?.leave(),
  onCallEnded: async (callId: Id) => manager?.onCallEnded(callId),
  setCamera: async (on: boolean) => manager?.setCamera(on),
  startScreenShare: async (opts: {
    quality: ScreenQuality;
    /** Native capture (picker); without it the system picker is used. */
    source?: CaptureSource;
    surface?: "monitor" | "window";
    motion: boolean;
    audio: CaptureMode | null;
  }) => manager?.startScreenShare(opts),
  stopScreenShare: async () => manager?.stopScreenShare(),
  watchStream: (identity: Id, on: boolean) => manager?.watchStream(identity, on),
  restartMic: async () => manager?.restartMic(),
  onPushToTalkSettingChanged: async () => manager?.onPushToTalkSettingChanged(),

  /** Works before joining too: the state is applied when the call connects. */
  async toggleMute() {
    if (manager && useCall.getState().status !== "idle") return manager.toggleMute();
    const s = useCall.getState();
    if (s.deafened) setCallUi({ deafened: false, muted: false });
    else setCallUi({ muted: !s.muted });
  },
  async toggleDeafen() {
    if (manager && useCall.getState().status !== "idle") return manager.toggleDeafen();
    const s = useCall.getState();
    setCallUi(s.deafened ? { deafened: false, muted: false } : { deafened: true, muted: true });
  },

  videoTrack(identity: Id, source: "camera" | "screen_share"): AttachableTrack | undefined {
    return manager?.videoTrack(identity, source);
  },
};

// Global hotkeys arrive even while minimized; route them to the call.
void listen<{ action: string; pressed: boolean }>("hotkey", (e) => {
  if (e.action === "mute" && e.pressed) void calls.toggleMute();
  else if (e.action === "deafen" && e.pressed) void calls.toggleDeafen();
  else manager?.onHotkey(e.action, e.pressed);
});
