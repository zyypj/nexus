import { useSettings } from "../lib/settings";
import type { MenuEntry } from "./ContextMenu";

/** Highest per-user volume (WebAudio gain, so above 100% is real amplification). */
export const MAX_USER_VOLUME = 3;

const clamp = (v: number) => Math.max(0, Math.min(MAX_USER_VOLUME, Math.round(v * 20) / 20));

/** What the slider controls: the person's voice or the audio of their screen share. */
type VolumeKind = "voice" | "stream";

const keys = {
  voice: { volumes: "volumes", mutes: "localMutes" },
  stream: { volumes: "streamVolumes", mutes: "streamMutes" },
} as const;

export function setUserVolume(identity: string, volume: number, kind: VolumeKind = "voice") {
  const s = useSettings.getState();
  const k = keys[kind].volumes;
  s.set({ [k]: { ...s[k], [identity]: clamp(volume) } });
}

/**
 * Local-only volume (0–300%) and mute for one person (or their stream), as a
 * row of the right-click menu. Only changes what you hear.
 */
function UserVolume({ identity, kind }: { identity: string; kind: VolumeKind }) {
  const k = keys[kind];
  const volume = useSettings((s) => s[k.volumes][identity] ?? 1);
  const muted = useSettings((s) => s[k.mutes][identity] ?? false);
  const pct = Math.round(volume * 100);
  const title = kind === "voice" ? "Volume do usuário" : "Volume da transmissão";
  const set = (v: number) => setUserVolume(identity, v, kind);
  const toggleMute = () => {
    const s = useSettings.getState();
    s.set({ [k.mutes]: { ...s[k.mutes], [identity]: !muted } });
  };
  return (
    <div className="ctx-volume" onContextMenu={(e) => e.preventDefault()}>
      <div className="ctx-volume-head">
        <span>{title}</span>
        <strong className={pct > 100 ? "boost" : undefined}>{muted ? "Silenciado" : `${pct}%`}</strong>
      </div>
      <input
        type="range"
        min={0}
        max={MAX_USER_VOLUME * 100}
        step={5}
        value={pct}
        aria-label={title}
        aria-valuetext={`${pct}%`}
        disabled={muted}
        // 100% sits at a third of the track: make it visible.
        style={{ "--fill": `${(pct / (MAX_USER_VOLUME * 100)) * 100}%` } as React.CSSProperties}
        onChange={(e) => set(Number(e.target.value) / 100)}
        onWheel={(e) => set(volume + (e.deltaY < 0 ? 0.05 : -0.05))}
        onKeyDown={(e) => {
          // Up/Down move through the menu; Left/Right stay on the slider.
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") e.stopPropagation();
        }}
      />
      <div className="ctx-volume-scale" aria-hidden>
        <span>0%</span>
        <span>100%</span>
        <span>200%</span>
        <span>300%</span>
      </div>
      <div className="ctx-volume-actions">
        <button type="button" onClick={() => set(1)} disabled={pct === 100}>
          Voltar para 100%
        </button>
        <button type="button" className={muted ? "on" : undefined} onClick={toggleMute}>
          {muted ? "Ativar som" : kind === "voice" ? "Silenciar para mim" : "Silenciar transmissão"}
        </button>
      </div>
    </div>
  );
}

/** Menu row with the voice volume slider (skip for yourself). */
export function volumeEntry(identity: string): MenuEntry {
  return { key: `volume:${identity}`, node: <UserVolume identity={identity} kind="voice" /> };
}

/** Menu row with the volume of someone's screen share audio. */
export function streamVolumeEntry(identity: string): MenuEntry {
  return { key: `stream-volume:${identity}`, node: <UserVolume identity={identity} kind="stream" /> };
}
