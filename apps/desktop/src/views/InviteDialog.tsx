import type { Id, ServerInvite } from "@nexus/protocol";
import { useEffect, useState } from "react";
import { Icon } from "../components/Icon";
import { Modal } from "../components/Modal";
import { client, useNexus } from "../lib/nexus";

const EXPIRY: { label: string; secs: number | undefined }[] = [
  { label: "1 hora", secs: 3600 },
  { label: "1 dia", secs: 86400 },
  { label: "7 dias", secs: 7 * 86400 },
  { label: "Nunca", secs: undefined },
];
const USES: { label: string; n: number | undefined }[] = [
  { label: "Sem limite", n: undefined },
  { label: "1 uso", n: 1 },
  { label: "5 usos", n: 5 },
  { label: "25 usos", n: 25 },
];

/** Creates an invite code to share (copy button). */
export function InviteDialog({ serverId, onClose }: { serverId: Id; onClose: () => void }) {
  const name = useNexus((s) => s.servers[serverId]?.name ?? "");
  const [expiry, setExpiry] = useState(1);
  const [uses, setUses] = useState(0);
  const [invite, setInvite] = useState<ServerInvite | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A fresh code whenever the options change (old ones stay valid).
  useEffect(() => {
    setInvite(null);
    setCopied(false);
    client()
      .api.createServerInvite(serverId, { expires_in_secs: EXPIRY[expiry]?.secs, max_uses: USES[uses]?.n })
      .then(setInvite)
      .catch((e: Error) => setError(e.message));
  }, [serverId, expiry, uses]);

  return (
    <Modal title={`Convidar para ${name}`} onClose={onClose}>
      <div className="form-grid">
        <p className="hint">Mande este código para seus amigos. Eles entram em “+ Adicionar um servidor → Entrar com um convite”.</p>
        <div className="invite-code">
          <code>{invite?.code ?? "…"}</code>
          <button
            type="button"
            className={`btn ${copied ? "success" : "primary"}`}
            disabled={!invite}
            onClick={() => {
              if (!invite) return;
              void navigator.clipboard.writeText(invite.code).then(() => setCopied(true));
            }}
          >
            <Icon name={copied ? "check" : "link"} size={16} /> {copied ? "Copiado" : "Copiar"}
          </button>
        </div>
        <div className="invite-options">
          <label>
            Expira em
            <select value={expiry} onChange={(e) => setExpiry(Number(e.target.value))}>
              {EXPIRY.map((o, i) => (
                <option key={o.label} value={i}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Limite de usos
            <select value={uses} onChange={(e) => setUses(Number(e.target.value))}>
              {USES.map((o, i) => (
                <option key={o.label} value={i}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {error && <p className="form-error">{error}</p>}
      </div>
    </Modal>
  );
}
