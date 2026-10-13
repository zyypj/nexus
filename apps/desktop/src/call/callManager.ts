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
  TrackEvent,
  VideoPresets,
} from "livekit-client";
import { client } from "../lib/nexus";
import { invoke } from "../lib/platform";
import {
  SILENT_VIRTUAL_MIC,
  type ScreenQuality,
  isChosenMic,
  isDeviceError,
  micDeviceId,
  settings,
  useSettings,
} from "../lib/settings";
import { playSound, startLoop, stopLoop } from "../lib/sounds";
import {
  type CallUiState,
  type ParticipantView,
  idleCall as idle,
  setCallUi as setUi,
  useCall,
} from "./callStore";
import { releaseAudio, resumeAudio, sharedAudioContext } from "./audioContext";
import { MicProcessor } from "./noise";
import { SpeakingDetector } from "./speaking";
import { type Limitation, QualityGovernor, type QualityPreset, autoStart, preset } from "./screenQuality";
import { type CaptureSource, NativeScreenCapture } from "./nativeScreen";
import { syncStage, watchStream } from "./stageLayout";
import { type CaptureMode, SystemAudioCapture } from "./systemAudio";

/** Mic capture options; `fallback` = the system default instead of the chosen device. */
function audioConstraints(fallback = false) {
  const s = settings();
  return {
    deviceId: fallback ? undefined : micDeviceId(),
    echoCancellation: s.echoCancellation,
    autoGainControl: s.autoGainControl,
    // Browser (WebRTC APM) suppression only in Standard mode; Enhanced uses
    // RNNoise instead so the voice is not processed twice.
    noiseSuppression: s.noise === "standard",
    channelCount: 1,
  };
}

/**
 * Voice is mono. With echo cancellation and AGC both off Chromium opens many
 * mics in stereo despite `channelCount: 1`, and LiveKit would then flag the
 * track as stereo (and drop DTX/RED). The audio itself is downmixed by
 * MicProcessor (see applyNoiseMode).
 */
const MIC_PUBLISH = { forceStereo: false };

/**
 * Screen share codec by content:
 * - text / still screens: VP9 (L1T3, one resolution) — libvpx has a
 *   screen-content mode that keeps small text sharp at a fraction of the
 *   bitrate; hardware H.264 encoders ignore the content hint and blur text.
 * - motion (games, video): H.264, the codec WebView2 can encode in hardware.
 *   (Where it does not, it is OpenH264 in software: ~50 FPS at 1080p on a
 *   fast desktop CPU, see docs/SCREEN_SHARE.md.)
 * VP8 is the fallback for receivers that cannot decode the main codec.
 */
/**
 * The encoder never lowers the resolution of a screen share by itself: under
 * pressure it drops frames and comes back as soon as the pressure is gone.
 * With "maintain-framerate" (once used for motion) WebRTC's quality scaler
 * took over the resolution: a 1080p60 share started at 288x180, climbed one
 * step every 5-10 s and fell again at any dip, on a perfect network too. The
 * resolution is ours to choose (QualityGovernor).
 */
const SCREEN_DEGRADATION = "maintain-resolution" as const;

function screenCodec(motion: boolean) {
  return motion
    ? { videoCodec: "h264" as const, backupCodec: { codec: "vp8" as const } }
    : { videoCodec: "vp9" as const, scalabilityMode: "L1T3" as const, backupCodec: { codec: "vp8" as const } };
}

/**
 * Runs `publish` (of `track`) so that H.264 is encoded by the GPU when it can.
 * LiveKit's server settles on constrained baseline (42e01f), which WebView2
 * only encodes in software (OpenH264: 1080p60 does not reach 60 FPS and eats
 * the CPU a game needs). The GPU's encoder (NVIDIA/Intel/AMD through Media
 * Foundation) takes the other profiles; so when it offers High, H.264 is
 * offered as High only and the server picks that. Measured on the same
 * content at 8 Mbps: 54-55 FPS at QP 28, against 41-52 FPS at QP 32.
 * Without a hardware encoder nothing changes. Viewers that cannot decode it
 * get the backup codec, as for any codec they lack.
 */
async function withHardwareH264<T>(track: MediaStreamTrack, publish: () => Promise<T>): Promise<T> {
  const h264 = (c: RTCRtpCodec) => c.mimeType.toLowerCase() === "video/h264";
  const high = (c: RTCRtpCodec) => h264(c) && /profile-level-id=64/i.test(c.sdpFmtpLine ?? "");
  const codecs = RTCRtpSender.getCapabilities("video")?.codecs ?? [];
  if (!codecs.some(high)) return publish();
  const proto = RTCPeerConnection.prototype;
  const original = proto.addTransceiver;
  proto.addTransceiver = function (this: RTCPeerConnection, trackOrKind, init) {
    const transceiver = original.call(this, trackOrKind, init);
    if (trackOrKind === track) {
      try {
        transceiver.setCodecPreferences(codecs.filter((c) => !h264(c) || high(c)));
      } catch {
        // Keep the default codecs: software H.264 still works.
      }
    }
    return transceiver;
  };
  try {
    return await publish();
  } finally {
    proto.addTransceiver = original;
  }
}

export class CallManager {
  room: Room | null = null;
  private wantMuted = false;
  private mutedBeforeDeafen = false;
  private micProcessor: MicProcessor | null = null;
  private noiseChain: Promise<void> = Promise.resolve();
  private systemAudio: SystemAudioCapture | null = null;
  private screenAudioPub: LocalTrackPublication | null = null;
  private nativeScreen: NativeScreenCapture | null = null;
  /** What the native capture is showing, to restart it with another codec. */
  private screenSource: CaptureSource | null = null;
  private governor: QualityGovernor | null = null;
  private statsTimer: ReturnType<typeof setTimeout> | null = null;
  private pttReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  private stateSync: ReturnType<typeof setTimeout> | null = null;
  private rejoinAttempt = 0;
  private leaving = false;
  private callingTimer: ReturnType<typeof setTimeout> | null = null;
  private watchedMic: LocalAudioTrack | null = null;
  private speaking: SpeakingDetector | null = null;
  /** Remote streams already seen, to tell a new one from one the user closed. */
  private knownStreams = new Set<Id>();
  private screenStop: Promise<void> | null = null;
  /** Running total of the share's bytes at the last stats check. */
  private lastSent: { bytes: number; at: number } | null = null;
  private audioChain: Promise<void> = Promise.resolve();
  /** Stream audio the capture is really set to (JSON), to skip repeated requests. */
  private appliedAudio = "null";

  constructor() {
    this.wantMuted = useCall.getState().muted;
    // Reapply local volumes when the user changes them in settings.
    useSettings.subscribe((s, prev) => {
      if (
        s.volumes !== prev.volumes ||
        s.localMutes !== prev.localMutes ||
        s.streamVolumes !== prev.streamVolumes ||
        s.streamMutes !== prev.streamMutes
      )
        this.applyVolumes();
      if (s.outputDeviceId !== prev.outputDeviceId && this.room)
        void this.room.switchActiveDevice("audiooutput", s.outputDeviceId);
    });
  }

  // ---------- join / leave ----------

  async start(conversationId: Id): Promise<void> {
    const join = await client().api.startCall(conversationId);
    await this.connect(join.call.id, join.call.conversation_id, join.livekit_url, join.livekit_token);
    // Ringback while nobody else has joined yet (stops on join or after 45 s).
    // Voice channels are rooms people drop into: nobody is being called.
    const channel = !!client().state.conversations[conversationId]?.server_id;
    if (!channel && this.room && this.room.remoteParticipants.size === 0) {
      startLoop("calling");
      this.callingTimer = setTimeout(() => this.stopCalling(), 45_000);
    }
  }

  private stopCalling() {
    if (this.callingTimer) clearTimeout(this.callingTimer);
    this.callingTimer = null;
    stopLoop("calling");
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
    setUi({
      ...idle,
      status: "connecting",
      callId,
      conversationId,
      muted: pre.muted,
      deafened: pre.deafened,
      stageExpanded: pre.stageExpanded,
    });
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
    this.speaking = new SpeakingDetector(room, () => this.refresh());
    this.wire(room);
    navigator.mediaDevices.addEventListener("devicechange", this.onDeviceChange);
    try {
      await room.connect(url, token, { autoSubscribe: true });
    } catch (e) {
      this.room = null;
      setUi({ ...idle, error: `Não foi possível conectar à chamada: ${(e as Error).message}` });
      void client().api.leaveCall(callId).catch(() => undefined);
      throw e;
    }
    if (this.rejoinAttempt === 0) playSound("join");
    this.rejoinAttempt = 0;
    setUi({ status: "connected" });
    this.speaking?.start();
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
    this.stopCalling();
    if (resetUi && this.room) playSound("leave");
    if (this.statsTimer) clearTimeout(this.statsTimer);
    this.statsTimer = null;
    await this.stopSystemAudio();
    this.speaking?.stop();
    this.speaking = null;
    const room = this.room;
    this.room = null;
    navigator.mediaDevices.removeEventListener("devicechange", this.onDeviceChange);
    this.watchedMic = null;
    if (room) await room.disconnect(true);
    for (const el of document.querySelectorAll("audio[data-nexus-audio]")) el.remove();
    await this.micProcessor?.destroy();
    this.micProcessor = null;
    this.governor = null;
    this.knownStreams.clear();
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
      .on(RoomEvent.ParticipantConnected, () => {
        this.stopCalling();
        playSound("join");
        refresh();
      })
      .on(RoomEvent.ParticipantDisconnected, () => {
        playSound("leave");
        refresh();
      })
      .on(RoomEvent.TrackMuted, refresh)
      .on(RoomEvent.TrackUnmuted, refresh)
      .on(RoomEvent.TrackSubscribed, (track) => {
        // Remote audio only plays once attached; with webAudioMix the element
        // stays muted and the sound goes through the per-user gain node.
        if (track.kind === Track.Kind.Audio) {
          const el = track.attach();
          el.dataset.nexusAudio = "";
          el.hidden = true;
          document.body.append(el);
        }
        bump();
      })
      .on(RoomEvent.TrackUnsubscribed, (track) => {
        if (track.kind === Track.Kind.Audio) for (const el of track.detach()) el.remove();
        bump();
      })
      .on(RoomEvent.AudioPlaybackStatusChanged, () => {
        if (!room.canPlaybackAudio) void room.startAudio().catch(() => undefined);
      })
      .on(RoomEvent.LocalTrackPublished, bump)
      // The mic delivers only digital silence (dead/disabled device, or the
      // wrong one picked): say so instead of letting people talk to nobody.
      .on(RoomEvent.LocalAudioSilenceDetected, () => {
        const label = this.micTrack()?.mediaStreamTrack.label ?? "";
        setUi({
          error: SILENT_VIRTUAL_MIC.test(label)
            ? `Você está no "${label}", um microfone virtual da Steam que não capta som. Escolha seu microfone em Configurações → Voz e vídeo.`
            : `Seu microfone${label ? ` (${label})` : ""} não está captando som. Confira o dispositivo em Configurações → Voz e vídeo.`,
        });
      })
      .on(RoomEvent.LocalTrackUnpublished, (pub) => {
        // Browser's own "stop sharing" button ends the screen track.
        const sharing = room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
        if (pub.source === Track.Source.ScreenShare && !sharing) void this.afterScreenStopped();
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
      try {
        await room.localParticipant.setMicrophoneEnabled(true, audioConstraints(), MIC_PUBLISH);
      } catch (e) {
        // The chosen mic is gone: use the Windows default, and say so.
        if (!micDeviceId() || !isDeviceError(e)) throw e;
        await room.localParticipant.setMicrophoneEnabled(true, audioConstraints(true), MIC_PUBLISH);
        this.warnFallback();
      }
    } catch (e) {
      setUi({ error: `Microfone indisponível: ${(e as Error).message}` });
      return;
    }
    this.watchMic();
    await this.applyNoiseMode();
    await this.applyMicGate();
  }

  private micTrack(): LocalAudioTrack | undefined {
    return this.micPub()?.track as LocalAudioTrack | undefined;
  }

  private warnFallback() {
    const label = this.micTrack()?.mediaStreamTrack.label;
    setUi({
      error: `O microfone escolhido não está disponível. Usando o padrão do Windows${label ? ` (${label})` : ""}.`,
    });
  }

  /**
   * Keeps the call on the chosen mic: LiveKit re-acquires the track by itself
   * (device reset, another app grabbing it) and Chromium may hand over a
   * different device, so check after every restart and when devices change
   * (the chosen mic plugged back in).
   */
  private watchMic() {
    const track = this.micTrack();
    if (!track || this.watchedMic === track) return;
    this.watchedMic = track;
    track.on(TrackEvent.Restarted, () => {
      // The new device may open in stereo where the old one was mono.
      void this.applyNoiseMode();
      void this.ensureChosenMic();
    });
    void this.ensureChosenMic();
  }

  private onDeviceChange = () => void this.ensureChosenMic();

  private ensuring = false;
  private async ensureChosenMic() {
    const track = this.micTrack();
    const chosen = settings().inputDeviceId;
    if (!track || !isChosenMic(chosen) || this.ensuring) return;
    // An ended track (the chosen mic was unplugged mid-call and LiveKit's own
    // re-acquire failed) is restarted too: back on the mic, or the default.
    const ended = track.mediaStreamTrack.readyState === "ended";
    if (!ended && track.mediaStreamTrack.getSettings().deviceId === chosen) return;
    const present = (await navigator.mediaDevices.enumerateDevices()).some(
      (d) => d.kind === "audioinput" && d.deviceId === chosen,
    );
    if (!present && !ended) return;
    this.ensuring = true;
    try {
      await this.restartMic();
    } finally {
      this.ensuring = false;
    }
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

  /**
   * Mic processor for the current settings and device: RNNoise in Enhanced
   * mode, a plain mono downmix for a mic that opened in stereo, else none.
   * Serialized: device restarts and settings changes can overlap.
   */
  applyNoiseMode(): Promise<void> {
    this.noiseChain = this.noiseChain.then(() => this.updateMicProcessor()).catch(() => undefined);
    return this.noiseChain;
  }

  private async updateMicProcessor() {
    const track = this.micTrack();
    if (!track) return;
    const stereo = (track.getSourceTrackSettings().channelCount ?? 1) > 1;
    const denoise = settings().noise === "enhanced";
    const want = denoise || stereo;
    if (this.micProcessor && want && this.micProcessor.denoise === denoise) return;
    if (!this.micProcessor && !want) return;
    if (this.micProcessor) {
      await track.stopProcessor();
      this.micProcessor = null;
    }
    if (!want) return;
    try {
      const processor = new MicProcessor(denoise);
      await track.setProcessor(processor);
      this.micProcessor = processor;
    } catch (e) {
      if (denoise) setUi({ error: `Supressão avançada indisponível: ${(e as Error).message}` });
      // Without RNNoise a stereo mic still needs the downmix.
      if (denoise && stereo) {
        const processor = new MicProcessor(false);
        await track.setProcessor(processor).then(() => (this.micProcessor = processor), () => undefined);
      }
    }
  }

  /**
   * Re-acquires the mic with new constraints (device, NS, AEC, AGC). The mic
   * processor is detached first and re-attached to the new track, and a failed switch
   * falls back to the system default so the call never ends up silent.
   */
  async restartMic() {
    const track = this.micTrack();
    if (!track) return;
    if (this.micProcessor) {
      await track.stopProcessor().catch(() => undefined);
      this.micProcessor = null;
    }
    try {
      await track.restartTrack(audioConstraints());
    } catch {
      // Same echo cancellation / noise / gain settings, default device.
      await track.restartTrack(audioConstraints(true)).catch(() => undefined);
      this.warnFallback();
    }
    await this.applyNoiseMode();
    await this.applyMicGate();
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
      playSound(this.wantMuted ? "mute" : "unmute");
    }
    await this.applyMicGate();
    this.syncServerState();
  }

  async setDeafened(deafened: boolean) {
    const ui = useCall.getState();
    if (deafened === ui.deafened) return;
    playSound(deafened ? "deafen" : "undeafen");
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

  /**
   * Local-only volumes (0..300%) and mutes, voice and stream audio set apart
   * (right-click the person / the stream); deafen silences everyone. A stream
   * is only heard while it is being watched.
   */
  applyVolumes() {
    const room = this.room;
    if (!room) return;
    const s = settings();
    const { deafened: deaf, watching } = useCall.getState();
    for (const p of room.remoteParticipants.values()) {
      const id = p.identity;
      const streamOff = deaf || s.streamMutes[id] || !watching.includes(id);
      p.setVolume(deaf || s.localMutes[id] ? 0 : (s.volumes[id] ?? 1), Track.Source.Microphone);
      p.setVolume(streamOff ? 0 : (s.streamVolumes[id] ?? 1), Track.Source.ScreenShareAudio);
    }
  }

  /** Starts/stops watching someone's screen share (its video and its audio). */
  watchStream(identity: Id, on: boolean) {
    setUi(watchStream(useCall.getState(), identity, on));
    this.applyVolumes();
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
    /** Native capture of this monitor/window (picker); otherwise getDisplayMedia. */
    source?: CaptureSource;
    surface?: "monitor" | "window";
    motion: boolean;
    audio: CaptureMode | null;
  }) {
    const room = this.room;
    if (!room) return;
    // Picking another screen/window while sharing replaces the share.
    if (useCall.getState().screenOn) await this.stopScreenShare();
    const { preset: p, governor } = this.screenPlan(opts.quality, opts.motion);
    const started = opts.source
      ? await this.startNativeScreen(opts.source, p, opts.motion)
      : await this.startBrowserScreen(p, opts.surface ?? "monitor", opts.motion);
    if (!started) return;
    this.governor = governor;
    this.lastSent = null;
    const window = opts.source?.kind === "window" ? opts.source : undefined;
    setUi({
      screenOn: true,
      screenQuality: p.label,
      screenNotice: null,
      screenSettings: {
        quality: opts.quality,
        motion: opts.motion,
        audio: null,
        app: window?.pid ? { pid: window.pid, name: window.app ?? window.name } : null,
      },
    });
    playSound("screen_start");
    if (opts.audio && (await this.startSystemAudio(opts.audio))) this.patchScreenSettings({ audio: opts.audio });
    this.appliedAudio = JSON.stringify(useCall.getState().screenSettings?.audio ?? null);
    this.scheduleStats();
    this.syncServerState();
  }

  /** Starting preset and governor of a quality choice ("auto" adapts by itself). */
  private screenPlan(quality: ScreenQuality, motion: boolean) {
    const auto = quality === "auto";
    const p: QualityPreset = auto ? autoStart() : preset(quality as QualityPreset["id"]);
    const allow60 = motion && (navigator.hardwareConcurrency || 4) >= 8;
    return { preset: p, governor: new QualityGovernor(p, auto, allow60) };
  }

  private patchScreenSettings(patch: Partial<NonNullable<CallUiState["screenSettings"]>>) {
    const current = useCall.getState().screenSettings;
    if (current) setUi({ screenSettings: { ...current, ...patch } });
  }

  /**
   * Changes resolution/FPS of the running share. Between options of the same
   * kind the track stays (no interruption for who is watching): only the
   * capture size and the encoder limits change. Going to or from 60 FPS
   * changes the codec (text: VP9, motion: H.264 on the GPU), which takes a new
   * publication: the share restarts on the same screen, a blink for viewers.
   */
  async setScreenQuality(quality: ScreenQuality) {
    const current = useCall.getState().screenSettings;
    const pub = this.room?.localParticipant.getTrackPublication(Track.Source.ScreenShare);
    const track = pub?.track as LocalVideoTrack | undefined;
    if (!current || !track) return;
    // "Automática" keeps the kind of content the share was started for.
    const motion = quality === "auto" ? current.motion : preset(quality).fps === 60;
    const source = this.screenSource;
    if (motion !== current.motion && source) {
      useSettings.getState().set({ screenQuality: quality });
      await this.startScreenShare({ quality, source, motion, audio: current.audio });
      return;
    }
    const { preset: p, governor } = this.screenPlan(quality, motion);
    this.governor = governor;
    this.patchScreenSettings({ quality, motion });
    setUi({ screenQuality: p.label, screenNotice: null });
    useSettings.getState().set({ screenQuality: quality });
    try {
      track.mediaStreamTrack.contentHint = motion ? "motion" : "detail";
      await this.applyScreenPreset(p);
    } catch (e) {
      setUi({ error: `Não foi possível mudar a qualidade: ${String((e as Error).message ?? e)}` });
    }
  }

  /**
   * Changes the sound that goes with the running share (null = none). Calls
   * are applied in order and only the last wish is: ticking several
   * applications in a row restarts the capture once.
   */
  setScreenAudio(audio: CaptureMode | null): Promise<void> {
    if (!useCall.getState().screenSettings) return Promise.resolve();
    this.patchScreenSettings({ audio: audio?.mode === "apps" && audio.pids.length === 0 ? null : audio });
    this.audioChain = this.audioChain.then(() => this.applyScreenAudio()).catch(() => undefined);
    return this.audioChain;
  }

  private async applyScreenAudio() {
    const wanted = useCall.getState().screenSettings?.audio ?? null;
    const key = JSON.stringify(wanted);
    if (!useCall.getState().screenOn || key === this.appliedAudio) return;
    if (!wanted) {
      await this.stopSystemAudio();
      setUi({ screenAudioOn: false });
    } else if (this.systemAudio) {
      try {
        // Same track, another source: nobody watching notices a gap.
        await this.systemAudio.setMode(wanted);
      } catch (e) {
        setUi({ error: `Áudio do computador indisponível: ${String((e as Error).message ?? e)}` });
        return;
      }
    } else if (!(await this.startSystemAudio(wanted))) {
      this.patchScreenSettings({ audio: null });
      return;
    }
    this.appliedAudio = key;
  }

  private async startNativeScreen(source: CaptureSource, p: QualityPreset, motion: boolean): Promise<boolean> {
    const room = this.room;
    if (!room) return false;
    const capture = new NativeScreenCapture();
    try {
      const track = await capture.start(
        source.id,
        { fps: p.fps, maxWidth: p.width, maxHeight: p.height },
        motion ? "motion" : "detail",
      );
      capture.onEnded = () => void this.stopScreenShare();
      this.nativeScreen = capture;
      this.screenSource = source;
      const publish = () =>
        room.localParticipant.publishTrack(track, {
          source: Track.Source.ScreenShare,
          name: "screen",
          ...screenCodec(motion),
          screenShareEncoding: { maxBitrate: p.maxBitrate, maxFramerate: p.fps },
          degradationPreference: SCREEN_DEGRADATION,
          simulcast: false,
        });
      await (motion ? withHardwareH264(track, publish) : publish());
      // Publishing resets the hint to "motion"; text needs "detail" to stay sharp.
      track.contentHint = motion ? "motion" : "detail";
      return true;
    } catch (e) {
      this.nativeScreen = null;
      await capture.stop();
      setUi({ error: `Não foi possível compartilhar: ${String((e as Error).message ?? e)}` });
      return false;
    }
  }

  /** Fallback (browser dev mode / old WebView2): the system picker. */
  private async startBrowserScreen(p: QualityPreset, surface: "monitor" | "window", motion: boolean): Promise<boolean> {
    const room = this.room;
    if (!room) return false;
    const opts = { surface, motion };
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
          ...screenCodec(opts.motion),
          screenShareEncoding: { maxBitrate: p.maxBitrate, maxFramerate: p.fps },
          degradationPreference: SCREEN_DEGRADATION,
          simulcast: false,
        },
      );
    } catch (e) {
      const err = e as Error;
      if (err.name !== "NotAllowedError") setUi({ error: `Não foi possível compartilhar a tela: ${err.message}` });
      return false;
    }
    void invoke("capture_bar_hide").catch(() => undefined);
    return true;
  }

  async stopScreenShare() {
    const room = this.room;
    const pub = room?.localParticipant.getTrackPublication(Track.Source.ScreenShare);
    if (this.nativeScreen && pub?.track) await room?.localParticipant.unpublishTrack(pub.track).catch(() => undefined);
    else await room?.localParticipant.setScreenShareEnabled(false);
    await this.afterScreenStopped();
  }

  /** One clean-up however the share ended (our button, the system's, a closed window). */
  private afterScreenStopped(): Promise<void> {
    this.screenStop ??= this.finishScreenStop().finally(() => {
      this.screenStop = null;
    });
    return this.screenStop;
  }

  private async finishScreenStop() {
    if (this.statsTimer) clearTimeout(this.statsTimer);
    this.statsTimer = null;
    this.governor = null;
    if (useCall.getState().screenOn) playSound("screen_stop");
    const native = this.nativeScreen;
    this.screenSource = null;
    this.nativeScreen = null;
    await native?.stop();
    await this.stopSystemAudio();
    this.appliedAudio = "null";
    setUi({ screenOn: false, screenAudioOn: false, screenQuality: null, screenNotice: null, screenSettings: null });
    this.syncServerState();
  }

  /** True when the sound is being sent. */
  private async startSystemAudio(mode: CaptureMode): Promise<boolean> {
    const room = this.room;
    if (!room) return false;
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
      return true;
    } catch (e) {
      this.systemAudio = null;
      await capture.stop();
      setUi({ error: `Áudio do computador indisponível: ${String((e as Error).message ?? e)}` });
      return false;
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
    // First check sooner: native capture needs its encoder scale set once the
    // first frame size is known.
    this.statsTimer = setTimeout(() => void this.checkStats(), this.governor?.current && !this.statsTimer ? 1500 : 5000);
  }

  /** Native frames are at least the target size; let the encoder scale down. */
  private async applyNativeScale(target: QualityPreset) {
    const native = this.nativeScreen;
    const pub = this.room?.localParticipant.getTrackPublication(Track.Source.ScreenShare);
    const sender = (pub?.track as LocalVideoTrack | undefined)?.sender;
    if (!native || !sender) return;
    const { width, height } = native.size;
    if (!width || !height) return;
    const scale = Math.max(1, width / target.width, height / target.height);
    const params = sender.getParameters();
    let changed = false;
    for (const enc of params.encodings) {
      if (Math.abs((enc.scaleResolutionDownBy ?? 1) - scale) > 0.05) {
        enc.scaleResolutionDownBy = scale;
        changed = true;
      }
    }
    if (changed) await sender.setParameters(params);
  }

  /** Puts the running share at a preset: capture size, then the encoder limits. */
  private async applyScreenPreset(p: QualityPreset) {
    const pub = this.room?.localParticipant.getTrackPublication(Track.Source.ScreenShare);
    const track = pub?.track as LocalVideoTrack | undefined;
    if (!track) return;
    if (this.nativeScreen) {
      // The capture hands over at least the target size; the encoder scales the rest.
      await this.nativeScreen.configure({ fps: p.fps, maxWidth: p.width, maxHeight: p.height });
      await this.applyNativeScale(p);
    } else {
      await track.mediaStreamTrack.applyConstraints({
        width: { ideal: p.width },
        height: { ideal: p.height },
        frameRate: { ideal: p.fps },
      });
    }
    const sender = track.sender;
    if (!sender) return;
    const params = sender.getParameters();
    for (const enc of params.encodings) {
      enc.maxBitrate = p.maxBitrate;
      enc.maxFramerate = p.fps;
    }
    // Also for a share published before this was the rule for motion.
    params.degradationPreference = SCREEN_DEGRADATION;
    await sender.setParameters(params);
  }

  private async checkStats() {
    const pub = this.room?.localParticipant.getTrackPublication(Track.Source.ScreenShare);
    const track = pub?.track as LocalVideoTrack | undefined;
    if (!track || !this.governor) return;
    try {
      const stats = await track.getSenderStats();
      const top = stats.sort((a, b) => (b.frameWidth ?? 0) - (a.frameWidth ?? 0))[0];
      // Bitrate really sent since the last check (bytesSent is a running total).
      const sent = { bytes: top?.bytesSent ?? 0, at: top?.timestamp ?? 0 };
      const before = this.lastSent;
      this.lastSent = sent;
      const seconds = before ? (sent.at - before.at) / 1000 : 0;
      const step = this.governor.sample({
        limitation: (top?.qualityLimitationReason ?? "none") as Limitation,
        targetBitrate: top?.targetBitrate ?? 0,
        sentBitrate: before && seconds > 0 ? Math.max(0, ((sent.bytes - before.bytes) * 8) / seconds) : 0,
      });
      if (step) await this.applyScreenPreset(step.preset);
      // Native frames follow window resizes: keep the encoder scale right.
      else await this.applyNativeScale(this.governor.current);
      if (step) {
        const why = step.why === "cpu" ? "CPU" : step.why === "network" ? "conexão" : "";
        setUi({
          screenQuality: step.preset.label,
          screenNotice: why ? `Qualidade reduzida para ${step.preset.label} (limite de ${why}).` : null,
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
        speaking: this.speaking?.isSpeaking(p.identity) ?? false,
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
    // Watched streams and the enlarged tile follow who is still sharing.
    const ui = useCall.getState();
    const stage = syncStage(ui, participants, this.knownStreams);
    this.knownStreams = new Set(participants.filter((p) => p.hasScreen && !p.isLocal).map((p) => p.identity));
    if (stage === ui) return setUi({ participants });
    setUi({ participants, watching: stage.watching, focus: stage.focus });
    this.applyVolumes();
  }

  videoTrack(identity: Id, source: "camera" | "screen_share") {
    const room = this.room;
    if (!room) return undefined;
    const p = identity === room.localParticipant.identity ? room.localParticipant : room.remoteParticipants.get(identity);
    const src = source === "camera" ? Track.Source.Camera : Track.Source.ScreenShare;
    return p?.getTrackPublication(src)?.track;
  }
}
