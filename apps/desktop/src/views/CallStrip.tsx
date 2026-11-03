import { conversationTitle } from "@nexus/shared";
import { useEffect, useState } from "react";
import { calls, useCall } from "../call/callStore";
import { openMenuAt } from "../components/ContextMenu";
import { Icon } from "../components/Icon";
import { openScreenShare } from "../lib/dialogs";
import { client, useNexus } from "../lib/nexus";
import { streamMenu } from "./StreamMenu";

/** "Voz conectada" card above the user bar while in a call. */
export function CallStrip() {
  const status = useCall((s) => s.status);
  const conversationId = useCall((s) => s.conversationId);
  const muted = useCall((s) => s.muted);
  const deafened = useCall((s) => s.deafened);
  const cameraOn = useCall((s) => s.cameraOn);
  const screenOn = useCall((s) => s.screenOn);
  const error = useCall((s) => s.error);
  const title = useNexus((s) => {
    const c = conversationId ? s.conversations[conversationId] : undefined;
    if (!c) return "";
    const server = c.server_id ? s.servers[c.server_id] : undefined;
    return server ? `${c.name} / ${server.name}` : conversationTitle(s, c);
  });
  // When we joined, from the server's call state (survives reloads of this view).
  const joinedAt = useNexus((s) => {
    const me = s.me?.id;
    const call = Object.values(s.calls).find((c) => c.conversation_id === conversationId);
    return call?.participants.find((p) => p.user_id === me)?.joined_at;
  });

  if (status === "idle") {
    return error ? (
      <div className="call-strip error" onClick={() => useCall.setState({ error: null })}>
        {error}
      </div>
    ) : null;
  }
  const ok = status === "connected";
  return (
    <div className="call-strip">
      <button
        type="button"
        className="call-strip-info"
        title="Abrir a chamada"
        onClick={() => conversationId && void client().openConversation(conversationId)}
      >
        <span className={`call-strip-state ${ok ? "ok" : "warn"}`}>
          <Icon name="signal" size={14} />
          {ok ? "Voz conectada" : status === "connecting" ? "Conectando…" : "Reconectando…"}
        </span>
        <span className="call-strip-where">
          <small>{title}</small>
          {ok && joinedAt && <Elapsed since={joinedAt} />}
        </span>
      </button>
      <div className="call-strip-actions">
        <button
          type="button"
          className={`strip-btn${muted ? " off" : ""}`}
          onClick={() => void calls.toggleMute()}
          title={muted ? "Ativar microfone" : "Silenciar microfone"}
        >
          <Icon name={muted ? "micOff" : "mic"} size={16} />
        </button>
        <button
          type="button"
          className={`strip-btn${deafened ? " off" : ""}`}
          onClick={() => void calls.toggleDeafen()}
          title={deafened ? "Ativar áudio" : "Desativar áudio"}
        >
          <Icon name={deafened ? "headphonesOff" : "headphones"} size={16} />
        </button>
        <button
          type="button"
          className={`strip-btn${cameraOn ? " on" : ""}`}
          onClick={() => void calls.setCamera(!cameraOn)}
          title={cameraOn ? "Desligar câmera" : "Ligar câmera"}
        >
          <Icon name={cameraOn ? "video" : "videoOff"} size={16} />
        </button>
        <button
          type="button"
          className={`strip-btn${screenOn ? " on" : ""}`}
          // While sharing: quality, sound, another screen, stop.
          onClick={(e) => (screenOn ? openMenuAt(e.currentTarget, streamMenu) : openScreenShare())}
          title={screenOn ? "Opções da transmissão" : "Compartilhar tela"}
        >
          <Icon name="screen" size={16} />
        </button>
        <button type="button" className="strip-btn leave" onClick={() => void calls.leave()} title="Sair da chamada">
          <Icon name="hangup" size={16} />
        </button>
      </div>
      {error && (
        <div className="call-strip-error" onClick={() => useCall.setState({ error: null })}>
          {error}
        </div>
      )}
    </div>
  );
}

/** mm:ss (h:mm:ss after an hour). Ticks on its own so only this text re-renders. */
export function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const total = Math.max(0, Math.floor((now - since) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return <time className="elapsed">{h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`}</time>;
}
