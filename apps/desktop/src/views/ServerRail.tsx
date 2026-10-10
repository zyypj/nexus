import type { ServerInvitePreview, ServerView } from "@nexus/protocol";
import { serverHasUnread, totalUnread } from "@nexus/shared";
import { memo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { openContextMenu } from "../components/ContextMenu";
import { Icon } from "../components/Icon";
import { Modal } from "../components/Modal";
import { type DragItem, type DropPlace, dragProps, dropClass, useDrop } from "../lib/dnd";
import { orderBy } from "../lib/layout";
import { client, useNexus } from "../lib/nexus";
import { initials, serverGradient, useUi } from "../lib/ui";
import { serverMenu } from "./menus";
import { moveServer } from "./serverActions";

/** Opens a server on its last channel (or its first text channel). */
export function openServer(id: string | null) {
  const ui = useUi.getState();
  ui.set({ serverId: id });
  if (!id) {
    void client().openConversation(null);
    return;
  }
  const s = client().store.getState();
  const last = ui.lastChannel[id];
  const target =
    (last && s.conversations[last]?.kind === "text" ? last : undefined) ??
    Object.values(s.conversations)
      .filter((c) => c.server_id === id && c.kind === "text")
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))[0]?.id ??
    null;
  void client().openConversation(target);
}

export function ServerIcon({ server, size = 48 }: { server: Pick<ServerView, "id" | "name" | "icon_url">; size?: number }) {
  const url = client().api.url(server.icon_url);
  return url ? (
    <img className="server-icon-img" src={url} alt="" width={size} height={size} draggable={false} />
  ) : (
    <span className="server-icon-initials" style={{ background: serverGradient(server.id), fontSize: size * 0.34 }}>
      {initials(server.name)}
    </span>
  );
}

/** Vertical bar of floating server icons (Início, servers, add). */
export function ServerRail() {
  // In the order the icons were dragged into.
  const order = useUi((s) => s.serverOrder);
  const servers = orderBy(useNexus(useShallow((s) => Object.values(s.servers))), order);
  const active = useUi((s) => s.serverId);
  const dmUnread = useNexus(totalUnread);
  const pending = useNexus((s) => s.incoming.length);
  const [adding, setAdding] = useState(false);
  return (
    <nav className="rail" aria-label="Servidores">
      <RailItem active={active === null} label="Início" onClick={() => openServer(null)} badge={dmUnread + pending}>
        <img src="/logo.png" alt="" className="rail-home-logo" draggable={false} />
      </RailItem>
      <div className="rail-sep" />
      <div className="rail-scroll">
        {servers.map((s) => (
          <ServerRailItem key={s.id} server={s} active={s.id === active} />
        ))}
        <RailItem label="Adicionar um servidor" onClick={() => setAdding(true)} accent>
          <Icon name="plus" size={22} />
        </RailItem>
      </div>
      {adding && <AddServerDialog onClose={() => setAdding(false)} />}
    </nav>
  );
}

const ServerRailItem = memo(function ServerRailItem({ server, active }: { server: ServerView; active: boolean }) {
  const unread = useNexus((s) => serverHasUnread(s, server.id));
  const drop = useDrop(
    (item) => (item.type === "server" && item.id !== server.id ? "reorder" : null),
    (item, place) => item.type === "server" && place !== "into" && moveServer(item.id, server.id, place),
  );
  return (
    <RailItem
      active={active}
      unread={unread}
      label={server.name}
      onClick={() => openServer(server.id)}
      onContextMenu={(e) => openContextMenu(e, () => serverMenu(server.id))}
      drag={{ type: "server", id: server.id }}
      drop={drop}
    >
      <ServerIcon server={server} />
    </RailItem>
  );
});

function RailItem({
  active,
  unread,
  label,
  onClick,
  children,
  badge,
  accent,
  onContextMenu,
  drag,
  drop,
}: {
  onContextMenu?: (e: React.MouseEvent) => void;
  /** Servers: drag the icon to reorder the bar. */
  drag?: DragItem;
  drop?: { place: DropPlace | null; props: object };
  active?: boolean;
  unread?: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  badge?: number;
  accent?: boolean;
}) {
  return (
    <div
      className={`rail-item${active ? " active" : ""}${unread ? " unread" : ""}${dropClass(drop?.place ?? null)}`}
      {...drop?.props}
      {...dragProps(drag ?? null)}
    >
      <span className="rail-pill" aria-hidden />
      <button
        type="button"
        className={`rail-btn${accent ? " accent" : ""}`}
        onClick={onClick}
        onContextMenu={onContextMenu}
        aria-label={label}
        data-tip={label}
      >
        {children}
      </button>
      {!!badge && badge > 0 && <span className="rail-badge">{badge > 99 ? "99+" : badge}</span>}
    </div>
  );
}

/** Create a server, or join one with an invite code. */
export function AddServerDialog({ onClose, initialCode }: { onClose: () => void; initialCode?: string }) {
  const [mode, setMode] = useState<"choose" | "create" | "join">(initialCode ? "join" : "choose");
  const [name, setName] = useState(() => `Servidor de ${client().store.getState().me?.display_name ?? "você"}`);
  const [code, setCode] = useState(initialCode ?? "");
  const [preview, setPreview] = useState<ServerInvitePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const view = await client().api.createServer(name.trim());
      client().store.setState((s) => ({ servers: { ...s.servers, [view.id]: view } }));
      onClose();
      setTimeout(() => openServer(view.id), 0);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** Accepts the bare code or a pasted text containing it. */
  const cleanCode = (raw: string) => raw.trim().split(/[\s/]+/).pop() ?? "";

  async function lookUp() {
    setBusy(true);
    setError(null);
    try {
      setPreview(await client().api.previewServerInvite(cleanCode(code)));
    } catch {
      setError("Convite inválido ou expirado.");
    } finally {
      setBusy(false);
    }
  }

  async function join() {
    if (!preview) return;
    setBusy(true);
    try {
      const view = await client().api.joinServer(preview.code);
      onClose();
      setTimeout(() => openServer(view.id), 0);
    } catch (e) {
      const status = (e as { status?: number }).status;
      setError(status === 403 ? "Você foi banido deste servidor." : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={mode === "join" ? "Entrar em um servidor" : "Adicionar um servidor"} onClose={onClose}>
      {mode === "choose" && (
        <div className="add-server-choices">
          <button type="button" className="choice-card" onClick={() => setMode("create")}>
            <span className="choice-icon gradient">
              <Icon name="plus" size={22} />
            </span>
            <span>
              <strong>Criar um servidor</strong>
              <small>Seu espaço com canais de texto, voz e cargos.</small>
            </span>
            <Icon name="chevronRight" />
          </button>
          <button type="button" className="choice-card" onClick={() => setMode("join")}>
            <span className="choice-icon">
              <Icon name="link" size={20} />
            </span>
            <span>
              <strong>Entrar com um convite</strong>
              <small>Use o código que alguém te mandou.</small>
            </span>
            <Icon name="chevronRight" />
          </button>
        </div>
      )}
      {mode === "create" && (
        <form
          className="form-grid"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <label>
            Nome do servidor
            <input value={name} maxLength={64} onChange={(e) => setName(e.target.value)} autoFocus />
          </label>
          <p className="hint">Ele já vem com #geral e um canal de voz. O ícone dá para trocar depois nas configurações.</p>
          {error && <p className="form-error">{error}</p>}
          <div className="modal-actions">
            <button type="button" className="btn" onClick={() => setMode("choose")}>
              Voltar
            </button>
            <button type="submit" className="btn primary" disabled={busy || !name.trim()}>
              Criar
            </button>
          </div>
        </form>
      )}
      {mode === "join" && (
        <form
          className="form-grid"
          onSubmit={(e) => {
            e.preventDefault();
            void (preview ? join() : lookUp());
          }}
        >
          <label>
            Código do convite
            <input
              value={code}
              placeholder="ex.: hK3mP9xa"
              onChange={(e) => {
                setCode(e.target.value);
                setPreview(null);
              }}
              autoFocus
            />
          </label>
          {preview && (
            <div className="invite-preview">
              <ServerIcon server={{ id: preview.server_id, name: preview.name, icon_url: preview.icon_url }} size={56} />
              <span>
                <strong>{preview.name}</strong>
                <small>
                  {preview.member_count} {preview.member_count === 1 ? "membro" : "membros"}
                  {preview.already_member ? " · você já está nele" : ""}
                </small>
              </span>
            </div>
          )}
          {error && <p className="form-error">{error}</p>}
          <div className="modal-actions">
            {!initialCode && (
              <button type="button" className="btn" onClick={() => setMode("choose")}>
                Voltar
              </button>
            )}
            <button type="submit" className="btn primary" disabled={busy || !code.trim()}>
              {preview ? (preview.already_member ? "Abrir" : "Entrar") : "Procurar"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
