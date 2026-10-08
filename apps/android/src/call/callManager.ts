import { AudioSession } from '@livekit/react-native';
import type { Id } from '@nexus/protocol';
import { backoffDelay } from '@nexus/shared';
import {
  AudioPresets,
  DisconnectReason,
  type LocalTrackPublication,
  type Participant,
  Room,
  RoomEvent,
  Track,
  VideoPresets,
} from 'livekit-client';
import { type Permission, PermissionsAndroid } from 'react-native';
import { create } from 'zustand';
import { client } from '../lib/nexus';
import { CAPTURE_BLOCKED_EVENT, NexusNative, nativeEvents } from '../native/NexusNative';

export interface ParticipantView {
  identity: Id;
  name: string;
  isLocal: boolean;
  speaking: boolean;
  micMuted: boolean;
  hasCamera: boolean;
  hasScreen: boolean;
}

export interface CallState {
  status: 'idle' | 'connecting' | 'connected' | 'reconnecting';
  callId: Id | null;
  conversationId: Id | null;
  error: string | null;
  muted: boolean;
  deafened: boolean;
  cameraOn: boolean;
  screenOn: boolean;
  screenAudioOn: boolean;
  /** An app currently playing does not allow its audio to be captured. */
  captureBlocked: boolean;
  participants: ParticipantView[];
  /** userId -> local volume (0..2). */
  volumes: Record<Id, number>;
  version: number;
}

const idle: CallState = {
  status: 'idle',
  callId: null,
  conversationId: null,
  error: null,
  muted: false,
  deafened: false,
  cameraOn: false,
  screenOn: false,
  screenAudioOn: false,
  captureBlocked: false,
  participants: [],
  volumes: {},
  version: 0,
};

export const useCall = create<CallState>()(() => ({ ...idle }));
const set = (p: Partial<CallState>) => useCall.setState(p);

async function ensurePermissions(video: boolean): Promise<boolean> {
  const wanted: Permission[] = [PermissionsAndroid.PERMISSIONS.RECORD_AUDIO];
  if (video) wanted.push(PermissionsAndroid.PERMISSIONS.CAMERA);
  const res = await PermissionsAndroid.requestMultiple(wanted);
  return wanted.every((p) => res[p] === PermissionsAndroid.RESULTS.GRANTED);
}

class CallManager {
  room: Room | null = null;
  private leaving = false;
  private attempt = 0;
  private mutedBeforeDeafen = false;

  async start(conversationId: Id, video = false) {
    if (!(await ensurePermissions(video))) {
      set({ error: 'Permita o acesso ao microfone para entrar na chamada.' });
      return;
    }
    const join = await client().api.startCall(conversationId);
    await this.connect(join.call.id, join.call.conversation_id, join.livekit_url, join.livekit_token);
    if (video) await this.setCamera(true);
  }

  async join(callId: Id) {
    if (!(await ensurePermissions(false))) {
      set({ error: 'Permita o acesso ao microfone para entrar na chamada.' });
      return;
    }
    const join = await client().api.joinCall(callId);
    await this.connect(join.call.id, join.call.conversation_id, join.livekit_url, join.livekit_token);
  }

  private async connect(callId: Id, conversationId: Id, url: string, token: string) {
    if (this.room) await this.teardown(false);
    this.leaving = false;
    const keep = useCall.getState();
    set({ ...idle, status: 'connecting', callId, conversationId, muted: keep.muted, volumes: keep.volumes });
    await AudioSession.startAudioSession();
    const room = new Room({
      adaptiveStream: { pixelDensity: 'screen' },
      dynacast: true,
      audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      publishDefaults: { dtx: true, red: true, audioPreset: AudioPresets.speech, simulcast: true, videoCodec: 'vp8' },
      videoCaptureDefaults: { resolution: VideoPresets.h540.resolution },
    });
    this.room = room;
    const refresh = () => this.refresh();
    room
      .on(RoomEvent.ParticipantConnected, refresh)
      .on(RoomEvent.ParticipantDisconnected, refresh)
      .on(RoomEvent.ActiveSpeakersChanged, refresh)
      .on(RoomEvent.TrackMuted, refresh)
      .on(RoomEvent.TrackUnmuted, refresh)
      .on(RoomEvent.TrackSubscribed, () => {
        this.applyVolumes();
        this.bump();
      })
      .on(RoomEvent.TrackUnsubscribed, () => this.bump())
      .on(RoomEvent.LocalTrackPublished, () => this.bump())
      .on(RoomEvent.LocalTrackUnpublished, (pub) => {
        if (pub.source === Track.Source.ScreenShare) void this.afterScreenStopped();
        this.bump();
      })
      .on(RoomEvent.Reconnecting, () => set({ status: 'reconnecting' }))
      .on(RoomEvent.Reconnected, () => set({ status: 'connected' }))
      .on(RoomEvent.Disconnected, (reason) => void this.onDisconnected(room, reason));
    try {
      await room.connect(url, token, { autoSubscribe: true });
    } catch (e) {
      this.room = null;
      await AudioSession.stopAudioSession();
      set({ ...idle, error: `Não foi possível conectar: ${(e as Error).message}` });
      void client().api.leaveCall(callId).catch(() => undefined);
      return;
    }
    this.attempt = 0;
    set({ status: 'connected' });
    // Keeps the microphone and the call alive with the screen off / app in background.
    await NexusNative.startCallService('Em chamada').catch(() => undefined);
    await room.localParticipant.setMicrophoneEnabled(true);
    await this.applyMicGate();
    this.refresh();
    this.sync();
  }

  private async onDisconnected(room: Room, reason?: DisconnectReason) {
    if (this.room !== room || this.leaving) return;
    const callId = useCall.getState().callId;
    const terminal =
      reason === DisconnectReason.CLIENT_INITIATED ||
      reason === DisconnectReason.ROOM_DELETED ||
      reason === DisconnectReason.PARTICIPANT_REMOVED ||
      reason === DisconnectReason.DUPLICATE_IDENTITY;
    if (terminal || !callId || this.attempt >= 6) {
      await this.teardown(true);
      return;
    }
    set({ status: 'reconnecting' });
    setTimeout(() => {
      if (this.room !== room || this.leaving) return;
      void this.join(callId).catch(() => this.onDisconnected(room, reason));
    }, backoffDelay(this.attempt++, { baseMs: 1000, capMs: 15_000 }));
  }

  async leave() {
    const callId = useCall.getState().callId;
    this.leaving = true;
    await this.teardown(true);
    if (callId) await client().api.leaveCall(callId).catch(() => undefined);
  }

  async onCallEnded(callId: Id) {
    if (useCall.getState().callId !== callId) return;
    this.leaving = true;
    await this.teardown(true);
  }

  private async teardown(reset: boolean) {
    await this.stopDeviceAudio();
    const room = this.room;
    this.room = null;
    if (room) await room.disconnect(true);
    await AudioSession.stopAudioSession().catch(() => undefined);
    await NexusNative.stopCallService().catch(() => undefined);
    if (reset) {
      const s = useCall.getState();
      set({ ...idle, muted: s.muted, volumes: s.volumes });
    }
  }

  private micPub(): LocalTrackPublication | undefined {
    return this.room?.localParticipant.getTrackPublication(Track.Source.Microphone);
  }

  /**
   * While device audio is shared it is mixed into the microphone track, so
   * muting must silence only the voice (natively) and keep the track open.
   */
  private async applyMicGate() {
    const s = useCall.getState();
    const closed = s.muted || s.deafened;
    const pub = this.micPub();
    if (s.screenAudioOn) {
      if (pub?.isMuted) await pub.unmute();
      await NexusNative.setMicMuted(closed);
    } else if (pub) {
      if (closed && !pub.isMuted) await pub.mute();
      else if (!closed && pub.isMuted) await pub.unmute();
    }
    this.refresh();
  }

  async toggleMute() {
    const s = useCall.getState();
    if (s.deafened) set({ deafened: false, muted: false });
    else set({ muted: !s.muted });
    this.applyVolumes();
    await this.applyMicGate();
    this.sync();
  }

  async toggleDeafen() {
    const s = useCall.getState();
    if (s.deafened) set({ deafened: false, muted: this.mutedBeforeDeafen });
    else {
      this.mutedBeforeDeafen = s.muted;
      set({ deafened: true, muted: true });
    }
    this.applyVolumes();
    await this.applyMicGate();
    this.sync();
  }

  setVolume(identity: Id, volume: number) {
    set({ volumes: { ...useCall.getState().volumes, [identity]: Math.max(0, Math.min(2, volume)) } });
    this.applyVolumes();
  }

  private applyVolumes() {
    const room = this.room;
    if (!room) return;
    const s = useCall.getState();
    for (const p of room.remoteParticipants.values()) {
      const v = s.deafened ? 0 : (s.volumes[p.identity] ?? 1);
      p.setVolume(v, Track.Source.Microphone);
      p.setVolume(s.deafened ? 0 : v, Track.Source.ScreenShareAudio);
    }
  }

  async setCamera(on: boolean) {
    const room = this.room;
    if (!room) return;
    if (on && !(await ensurePermissions(true))) return;
    try {
      await room.localParticipant.setCameraEnabled(on);
      set({ cameraOn: on });
    } catch (e) {
      set({ error: `Câmera indisponível: ${(e as Error).message}` });
    }
    this.sync();
  }

  async switchCamera() {
    const pub = this.room?.localParticipant.getTrackPublication(Track.Source.Camera);
    const track = pub?.track?.mediaStreamTrack as unknown as { _switchCamera?: () => void } | undefined;
    track?._switchCamera?.();
  }

  /** MediaProjection (foreground service handled by react-native-webrtc). */
  async startScreenShare(withAudio: boolean) {
    const room = this.room;
    if (!room) return;
    try {
      await room.localParticipant.setScreenShareEnabled(true, undefined, {
        screenShareEncoding: { maxBitrate: 2_500_000, maxFramerate: 30 },
        videoCodec: 'vp8',
      });
    } catch (e) {
      set({ error: `Não foi possível compartilhar a tela: ${(e as Error).message}` });
      return;
    }
    set({ screenOn: true });
    if (withAudio) await this.startDeviceAudio();
    this.sync();
  }

  async stopScreenShare() {
    await this.room?.localParticipant.setScreenShareEnabled(false);
    await this.afterScreenStopped();
  }

  private async afterScreenStopped() {
    await this.stopDeviceAudio();
    set({ screenOn: false });
    this.sync();
  }

  private async startDeviceAudio() {
    try {
      if (!(await NexusNative.playbackCaptureSupported())) {
        set({ error: 'Compartilhar o áudio do aparelho requer Android 10 ou superior.' });
        return;
      }
      await NexusNative.startPlaybackCapture();
      set({ screenAudioOn: true, captureBlocked: false });
      await this.applyMicGate();
    } catch (e) {
      set({ error: `Áudio do aparelho indisponível: ${(e as Error).message}` });
    }
  }

  private async stopDeviceAudio() {
    if (!useCall.getState().screenAudioOn) return;
    await NexusNative.stopPlaybackCapture().catch(() => undefined);
    await NexusNative.setMicMuted(false).catch(() => undefined);
    set({ screenAudioOn: false, captureBlocked: false });
    await this.applyMicGate();
  }

  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private sync() {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      const s = useCall.getState();
      if (!s.callId || s.status === 'idle') return;
      void client()
        .api.updateCallState(s.callId, { muted: s.muted, deafened: s.deafened, video: s.cameraOn, screen: s.screenOn })
        .catch(() => undefined);
    }, 250);
  }

  private bump() {
    set({ version: useCall.getState().version + 1 });
    this.refresh();
  }

  private refresh() {
    const room = this.room;
    if (!room) return;
    const view = (p: Participant, isLocal: boolean): ParticipantView => {
      const mic = p.getTrackPublication(Track.Source.Microphone);
      const cam = p.getTrackPublication(Track.Source.Camera);
      return {
        identity: p.identity,
        name: p.name || p.identity,
        isLocal,
        speaking: p.isSpeaking,
        micMuted: !mic || mic.isMuted,
        hasCamera: !!cam?.track && !cam.isMuted,
        hasScreen: !!p.getTrackPublication(Track.Source.ScreenShare)?.track,
      };
    };
    set({
      participants: [view(room.localParticipant, true), ...[...room.remoteParticipants.values()].map((p) => view(p, false))],
    });
  }

  trackRef(identity: Id, source: Track.Source) {
    const room = this.room;
    if (!room) return undefined;
    const participant =
      identity === room.localParticipant.identity ? room.localParticipant : room.remoteParticipants.get(identity);
    const publication = participant?.getTrackPublication(source);
    if (!participant || !publication) return undefined;
    return { participant, publication, source };
  }
}

export const calls = new CallManager();

nativeEvents?.addListener(CAPTURE_BLOCKED_EVENT, (e) => {
  const blocked = (e as { blocked?: boolean }).blocked === true;
  if (useCall.getState().screenAudioOn) set({ captureBlocked: blocked });
});
