import { create } from "zustand";

export type NoiseMode = "off" | "standard" | "enhanced";
export type ScreenQuality = "auto" | "720p30" | "1080p30" | "1080p60";
export type HotkeyAction = "ptt" | "mute" | "deafen" | "camera_on" | "camera_off";

export interface HotkeyBinding {
  action: HotkeyAction;
  code: number;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  name: string;
}

export interface Settings {
  serverUrl: string;
  inputDeviceId: string;
  outputDeviceId: string;
  cameraDeviceId: string;
  noise: NoiseMode;
  echoCancellation: boolean;
  autoGainControl: boolean;
  pushToTalk: boolean;
  /** Keep the mic open briefly after releasing PTT so the last word is not cut. */
  pttReleaseMs: number;
  hotkeys: HotkeyBinding[];
  screenQuality: ScreenQuality;
  /** userId -> 0..2 (local playback volume, 1 = 100%). */
  volumes: Record<string, number>;
  /** userId -> locally muted. */
  localMutes: Record<string, boolean>;
  closeToTray: boolean;
  notifications: boolean;
  /** Download new versions from GitHub in the background. */
  autoUpdate: boolean;
}

const KEY = "nexus.settings.v1";

const defaults: Settings = {
  serverUrl: "",
  inputDeviceId: "default",
  outputDeviceId: "default",
  cameraDeviceId: "",
  noise: "standard",
  echoCancellation: true,
  autoGainControl: true,
  pushToTalk: false,
  pttReleaseMs: 200,
  hotkeys: [],
  screenQuality: "auto",
  volumes: {},
  localMutes: {},
  closeToTray: true,
  notifications: true,
  autoUpdate: true,
};

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...defaults, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    // corrupted settings: fall back to defaults
  }
  return { ...defaults };
}

interface SettingsStore extends Settings {
  set: (patch: Partial<Settings>) => void;
}

export const useSettings = create<SettingsStore>()((set, get) => ({
  ...load(),
  set: (patch) => {
    set(patch);
    const { set: _omit, ...data } = { ...get(), ...patch };
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
    } catch {
      /* storage full or disabled */
    }
  },
}));

export const settings = () => useSettings.getState();
