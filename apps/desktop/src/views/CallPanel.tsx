import { memo, useEffect, useRef, useState } from "react";
import { type ParticipantView, calls, useCall } from "../call/callStore";
import { Avatar } from "../components/Avatar";
import { Icon } from "../components/Icon";
import { useNexus } from "../lib/nexus";
import { useSettings } from "../lib/settings";

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
    <div className={`screen-tile${full ? " full" : ""}`}>
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
  const [menu, setMenu] = useState(false);

  return (
    <div
      className={`tile${p.speaking && !p.micMuted ? " speaking" : ""}`}
      onContextMenu={(e) => {
        if (p.isLocal) return;
        e.preventDefault();
        setMenu(true);
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
      {menu && <VolumeMenu identity={p.identity} name={user?.display_name ?? p.name} onClose={() => setMenu(false)} />}
    </div>
  );
});

/** Local-only volume (0–200%) and mute for one participant. */
function VolumeMenu({ identity, name, onClose }: { identity: string; name: string; onClose: () => void }) {
  const volume = useSettings((s) => s.volumes[identity] ?? 1);
  const muted = useSettings((s) => s.localMutes[identity] ?? false);
  const set = useSettings((s) => s.set);
  return (
    <div className="volume-menu" onMouseLeave={onClose}>
      <strong>{name}</strong>
      <label>
        Volume: {Math.round(volume * 100)}%
        <input
          type="range"
          min={0}
          max={200}
          step={5}
          value={Math.round(volume * 100)}
          onChange={(e) => set({ volumes: { ...useSettings.getState().volumes, [identity]: Number(e.target.value) / 100 } })}
        />
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={muted}
          onChange={(e) => set({ localMutes: { ...useSettings.getState().localMutes, [identity]: e.target.checked } })}
        />
        Silenciar para mim
      </label>
      <small className="muted">Só altera o que você ouve.</small>
    </div>
  );
}
