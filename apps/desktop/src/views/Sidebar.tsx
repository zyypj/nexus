import type { ConversationView } from "@nexus/protocol";
import { callForConversation, conversationTitle, dmPeer, sortedConversations } from "@nexus/shared";
import { memo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Avatar } from "../components/Avatar";
import { openContextMenu } from "../components/ContextMenu";
import { Icon } from "../components/Icon";
import { client, useNexus } from "../lib/nexus";
import { CallStrip } from "./CallStrip";
import { CreateGroupDialog } from "./CreateGroupDialog";
import { conversationMenu } from "./menus";
import { ServerSidebar } from "./ServerSidebar";
import { UpdateBanner } from "./UpdateBanner";
import { UserBar } from "./UserBar";

export function Sidebar({ onOpenSettings, serverId }: { onOpenSettings: () => void; serverId: string | null }) {
  return (
    <aside className="sidebar panel">
      {serverId ? <ServerSidebar serverId={serverId} /> : <HomeNav />}
      <UpdateBanner />
      <CallStrip />
      <UserBar onOpenSettings={onOpenSettings} />
    </aside>
  );
}

/** Início: friends, DMs and groups. */
function HomeNav() {
  const conversations = useNexus(useShallow(sortedConversations));
  const active = useNexus((s) => s.activeConversationId);
  const pending = useNexus((s) => s.incoming.length);
  const [creating, setCreating] = useState(false);
  const dms = conversations.filter((c) => c.kind === "dm");
  const groups = conversations.filter((c) => c.kind === "group");

  return (
    <>
      <header className="server-header home">
        <strong>Início</strong>
      </header>
      <nav className="sidebar-scroll">
        <button
          type="button"
          className={`nav-item${active === null ? " active" : ""}`}
          onClick={() => void client().openConversation(null)}
        >
          <Icon name="users" />
          <span>Amigos</span>
          {pending > 0 && <span className="badge">{pending}</span>}
        </button>

        <div className="section-title">
          <span>Mensagens diretas</span>
        </div>
        {dms.map((c) => (
          <ConversationItem key={c.id} conversation={c} active={c.id === active} />
        ))}
        {dms.length === 0 && <p className="empty-hint">Abra uma conversa pela lista de amigos.</p>}

        <div className="section-title">
          <span>Grupos</span>
          <button type="button" className="icon-btn small" onClick={() => setCreating(true)} title="Novo grupo">
            <Icon name="plus" size={16} />
          </button>
        </div>
        {groups.map((c) => (
          <ConversationItem key={c.id} conversation={c} active={c.id === active} />
        ))}
      </nav>
      {creating && <CreateGroupDialog onClose={() => setCreating(false)} />}
    </>
  );
}

const ConversationItem = memo(function ConversationItem({
  conversation,
  active,
}: {
  conversation: ConversationView;
  active: boolean;
}) {
  const title = useNexus((s) => conversationTitle(s, conversation));
  const peer = useNexus((s) => (conversation.kind === "dm" ? dmPeer(s, conversation) : undefined));
  const peerUser = useNexus((s) => (peer ? s.users[peer.id] : undefined));
  const presence = useNexus((s) => (peer ? (s.presences[peer.id] ?? "offline") : undefined));
  const inCall = useNexus((s) => (callForConversation(s, conversation.id)?.participants.length ?? 0) > 0);
  const unread = conversation.unread_count;
  return (
    <button
      type="button"
      className={`nav-item conv${active ? " active" : ""}${unread > 0 ? " unread" : ""}`}
      onClick={() => void client().openConversation(conversation.id)}
      onContextMenu={(e) => {
        const at = { x: e.clientX, y: e.clientY };
        openContextMenu(e, () => conversationMenu(conversation, at));
      }}
    >
      {conversation.kind === "dm" ? (
        <Avatar user={peerUser ?? peer} size={32} presence={presence} />
      ) : (
        <span className="group-icon">
          <Icon name="hash" size={16} />
        </span>
      )}
      <span className="conv-title">{title}</span>
      {inCall && (
        <span className="call-dot" title="Chamada em andamento">
          <Icon name="volume" size={14} />
        </span>
      )}
      {unread > 0 && <span className="badge">{unread >= 100 ? "99+" : unread}</span>}
    </button>
  );
});
