import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

/** Kotlin module: android/app/src/main/java/app/nexus/android/NexusNativeModule.kt */
interface NexusNativeSpec {
  getPref(key: string): Promise<string | null>;
  setPref(key: string, value: string | null): Promise<void>;
  startCallService(title: string): Promise<void>;
  stopCallService(): Promise<void>;
  notify(title: string, body: string): Promise<void>;
  pickFiles(): Promise<PickedFile[]>;
  playbackCaptureSupported(): Promise<boolean>;
  startPlaybackCapture(): Promise<void>;
  stopPlaybackCapture(): Promise<void>;
  setMicMuted(muted: boolean): Promise<void>;
  getAppVersion(): Promise<string>;
  installUpdate(url: string, version: string): Promise<'permission' | 'downloading'>;
  playSound(name: string, volume: number): Promise<void>;
  startSoundLoop(name: string, volume: number): Promise<void>;
  stopSoundLoop(name: string): Promise<void>;
  voiceStart(): Promise<void>;
  voiceStop(): Promise<VoiceFile | null>;
  voiceCancel(): void;
  audioPlay(id: string, url: string): void;
  audioPause(): void;
  audioSeek(positionMs: number): void;
  audioStop(): void;
  playVideo(url: string, title: string, type: string): void;
  copyText(text: string): void;
}

export interface VoiceFile {
  uri: string;
  name: string;
  type: string;
  size: number;
  durationMs: number;
}

export interface PickedFile {
  uri: string;
  name: string;
  size: number;
  type: string;
}

const mod: NexusNativeSpec | undefined = NativeModules.NexusNative;

function native(): NexusNativeSpec {
  if (!mod) throw new Error('NexusNative module is not linked');
  return mod;
}

// Promise methods are async so a missing module rejects (callers .catch) instead
// of throwing synchronously.
export const NexusNative = {
  getPref: async (key: string) => native().getPref(key),
  setPref: async (key: string, value: string | null) => native().setPref(key, value),
  startCallService: async (title: string) => native().startCallService(title),
  stopCallService: async () => native().stopCallService(),
  notify: async (title: string, body: string) => native().notify(title, body),
  pickFiles: async () => native().pickFiles(),
  playbackCaptureSupported: async () =>
    Platform.OS === 'android' && Number(Platform.Version) >= 29 && native().playbackCaptureSupported(),
  startPlaybackCapture: async () => native().startPlaybackCapture(),
  stopPlaybackCapture: async () => native().stopPlaybackCapture(),
  setMicMuted: async (muted: boolean) => native().setMicMuted(muted),
  getAppVersion: async () => native().getAppVersion(),
  installUpdate: async (url: string, version: string) => native().installUpdate(url, version),
  // Fire-and-forget @ReactMethods (no Promise on the Kotlin side).
  playSound: async (name: string, volume: number) => native().playSound(name, volume),
  startSoundLoop: async (name: string, volume: number) => native().startSoundLoop(name, volume),
  stopSoundLoop: async (name: string) => native().stopSoundLoop(name),
  voiceStart: async () => native().voiceStart(),
  voiceStop: async () => native().voiceStop(),
  voiceCancel: () => native().voiceCancel(),
  audioPlay: (id: string, url: string) => native().audioPlay(id, url),
  audioPause: () => native().audioPause(),
  audioSeek: (positionMs: number) => native().audioSeek(positionMs),
  audioStop: () => native().audioStop(),
  /** Full-screen native player (VideoPlayerActivity). */
  playVideo: (url: string, title: string, type: string) => native().playVideo(url, title, type),
  copyText: (text: string) => native().copyText(text),
};

/** Chat audio player progress: { id, state, position, duration } (ms). */
export const AUDIO_EVENT = 'NexusAudio';

export const UPDATE_ERROR_EVENT = 'NexusUpdateError';

/**
 * Emitted while sharing device audio when an app that is playing forbids
 * capture (allowAudioPlaybackCapture=false / old targetSdk). Android's
 * protection is respected; we only inform the user.
 */
export const CAPTURE_BLOCKED_EVENT = 'NexusCaptureBlocked';
export const nativeEvents = mod ? new NativeEventEmitter(NativeModules.NexusNative) : null;
