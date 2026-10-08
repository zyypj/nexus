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

export const NexusNative = {
  getPref: (key: string) => native().getPref(key),
  setPref: (key: string, value: string | null) => native().setPref(key, value),
  startCallService: (title: string) => native().startCallService(title),
  stopCallService: () => native().stopCallService(),
  notify: (title: string, body: string) => native().notify(title, body),
  pickFiles: () => native().pickFiles(),
  playbackCaptureSupported: async () =>
    Platform.OS === 'android' && Number(Platform.Version) >= 29 && native().playbackCaptureSupported(),
  startPlaybackCapture: () => native().startPlaybackCapture(),
  stopPlaybackCapture: () => native().stopPlaybackCapture(),
  setMicMuted: (muted: boolean) => native().setMicMuted(muted),
};

/**
 * Emitted while sharing device audio when an app that is playing forbids
 * capture (allowAudioPlaybackCapture=false / old targetSdk). Android's
 * protection is respected; we only inform the user.
 */
export const CAPTURE_BLOCKED_EVENT = 'NexusCaptureBlocked';
export const nativeEvents = mod ? new NativeEventEmitter(NativeModules.NexusNative) : null;
