import type { SessionInfo } from "@nexus/protocol";
import { useEffect, useRef, useState } from "react";
import { calls } from "../call/callStore";
import { Avatar } from "../components/Avatar";
import { Modal } from "../components/Modal";
import { client, useNexus, useSession } from "../lib/nexus";
import { invoke, isTauri, listen } from "../lib/platform";
import { type HotkeyAction, type HotkeyBinding, type NoiseMode, useSettings } from "../lib/settings";
import { playSound } from "../lib/sounds";
import { checkForUpdates, useUpdater } from "../lib/updater";

const APP_VERSION = __APP_VERSION__;

type Tab = "account" | "voice" | "hotkeys" | "app";

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("account");
  return (
    <Modal title="Configurações" onClose={onClose} wide>
      <div className="settings">
        <nav className="settings-nav">
          {(
            [
              ["account", "Minha conta"],
              ["voice", "Voz e vídeo"],
              ["hotkeys", "Atalhos"],
              ["app", "Aplicativo"],
            ] as const
          ).map(([id, label]) => (
            <button type="button" key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </nav>
        <div className="settings-body">
          {tab === "account" && <Account />}
          {tab === "voice" && <Voice />}
          {tab === "hotkeys" && <Hotkeys />}
          {tab === "app" && <AppSettings />}
        </div>
      </div>
    </Modal>
  );
}

function Account() {
  const me = useNexus((s) => s.me);
  const [displayName, setDisplayName] = useState(me?.display_name ?? "");
  const [bio, setBio] = useState(me?.bio ?? "");
  const [msg, setMsg] = useState<string | null>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const loadSessions = () => void client().api.sessions().then(setSessions).catch(() => undefined);
  useEffect(loadSessions, []);
  if (!me) return null;

  return (
    <div className="form-grid">
      <div className="profile-row">
        <Avatar user={me} size={72} />
        <div>
          <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
            Trocar avatar
          </button>
          {me.avatar_url && (
            <button type="button" className="btn link" onClick={() => void client().api.deleteAvatar()}>
              Remover
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f)
                void client()
                  .api.uploadAvatar(f, f.name)
                  .catch((err: Error) => setMsg(err.message));
              e.target.value = "";
            }}
          />
          <p className="hint">@{me.username}</p>
        </div>
      </div>
      <label>
        Nome de exibição
        <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={32} />
      </label>
      <label>
        Sobre mim
        <textarea value={bio} onChange={(e) => setBio(e.target.value)} maxLength={190} rows={2} />
      </label>
      <button
        type="button"
        className="btn primary"
        onClick={() =>
          void client()
            .api.updateMe({ display_name: displayName, bio })
            .then(() => setMsg("Perfil salvo."))
            .catch((e: Error) => setMsg(e.message))
        }
      >
        Salvar perfil
      </button>
      {msg && <p className="hint">{msg}</p>}

      <h3>Senha</h3>
      <label>
        Senha atual
        <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      </label>
      <label>
        Nova senha
        <input type="password" value={next} onChange={(e) => setNext(e.target.value)} minLength={8} />
      </label>
      <button
        type="button"
        className="btn"
        onClick={() =>
          void client()
            .api.changePassword(current, next)
            .then(() => {
              setMsg("Senha alterada. Outras sessões foram encerradas.");
              setCurrent("");
              setNext("");
              loadSessions();
            })
            .catch((e: Error) => setMsg(e.message))
        }
      >
        Alterar senha
      </button>

      <h3>Sessões ativas</h3>
      <div className="sessions">
        {sessions.map((s) => (
          <div key={s.id} className="session">
            <span>
              {s.device_name || "Dispositivo"} {s.current && <small className="ok">(este)</small>}
              <small className="muted"> · último uso {new Date(s.last_used_at).toLocaleString()}</small>
            </span>
            {!s.current && (
              <button type="button" className="btn small" onClick={() => void client().api.revokeSession(s.id).then(loadSessions)}>
                Encerrar
              </button>
            )}
          </div>
        ))}
      </div>
      <button
        type="button"
        className="btn danger"
        onClick={async () => {
          await calls.leave();
          await client().logout();
          useSession.getState().setPhase("login");
        }}
      >
        Sair da conta
      </button>
    </div>
  );
}

function useDevices(kind: MediaDeviceKind) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    const load = () =>
      void navigator.mediaDevices
        .enumerateDevices()
        .then((d) => setDevices(d.filter((x) => x.kind === kind && x.deviceId)));
    load();
    navigator.mediaDevices.addEventListener("devicechange", load);
    return () => navigator.mediaDevices.removeEventListener("devicechange", load);
  }, [kind]);
  return devices;
}

/**
 * Chromium lists the virtual "default" and "communications" entries next to
 * the real devices. Showing them as options duplicated the "default" value,
 * so picking "Padrão - X" looked like the choice did not change; the default
 * device's name goes into the "Padrão do sistema" label instead.
 */
function splitDefault(devices: MediaDeviceInfo[]): { real: MediaDeviceInfo[]; defaultLabel: string } {
  const def = devices.find((d) => d.deviceId === "default");
  const name = def?.label.replace(/^[^-]*-\s*/, "") ?? "";
  return {
    real: devices.filter((d) => d.deviceId !== "default" && d.deviceId !== "communications"),
    defaultLabel: name ? `Padrão do sistema (${name})` : "Padrão do sistema",
  };
}

function MicMeter({ deviceId }: { deviceId: string }) {
  const bar = useRef<HTMLDivElement>(null);
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!on) return;
    let stream: MediaStream | null = null;
    let raf = 0;
    const ctx = new AudioContext();
    void navigator.mediaDevices
      .getUserMedia({ audio: { deviceId: deviceId !== "default" ? { ideal: deviceId } : undefined } })
      .then((s) => {
        stream = s;
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        ctx.createMediaStreamSource(s).connect(analyser);
        const data = new Float32Array(analyser.fftSize);
        const tick = () => {
          analyser.getFloatTimeDomainData(data);
          let peak = 0;
          for (const v of data) peak = Math.max(peak, Math.abs(v));
          if (bar.current) bar.current.style.width = `${Math.min(100, peak * 140)}%`;
          raf = requestAnimationFrame(tick);
        };
        tick();
      });
    return () => {
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      void ctx.close();
    };
  }, [on, deviceId]);
  return (
    <div className="mic-test">
      <button type="button" className="btn small" onClick={() => setOn((v) => !v)}>
        {on ? "Parar teste" : "Testar microfone"}
      </button>
      <div className="meter">
        <div ref={bar} />
      </div>
    </div>
  );
}

function Voice() {
  const s = useSettings();
  const inputs = splitDefault(useDevices("audioinput"));
  const outputs = splitDefault(useDevices("audiooutput"));
  const cams = useDevices("videoinput");
  const restartMic = (patch: Partial<typeof s>) => {
    s.set(patch);
    void calls.restartMic();
  };
  return (
    <div className="form-grid">
      <label>
        Microfone
        <select value={s.inputDeviceId} onChange={(e) => restartMic({ inputDeviceId: e.target.value })}>
          <option value="default">{inputs.defaultLabel}</option>
          {inputs.real.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || "Microfone"}
            </option>
          ))}
        </select>
      </label>
      <MicMeter deviceId={s.inputDeviceId} />
      <label>
        Saída de áudio
        <select value={s.outputDeviceId} onChange={(e) => s.set({ outputDeviceId: e.target.value })}>
          <option value="default">{outputs.defaultLabel}</option>
          {outputs.real.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || "Alto-falante"}
            </option>
          ))}
        </select>
      </label>
      <label>
        Câmera
        <select value={s.cameraDeviceId} onChange={(e) => s.set({ cameraDeviceId: e.target.value })}>
          <option value="">Padrão</option>
          {cams.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || "Câmera"}
            </option>
          ))}
        </select>
      </label>
      <label>
        Supressão de ruído
        <select value={s.noise} onChange={(e) => restartMic({ noise: e.target.value as NoiseMode })}>
          <option value="standard">Padrão — WebRTC (CPU mínima)</option>
          <option value="enhanced">Avançada — RNNoise (ventilador, teclado, ar-condicionado)</option>
          <option value="off">Desligada</option>
        </select>
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={s.echoCancellation}
          onChange={(e) => restartMic({ echoCancellation: e.target.checked })}
        />
        Cancelamento de eco
      </label>
      <label className="check">
        <input type="checkbox" checked={s.autoGainControl} onChange={(e) => restartMic({ autoGainControl: e.target.checked })} />
        Controle automático de ganho
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={s.pushToTalk}
          onChange={(e) => {
            s.set({ pushToTalk: e.target.checked });
            void calls.onPushToTalkSettingChanged();
          }}
        />
        Push-to-talk (configure a tecla em Atalhos)
      </label>
      {s.pushToTalk && (
        <label>
          Atraso ao soltar: {s.pttReleaseMs} ms
          <input
            type="range"
            min={0}
            max={1000}
            step={50}
            value={s.pttReleaseMs}
            onChange={(e) => s.set({ pttReleaseMs: Number(e.target.value) })}
          />
        </label>
      )}
    </div>
  );
}

const ACTIONS: { action: HotkeyAction; label: string }[] = [
  { action: "ptt", label: "Push-to-talk (segurar)" },
  { action: "mute", label: "Mutar / desmutar" },
  { action: "deafen", label: "Ensurdecer / ouvir" },
  { action: "camera_on", label: "Ligar câmera" },
  { action: "camera_off", label: "Desligar câmera" },
];

function describe(b: HotkeyBinding) {
  return [b.ctrl && "Ctrl", b.alt && "Alt", b.shift && "Shift", b.name].filter(Boolean).join(" + ");
}

function Hotkeys() {
  const hotkeys = useSettings((s) => s.hotkeys);
  const set = useSettings((s) => s.set);
  const [capturing, setCapturing] = useState<HotkeyAction | null>(null);

  useEffect(() => {
    if (!capturing) return;
    let unlisten: (() => void) | undefined;
    void listen<Omit<HotkeyBinding, "action">>("hotkey-captured", (k) => {
      const rest = useSettings.getState().hotkeys.filter((h) => h.action !== capturing);
      set({ hotkeys: [...rest, { ...k, action: capturing }] });
      setCapturing(null);
    }).then((u) => {
      unlisten = u;
    });
    void invoke("hotkeys_capture", { enable: true });
    return () => {
      unlisten?.();
      void invoke("hotkeys_capture", { enable: false });
    };
  }, [capturing, set]);

  if (!isTauri) return <p className="hint">Atalhos globais funcionam apenas no app Windows.</p>;
  return (
    <div className="form-grid">
      <p className="hint">Os atalhos funcionam mesmo com o Nexus minimizado ou com um jogo em foco.</p>
      {ACTIONS.map(({ action, label }) => {
        const b = hotkeys.find((h) => h.action === action);
        return (
          <div key={action} className="hotkey-row">
            <span>{label}</span>
            <button type="button" className="btn" onClick={() => setCapturing(action)}>
              {capturing === action ? "Pressione uma tecla…" : b ? describe(b) : "Definir"}
            </button>
            {b && (
              <button type="button" className="btn link" onClick={() => set({ hotkeys: hotkeys.filter((h) => h.action !== action) })}>
                Limpar
              </button>
            )}
          </div>
        );
      })}
      <p className="hint">Botões laterais do mouse (Mouse 4/5) também podem ser usados.</p>
    </div>
  );
}

function UpdateNow() {
  const { status, version } = useUpdater();
  return (
    <div className="hotkey-row">
      <span className="hint">
        Versão {APP_VERSION}
        {status === "checking" && " · procurando atualizações…"}
        {version && status !== "idle" && ` · nova versão ${version}`}
      </span>
      <button type="button" className="btn small" onClick={() => void checkForUpdates()}>
        Procurar atualizações
      </button>
    </div>
  );
}

function AppSettings() {
  const s = useSettings();
  return (
    <div className="form-grid">
      <label className="check">
        <input type="checkbox" checked={s.closeToTray} onChange={(e) => s.set({ closeToTray: e.target.checked })} />
        Fechar a janela mantém o Nexus na bandeja do sistema
      </label>
      <label className="check">
        <input type="checkbox" checked={s.notifications} onChange={(e) => s.set({ notifications: e.target.checked })} />
        Notificações de novas mensagens
      </label>
      <label className="check">
        <input type="checkbox" checked={s.sounds} onChange={(e) => s.set({ sounds: e.target.checked })} />
        Sons (chamadas, mute, compartilhamento, mensagens)
      </label>
      {s.sounds && (
        <label>
          Volume dos sons: {Math.round(s.soundVolume * 100)}%
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={s.soundVolume}
            onChange={(e) => s.set({ soundVolume: Number(e.target.value) })}
            onMouseUp={() => playSound("message")}
          />
        </label>
      )}
      <label className="check">
        <input type="checkbox" checked={s.autoUpdate} onChange={(e) => s.set({ autoUpdate: e.target.checked })} />
        Baixar atualizações automaticamente (GitHub)
      </label>
      <UpdateNow />
      <p className="hint">Servidor: {s.serverUrl}</p>
    </div>
  );
}
