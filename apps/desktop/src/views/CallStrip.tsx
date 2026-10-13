import { conversationTitle } from "@nexus/shared";
import { calls, useCall } from "../call/callStore";
import { openMenuAt } from "../components/ContextMenu";
import { Icon } from "../components/Icon";
import { openScreenShare } from "../lib/dialogs";
import { client, useNexus } from "../lib/nexus";
import { streamMenu } from "./StreamMenu";

/** Compact call controls above the user bar while connected. */
export function CallStrip() {
  const status = useCall((s) => s.status);
  const conversationId = useCall((s) => s.conversationId);
  const cameraOn = useCall((s) => s.cameraOn);
  const screenOn = useCall((s) => s.screenOn);
  const error = useCall((s) => s.error);
  const title = useNexus((s) => {
    const c = conversationId ? s.conversations[conversationId] : undefined;
    if (!c) return "";
    const server = c.server_id ? s.servers[c.server_id] : undefined;
    return server ? `${c.name} / ${server.name}` : conversationTitle(s, c);
  });

  if (status === "idle") {
    return error ? (
      <div className="call-strip error" onClick={() => useCall.setState({ error: null })}>
        {error}
      </div>
    ) : null;
  }
  return (
    <div className="call-strip">
      <button
        type="button"
        className="call-strip-info"
        onClick={() => conversationId && void client().openConversation(conversationId)}
      >
        <strong className={status === "connected" ? "ok" : "warn"}>
          {status === "connected" ? "Em chamada" : status === "connecting" ? "Conectando…" : "Reconectando…"}
        </strong>
        <small>{title}</small>
      </button>
      <div className="call-strip-actions">
        <button
          type="button"
          className={`icon-btn${cameraOn ? " on" : ""}`}
          onClick={() => void calls.setCamera(!cameraOn)}
          title={cameraOn ? "Desligar câmera" : "Ligar câmera"}
        >
          <Icon name={cameraOn ? "video" : "videoOff"} />
        </button>
        <button
          type="button"
          className={`icon-btn${screenOn ? " on" : ""}`}
          // While sharing: quality, sound, another screen, stop.
          onClick={(e) => (screenOn ? openMenuAt(e.currentTarget, streamMenu) : openScreenShare())}
          title={screenOn ? "Opções da transmissão" : "Compartilhar tela"}
        >
          <Icon name="screen" />
        </button>
        <button type="button" className="icon-btn danger" onClick={() => void calls.leave()} title="Sair da chamada">
          <Icon name="phoneOff" />
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
