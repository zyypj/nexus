import type { UserStatus } from "@nexus/protocol";
import { useState } from "react";
import { calls, useCall } from "../call/callStore";
import { Avatar } from "../components/Avatar";
import { Icon } from "../components/Icon";
import { client, useNexus } from "../lib/nexus";
import { useSettings } from "../lib/settings";

const STATUS_LABEL: Record<UserStatus, string> = {
  online: "Online",
  idle: "Ausente",
  dnd: "Não perturbe",
  invisible: "Invisível",
};

export function UserBar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const me = useNexus((s) => s.me);
  const muted = useCall((s) => s.muted);
  const deafened = useCall((s) => s.deafened);
  const ptt = useSettings((s) => s.pushToTalk);
  const [menu, setMenu] = useState(false);
  if (!me) return null;
  const presence = me.status === "invisible" ? "offline" : me.status;

  return (
    <div className="userbar">
      <button type="button" className="userbar-me" onClick={() => setMenu((m) => !m)} title="Alterar status">
        <Avatar user={me} size={34} presence={presence} />
        <span className="userbar-names">
          <strong>{me.display_name}</strong>
          <small>{ptt ? "Push-to-talk" : STATUS_LABEL[me.status]}</small>
        </span>
      </button>
      <button
        type="button"
        className={`icon-btn${muted ? " danger" : ""}`}
        onClick={() => void calls.toggleMute()}
        title={muted ? "Ativar microfone" : "Mutar microfone"}
      >
        <Icon name={muted ? "micOff" : "mic"} />
      </button>
      <button
        type="button"
        className={`icon-btn${deafened ? " danger" : ""}`}
        onClick={() => void calls.toggleDeafen()}
        title={deafened ? "Ativar áudio" : "Ensurdecer"}
      >
        <Icon name={deafened ? "headphonesOff" : "headphones"} />
      </button>
      <button type="button" className="icon-btn" onClick={onOpenSettings} title="Configurações">
        <Icon name="settings" />
      </button>
      {menu && (
        <div className="status-menu" onMouseLeave={() => setMenu(false)}>
          {(Object.keys(STATUS_LABEL) as UserStatus[]).map((st) => (
            <button
              type="button"
              key={st}
              className={st === me.status ? "active" : ""}
              onClick={() => {
                setMenu(false);
                void client().api.updateMe({ status: st });
              }}
            >
              {STATUS_LABEL[st]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
