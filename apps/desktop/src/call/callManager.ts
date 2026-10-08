import type { Id } from "@nexus/protocol";
import { backoffDelay } from "@nexus/shared";
import {
  AudioPresets,
  ConnectionState,
  DisconnectReason,
  type LocalAudioTrack,
  type LocalTrackPublication,
  type LocalVideoTrack,
  type Participant,
  type RemoteParticipant,
  Room,
  RoomEvent,
  Track,
  VideoPresets,
} from "livekit-client";
import { client } from "../lib/nexus";
import { type ScreenQuality, settings, useSettings } from "../lib/settings";
import { type ParticipantView, idleCall as idle, setCallUi as setUi, useCall } from "./callStore";
import { releaseAudio, resumeAudio, sharedAudioContext } from "./audioContext";
import { RnnoiseProcessor } from "./noise";
import { type Limitation, QualityGovernor, type QualityPreset, autoStart, preset } from "./screenQuality";
import { type CaptureMode, SystemAudioCapture } from "./systemAudio";

function audioConstraints() {
  const s = settings();
  return {
    deviceId: s.inputDeviceId && s.inputDeviceId !== "default" ? { ideal: s.inputDeviceId } : undefined,
    echoCancellation: s.echoCancellation,
    autoGainControl: s.autoGainControl,
    // Browser (WebRTC APM) suppression only in Standard mode; Enhanced uses
    // RNNoise instead so the voice is not processed twice.
    noiseSuppression: s.noise === "standard",
    channelCount: 1,
  };
}

export class CallManager {
  room: Room | null = null;
  private wantMuted = false;
  private mutedBeforeDeafen = false;
  private rnnoise: RnnoiseProcessor | null = null;
  private systemAudio: SystemAudioCapture | null = null;
  private screenAudioPub: LocalTrackPublication | null = null;
  private governor: QualityGovernor | null = null;
  private statsTimer: ReturnType<typeof setTimeout> | null = null;
  private pttReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  private stateSync: ReturnType<typeof setTimeout> | null = null;
  private rejoinAttempt = 0;
  private leaving = false;

  constructor() {
    this.wantMuted = useCall.getState().muted;
    // Reapply local volumes when the user changes them in settings.
    useSettings.subscribe((s, prev) => {
      if (s.volumes !== prev.volumes || s.localMutes !== prev.localMutes) this.applyVolumes();
      if (s.outputDeviceId !== prev.outputDeviceId && this.room)
        void this.room.switchActiveDevice("audiooutput", s.outputDeviceId);
    });
  }

  // ---------- join / leave ----------

  async start(conversationId: Id): Promise<void> {
    const join = await client().api.startCall(conversationId);
    await this.connect(join.call.id, join.call.conversation_id, join.livekit_url, join.livekit_token);
  }

  async join(callId: Id): Promise<void> {
    const join = await client().api.joinCall(callId);
    await this.connect(join.call.id, join.call.conversation_id, join.livekit_url, join.livekit_token);
  }

  private async connect(callId: Id, conversationId: Id, url: string, token: string) {
    if (this.room) await this.teardown(false);
    this.leaving = false;
    const pre = useCall.getState();
    this.wantMuted = pre.muted;
    setUi({ ...idle, status: "connecting", callId, conversationId, muted: pre.muted, deafened: pre.deafened });
    await resumeAudio();
    const s = settings();
    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
      // Mixing in WebAudio enables per-user gain above 100%.
      webAudioMix: { audioContext: sharedAudioContext() },
      audioCaptureDefaults: audioConstraints(),
      audioOutput: s.outputDeviceId ? { deviceId: s.outputDeviceId } : undefined,
      publishDefaults: {
        dtx: true,
        red: true,
        audioPreset: AudioPresets.speech,
        simulcast: true,
        videoCodec: "vp8",
      },
      videoCaptureDefaults: { resolution: VideoPresets.h720.resolution },
      disconnectOnPageLeave: true,
    });
    this.room = room;
    this.wire(room);
    try {
      await room.connect(url, token, { autoSubscribe: true });
    } catch (e) {
      this.room = null;
      setUi({ ...idle, error: `Não foi possível conectar à chamada: ${(e as Error).message}` });
      void client().api.leaveCall(callId).catch(() => undefined);
      throw e;
    }
    this.rejoinAttempt = 0;
    setUi({ status: "connected" });
    await this.publishMic();
    this.refresh();
    this.syncServerState();
  }

  async leave(): Promise<void> {
    const callId = useCall.getState().callId;
    this.leaving = true;
    await this.teardown(true);
    if (callId) await client().api.leaveCall(callId).catch(() => undefined);
  }

  /** CALL_END from the gateway or the call disappearing from state. */
  async onCallEnded(callId: Id) {
    if (useCall.getState().callId !== callId) return;
    this.leaving = true;
    await this.teardown(true);
  }

  private async teardown(resetUi: boolean) {
    if (this.statsTimer) clearTimeout(this.statsTimer);
    this.statsTimer = null;
    await this.stopSystemAudio();
    const room = this.room;
    this.room = null;
    if (room) await room.disconnect(true);
    await this.rnnoise?.destroy();
    this.rnnoise = null;
    this.governor = null;
    if (resetUi) setUi({ ...idle, muted: this.wantMuted, deafened: useCall.getState().deafened });
    void releaseAudio();
  }

  private wire(room: Room) {
    const refresh = () => this.refresh();
    const bump = () => {
      setUi({ trackVersion: useCall.getState().trackVersion + 1 });
      this.refresh();
      this.applyVolumes();
    };
    room
      .on(RoomEvent.ParticipantConnected, refresh)
      .on(RoomEvent.ParticipantDisconnected, refresh)
      .on(RoomEvent.ActiveSpeakersChanged, refresh)
      .on(RoomEvent.TrackMuted, refresh)
      .on(RoomEvent.TrackUnmuted, refresh)
      .on(RoomEvent.TrackSubscribed, bump)
      .on(RoomEvent.TrackUnsubscribed, bump)
      .on(RoomEvent.LocalTrackPublished, bump)
      .on(RoomEvent.LocalTrackUnpublished, (pub) => {
        // Browser's own "stop sharing" button ends the screen track.
        if (pub.source === Track.Source.ScreenShare) void this.afterScreenStopped();
        bump();
      })
      .on(RoomEvent.ConnectionQualityChanged, refresh)
      .on(RoomEvent.Reconnecting, () => setUi({ status: "reconnecting" }))
      .on(RoomEvent.Reconnected, () => setUi({ status: "connected" }))
      .on(RoomEvent.Disconnected, (reason) => void this.onDisconnected(room, reason));
  }

  /**
   * LiveKit already retries ICE/signal drops internally; this handles the
   * case where it gives up (long outage): ask our server for a new token for
   * the same call and reconnect, with backoff.
   */
  private async onDisconnected(room: Room, reason?: DisconnectReason) {
    if (this.room !== room || this.leaving) return;
    const callId = useCall.getState().callId;
    const terminal =
      reason === DisconnectReason.CLIENT_INITIATED ||
      reason === DisconnectReason.ROOM_DELETED ||
      reason === DisconnectReason.PARTICIPANT_REMOVED ||
      reason === DisconnectReason.DUPLICATE_IDENTITY;
    if (terminal || !callId || this.rejoinAttempt >= 6) {
      await this.teardown(true);
      if (reason === DisconnectReason.DUPLICATE_IDENTITY)
        setUi({ error: "Você entrou nesta chamada em outro dispositivo." });
      return;
    }
    setUi({ status: "reconnecting" });
    const delay = backoffDelay(this.rejoinAttempt++, { baseMs: 1000, capMs: 15_000 });
    setTimeout(() => {
      if (this.room !== room || this.leaving) return;
      void this.join(callId).catch(() => this.onDisconnected(room, reason));
    }, delay);
  }

  // ---------- microphone ----------

  private micPub(): LocalTrackPublication | undefined {
    return this.room?.localParticipant.getTrackPublication(Track.Source.Microphone);
  }

  private async publishMic() {
    const room = this.room;
    if (!room) return;
    try {
      await room.localParticipant.setMicrophoneEnabled(true, audioConstraints());
    } catch (e) {
      setUi({ error: `Microfone indisponível: ${(e as Error).message}` });
      return;
    }
    await this.applyNoiseMode();
    await this.applyMicGate();
  }

  /** Effective mic state = !(muted || deafened || (PTT && !held)). */
  private async applyMicGate() {
    const pub = this.micPub();
    if (!pub) return;
    const ui = useCall.getState();
    const closed = ui.muted || ui.deafened || (settings().pushToTalk && !ui.pttHeld);
    if (closed && !pub.isMuted) await pub.mute();
    else if (!closed && pub.isMuted) await pub.unmute();
    this.refresh();
  }

  async applyNoiseMode() {
    const track = this.micPub()?.track as LocalAudioTrack | undefined;
    if (!track) return;
    const mode = settings().noise;
    if (mode === "enhanced") {
      if (!this.rnnoise) {
        this.rnnoise = new RnnoiseProcessor();
        try {
          await track.setProcessor(this.rnnoise);
        } catch (e) {
          this.rnnoise = null;
          setUi({ error: `Supressão avançada indisponível: ${(e as Error).message}` });
        }
      }
    } else if (this.rnnoise) {
      await track.stopProcessor();
      this.rnnoise = null;
    }
  }

  /** Re-acquires the mic with new constraints (device, NS, AEC, AGC). */
  async restartMic() {
    const track = this.micPub()?.track as LocalAudioTrack | undefined;
    if (!track) return;
    await track.restartTrack(audioConstraints());
    await this.applyNoiseMode();
  }

  async toggleMute() {
    const ui = useCall.getState();
    if (ui.deafened) {
      // Unmuting while deafened also undeafens.
      await this.setDeafened(false);
      this.wantMuted = false;
      setUi({ muted: false });
    } else {
      this.wantMuted = !ui.muted;
      setUi({ muted: this.wantMuted });
    }
    await this.applyMicGate();
    this.syncServerState();
  }

  async setDeafened(deafened: boolean) {
    const ui = useCall.getState();
    if (deafened === ui.deafened) return;
    if (deafened) {
      this.mutedBeforeDeafen = ui.muted;
      setUi({ deafened: true, muted: true });
    } else {
      setUi({ deafened: false, muted: this.mutedBeforeDeafen });
      this.wantMuted = this.mutedBeforeDeafen;
    }
    this.applyVolumes();
    await this.applyMicGate();
    this.syncServerState();
  }

  toggleDeafen() {
    return this.setDeafened(!useCall.getState().deafened);
  }

  onHotkey(action: string, pressed: boolean) {
    switch (action) {
      case "ptt":
        if (!settings().pushToTalk) return;
        if (pressed) {
          if (this.pttReleaseTimer) clearTimeout(this.pttReleaseTimer);
          this.pttReleaseTimer = null;
          setUi({ pttHeld: true });
          void this.applyMicGate();
        } else {
          this.pttReleaseTimer = setTimeout(() => {
            setUi({ pttHeld: false });
            void this.applyMicGate();
          }, settings().pttReleaseMs);
        }
        return;
      case "mute":
        if (pressed) void this.toggleMute();
        return;
      case "deafen":
        if (pressed) void this.toggleDeafen();
        return;
      case "camera_on":
        if (pressed) void this.setCamera(true);
        return;
      case "camera_off":
        if (pressed) void this.setCamera(false);
        return;
    }
  }

  async onPushToTalkSettingChanged() {
    setUi({ pttHeld: false });
    await this.applyMicGate();
  }

  // ---------- playback ----------

  /** Local-only volumes (0..200%) and mutes; deafen silences everyone. */
  applyVolumes() {
    const room = this.room;
    if (!room) return;
    const s = settings();
    const deaf = useCall.getState().deafened;
    for (const p of room.remoteParticipants.values()) {
      const v = deaf || s.localMutes[p.identity] ? 0 : (s.volumes[p.identity] ?? 1);
      p.setVolume(v, Track.Source.Microphone);
      p.setVolume(deaf ? 0 : v, Track.Source.ScreenShareAudio);
    }
  }

  // ---------- camera ----------

  async setCamera(on: boolean) {
    const room = this.room;
    if (!room) return;
    try {
      const deviceId = settings().cameraDeviceId || undefined;
      await room.localParticipant.setCameraEnabled(
        on,
        { deviceId, resolution: VideoPresets.h720.resolution },
        { simulcast: true, videoCodec: "vp8" },
      );
      setUi({ cameraOn: on });
    } catch (e) {
      setUi({ error: `Câmera indisponível: ${(e as Error).message}` });
    }
    this.syncServerState();
  }

  // ---------- screen share ----------

  async startScreenShare(opts: {
    quality: ScreenQuality;
    surface: "monitor" | "window";
    motion: boolean;
    audio: CaptureMode | null;
  }) {
    const room = this.room;
    if (!room) return;
    const auto = opts.quality === "auto";
    const p: QualityPreset = auto ? autoStart() : preset(opts.quality as QualityPreset["id"]);
    const allow60 = opts.motion && (navigator.hardwareConcurrency || 4) >= 8;
    try {
      await room.localParticipant.setScreenShareEnabled(
        true,
        {
          audio: false,
          video: { displaySurface: opts.surface },
          resolution: { width: p.width, height: p.height, frameRate: p.fps },
          contentHint: opts.motion ? "motion" : "detail",
          selfBrowserSurface: "exclude",
          surfaceSwitching: "include",
          systemAudio: "exclude",
        },
        {
          // H.264 is the codec WebView2 is most likely to hardware-encode.
          videoCodec: "h264",
          backupCodec: { codec: "vp8" },
          screenShareEncoding: { maxBitrate: p.maxBitrate, maxFramerate: p.fps },
          degradationPreference: opts.motion ? "maintain-framerate" : "maintain-resolution",
          simulcast: false,
        },
      );
    } catch (e) {
      const err = e as Error;
      if (err.name !== "NotAllowedError") setUi({ error: `Não foi possível compartilhar a tela: ${err.message}` });
      return;
    }
    this.governor = new QualityGovernor(p, auto, allow60);
    setUi({ screenOn: true, screenQuality: p.label, screenNotice: null });
    if (opts.audio) await this.startSystemAudio(opts.audio);
    this.scheduleStats();
    this.syncServerState();
  }

  async stopScreenShare() {
    await this.room?.localParticipant.setScreenShareEnabled(false);
    await this.afterScreenStopped();
  }

  private async afterScreenStopped() {
    if (this.statsTimer) clearTimeout(this.statsTimer);
    this.statsTimer = null;
    this.governor = null;
    await this.stopSystemAudio();
    setUi({ screenOn: false, screenAudioOn: false, screenQuality: null, screenNotice: null });
    this.syncServerState();
  }

  private async startSystemAudio(mode: CaptureMode) {
    const room = this.room;
    if (!room) return;
    const capture = new SystemAudioCapture();
    try {
      const track = await capture.start(mode);
      this.systemAudio = capture;
      this.screenAudioPub = await room.localParticipant.publishTrack(track, {
        source: Track.Source.ScreenShareAudio,
        name: "system-audio",
        audioPreset: AudioPresets.musicHighQualityStereo,
        forceStereo: true,
        dtx: false,
        red: false,
      });
      setUi({ screenAudioOn: true });
    } catch (e) {
      await capture.stop();
      setUi({ error: `Áudio do computador indisponível: ${String((e as Error).message ?? e)}` });
    }
  }

  private async stopSystemAudio() {
    const pub = this.screenAudioPub;
    this.screenAudioPub = null;
    if (pub?.track && this.room) await this.room.localParticipant.unpublishTrack(pub.track).catch(() => undefined);
    await this.systemAudio?.stop();
    this.systemAudio = null;
  }

  /** Samples encoder stats every 5 s while sharing (no timer otherwise). */
  private scheduleStats() {
    this.statsTimer = setTimeout(() => void this.checkStats(), 5000);
  }

  private async checkStats() {
    const pub = this.room?.localParticipant.getTrackPublication(Track.Source.ScreenShare);
    const track = pub?.track as LocalVideoTrack | undefined;
    if (!track || !this.governor) return;
    try {
      const stats = await track.getSenderStats();
      const top = stats.sort((a, b) => (b.frameWidth ?? 0) - (a.frameWidth ?? 0))[0];
      const reason = (top?.qualityLimitationReason ?? "none") as Limitation;
      const next = this.governor.sample(reason, top?.framesPerSecond ?? 0);
      if (next) {
        await track.mediaStreamTrack.applyConstraints({
          width: { ideal: next.width },
          height: { ideal: next.height },
          frameRate: { ideal: next.fps },
        });
        const sender = track.sender;
        if (sender) {
          const params = sender.getParameters();
          for (const enc of params.encodings) {
            enc.maxBitrate = next.maxBitrate;
            enc.maxFramerate = next.fps;
          }
          await sender.setParameters(params);
        }
        const why = reason === "cpu" ? "CPU" : reason === "bandwidth" ? "conexão" : "";
        setUi({
          screenQuality: next.label,
          screenNotice: why ? `Qualidade reduzida para ${next.label} (limite de ${why}).` : null,
        });
      }
    } catch {
      // stats are best effort
    }
    if (useCall.getState().screenOn) this.scheduleStats();
  }

  // ---------- state ----------

  /** Debounced push of mute/deafen/camera/screen to the server (other clients' UI). */
  private syncServerState() {
    if (this.stateSync) clearTimeout(this.stateSync);
    this.stateSync = setTimeout(() => {
      const ui = useCall.getState();
      if (!ui.callId || ui.status === "idle") return;
      void client()
        .api.updateCallState(ui.callId, {
          muted: ui.muted,
          deafened: ui.deafened,
          video: ui.cameraOn,
          screen: ui.screenOn,
        })
        .catch(() => undefined);
    }, 250);
  }

  private refresh() {
    const room = this.room;
    if (!room || room.state === ConnectionState.Disconnected) return;
    const view = (p: Participant, isLocal: boolean): ParticipantView => {
      const mic = p.getTrackPublication(Track.Source.Microphone);
      return {
        identity: p.identity,
        name: p.name || p.identity,
        isLocal,
        speaking: p.isSpeaking,
        micMuted: !mic || mic.isMuted,
        hasCamera: !!p.getTrackPublication(Track.Source.Camera)?.track && !p.getTrackPublication(Track.Source.Camera)?.isMuted,
        hasScreen: !!p.getTrackPublication(Track.Source.ScreenShare)?.track,
        hasScreenAudio: !!p.getTrackPublication(Track.Source.ScreenShareAudio),
        quality: p.connectionQuality,
      };
    };
    const participants = [
      view(room.localParticipant, true),
      ...[...room.remoteParticipants.values()].map((p: RemoteParticipant) => view(p, false)),
    ];
    setUi({ participants });
  }

  videoTrack(identity: Id, source: "camera" | "screen_share") {
    const room = this.room;
    if (!room) return undefined;
    const p = identity === room.localParticipant.identity ? room.localParticipant : room.remoteParticipants.get(identity);
    const src = source === "camera" ? Track.Source.Camera : Track.Source.ScreenShare;
    return p?.getTrackPublication(src)?.track;
  }
}
