import { useEffect, useState } from "react";
import { calls, useCall } from "../call/callStore";
import { PRESETS } from "../call/screenQuality";
import { type AudioApp, type AudioAppGroup, groupAudioApps, listAudioApps, systemAudioSupport } from "../call/systemAudio";
import type { MenuEntry } from "../components/ContextMenu";
import { Icon } from "../components/Icon";
import { openScreenShare } from "../lib/dialogs";
import type { ScreenQuality } from "../lib/settings";

const QUALITIES: { id: ScreenQuality; label: string }[] = [
  { id: "auto", label: "Automática" },
  ...PRESETS.map((p) => ({ id: p.id, label: p.label })),
];

/**
 * Menu of your own running screen share (its button in the call strip, and
 * right-click on "Sua tela"): everything is changed live, without stopping.
 */
export function streamMenu(): MenuEntry[] {
  const settings = useCall.getState().screenSettings;
  if (!settings) return [];
  return [
    {
      label: "Qualidade",
      icon: "settings",
      submenu: QUALITIES.map((q) => ({
        label: q.label,
        checked: settings.quality === q.id,
        run: () => void calls.setScreenQuality(q.id),
      })),
    },
    { label: "Áudio da transmissão", icon: "volume", submenu: [{ key: "stream-audio", node: <StreamAudio /> }] },
    { label: "Trocar tela ou janela", icon: "screen", run: openScreenShare },
    { separator: true },
    { label: "Parar transmissão", icon: "x", danger: true, run: () => void calls.stopScreenShare() },
  ];
}

/** How often the list of applications making sound is refreshed while open. */
const REFRESH_MS = 3000;

/**
 * What is heard in your stream: nothing, everything the computer plays
 * (never Nexus itself, so the call is not sent back), or only the chosen
 * applications. Applies as you click.
 */
function StreamAudio() {
  const settings = useCall((s) => s.screenSettings);
  const [apps, setApps] = useState<AudioApp[] | null>(null);
  const [unsupported, setUnsupported] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      void listAudioApps().then(
        (list) => alive && setApps(list),
        () => alive && setApps([]),
      );
    load();
    const timer = setInterval(load, REFRESH_MS);
    void systemAudioSupport().then((s) => alive && !s.supported && setUnsupported(s.reason ?? "Indisponível neste Windows."));
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  if (!settings) return null;
  if (unsupported) return <p className="ctx-stream-note">{unsupported}</p>;
  const audio = settings.audio;
  const chosen = audio?.mode === "apps" ? audio.pids : [];
  const groups = groupAudioApps(apps ?? [], settings.app);
  const toggle = (group: AudioAppGroup) => {
    const on = group.pids.some((pid) => chosen.includes(pid));
    // Applications that closed meanwhile leave the selection.
    const open = new Set(groups.flatMap((g) => g.pids));
    const kept = chosen.filter((pid) => !group.pids.includes(pid) && (!apps || open.has(pid)));
    const pids = on ? kept : [...kept, ...group.pids];
    void calls.setScreenAudio(pids.length ? { mode: "apps", pids } : null);
  };

  return (
    <div className="ctx-stream" onContextMenu={(e) => e.preventDefault()}>
      <button type="button" role="menuitemradio" aria-checked={!audio} onClick={() => void calls.setScreenAudio(null)}>
        <span className={`ctx-radio${audio ? "" : " on"}`} />
        <span className="ctx-label">Sem áudio</span>
      </button>
      <button
        type="button"
        role="menuitemradio"
        aria-checked={audio?.mode === "exclude_self"}
        onClick={() => void calls.setScreenAudio({ mode: "exclude_self" })}
      >
        <span className={`ctx-radio${audio?.mode === "exclude_self" ? " on" : ""}`} />
        <span className="ctx-label">
          Todo o computador
          <small>menos o Nexus (as vozes da chamada)</small>
        </span>
      </button>
      <div className="ctx-stream-head">Só estes aplicativos</div>
      {groups.map((group) => {
        const on = group.pids.some((pid) => chosen.includes(pid));
        return (
          <button type="button" role="menuitemcheckbox" aria-checked={on} key={group.name} onClick={() => toggle(group)}>
            <span className={`ctx-check${on ? " on" : ""}`}>{on && <Icon name="check" size={12} />}</span>
            <span className="ctx-label">{group.name}</span>
            {group.active && <span className="ctx-stream-playing" title="Tocando agora" />}
          </button>
        );
      })}
      {groups.length === 0 && (
        <p className="ctx-stream-note">{apps ? "Nenhum aplicativo está tocando som agora." : "Procurando aplicativos…"}</p>
      )}
    </div>
  );
}
