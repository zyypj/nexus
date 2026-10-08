import type { Invite, PublicUser } from "@nexus/protocol";
import { ApiError } from "@nexus/shared";
import { type FormEvent, useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Avatar } from "../components/Avatar";
import { Icon } from "../components/Icon";
import { client, useNexus } from "../lib/nexus";

type Tab = "online" | "all" | "pending" | "blocked" | "add" | "invites";

export function FriendsView() {
  const [tab, setTab] = useState<Tab>("online");
  const pending = useNexus((s) => s.incoming.length);
  const isAdmin = useNexus((s) => s.me?.is_admin ?? false);
  return (
    <section className="friends">
      <header className="header">
        <Icon name="users" />
        <h2>Amigos</h2>
        <div className="tabs inline">
          {(
            [
              ["online", "Online"],
              ["all", "Todos"],
              ["pending", pending ? `Pendentes (${pending})` : "Pendentes"],
              ["blocked", "Bloqueados"],
            ] as const
          ).map(([id, label]) => (
            <button type="button" key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
          <button type="button" className={`accent${tab === "add" ? " active" : ""}`} onClick={() => setTab("add")}>
            Adicionar amigo
          </button>
          {isAdmin && (
            <button type="button" className={tab === "invites" ? "active" : ""} onClick={() => setTab("invites")}>
              Convites
            </button>
          )}
        </div>
      </header>
      <div className="friends-body">
        {tab === "add" && <AddFriend />}
        {(tab === "online" || tab === "all") && <FriendList onlineOnly={tab === "online"} />}
        {tab === "pending" && <Pending />}
        {tab === "blocked" && <Blocked />}
        {tab === "invites" && <Invites />}
      </div>
    </section>
  );
}

function AddFriend() {
  const [username, setUsername] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      const r = await client().api.sendFriendRequest(username.trim());
      setMsg({ ok: true, text: r.status === "accepted" ? "Vocês agora são amigos!" : "Pedido enviado." });
      setUsername("");
    } catch (err) {
      const text =
        err instanceof ApiError && err.status === 404 ? "Usuário não encontrado." : (err as Error).message;
      setMsg({ ok: false, text });
    }
  }
  return (
    <form className="add-friend" onSubmit={submit}>
      <p>Adicione pelo nome de usuário exato.</p>
      <div className="row">
        <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="usuario" required />
        <button className="btn primary" type="submit">
          Enviar pedido
        </button>
      </div>
      {msg && <p className={msg.ok ? "hint ok" : "form-error"}>{msg.text}</p>}
    </form>
  );
}

function UserRow({ user, children, subtitle }: { user: PublicUser; children?: React.ReactNode; subtitle?: string }) {
  const presence = useNexus((s) => s.presences[user.id] ?? "offline");
  return (
    <div className="user-row">
      <Avatar user={user} size={36} presence={presence} />
      <div className="user-row-names">
        <strong>{user.display_name}</strong>
        <small>{subtitle ?? `@${user.username}`}</small>
      </div>
      <div className="user-row-actions">{children}</div>
    </div>
  );
}

function FriendList({ onlineOnly }: { onlineOnly: boolean }) {
  const friends = useNexus(
    useShallow((s) =>
      Object.values(s.friends)
        .map((f) => s.users[f.user.id] ?? f.user)
        .filter((u) => !onlineOnly || (s.presences[u.id] ?? "offline") !== "offline")
        .sort((a, b) => a.display_name.localeCompare(b.display_name)),
    ),
  );
  if (friends.length === 0)
    return <p className="empty-hint">{onlineOnly ? "Ninguém online agora." : "Você ainda não tem amigos aqui."}</p>;
  return (
    <div className="user-list">
      {friends.map((u) => (
        <UserRow key={u.id} user={u}>
          <button
            type="button"
            className="icon-btn"
            title="Mensagem"
            onClick={async () => {
              const c = await client().api.openDm(u.id);
              await client().openConversation(c.id);
            }}
          >
            <Icon name="send" />
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Remover amizade"
            onClick={() => confirm(`Remover ${u.display_name} dos amigos?`) && void client().api.removeFriend(u.id)}
          >
            <Icon name="x" />
          </button>
          <button
            type="button"
            className="icon-btn danger"
            title="Bloquear"
            onClick={() => confirm(`Bloquear ${u.display_name}?`) && void client().api.block(u.id)}
          >
            <Icon name="shield" />
          </button>
        </UserRow>
      ))}
    </div>
  );
}

function Pending() {
  const incoming = useNexus((s) => s.incoming);
  const outgoing = useNexus((s) => s.outgoing);
  if (!incoming.length && !outgoing.length) return <p className="empty-hint">Nenhum pedido pendente.</p>;
  return (
    <div className="user-list">
      {incoming.map((r) => (
        <UserRow key={r.id} user={r.from} subtitle="Pedido recebido">
          <button
            type="button"
            className="icon-btn on"
            title="Aceitar"
            onClick={() => void client().api.acceptFriendRequest(r.id)}
          >
            <Icon name="check" />
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Recusar"
            onClick={() => void client().api.deleteFriendRequest(r.id)}
          >
            <Icon name="x" />
          </button>
        </UserRow>
      ))}
      {outgoing.map((r) => (
        <UserRow key={r.id} user={r.to} subtitle="Pedido enviado">
          <button
            type="button"
            className="icon-btn"
            title="Cancelar"
            onClick={() => void client().api.deleteFriendRequest(r.id)}
          >
            <Icon name="x" />
          </button>
        </UserRow>
      ))}
    </div>
  );
}

function Blocked() {
  const blocked = useNexus(useShallow((s) => Object.values(s.blocked)));
  if (!blocked.length) return <p className="empty-hint">Ninguém bloqueado.</p>;
  return (
    <div className="user-list">
      {blocked.map((u) => (
        <UserRow key={u.id} user={u} subtitle="Bloqueado">
          <button type="button" className="btn" onClick={() => void client().api.unblock(u.id)}>
            Desbloquear
          </button>
        </UserRow>
      ))}
    </div>
  );
}

function Invites() {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [maxUses, setMaxUses] = useState("1");
  const [expires, setExpires] = useState("7d");
  const [created, setCreated] = useState<string | null>(null);
  const reload = () => void client().api.invites().then(setInvites);
  useEffect(reload, []);
  async function create() {
    const inv = await client().api.createInvite({
      max_uses: maxUses ? Number(maxUses) : undefined,
      expires_in: expires || undefined,
    });
    setCreated(inv.code);
    void navigator.clipboard?.writeText(inv.code).catch(() => undefined);
    reload();
  }
  return (
    <div className="invites">
      <div className="row">
        <label>
          Usos
          <input value={maxUses} onChange={(e) => setMaxUses(e.target.value.replace(/\D/g, ""))} placeholder="∞" />
        </label>
        <label>
          Expira em
          <select value={expires} onChange={(e) => setExpires(e.target.value)}>
            <option value="1d">1 dia</option>
            <option value="7d">7 dias</option>
            <option value="30d">30 dias</option>
            <option value="">Nunca</option>
          </select>
        </label>
        <button type="button" className="btn primary" onClick={() => void create()}>
          Gerar convite
        </button>
      </div>
      {created && (
        <p className="hint ok">
          Convite <code>{created}</code> copiado para a área de transferência.
        </p>
      )}
      <table className="table">
        <thead>
          <tr>
            <th>Código</th>
            <th>Usos</th>
            <th>Expira</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {invites.map((i) => (
            <tr key={i.code} className={i.revoked ? "muted" : ""}>
              <td>
                <code>{i.code}</code>
              </td>
              <td>
                {i.uses}/{i.max_uses ?? "∞"}
              </td>
              <td>{i.expires_at ? new Date(i.expires_at).toLocaleDateString() : "nunca"}</td>
              <td>
                {!i.revoked && (
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => void client().api.revokeInvite(i.code).then(reload)}
                  >
                    Revogar
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
