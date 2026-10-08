import type { Id, ServerMember, ServerView } from "@nexus/protocol";
import { memberColor } from "@nexus/shared";
import { memo, useMemo } from "react";
import { Avatar } from "../components/Avatar";
import { openContextMenu } from "../components/ContextMenu";
import { Icon } from "../components/Icon";
import { openProfile } from "../lib/dialogs";
import { useNexus } from "../lib/nexus";
import { useUi } from "../lib/ui";
import { userMenu } from "./menus";

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
              onOpen={(x, y) => openProfile({ userId: m.user.id, serverId: server.id, x, y })}
            />
          ))}
        </section>
      ))}
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
  onOpen: (x: number, y: number) => void;
}) {
  const presence = useNexus((s) => (offline ? undefined : (s.presences[member.user.id] ?? "online")));
  const color = memberColor(server, member.user.id);
  return (
    <button
      type="button"
      className={`member-item${offline ? " offline" : ""}`}
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onOpen(r.left, r.top);
      }}
      onContextMenu={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const at = { x: r.left, y: r.top };
        openContextMenu(e, () => userMenu(member.user.id, at, server.id));
      }}
    >
      <Avatar user={member.user} size={32} presence={presence} />
      <span className="member-item-name" style={color ? { color } : undefined}>
        {member.nickname || member.user.display_name}
      </span>
      {member.user.id === server.owner_id && <Icon name="crown" size={13} className="owner-crown" />}
    </button>
  );
});

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
