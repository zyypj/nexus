import { memo, useEffect, useRef, useState } from "react";
import { type ParticipantView, calls, useCall } from "../call/callStore";
import { Avatar } from "../components/Avatar";
import { openContextMenu } from "../components/ContextMenu";
import { streamVolumeEntry, volumeEntry } from "../components/UserVolume";
import { Icon } from "../components/Icon";
import { client, useNexus } from "../lib/nexus";
import { userMenu } from "./menus";

/**
 * Call stage. Screen shares take the spotlight; otherwise an automatic grid
 * of camera/avatar tiles. Only visible tiles subscribe to video (LiveKit
 * adaptiveStream pauses tracks attached to hidden elements).
 */
export function CallPanel() {
  const participants = useCall((s) => s.participants);
  const status = useCall((s) => s.status);
  const screenNotice = useCall((s) => s.screenNotice);
  const screenQuality = useCall((s) => s.screenQuality);
  const [focus, setFocus] = useState<string | null>(null);
  const sharers = participants.filter((p) => p.hasScreen);
  const spotlight = sharers.find((p) => p.identity === focus) ?? sharers[0];

  return (
    <div className={`call-panel${spotlight ? " has-screen" : ""}`}>
      {status !== "connected" && <div className="call-status">{status === "connecting" ? "Conectando…" : "Reconectando…"}</div>}
      {spotlight && <ScreenTile participant={spotlight} />}
      <div className={`call-grid n${Math.min(participants.length, 9)}`}>
        {participants.map((p) => (
          <ParticipantTile key={p.identity} p={p} onFocusScreen={p.hasScreen ? () => setFocus(p.identity) : undefined} />
        ))}
      </div>
      {(screenNotice || screenQuality) && (
        <div className="screen-info">
          {screenQuality && <span>Transmitindo em {screenQuality}</span>}
          {screenNotice && <span className="warn">{screenNotice}</span>}
        </div>
      )}
    </div>
  );
}

function useAttachedVideo(identity: string, source: "camera" | "screen_share") {
  const ref = useRef<HTMLVideoElement>(null);
  const version = useCall((s) => s.trackVersion);
  useEffect(() => {
    const el = ref.current;
    const track = calls.videoTrack(identity, source);
    if (!el || !track) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [identity, source, version]);
  return ref;
}

function ScreenTile({ participant }: { participant: ParticipantView }) {
  const ref = useAttachedVideo(participant.identity, "screen_share");
  const [full, setFull] = useState(false);
  return (
    <div
      className={`screen-tile${full ? " full" : ""}`}
      onContextMenu={(e) =>
        // Stream audio volume, apart from the person's voice. You never hear your own stream.
        openContextMenu(e, () => [
          !participant.isLocal &&
            (participant.hasScreenAudio
              ? streamVolumeEntry(participant.identity)
              : { label: "Esta transmissão está sem áudio", icon: "volume", disabled: true }),
          { separator: true },
          { label: full ? "Sair da tela cheia" : "Tela cheia", icon: "maximize", run: () => setFull((f) => !f) },
        ])
      }
    >
      <video ref={ref} autoPlay playsInline muted />
      <div className="tile-label">
        <Icon name="screen" size={14} /> {participant.name}
        {participant.hasScreenAudio && <Icon name="volume" size={14} />}
      </div>
      <button type="button" className="icon-btn fullscreen" onClick={() => setFull((f) => !f)} title="Tela cheia">
        <Icon name="maximize" />
      </button>
    </div>
  );
}

const ParticipantTile = memo(function ParticipantTile({
  p,
  onFocusScreen,
}: {
  p: ParticipantView;
  onFocusScreen?: () => void;
}) {
  const user = useNexus((s) => s.users[p.identity]);
  const deafenedRemote = useNexus((s) => {
    const call = Object.values(s.calls).find((c) => c.participants.some((x) => x.user_id === p.identity));
    return call?.participants.find((x) => x.user_id === p.identity)?.deafened ?? false;
  });
  const ref = useAttachedVideo(p.identity, "camera");

  return (
    <div
      className={`tile${p.speaking && !p.micMuted ? " speaking" : ""}`}
      onContextMenu={(e) => {
        // Volume first (the most used action in a call), then the usual person menu.
        const at = { x: e.clientX, y: e.clientY };
        const conv = useCall.getState().conversationId;
        const serverId = (conv && client().store.getState().conversations[conv]?.server_id) || null;
        openContextMenu(e, () => [
          !p.isLocal && volumeEntry(p.identity),
          !p.isLocal && p.hasScreenAudio && streamVolumeEntry(p.identity),
          { separator: true },
          ...userMenu(p.identity, at, serverId),
        ]);
      }}
    >
      {p.hasCamera ? (
        <video ref={ref} autoPlay playsInline muted className={p.isLocal ? "mirror" : ""} />
      ) : (
        <Avatar user={user ?? { id: p.identity, display_name: p.name, avatar_url: null }} size={64} speaking={p.speaking && !p.micMuted} />
      )}
      <div className="tile-label">
        {p.micMuted && <Icon name="micOff" size={14} className="danger-text" />}
        {deafenedRemote && <Icon name="headphonesOff" size={14} className="danger-text" />}
        <span>{user?.display_name ?? p.name}</span>
        {p.quality === "poor" && <small className="warn"> conexão ruim</small>}
      </div>
      {onFocusScreen && (
        <button type="button" className="tile-screen-btn" onClick={onFocusScreen} title="Ver tela">
          <Icon name="screen" size={14} />
        </button>
      )}
    </div>
  );
});
