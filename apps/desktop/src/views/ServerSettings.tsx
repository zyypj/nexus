import {
  ALL_PERMISSIONS,
  type Id,
  Permissions,
  type ServerBan,
  type ServerInvite,
  type ServerRole,
  type ServerView,
  hasPermission,
} from "@nexus/protocol";
import { memberColor, memberTop } from "@nexus/shared";
import { useEffect, useMemo, useState } from "react";
import { Avatar } from "../components/Avatar";
import { Icon } from "../components/Icon";
import { Modal } from "../components/Modal";
import { RolePermissions } from "../components/PermissionEditor";
import { client, useNexus } from "../lib/nexus";
import { ROLE_COLORS, colorHex } from "../lib/ui";
import { InviteDialog } from "./InviteDialog";
import { openServer } from "./ServerRail";
import { ServerIcon } from "./ServerRail";

type Tab = "overview" | "roles" | "members" | "invites" | "bans";

export function ServerSettings({ serverId, onClose }: { serverId: Id; onClose: () => void }) {
  const server = useNexus((s) => s.servers[serverId]);
  const meId = useNexus((s) => s.me?.id ?? "");
  const p = server?.permissions ?? 0;
  const tabs: { id: Tab; label: string; show: boolean }[] = [
    { id: "overview", label: "Visão geral", show: hasPermission(p, Permissions.MANAGE_SERVER) },
    { id: "roles", label: "Cargos", show: hasPermission(p, Permissions.MANAGE_ROLES) },
    {
      id: "members",
      label: "Membros",
      show:
        hasPermission(p, Permissions.MANAGE_ROLES) ||
        hasPermission(p, Permissions.KICK_MEMBERS) ||
        hasPermission(p, Permissions.BAN_MEMBERS),
    },
    { id: "invites", label: "Convites", show: hasPermission(p, Permissions.MANAGE_SERVER) },
    { id: "bans", label: "Banimentos", show: hasPermission(p, Permissions.BAN_MEMBERS) },
  ];
  const visible = tabs.filter((t) => t.show);
  const [tab, setTab] = useState<Tab>(visible[0]?.id ?? "members");
  if (!server) return null;
  return (
    <Modal title={server.name} onClose={onClose} wide>
      <div className="settings-layout">
        <nav className="settings-nav">
          {visible.map((t) => (
            <button key={t.id} type="button" className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="settings-body">
          {tab === "overview" && <Overview server={server} meId={meId} onClose={onClose} />}
          {tab === "roles" && <Roles server={server} meId={meId} />}
          {tab === "members" && <Members server={server} meId={meId} />}
          {tab === "invites" && <Invites server={server} />}
          {tab === "bans" && <Bans server={server} />}
        </div>
      </div>
    </Modal>
  );
}

function useError() {
  const [error, setError] = useState<string | null>(null);
  const run = (p: Promise<unknown>) => {
    setError(null);
    return p.catch((e: Error) => setError(e.message));
  };
  return { error, run };
}

// ---------------------------------------------------------------- overview

function Overview({ server, meId, onClose }: { server: ServerView; meId: Id; onClose: () => void }) {
  const [name, setName] = useState(server.name);
  const [transferTo, setTransferTo] = useState<Id>("");
  const [confirm, setConfirm] = useState("");
  const { error, run } = useError();
  const api = client().api;
  const owner = server.owner_id === meId;
  return (
    <div className="form-grid">
      <div className="overview-head">
        <label className="icon-upload" title="Trocar ícone">
          <ServerIcon server={server} size={84} />
          <span className="icon-upload-hint">
            <Icon name="edit" size={16} />
          </span>
          <input
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void run(api.uploadServerIcon(server.id, f, f.name));
              e.target.value = "";
            }}
          />
        </label>
        <div className="form-grid" style={{ flex: 1 }}>
          <label>
            Nome do servidor
            <input value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />
          </label>
          <div className="row-actions">
            <button
              type="button"
              className="btn primary"
              disabled={!name.trim() || name === server.name}
              onClick={() => void run(api.updateServer(server.id, { name }))}
            >
              Salvar nome
            </button>
            {server.icon_url && (
              <button type="button" className="btn" onClick={() => void run(api.deleteServerIcon(server.id))}>
                Remover ícone
              </button>
            )}
          </div>
        </div>
      </div>
      {error && <p className="form-error">{error}</p>}
      {owner && (
        <>
          <h3 className="settings-subtitle">Transferir posse</h3>
          <div className="row-actions">
            <select value={transferTo} onChange={(e) => setTransferTo(e.target.value)}>
              <option value="">Escolha um membro…</option>
              {server.members
                .filter((m) => m.user.id !== meId)
                .map((m) => (
                  <option key={m.user.id} value={m.user.id}>
                    {m.nickname || m.user.display_name}
                  </option>
                ))}
            </select>
            <button
              type="button"
              className="btn"
              disabled={!transferTo}
              onClick={() => void run(api.transferServer(server.id, transferTo))}
            >
              Transferir
            </button>
          </div>
          <h3 className="settings-subtitle danger">Apagar servidor</h3>
          <p className="hint">Apaga canais, mensagens e arquivos para todo mundo. Digite o nome do servidor para confirmar.</p>
          <div className="row-actions">
            <input value={confirm} placeholder={server.name} onChange={(e) => setConfirm(e.target.value)} />
            <button
              type="button"
              className="btn danger"
              disabled={confirm !== server.name}
              onClick={() =>
                void run(
                  api.deleteServer(server.id).then(() => {
                    onClose();
                    openServer(null);
                  }),
                )
              }
            >
              Apagar
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- roles

function Roles({ server, meId }: { server: ServerView; meId: Id }) {
  const myTop = memberTop(server, meId);
  const myPerms = server.permissions;
  const grantable = myPerms === ALL_PERMISSIONS ? ALL_PERMISSIONS : myPerms;
  const [selected, setSelected] = useState<Id>(server.roles[0]?.id ?? server.id);
  const role = server.roles.find((r) => r.id === selected) ?? server.roles[server.roles.length - 1];
  const { error, run } = useError();
  const api = client().api;
  const ordered = server.roles.filter((r) => r.id !== server.id);

  function move(r: ServerRole, dir: -1 | 1) {
    const ids = ordered.map((x) => x.id);
    const i = ids.indexOf(r.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j] as Id, ids[i] as Id];
    void run(api.orderRoles(server.id, ids));
  }

  return (
    <div className="roles-layout">
      <div className="roles-list">
        <button
          type="button"
          className="btn primary small"
          onClick={() =>
            void run(api.createRole(server.id, { name: "novo cargo", color: 0 }).then((r) => setSelected(r.id)))
          }
        >
          <Icon name="plus" size={14} /> Criar cargo
        </button>
        {server.roles.map((r) => {
          const editable = r.id === server.id || r.position < myTop;
          return (
            <div key={r.id} className={`role-item${selected === r.id ? " active" : ""}`}>
              <button type="button" className="role-item-main" onClick={() => setSelected(r.id)}>
                <span className="role-dot" style={{ background: r.color ? colorHex(r.color) : "var(--c-text-faint)" }} />
                <span className="role-item-name">{r.name}</span>
                {!editable && <Icon name="lock" size={12} />}
              </button>
              {r.id !== server.id && editable && (
                <span className="role-move">
                  <button type="button" className="icon-btn tiny" title="Subir" onClick={() => move(r, -1)}>
                    <Icon name="chevronDown" size={12} className="flip" />
                  </button>
                  <button type="button" className="icon-btn tiny" title="Descer" onClick={() => move(r, 1)}>
                    <Icon name="chevronDown" size={12} />
                  </button>
                </span>
              )}
            </div>
          );
        })}
      </div>
      {role && (
        <RoleEditor
          key={role.id}
          server={server}
          role={role}
          editable={role.id === server.id || role.position < myTop}
          grantable={grantable}
          onError={(e) => void run(Promise.reject(e))}
        />
      )}
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}

function RoleEditor({
  server,
  role,
  editable,
  grantable,
  onError,
}: {
  server: ServerView;
  role: ServerRole;
  editable: boolean;
  grantable: number;
  onError: (e: Error) => void;
}) {
  const everyone = role.id === server.id;
  const [name, setName] = useState(role.name);
  const [color, setColor] = useState(role.color);
  const [hoist, setHoist] = useState(role.hoist);
  const [perms, setPerms] = useState(role.permissions);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dirty = name !== role.name || color !== role.color || hoist !== role.hoist || perms !== role.permissions;
  const api = client().api;
  const save = () =>
    void api
      .updateRole(server.id, role.id, {
        ...(everyone ? {} : { name, hoist }),
        color,
        permissions: perms,
      })
      .catch(onError);

  return (
    <div className="role-editor">
      {!editable && <p className="hint warn">Este cargo está acima do seu; só dá para ver.</p>}
      {!everyone && (
        <label>
          Nome do cargo
          <input value={name} maxLength={32} disabled={!editable} onChange={(e) => setName(e.target.value)} />
        </label>
      )}
      {!everyone && (
        <div>
          <span className="label">Cor</span>
          <div className="swatches">
            <button
              type="button"
              className={`swatch none${color === 0 ? " on" : ""}`}
              disabled={!editable}
              title="Sem cor"
              onClick={() => setColor(0)}
            />
            {ROLE_COLORS.map((c) => (
              <button
                type="button"
                key={c}
                className={`swatch${color === c ? " on" : ""}`}
                style={{ background: colorHex(c) }}
                disabled={!editable}
                onClick={() => setColor(c)}
              />
            ))}
            <label className="swatch custom" title="Outra cor">
              <input
                type="color"
                value={colorHex(color || 0x5b73f7)}
                disabled={!editable}
                onChange={(e) => setColor(Number.parseInt(e.target.value.slice(1), 16))}
              />
            </label>
          </div>
          <p className="role-preview" style={{ color: color ? colorHex(color) : undefined }}>
            {name || "Cargo"} — prévia do nome no chat
          </p>
        </div>
      )}
      {!everyone && (
        <label className="perm-row">
          <span>
            <strong>Mostrar separado na lista de membros</strong>
            <small>Membros com este cargo aparecem em um grupo próprio.</small>
          </span>
          <input type="checkbox" checked={hoist} disabled={!editable} onChange={(e) => setHoist(e.target.checked)} />
          <span className="switch" aria-hidden />
        </label>
      )}
      <h3 className="settings-subtitle">Permissões</h3>
      {everyone && <p className="hint">O que todo mundo no servidor pode fazer por padrão.</p>}
      <RolePermissions value={perms} editable={editable ? grantable : 0} onChange={setPerms} />
      <div className="sticky-actions">
        {!everyone && editable && (
          <button type="button" className="btn danger" onClick={() => setConfirmDelete(true)}>
            Apagar cargo
          </button>
        )}
        <span style={{ flex: 1 }} />
        {dirty && (
          <button
            type="button"
            className="btn"
            onClick={() => {
              setName(role.name);
              setColor(role.color);
              setHoist(role.hoist);
              setPerms(role.permissions);
            }}
          >
            Desfazer
          </button>
        )}
        <button type="button" className="btn primary" disabled={!editable || !dirty} onClick={save}>
          Salvar alterações
        </button>
      </div>
      {confirmDelete && (
        <Modal title={`Apagar o cargo ${role.name}?`} onClose={() => setConfirmDelete(false)}>
          <p className="hint">Quem tem o cargo perde as permissões dele.</p>
          <div className="modal-actions">
            <button type="button" className="btn" onClick={() => setConfirmDelete(false)}>
              Cancelar
            </button>
            <button
              type="button"
              className="btn danger"
              onClick={() => void api.deleteRole(server.id, role.id).catch(onError)}
            >
              Apagar
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- members

function Members({ server, meId }: { server: ServerView; meId: Id }) {
  const [q, setQ] = useState("");
  const myTop = memberTop(server, meId);
  const p = server.permissions;
  const { error, run } = useError();
  const [banning, setBanning] = useState<Id | null>(null);
  const [reason, setReason] = useState("");
  const api = client().api;
  const members = useMemo(
    () =>
      server.members.filter((m) =>
        `${m.nickname ?? ""} ${m.user.display_name} ${m.user.username}`.toLowerCase().includes(q.toLowerCase()),
      ),
    [server.members, q],
  );
  const assignable = server.roles.filter((r) => r.id !== server.id && r.position < myTop);

  return (
    <div className="form-grid">
      <input placeholder="Buscar membros" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="member-table">
        {members.map((m) => {
          const isOwner = m.user.id === server.owner_id;
          const above = memberTop(server, m.user.id) >= myTop && m.user.id !== meId;
          const color = memberColor(server, m.user.id);
          return (
            <div key={m.user.id} className="member-row">
              <Avatar user={m.user} size={36} />
              <div className="member-row-main">
                <span className="member-row-name" style={color ? { color } : undefined}>
                  {m.nickname || m.user.display_name}
                  {isOwner && <Icon name="crown" size={13} className="owner-crown" />}
                </span>
                <small>@{m.user.username}</small>
                <div className="role-chips">
                  {m.role_ids.map((rid) => {
                    const r = server.roles.find((x) => x.id === rid);
                    if (!r) return null;
                    const can = hasPermission(p, Permissions.MANAGE_ROLES) && r.position < myTop && (!above || m.user.id === meId);
                    return (
                      <span key={rid} className="role-chip">
                        <span className="role-dot" style={{ background: r.color ? colorHex(r.color) : "var(--c-text-faint)" }} />
                        {r.name}
                        {can && (
                          <button
                            type="button"
                            aria-label={`Tirar ${r.name}`}
                            onClick={() =>
                              void run(
                                api.updateServerMember(server.id, m.user.id, {
                                  role_ids: m.role_ids.filter((x) => x !== rid),
                                }),
                              )
                            }
                          >
                            <Icon name="x" size={11} />
                          </button>
                        )}
                      </span>
                    );
                  })}
                  {hasPermission(p, Permissions.MANAGE_ROLES) && (!above || m.user.id === meId) && (
                    <select
                      className="role-add"
                      value=""
                      onChange={(e) =>
                        e.target.value &&
                        void run(
                          api.updateServerMember(server.id, m.user.id, { role_ids: [...m.role_ids, e.target.value] }),
                        )
                      }
                    >
                      <option value="">+ cargo</option>
                      {assignable
                        .filter((r) => !m.role_ids.includes(r.id))
                        .map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name}
                          </option>
                        ))}
                    </select>
                  )}
                </div>
              </div>
              {!isOwner && !above && m.user.id !== meId && (
                <div className="member-actions">
                  {hasPermission(p, Permissions.KICK_MEMBERS) && (
                    <button
                      type="button"
                      className="btn small"
                      onClick={() => void run(api.kickMember(server.id, m.user.id))}
                    >
                      Expulsar
                    </button>
                  )}
                  {hasPermission(p, Permissions.BAN_MEMBERS) && (
                    <button type="button" className="btn small danger" onClick={() => setBanning(m.user.id)}>
                      Banir
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {error && <p className="form-error">{error}</p>}
      {banning && (
        <Modal title="Banir membro" onClose={() => setBanning(null)}>
          <div className="form-grid">
            <label>
              Motivo (opcional)
              <input value={reason} maxLength={512} onChange={(e) => setReason(e.target.value)} autoFocus />
            </label>
            <p className="hint">A pessoa sai do servidor e não consegue voltar por convite até ser desbanida.</p>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setBanning(null)}>
                Cancelar
              </button>
              <button
                type="button"
                className="btn danger"
                onClick={() => {
                  void run(api.banMember(server.id, banning, reason || undefined));
                  setBanning(null);
                  setReason("");
                }}
              >
                Banir
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- invites & bans

function Invites({ server }: { server: ServerView }) {
  const [invites, setInvites] = useState<ServerInvite[] | null>(null);
  const [creating, setCreating] = useState(false);
  const users = useNexus((s) => s.users);
  const { error, run } = useError();
  const load = () => void run(client().api.listServerInvites(server.id).then(setInvites));
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload when the dialog closes
  useEffect(load, [server.id, creating]);
  return (
    <div className="form-grid">
      <div className="row-actions">
        <button type="button" className="btn primary small" onClick={() => setCreating(true)}>
          <Icon name="link" size={14} /> Novo convite
        </button>
      </div>
      {invites?.length === 0 && <p className="hint">Nenhum convite ativo.</p>}
      <div className="member-table">
        {invites?.map((i) => (
          <div key={i.code} className="member-row">
            <code className="invite-code-small">{i.code}</code>
            <div className="member-row-main">
              <small>
                por {i.created_by ? (users[i.created_by]?.display_name ?? "alguém") : "alguém"} · {i.uses}
                {i.max_uses ? `/${i.max_uses}` : ""} usos ·{" "}
                {i.expires_at ? `expira ${new Date(i.expires_at).toLocaleString()}` : "não expira"}
              </small>
            </div>
            <button
              type="button"
              className="btn small danger"
              onClick={() => void run(client().api.deleteServerInvite(i.code)).then(load)}
            >
              Revogar
            </button>
          </div>
        ))}
      </div>
      {error && <p className="form-error">{error}</p>}
      {creating && <InviteDialog serverId={server.id} onClose={() => setCreating(false)} />}
    </div>
  );
}

function Bans({ server }: { server: ServerView }) {
  const [bans, setBans] = useState<ServerBan[] | null>(null);
  const { error, run } = useError();
  const load = () => void run(client().api.listBans(server.id).then(setBans));
  // biome-ignore lint/correctness/useExhaustiveDependencies: load once per server
  useEffect(load, [server.id]);
  return (
    <div className="form-grid">
      {bans?.length === 0 && <p className="hint">Ninguém banido.</p>}
      <div className="member-table">
        {bans?.map((b) => (
          <div key={b.user.id} className="member-row">
            <Avatar user={b.user} size={36} />
            <div className="member-row-main">
              <span className="member-row-name">{b.user.display_name}</span>
              <small>{b.reason ? `Motivo: ${b.reason}` : "Sem motivo"}</small>
            </div>
            <button
              type="button"
              className="btn small"
              onClick={() => void run(client().api.unbanMember(server.id, b.user.id)).then(load)}
            >
              Desbanir
            </button>
          </div>
        ))}
      </div>
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}
