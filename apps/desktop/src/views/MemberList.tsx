import { type Call, type ConversationView, type Id, Permissions, type Presence, type ServerMember, type ServerView, hasPermission } from "@nexus/protocol";
import { memberColor } from "@nexus/shared";
import { memo, useMemo } from "react";
import { calls, useCall } from "../call/callStore";
import { Avatar } from "../components/Avatar";
import { openContextMenu } from "../components/ContextMenu";
import { Icon } from "../components/Icon";
import { openProfile } from "../lib/dialogs";
import { client, useNexus } from "../lib/nexus";
import { useUi } from "../lib/ui";
import { userMenu } from "./menus";

interface Group {
  key: string;
  title: string;
  members: ServerMember[];
}

/** What someone is doing in a voice channel of this server (subtitle under the name). */
interface VoiceActivity {
  channel: string;
  screen: boolean;
}

interface VoiceRoom {
  channel: ConversationView;
  call: Call;
}

const PRESENCE_LABEL: Record<Presence, string> = {
  online: "Online",
  idle: "Ausente",
  dnd: "Não perturbe",
  offline: "Offline",
};

/**
 * Members of a server: hoisted roles first (online only), then Online and
 * Offline. Names in the color of the member's highest colored role.
 */
export function MemberList({ server }: { server: ServerView }) {
  const presences = useNexus((s) => s.presences);
  const meId = useNexus((s) => s.me?.id);
  const allCalls = useNexus((s) => s.calls);
  const conversations = useNexus((s) => s.conversations);

  // Voice channels of this server with people in them, and who is where.
  const { rooms, activity } = useMemo(() => {
    const rooms: VoiceRoom[] = [];
    const activity = new Map<Id, VoiceActivity>();
    for (const call of Object.values(allCalls)) {
      const channel = conversations[call.conversation_id];
      if (!channel || channel.server_id !== server.id || channel.kind !== "voice" || !call.participants.length) continue;
      rooms.push({ channel, call });
      for (const p of call.participants) activity.set(p.user_id, { channel: channel.name ?? "", screen: p.screen });
    }
    rooms.sort((a, b) => (a.channel.position ?? 0) - (b.channel.position ?? 0));
    return { rooms, activity };
  }, [allCalls, conversations, server.id]);

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
    <aside className="member-list">
      <header className="aside-header">
        <strong>Membros</strong>
        <Icon name="users" size={16} />
      </header>
      <div className="member-list-scroll">
        {rooms.map((r) => (
          <VoiceRoomCard key={r.channel.id} room={r} />
        ))}
        {groups.map((g) => (
          <section key={g.key}>
            <h4>
              {g.title} — {g.members.length}
              {g.key === "online" && <span className="online-dot" aria-hidden />}
            </h4>
            {g.members.map((m) => (
              <MemberRow
                key={m.user.id}
                server={server}
                member={m}
                offline={g.key === "offline"}
                activity={activity.get(m.user.id)}
                onOpen={(x, y) => openProfile({ userId: m.user.id, serverId: server.id, x, y })}
              />
            ))}
          </section>
        ))}
      </div>
    </aside>
  );
}

const MemberRow = memo(function MemberRow({
  server,
  member,
  offline,
  activity,
  onOpen,
}: {
  server: ServerView;
  member: ServerMember;
  offline: boolean;
  activity: VoiceActivity | undefined;
  onOpen: (x: number, y: number) => void;
}) {
  const presence = useNexus((s) => (offline ? undefined : (s.presences[member.user.id] ?? "online")));
  const color = memberColor(server, member.user.id);
  const status = activity
    ? activity.screen
      ? "Compartilhando tela"
      : `Em ${activity.channel}`
    : PRESENCE_LABEL[presence ?? "offline"];
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
      <Avatar user={member.user} size={30} presence={presence} />
      <span className="member-item-names">
        <span className="member-item-name" style={color ? { color } : undefined}>
          {member.nickname || member.user.display_name}
          {member.user.id === server.owner_id && <Icon name="crown" size={12} className="owner-crown" />}
        </span>
        <small className={activity ? "active" : undefined}>{status}</small>
      </span>
    </button>
  );
});

/** A voice channel with people in it: who is there and a shortcut to join. */
const VoiceRoomCard = memo(function VoiceRoomCard({ room }: { room: VoiceRoom }) {
  const { channel, call } = room;
  const here = useCall((s) => s.conversationId === channel.id);
  const users = useNexus((s) => s.users);
  const people = call.participants;
  const live = people.some((p) => p.screen);
  return (
    <div className="voice-room">
      <div className="voice-room-head">
        <Icon name="volume" size={15} />
        <strong>{channel.name}</strong>
        {live && <span className="live-chip">AO VIVO</span>}
      </div>
      <small>
        {people.length} {people.length === 1 ? "pessoa conversando" : "pessoas conversando"} agora
      </small>
      <div className="voice-room-foot">
        <span className="voice-room-faces">
          {people.slice(0, 4).map((p) => (
            <Avatar key={p.user_id} user={users[p.user_id]} size={24} />
          ))}
          {people.length > 4 && <span className="voice-room-more">+{people.length - 4}</span>}
        </span>
        <button
          type="button"
          className="voice-room-join"
          disabled={!here && !hasPermission(channel.permissions, Permissions.CONNECT)}
          onClick={() => {
            void client().openConversation(channel.id);
            if (!here) void calls.start(channel.id);
          }}
        >
          {here ? "Abrir sala" : "Entrar na sala"} <Icon name="external" size={12} />
        </button>
      </div>
    </div>
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
