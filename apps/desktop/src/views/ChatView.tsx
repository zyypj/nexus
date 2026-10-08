import type { Id } from "@nexus/protocol";
import { callForConversation, conversationTitle, dmPeer, typingUsers } from "@nexus/shared";
import { useState } from "react";
import { calls, useCall } from "../call/callStore";
import { Avatar } from "../components/Avatar";
import { Icon } from "../components/Icon";
import { useNexus } from "../lib/nexus";
import { CallPanel } from "./CallPanel";
import { Composer } from "./Composer";
import { GroupMembers } from "./GroupMembers";
import { MessageList } from "./MessageList";

export function ChatView({ conversationId }: { conversationId: Id }) {
  const conv = useNexus((s) => s.conversations[conversationId]);
  const title = useNexus((s) => (conv ? conversationTitle(s, conv) : ""));
  const peer = useNexus((s) => (conv?.kind === "dm" ? dmPeer(s, conv) : undefined));
  const peerUser = useNexus((s) => (peer ? s.users[peer.id] : undefined));
  const presence = useNexus((s) => (peer ? (s.presences[peer.id] ?? "offline") : undefined));
  const blocked = useNexus((s) => (peer ? !!s.blocked[peer.id] : false));
  const activeCall = useNexus((s) => callForConversation(s, conversationId));
  const callsEnabled = useNexus((s) => s.server?.calls_enabled ?? false);
  const myCallConv = useCall((s) => s.conversationId);
  const [replyTo, setReplyTo] = useState<Id | null>(null);
  const [showMembers, setShowMembers] = useState(false);
  if (!conv) return null;

  const inThisCall = myCallConv === conversationId;
  const startCall = async (video: boolean) => {
    if (activeCall) await calls.join(activeCall.id);
    else await calls.start(conversationId);
    if (video) await calls.setCamera(true);
  };

  return (
    <section className="chat">
      <header className="header">
        {conv.kind === "dm" ? (
          <Avatar user={peerUser ?? peer} size={28} presence={presence} />
        ) : (
          <Icon name="hash" />
        )}
        <h2>{title}</h2>
        {conv.kind === "group" && <small className="muted">{conv.members.length} membros</small>}
        <div className="header-actions">
          {callsEnabled && !inThisCall && !blocked && (
            <>
              <button type="button" className="icon-btn" title="Chamada de voz" onClick={() => void startCall(false)}>
                <Icon name="phone" />
              </button>
              <button type="button" className="icon-btn" title="Chamada de vídeo" onClick={() => void startCall(true)}>
                <Icon name="video" />
              </button>
            </>
          )}
          {conv.kind === "group" && (
            <button
              type="button"
              className={`icon-btn${showMembers ? " on" : ""}`}
              title="Membros"
              onClick={() => setShowMembers((v) => !v)}
            >
              <Icon name="users" />
            </button>
          )}
        </div>
      </header>

      {inThisCall ? (
        <CallPanel />
      ) : (
        activeCall &&
        activeCall.participants.length > 0 && (
          <div className="join-bar">
            <span>
              Chamada em andamento · {activeCall.participants.length}{" "}
              {activeCall.participants.length === 1 ? "pessoa" : "pessoas"}
            </span>
            <button type="button" className="btn primary small" onClick={() => void calls.join(activeCall.id)}>
              Entrar
            </button>
          </div>
        )
      )}

      <div className="chat-body">
        <div className="chat-column">
          <MessageList conversationId={conversationId} onReply={setReplyTo} />
          <TypingIndicator conversationId={conversationId} />
          {blocked ? (
            <div className="composer disabled">Você bloqueou este usuário.</div>
          ) : (
            <Composer conversationId={conversationId} replyTo={replyTo} onClearReply={() => setReplyTo(null)} />
          )}
        </div>
        {showMembers && conv.kind === "group" && <GroupMembers conversationId={conversationId} />}
      </div>
    </section>
  );
}

function TypingIndicator({ conversationId }: { conversationId: Id }) {
  const names = useNexus((s) =>
    typingUsers(s, conversationId)
      .map((id) => s.users[id]?.display_name ?? "Alguém")
      .join(", "),
  );
  return (
    <div className="typing" aria-live="polite">
      {names && (
        <>
          <span className="dots">
            <i />
            <i />
            <i />
          </span>
          {names} {names.includes(",") ? "estão digitando…" : "está digitando…"}
        </>
      )}
    </div>
  );
}

