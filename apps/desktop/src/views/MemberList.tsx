import { type Id, Permissions, type ServerMember, type ServerView, hasPermission } from "@nexus/protocol";
import { memberColor, memberTop } from "@nexus/shared";
import { memo, useMemo, useState } from "react";
import { Avatar } from "../components/Avatar";
import { Icon } from "../components/Icon";
import { client, useNexus } from "../lib/nexus";
import { colorHex, useUi } from "../lib/ui";
import { openServer } from "./ServerRail";

interface Group {
  key: string;
  title: string;
  members: ServerMember[];
}

/**
 * Members of a server: hoisted roles first (online only), then Online and
 * Offline. Names in the color of the member's highest colored role.
 */
export function MemberList({ server }: { server: ServerView }) {
  const presences = useNexus((s) => s.presences);
  const meId = useNexus((s) => s.me?.id);
  const [card, setCard] = useState<{ member: ServerMember; top: number } | null>(null);

  const groups = useMemo(() => {
    const online = (m: ServerMember) => m.user.id === meId || (presences[m.user.id] ?? "offline") !== "offline";
    const byName = (a: ServerMember, b: ServerMember) =>
      (a.nickname || a.user.display_name).localeCompare(b.nickname || b.user.display_name);
    const placed = new Set<Id>();
    const out: Group[] = [];
    for (const role of server.roles.filter((r) => r.hoist)) {
      const ms = server.members.filter((m) => !placed.has(m.user.id) && online(m) && m.role_ids.includes(role.id));
      for (const m of ms) placed.add(m.user.id);
      if (ms.length) out.push({ key: role.id, title: role.name, members: ms.sort(byName) });
    }
    const rest = server.members.filter((m) => !placed.has(m.user.id));
    const on = rest.filter(online).sort(byName);
    const off = rest.filter((m) => !online(m)).sort(byName);
    if (on.length) out.push({ key: "online", title: "Online", members: on });
    if (off.length) out.push({ key: "offline", title: "Offline", members: off });
    return out;
  }, [server, presences, meId]);

  return (
    <aside className="member-list panel">
      {groups.map((g) => (
        <section key={g.key}>
          <h4>
            {g.title} — {g.members.length}
          </h4>
          {g.members.map((m) => (
            <MemberRow
              key={m.user.id}
              server={server}
              member={m}
              offline={g.key === "offline"}
              onOpen={(top) => setCard({ member: m, top })}
            />
          ))}
        </section>
      ))}
      {card && <MemberCard server={server} member={card.member} top={card.top} onClose={() => setCard(null)} />}
    </aside>
  );
}

const MemberRow = memo(function MemberRow({
  server,
  member,
  offline,
  onOpen,
}: {
  server: ServerView;
  member: ServerMember;
  offline: boolean;
  onOpen: (top: number) => void;
}) {
  const presence = useNexus((s) => (offline ? undefined : (s.presences[member.user.id] ?? "online")));
  const color = memberColor(server, member.user.id);
  return (
    <button
      type="button"
      className={`member-item${offline ? " offline" : ""}`}
      onClick={(e) => onOpen((e.currentTarget as HTMLElement).getBoundingClientRect().top)}
    >
      <Avatar user={member.user} size={32} presence={presence} />
      <span className="member-item-name" style={color ? { color } : undefined}>
        {member.nickname || member.user.display_name}
      </span>
      {member.user.id === server.owner_id && <Icon name="crown" size={13} className="owner-crown" />}
    </button>
  );
});

function MemberCard({
  server,
  member,
  top,
  onClose,
}: {
  server: ServerView;
  member: ServerMember;
  top: number;
  onClose: () => void;
}) {
  const meId = useNexus((s) => s.me?.id ?? "");
  const color = memberColor(server, member.user.id);
  const roles = server.roles.filter((r) => member.role_ids.includes(r.id));
  const p = server.permissions;
  const isMe = member.user.id === meId;
  const canModerate =
    !isMe && member.user.id !== server.owner_id && memberTop(server, meId) > memberTop(server, member.user.id);
  const [error, setError] = useState<string | null>(null);
  const api = client().api;
  return (
    <div className="card-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="member-card" style={{ top: Math.min(top, window.innerHeight - 340) }}>
        <div className="member-card-banner" style={color ? { background: color } : undefined} />
        <div className="member-card-body">
          <Avatar user={member.user} size={64} />
          <strong style={color ? { color } : undefined}>{member.nickname || member.user.display_name}</strong>
          <small>@{member.user.username}</small>
          {member.user.bio && <p className="member-card-bio">{member.user.bio}</p>}
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
          <div className="row-actions">
            {!isMe && (
              <button
                type="button"
                className="btn primary small"
                onClick={() =>
                  void api.openDm(member.user.id).then((c) => {
                    onClose();
                    openServer(null);
                    void client().openConversation(c.id);
                  })
                }
              >
                Mensagem
              </button>
            )}
            {canModerate && hasPermission(p, Permissions.KICK_MEMBERS) && (
              <button
                type="button"
                className="btn small"
                onClick={() => void api.kickMember(server.id, member.user.id).then(onClose, (e: Error) => setError(e.message))}
              >
                Expulsar
              </button>
            )}
            {canModerate && hasPermission(p, Permissions.BAN_MEMBERS) && (
              <button
                type="button"
                className="btn small danger"
                onClick={() =>
                  void api.banMember(server.id, member.user.id).then(onClose, (e: Error) => setError(e.message))
                }
              >
                Banir
              </button>
            )}
          </div>
          {error && <p className="form-error">{error}</p>}
        </div>
      </div>
    </div>
  );
}

/** Toggle shown in channel headers. */
export function MemberListToggle() {
  const on = useUi((s) => s.memberList);
  return (
    <button
      type="button"
      className={`icon-btn${on ? " on" : ""}`}
      title={on ? "Esconder membros" : "Mostrar membros"}
      onClick={() => useUi.getState().set({ memberList: !on })}
    >
      <Icon name="users" />
    </button>
  );
}
