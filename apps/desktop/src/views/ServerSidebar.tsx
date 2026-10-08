import { type ConversationView, type Id, Permissions, hasPermission } from "@nexus/protocol";
import { type ChannelGroup, callForConversation, memberColor, memberName, serverChannels } from "@nexus/shared";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { calls, useCall } from "../call/callStore";
import { Avatar } from "../components/Avatar";
import { Icon } from "../components/Icon";
import { Modal } from "../components/Modal";
import { client, useNexus } from "../lib/nexus";
import { useUi } from "../lib/ui";
import { ChannelSettings } from "./ChannelSettings";
import { InviteDialog } from "./InviteDialog";
import { openServer } from "./ServerRail";
import { ServerSettings } from "./ServerSettings";

const NO_CATEGORIES: { id: Id; name: string; position: number }[] = [];

type Dialog =
  | { kind: "invite" }
  | { kind: "settings" }
  | { kind: "channel"; categoryId: Id | null; type: "text" | "voice" }
  | { kind: "category" }
  | { kind: "channelSettings"; channelId: Id }
  | { kind: "leave" }
  | null;

/** Channel list of the open server (categories, text and voice channels). */
export function ServerSidebar({ serverId }: { serverId: Id }) {
  const server = useNexus((s) => s.servers[serverId]);
  // Raw slices only (stable references); grouping is derived below.
  const conversations = useNexus((s) => s.conversations);
  const groups = useMemo(
    () => (server ? serverChannels({ servers: { [serverId]: server }, conversations }, serverId) : []),
    [server, conversations, serverId],
  );
  const active = useNexus((s) => s.activeConversationId);
  const [menu, setMenu] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  if (!server) return null;
  const perms = server.permissions;
  const canChannels = hasPermission(perms, Permissions.MANAGE_CHANNELS);
  const isOwner = server.owner_id === client().store.getState().me?.id;

  return (
    <>
      <header className="server-header">
        <button type="button" className="server-header-btn" onClick={() => setMenu((m) => !m)} aria-expanded={menu}>
          <strong>{server.name}</strong>
          <Icon name={menu ? "x" : "chevronDown"} size={16} />
        </button>
        {menu && (
          <ServerMenu
            onClose={() => setMenu(false)}
            items={[
              hasPermission(perms, Permissions.CREATE_INVITE) && {
                label: "Convidar pessoas",
                icon: "link",
                accent: true,
                run: () => setDialog({ kind: "invite" }),
              },
              (hasPermission(perms, Permissions.MANAGE_SERVER) ||
                hasPermission(perms, Permissions.MANAGE_ROLES) ||
                hasPermission(perms, Permissions.KICK_MEMBERS) ||
                hasPermission(perms, Permissions.BAN_MEMBERS)) && {
                label: "Configurações do servidor",
                icon: "settings",
                run: () => setDialog({ kind: "settings" }),
              },
              canChannels && {
                label: "Criar canal",
                icon: "plus",
                run: () => setDialog({ kind: "channel", categoryId: null, type: "text" }),
              },
              canChannels && { label: "Criar categoria", icon: "plus", run: () => setDialog({ kind: "category" }) },
              !isOwner && { label: "Sair do servidor", icon: "doorOut", danger: true, run: () => setDialog({ kind: "leave" }) },
            ]}
          />
        )}
      </header>
      <nav className="sidebar-scroll channel-list">
        {groups.map((g) => (
          <ChannelCategory
            key={g.category?.id ?? "none"}
            group={g}
            active={active}
            canManage={canChannels}
            onCreate={(type) => setDialog({ kind: "channel", categoryId: g.category?.id ?? null, type })}
            onEdit={(channelId) => setDialog({ kind: "channelSettings", channelId })}
          />
        ))}
        {groups.every((g) => g.channels.length === 0) && (
          <p className="empty-hint">Nenhum canal visível para você aqui.</p>
        )}
      </nav>
      {dialog?.kind === "invite" && <InviteDialog serverId={serverId} onClose={() => setDialog(null)} />}
      {dialog?.kind === "settings" && <ServerSettings serverId={serverId} onClose={() => setDialog(null)} />}
      {dialog?.kind === "channel" && (
        <CreateChannelDialog
          serverId={serverId}
          categoryId={dialog.categoryId}
          type={dialog.type}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "category" && <CreateCategoryDialog serverId={serverId} onClose={() => setDialog(null)} />}
      {dialog?.kind === "channelSettings" && (
        <ChannelSettings serverId={serverId} targetId={dialog.channelId} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "leave" && (
        <Modal title={`Sair de ${server.name}?`} onClose={() => setDialog(null)}>
          <p className="hint">Você só volta com um novo convite.</p>
          <div className="modal-actions">
            <button type="button" className="btn" onClick={() => setDialog(null)}>
              Cancelar
            </button>
            <button
              type="button"
              className="btn danger"
              onClick={() => {
                void client()
                  .api.leaveServer(serverId)
                  .then(() => openServer(null));
                setDialog(null);
              }}
            >
              Sair do servidor
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

type MenuItem = { label: string; icon: import("../components/Icon").IconName; run: () => void; danger?: boolean; accent?: boolean };

function ServerMenu({ items, onClose }: { items: (MenuItem | false)[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (ref.current && !ref.current.parentElement?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [onClose]);
  return (
    <div className="pop-menu server-menu" ref={ref} role="menu">
      {items.filter(Boolean).map((it) => {
        const item = it as MenuItem;
        return (
          <button
            type="button"
            role="menuitem"
            key={item.label}
            className={`${item.danger ? "danger" : ""}${item.accent ? " accent" : ""}`}
            onClick={() => {
              onClose();
              item.run();
            }}
          >
            <span>{item.label}</span>
            <Icon name={item.icon} size={16} />
          </button>
        );
      })}
    </div>
  );
}

function ChannelCategory({
  group,
  active,
  canManage,
  onCreate,
  onEdit,
}: {
  group: ChannelGroup;
  active: Id | null;
  canManage: boolean;
  onCreate: (type: "text" | "voice") => void;
  onEdit: (id: Id) => void;
}) {
  const id = group.category?.id;
  const collapsed = useUi((s) => (id ? !!s.collapsed[id] : false));
  // A collapsed category still shows the open channel and unread ones.
  const shown = collapsed ? group.channels.filter((c) => c.id === active || c.unread_count > 0) : group.channels;
  return (
    <div className="channel-category">
      {group.category && (
        <div className="category-header">
          <button
            type="button"
            className="category-toggle"
            onClick={() => id && useUi.getState().set({ collapsed: { ...useUi.getState().collapsed, [id]: !collapsed } })}
          >
            <Icon name={collapsed ? "chevronRight" : "chevronDown"} size={12} />
            <span>{group.category.name}</span>
          </button>
          {canManage && (
            <>
              <button type="button" className="icon-btn tiny" title="Editar categoria" onClick={() => id && onEdit(id)}>
                <Icon name="settings" size={13} />
              </button>
              <button type="button" className="icon-btn tiny" title="Criar canal" onClick={() => onCreate("text")}>
                <Icon name="plus" size={14} />
              </button>
            </>
          )}
        </div>
      )}
      {shown.map((c) =>
        c.kind === "voice" ? (
          <VoiceChannel key={c.id} channel={c} active={c.id === active} canManage={canManage} onEdit={onEdit} />
        ) : (
          <TextChannel key={c.id} channel={c} active={c.id === active} canManage={canManage} onEdit={onEdit} />
        ),
      )}
    </div>
  );
}

const TextChannel = memo(function TextChannel({
  channel,
  active,
  canManage,
  onEdit,
}: {
  channel: ConversationView;
  active: boolean;
  canManage: boolean;
  onEdit: (id: Id) => void;
}) {
  const unread = channel.unread_count;
  const locked = !hasPermission(channel.permissions, Permissions.SEND_MESSAGES);
  return (
    <div className={`channel-row${active ? " active" : ""}${unread > 0 ? " unread" : ""}`}>
      <button
        type="button"
        className="channel-btn"
        onClick={() => {
          if (channel.server_id)
            useUi.getState().set({ lastChannel: { ...useUi.getState().lastChannel, [channel.server_id]: channel.id } });
          void client().openConversation(channel.id);
        }}
      >
        <Icon name={locked ? "lock" : "hash"} size={18} className="channel-icon" />
        <span className="channel-name">{channel.name}</span>
        {unread > 0 && !active && <span className="badge small">{unread >= 100 ? "99+" : unread}</span>}
      </button>
      {canManage && (
        <button type="button" className="icon-btn tiny channel-edit" title="Editar canal" onClick={() => onEdit(channel.id)}>
          <Icon name="settings" size={13} />
        </button>
      )}
    </div>
  );
});

const VoiceChannel = memo(function VoiceChannel({
  channel,
  active,
  canManage,
  onEdit,
}: {
  channel: ConversationView;
  active: boolean;
  canManage: boolean;
  onEdit: (id: Id) => void;
}) {
  const call = useNexus((s) => callForConversation(s, channel.id));
  const myCallConv = useCall((s) => s.conversationId);
  const here = myCallConv === channel.id;
  const canConnect = hasPermission(channel.permissions, Permissions.CONNECT);
  return (
    <div className="voice-channel">
      <div className={`channel-row${active ? " active" : ""}${here ? " connected" : ""}`}>
        <button
          type="button"
          className="channel-btn"
          disabled={!canConnect}
          title={canConnect ? "Entrar no canal de voz" : "Você não pode entrar neste canal"}
          onClick={() => {
            void client().openConversation(channel.id);
            if (!here) void calls.start(channel.id);
          }}
        >
          <Icon name={canConnect ? "volume" : "lock"} size={18} className="channel-icon" />
          <span className="channel-name">{channel.name}</span>
        </button>
        {canManage && (
          <button type="button" className="icon-btn tiny channel-edit" title="Editar canal" onClick={() => onEdit(channel.id)}>
            <Icon name="settings" size={13} />
          </button>
        )}
      </div>
      {call && call.participants.length > 0 && (
        <ul className="voice-members">
          {call.participants.map((p) => (
            <VoiceMember
              key={p.user_id}
              serverId={channel.server_id ?? ""}
              userId={p.user_id}
              muted={p.muted}
              deafened={p.deafened}
              video={p.video}
              screen={p.screen}
              inMyCall={here}
            />
          ))}
        </ul>
      )}
    </div>
  );
});

function VoiceMember({
  serverId,
  userId,
  muted,
  deafened,
  video,
  screen,
  inMyCall,
}: {
  serverId: Id;
  userId: Id;
  muted: boolean;
  deafened: boolean;
  video: boolean;
  screen: boolean;
  inMyCall: boolean;
}) {
  const user = useNexus((s) => s.users[userId]);
  const name = useNexus((s) => memberName(s, s.servers[serverId], userId));
  const color = useNexus((s) => {
    const sv = s.servers[serverId];
    return sv ? memberColor(sv, userId) : undefined;
  });
  const speaking = useCall((s) => inMyCall && s.participants.some((p) => p.identity === userId && p.speaking));
  return (
    <li className={`voice-member${speaking ? " speaking" : ""}`}>
      <Avatar user={user} size={22} />
      <span className="voice-member-name" style={color ? { color } : undefined}>
        {name}
      </span>
      {screen && <span className="live-tag">AO VIVO</span>}
      {video && <Icon name="video" size={13} />}
      {deafened ? <Icon name="headphonesOff" size={13} /> : muted ? <Icon name="micOff" size={13} /> : null}
    </li>
  );
}

function CreateChannelDialog({
  serverId,
  categoryId,
  type: initialType,
  onClose,
}: {
  serverId: Id;
  categoryId: Id | null;
  type: "text" | "voice";
  onClose: () => void;
}) {
  const categories = useNexus((s) => s.servers[serverId]?.categories) ?? NO_CATEGORIES;
  const [type, setType] = useState(initialType);
  const [name, setName] = useState("");
  const [category, setCategory] = useState<Id | null>(categoryId);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="Criar canal" onClose={onClose}>
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          client()
            .api.createChannel(serverId, { name, kind: type, category_id: category })
            .then(onClose)
            .catch((err: Error) => setError(err.message));
        }}
      >
        <div className="type-cards">
          {(["text", "voice"] as const).map((t) => (
            <button
              key={t}
              type="button"
              className={`type-card${type === t ? " active" : ""}`}
              onClick={() => setType(t)}
            >
              <Icon name={t === "text" ? "hash" : "volume"} size={22} />
              <span>
                <strong>{t === "text" ? "Texto" : "Voz"}</strong>
                <small>{t === "text" ? "Mensagens, imagens, vídeos e áudios" : "Conversar, compartilhar tela e vídeo"}</small>
              </span>
            </button>
          ))}
        </div>
        <label>
          Nome do canal
          <input
            value={name}
            maxLength={64}
            placeholder={type === "text" ? "novo-canal" : "Sala de jogos"}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </label>
        <label>
          Categoria
          <select value={category ?? ""} onChange={(e) => setCategory(e.target.value || null)}>
            <option value="">Sem categoria</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn primary" disabled={!name.trim()}>
            Criar canal
          </button>
        </div>
      </form>
    </Modal>
  );
}

function CreateCategoryDialog({ serverId, onClose }: { serverId: Id; onClose: () => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="Criar categoria" onClose={onClose}>
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          client()
            .api.createCategory(serverId, name)
            .then(onClose)
            .catch((err: Error) => setError(err.message));
        }}
      >
        <label>
          Nome da categoria
          <input value={name} maxLength={64} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        <p className="hint">Dá para deixar a categoria privada depois, nas permissões dela.</p>
        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn primary" disabled={!name.trim()}>
            Criar categoria
          </button>
        </div>
      </form>
    </Modal>
  );
}
