import { useEffect, useState } from "react";
import { calls } from "../call/callStore";
import { PRESETS } from "../call/screenQuality";
import { type AudioApp, type CaptureMode, listAudioApps, systemAudioSupport } from "../call/systemAudio";
import { Modal } from "../components/Modal";
import { type ScreenQuality, useSettings } from "../lib/settings";

type AudioChoice = "none" | "system" | `app:${number}`;

export function ScreenShareDialog({ onClose }: { onClose: () => void }) {
  const savedQuality = useSettings((s) => s.screenQuality);
  const [quality, setQuality] = useState<ScreenQuality>(savedQuality);
  const [surface, setSurface] = useState<"monitor" | "window">("monitor");
  const [motion, setMotion] = useState(false);
  const [audio, setAudio] = useState<AudioChoice>("none");
  const [support, setSupport] = useState<{ supported: boolean; reason: string | null } | null>(null);
  const [apps, setApps] = useState<AudioApp[]>([]);

  useEffect(() => {
    void systemAudioSupport().then((s) => {
      setSupport(s);
      if (s.supported) void listAudioApps().then(setApps).catch(() => setApps([]));
    });
  }, []);

  async function start() {
    useSettings.getState().set({ screenQuality: quality });
    let mode: CaptureMode | null = null;
    if (audio === "system") mode = { mode: "exclude_self" };
    else if (audio.startsWith("app:")) mode = { mode: "app", pid: Number(audio.slice(4)) };
    onClose();
    await calls.startScreenShare({ quality, surface, motion, audio: mode });
  }

  return (
    <Modal title="Compartilhar tela" onClose={onClose}>
      <div className="form-grid">
        <label>
          O que compartilhar
          <select value={surface} onChange={(e) => setSurface(e.target.value as "monitor" | "window")}>
            <option value="monitor">Monitor inteiro</option>
            <option value="window">Janela / aplicativo</option>
          </select>
        </label>
        <label>
          Qualidade
          <select value={quality} onChange={(e) => setQuality(e.target.value as ScreenQuality)}>
            <option value="auto">Automática (recomendado)</option>
            {PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={motion} onChange={(e) => setMotion(e.target.checked)} />
          Conteúdo com movimento (jogo, vídeo) — prioriza fluidez em vez de nitidez
        </label>
        <label>
          Compartilhar áudio
          <select value={audio} onChange={(e) => setAudio(e.target.value as AudioChoice)} disabled={!support?.supported}>
            <option value="none">Sem áudio</option>
            <option value="system">Áudio do computador (sem as vozes da chamada)</option>
            {apps.map((a) => (
              <option key={a.pid} value={`app:${a.pid}`}>
                Somente {a.name}
                {a.active ? " (tocando)" : ""}
              </option>
            ))}
          </select>
        </label>
        {support && !support.supported && <p className="hint warn">{support.reason}</p>}
        <p className="hint">
          O áudio é capturado direto do Windows excluindo o próprio Nexus, então quem está na chamada não ouve as
          próprias vozes de volta. Não é necessário cabo virtual.
        </p>
      </div>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>
          Cancelar
        </button>
        <button type="button" className="btn primary" onClick={() => void start()}>
          Escolher e compartilhar
        </button>
      </div>
    </Modal>
  );
}
