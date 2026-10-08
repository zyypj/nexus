import type { Id } from "@nexus/protocol";
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Avatar } from "../components/Avatar";
import { Icon } from "../components/Icon";
import { client, useNexus } from "../lib/nexus";

export function GroupMembers({ conversationId }: { conversationId: Id }) {
  const conv = useNexus((s) => s.conversations[conversationId]);
  const myId = useNexus((s) => s.me?.id);
  const friends = useNexus(useShallow((s) => Object.values(s.friends).map((f) => f.user)));
  const presences = useNexus((s) => s.presences);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState(conv?.name ?? "");
  if (!conv) return null;
  const isOwner = conv.owner_id === myId;
  const candidates = friends.filter((f) => !conv.members.some((m) => m.id === f.id));

  return (
    <aside className="members">
      <form
        className="rename"
        onSubmit={(e) => {
          e.preventDefault();
          void client().api.renameGroup(conversationId, name);
        }}
      >
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome do grupo" maxLength={64} />
      </form>
      <div className="section-title">
        <span>Membros — {conv.members.length}</span>
        <button type="button" className="icon-btn small" onClick={() => setAdding((a) => !a)} title="Adicionar">
          <Icon name="plus" size={16} />
        </button>
      </div>
      {adding && (
        <div className="pick-list">
          {candidates.map((f) => (
            <button
              type="button"
              key={f.id}
              className="pick-item"
              onClick={() => void client().api.addMember(conversationId, f.id)}
            >
              <Avatar user={f} size={24} />
              <span>{f.display_name}</span>
            </button>
          ))}
          {candidates.length === 0 && <p className="empty-hint">Todos os seus amigos já estão aqui.</p>}
        </div>
      )}
      {conv.members.map((m) => (
        <div key={m.id} className="member">
          <Avatar user={m} size={30} presence={presences[m.id] ?? (m.id === myId ? "online" : "offline")} />
          <span>
            {m.display_name}
            {conv.owner_id === m.id && <small className="owner"> dono</small>}
          </span>
          {isOwner && m.id !== myId && (
            <button
              type="button"
              className="icon-btn small"
              title="Remover do grupo"
              onClick={() => confirm(`Remover ${m.display_name}?`) && void client().api.removeMember(conversationId, m.id)}
            >
              <Icon name="x" size={14} />
            </button>
          )}
        </div>
      ))}
      <button
        type="button"
        className="btn danger small leave"
        onClick={() => myId && confirm("Sair do grupo?") && void client().api.removeMember(conversationId, myId)}
      >
        Sair do grupo
      </button>
    </aside>
  );
}
