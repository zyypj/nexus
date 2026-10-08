import { useCallback, useEffect, useMemo, useState } from "react";
import { calls } from "../call/callStore";
import { type CaptureSource, listCaptureSources, nativeCaptureSupported } from "../call/nativeScreen";
import { type CaptureMode, systemAudioSupport } from "../call/systemAudio";
import { Icon } from "../components/Icon";
import { Modal } from "../components/Modal";
import { type ScreenQuality, useSettings } from "../lib/settings";

type Tab = "window" | "screen";
type Resolution = "auto" | "720p" | "1080p";

/** Maps the picker's resolution + fps onto the quality presets. */
function quality(res: Resolution, fps: 30 | 60): ScreenQuality {
  if (res === "auto") return "auto";
  if (res === "720p") return "720p30";
  return fps === 60 ? "1080p60" : "1080p30";
}

function fromSaved(q: ScreenQuality): { res: Resolution; fps: 30 | 60 } {
  if (q === "720p30") return { res: "720p", fps: 30 };
  if (q === "1080p30") return { res: "1080p", fps: 30 };
  if (q === "1080p60") return { res: "1080p", fps: 60 };
  return { res: "auto", fps: 30 };
}

/**
 * Discord-style "Go Live" picker: the sources (with live thumbnails) and the
 * stream options in one place, then one click starts sharing. Uses native
 * capture, so no second system picker and no "sharing your screen" bar.
 */
export function ScreenShareDialog({ onClose }: { onClose: () => void }) {
  const saved = useSettings((s) => s.screenQuality);
  const [native, setNative] = useState<boolean | null>(null);
  const [sources, setSources] = useState<CaptureSource[]>([]);
  const [tab, setTab] = useState<Tab>("window");
  const [selected, setSelected] = useState<string | null>(null);
  const [res, setRes] = useState<Resolution>(fromSaved(saved).res);
  const [fps, setFps] = useState<30 | 60>(fromSaved(saved).fps);
  const [audio, setAudio] = useState(true);
  const [audioSupported, setAudioSupported] = useState(false);

  const refresh = useCallback(async () => {
    const list = await listCaptureSources().catch(() => []);
    setSources(list);
    return list;
  }, []);

  useEffect(() => {
    void nativeCaptureSupported().then(async (ok) => {
      setNative(ok);
      if (!ok) return;
      const list = await refresh();
      if (!list.some((s) => s.kind === "window")) setTab("screen");
    });
    void systemAudioSupport().then((s) => setAudioSupported(s.supported));
  }, [refresh]);

  // Live thumbnails while the picker is open.
  useEffect(() => {
    if (!native) return;
    const t = setInterval(() => void refresh(), 4000);
    return () => clearInterval(t);
  }, [native, refresh]);

  const shown = useMemo(() => sources.filter((s) => s.kind === tab), [sources, tab]);
  const source = sources.find((s) => s.id === selected) ?? null;
  const windows = sources.filter((s) => s.kind === "window").length;
  const screens = sources.length - windows;

  async function goLive(pick: CaptureSource | null = source) {
    const source = pick;
    const q = quality(res, fps);
    useSettings.getState().set({ screenQuality: q });
    let mode: CaptureMode | null = null;
    if (audio && audioSupported && source) {
      // A window shares only that app's audio; a screen shares everything
      // except Nexus (so nobody hears the call twice).
      mode = source.kind === "window" && source.pid ? { mode: "app", pid: source.pid } : { mode: "exclude_self" };
    }
    onClose();
    await calls.startScreenShare({ quality: q, source: source ?? undefined, motion: fps === 60, audio: mode });
  }

  async function legacy() {
    const q = quality(res, fps);
    useSettings.getState().set({ screenQuality: q });
    onClose();
    await calls.startScreenShare({
      quality: q,
      surface: "monitor",
      motion: fps === 60,
      audio: audio && audioSupported ? { mode: "exclude_self" } : null,
    });
  }

  return (
    <Modal title="Transmitir" onClose={onClose} wide>
      <div className="golive">
        {native === false ? (
          <p className="hint">
            A captura nativa não está disponível neste Windows. Ao continuar, o Windows vai pedir para escolher a tela
            ou janela.
          </p>
        ) : (
          <>
            <div className="golive-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={tab === "window"}
                className={tab === "window" ? "active" : ""}
                onClick={() => setTab("window")}
              >
                Aplicativos <span className="count">{windows}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "screen"}
                className={tab === "screen" ? "active" : ""}
                onClick={() => setTab("screen")}
              >
                Telas <span className="count">{screens}</span>
              </button>
            </div>
            <div className="golive-grid">
              {native === null && <p className="hint">Carregando…</p>}
              {native && shown.length === 0 && <p className="hint">Nada para mostrar aqui.</p>}
              {shown.map((s) => (
                <button
                  type="button"
                  key={s.id}
                  className={`golive-card${selected === s.id ? " selected" : ""}`}
                  onClick={() => setSelected(s.id)}
                  onDoubleClick={() => void goLive(s)}
                  title={s.name}
                >
                  <div className="golive-thumb">
                    {s.thumbnail ? <img src={s.thumbnail} alt="" draggable={false} /> : <Icon name="screen" />}
                  </div>
                  <div className="golive-name">
                    <span className="golive-badge">{(s.app ?? s.name).slice(0, 1).toUpperCase()}</span>
                    <span className="golive-title">{s.name}</span>
                  </div>
                </button>
              ))}
            </div>
          </>
        )}

        <div className="golive-options">
          <div className="golive-option">
            <span className="golive-label">Resolução</span>
            <div className="segmented">
              {(["auto", "720p", "1080p"] as Resolution[]).map((r) => (
                <button type="button" key={r} className={res === r ? "active" : ""} onClick={() => setRes(r)}>
                  {r === "auto" ? "Automática" : r}
                </button>
              ))}
            </div>
          </div>
          <div className="golive-option">
            <span className="golive-label">Taxa de quadros</span>
            <div className="segmented">
              {([30, 60] as const).map((f) => (
                <button
                  type="button"
                  key={f}
                  className={fps === f ? "active" : ""}
                  disabled={res === "720p" && f === 60}
                  onClick={() => setFps(f)}
                >
                  {f} FPS
                </button>
              ))}
            </div>
          </div>
          <label className={`golive-switch${audioSupported ? "" : " disabled"}`}>
            <input
              type="checkbox"
              checked={audio && audioSupported}
              disabled={!audioSupported}
              onChange={(e) => setAudio(e.target.checked)}
            />
            <span className="switch" aria-hidden />
            <span>
              Compartilhar áudio
              <small>
                {!audioSupported
                  ? "Requer Windows 10 2004 ou mais recente."
                  : source?.kind === "window"
                    ? `Somente o som de ${source.app ?? "este aplicativo"}.`
                    : "Som do computador, sem as vozes da chamada."}
              </small>
            </span>
          </label>
        </div>

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          {native === false ? (
            <button type="button" className="btn primary" onClick={() => void legacy()}>
              Continuar
            </button>
          ) : (
            <button type="button" className="btn primary golive-go" disabled={!source} onClick={() => void goLive()}>
              <Icon name="screen" /> Transmitir
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
