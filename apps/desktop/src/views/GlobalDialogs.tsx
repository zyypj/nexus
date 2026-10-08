import { type Id, Permissions, hasPermission } from "@nexus/protocol";
import { memberColor, memberTop, serverMember } from "@nexus/shared";
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Avatar } from "../components/Avatar";
import { Modal } from "../components/Modal";
import { closeDialog, closeProfile, type ProfileCard, useDialogs } from "../lib/dialogs";
import { client, useNexus } from "../lib/nexus";
import { colorHex } from "../lib/ui";
import { ChannelSettings } from "./ChannelSettings";
import { InviteDialog } from "./InviteDialog";
import { openDmWith } from "./menus";
import { openServer } from "./ServerRail";
import { ServerSettings } from "./ServerSettings";
import { CreateCategoryDialog, CreateChannelDialog } from "./ServerSidebar";

/** Server dialogs and the profile card, wherever they were opened from. */
export function GlobalDialogs() {
  const dialog = useDialogs((s) => s.dialog);
  const profile = useDialogs((s) => s.profile);
  const serverExists = useNexus((s) => (dialog ? !!s.servers[dialog.serverId] : false));
  return (
    <>
      {dialog && serverExists && (
        <>
          {dialog.kind === "invite" && <InviteDialog serverId={dialog.serverId} onClose={closeDialog} />}
          {dialog.kind === "settings" && <ServerSettings serverId={dialog.serverId} onClose={closeDialog} />}
          {dialog.kind === "channel" && (
            <CreateChannelDialog
              serverId={dialog.serverId}
              categoryId={dialog.categoryId}
              type={dialog.type}
              onClose={closeDialog}
            />
          )}
          {dialog.kind === "category" && <CreateCategoryDialog serverId={dialog.serverId} onClose={closeDialog} />}
          {dialog.kind === "channelSettings" && (
            <ChannelSettings serverId={dialog.serverId} targetId={dialog.channelId} onClose={closeDialog} />
          )}
          {dialog.kind === "leave" && <LeaveServer serverId={dialog.serverId} />}
          {dialog.kind === "nickname" && <NicknameDialog serverId={dialog.serverId} userId={dialog.userId} />}
        </>
      )}
      {profile && <UserCard key={`${profile.userId}${profile.x}${profile.y}`} card={profile} />}
    </>
  );
}

function LeaveServer({ serverId }: { serverId: Id }) {
  const name = useNexus((s) => s.servers[serverId]?.name ?? "");
  return (
    <Modal title={`Sair de ${name}?`} onClose={closeDialog}>
      <p className="hint">Você só volta com um novo convite.</p>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={closeDialog}>
          Cancelar
        </button>
        <button
          type="button"
          className="btn danger"
          onClick={() => {
            closeDialog();
            void client()
              .api.leaveServer(serverId)
              .then(() => openServer(null));
          }}
        >
          Sair do servidor
        </button>
      </div>
    </Modal>
  );
}

function NicknameDialog({ serverId, userId }: { serverId: Id; userId: Id }) {
  const current = useNexus((s) => {
    const sv = s.servers[serverId];
    return (sv && serverMember(sv, userId)?.nickname) ?? "";
  });
  const displayName = useNexus((s) => s.users[userId]?.display_name ?? "");
  const isMe = useNexus((s) => s.me?.id === userId);
  const [value, setValue] = useState(current);
  const [error, setError] = useState<string | null>(null);
  const save = (nickname: string | null) =>
    client()
      .api.updateServerMember(serverId, userId, { nickname })
      .then(closeDialog)
      .catch((e: Error) => setError(e.message));
  return (
    <Modal title={isMe ? "Mudar meu apelido" : `Apelido de ${displayName}`} onClose={closeDialog}>
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          void save(value.trim() || null);
        }}
      >
        <label>
          Apelido neste servidor
          <input value={value} maxLength={32} placeholder={displayName} onChange={(e) => setValue(e.target.value)} autoFocus />
        </label>
        <p className="hint">Vazio = usar o nome de exibição ({displayName}).</p>
        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions">
          {current && (
            <button type="button" className="btn" onClick={() => void save(null)}>
              Remover apelido
            </button>
          )}
          <button type="button" className="btn" onClick={closeDialog}>
            Cancelar
          </button>
          <button type="submit" className="btn primary">
            Salvar
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Profile card at a point (member list, message author, right-click "Ver perfil"). */
function UserCard({ card }: { card: ProfileCard }) {
  const user = useNexus((s) => s.users[card.userId]);
  const server = useNexus((s) => (card.serverId ? s.servers[card.serverId] : undefined));
  const meId = useNexus((s) => s.me?.id ?? "");
  const friend = useNexus((s) => !!s.friends[card.userId]);
  const pending = useNexus(
    (s) => s.outgoing.some((r) => r.to.id === card.userId) || s.incoming.some((r) => r.from.id === card.userId),
  );
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const m = 12;
    // Prefer the left of the pointer when it is on the right half (member list).
    const left = card.x > window.innerWidth / 2 ? card.x - el.offsetWidth - m : card.x + m;
    setPos({
      left: Math.max(m, Math.min(left, window.innerWidth - el.offsetWidth - m)),
      top: Math.max(m, Math.min(card.y, window.innerHeight - el.offsetHeight - m)),
    });
  }, [card.x, card.y]);

  if (!user) return null;
  const member = server ? serverMember(server, user.id) : undefined;
  const color = server && member ? memberColor(server, user.id) : undefined;
  const roles = server && member ? server.roles.filter((r) => member.role_ids.includes(r.id)) : [];
  const isMe = user.id === meId;
  const canModerate =
    !!server && !!member && !isMe && user.id !== server.owner_id && memberTop(server, meId) > memberTop(server, user.id);
  const api = client().api;
  const run = (p: Promise<unknown>) => void p.then(closeProfile, (e: Error) => setError(e.message));

  return createPortal(
    <div className="card-backdrop" onMouseDown={(e) => e.target === e.currentTarget && closeProfile()}>
      <div
        ref={ref}
        className="member-card"
        role="dialog"
        aria-label={user.display_name}
        style={pos ? { left: pos.left, top: pos.top, right: "auto" } : { visibility: "hidden" }}
      >
        <div className="member-card-banner" style={color ? { background: color } : undefined} />
        <div className="member-card-body">
          <Avatar user={user} size={64} />
          <strong style={color ? { color } : undefined}>{member?.nickname || user.display_name}</strong>
          <small>
            @{user.username}
            {member?.nickname ? ` · ${user.display_name}` : ""}
          </small>
          {user.bio && <p className="member-card-bio">{user.bio}</p>}
          {roles.length > 0 && (
            <div className="role-chips">
              {roles.map((r) => (
                <span key={r.id} className="role-chip">
                  <span className="role-dot" style={{ background: r.color ? colorHex(r.color) : "var(--c-text-faint)" }} />
                  {r.name}
                </span>
              ))}
            </div>
          )}
          {!isMe && (
            <div className="row-actions">
              <button
                type="button"
                className="btn primary small"
                onClick={() => {
                  closeProfile();
                  void openDmWith(user.id);
                }}
              >
                Mensagem
              </button>
              {!friend && !pending && !sent && (
                <button
                  type="button"
                  className="btn small"
                  onClick={() =>
                    void api.sendFriendRequest(user.username).then(
                      () => setSent(true),
                      (e: Error) => setError(e.message),
                    )
                  }
                >
                  Adicionar amigo
                </button>
              )}
              {(pending || sent) && !friend && <small className="hint">Pedido de amizade pendente</small>}
              {canModerate && server && hasPermission(server.permissions, Permissions.KICK_MEMBERS) && (
                <button
                  type="button"
                  className="btn small"
                  onClick={() =>
                    confirm(`Expulsar ${member?.nickname || user.display_name}?`) && run(api.kickMember(server.id, user.id))
                  }
                >
                  Expulsar
                </button>
              )}
              {canModerate && server && hasPermission(server.permissions, Permissions.BAN_MEMBERS) && (
                <button
                  type="button"
                  className="btn small danger"
                  onClick={() =>
                    confirm(`Banir ${member?.nickname || user.display_name}?`) && run(api.banMember(server.id, user.id))
                  }
                >
                  Banir
                </button>
              )}
            </div>
          )}
          {error && <p className="form-error">{error}</p>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
