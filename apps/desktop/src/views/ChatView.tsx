import { type Id, Permissions, hasPermission, isChannel } from "@nexus/protocol";
import { callForConversation, conversationTitle, dmPeer, typingUsers } from "@nexus/shared";
import { type DragEvent, useRef, useState } from "react";
import { calls, useCall } from "../call/callStore";
import { Avatar } from "../components/Avatar";
import { Icon } from "../components/Icon";
import { useNexus } from "../lib/nexus";
import { useUi } from "../lib/ui";
import { CallPanel } from "./CallPanel";
import { Composer } from "./Composer";
import { GroupMembers } from "./GroupMembers";
import { MemberList, MemberListToggle } from "./MemberList";
import { VoiceLobby } from "./VoiceLobby";
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
  const callExpanded = useCall((s) => s.stageExpanded);
  const [replyTo, setReplyTo] = useState<Id | null>(null);
  const [dropped, setDropped] = useState<File[] | null>(null);
  const [dragging, setDragging] = useState(false);
  // dragenter/leave fire for every child; count them to know when we left.
  const depth = useRef(0);
  const onDragEnter = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth.current++;
    setDragging(true);
  };
  const onDragLeave = () => {
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragging(false);
  };
  const onDrop = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth.current = 0;
    setDragging(false);
    if (!blocked && e.dataTransfer.files.length) setDropped(Array.from(e.dataTransfer.files));
  };
  const [showMembers, setShowMembers] = useState(false);
  const server = useNexus((s) => (conv?.server_id ? s.servers[conv.server_id] : undefined));
  const showServerMembers = useUi((s) => s.memberList);
  if (!conv) return null;
  const channel = isChannel(conv);
  const canSend = !channel || hasPermission(conv.permissions, Permissions.SEND_MESSAGES);

  const inThisCall = myCallConv === conversationId;
  const startCall = async (video: boolean) => {
    if (activeCall) await calls.join(activeCall.id);
    else await calls.start(conversationId);
    if (video) await calls.setCamera(true);
  };

  const subtitle =
    conv.kind === "text"
      ? conv.topic || ""
      : conv.kind === "voice"
        ? `Canal de voz${server ? ` · ${server.name}` : ""}`
        : conv.kind === "group"
          ? `${conv.members.length} membros`
          : presence === "online"
            ? "Online"
            : presence === "idle"
              ? "Ausente"
              : presence === "dnd"
                ? "Não perturbe"
                : "Offline";
  const aside =
    showMembers && conv.kind === "group" ? (
      <GroupMembers conversationId={conversationId} />
    ) : server && conv.kind === "text" && showServerMembers ? (
      <MemberList server={server} />
    ) : null;

  return (
    <section className={`chat${inThisCall && callExpanded ? " call-expanded" : ""}`}>
      <div className="chat-main">
        <header className="header">
          {conv.kind === "dm" ? (
            <Avatar user={peerUser ?? peer} size={34} presence={presence} />
          ) : (
            <span className="header-icon">
              <Icon name={conv.kind === "voice" ? "volume" : "hash"} size={18} />
            </span>
          )}
          <div className="header-titles">
            <h2>{title}</h2>
            {subtitle && (
              <small className="header-topic" title={subtitle}>
                {subtitle}
              </small>
            )}
          </div>
          <div className="header-actions">
            {callsEnabled && !channel && !inThisCall && !blocked && (
              <>
                <button type="button" className="icon-btn" title="Chamada de voz" onClick={() => void startCall(false)}>
                  <Icon name="phone" />
                </button>
                <button type="button" className="icon-btn" title="Chamada de vídeo" onClick={() => void startCall(true)}>
                  <Icon name="video" />
                </button>
              </>
            )}
            {conv.kind === "text" && <MemberListToggle />}
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

        {conv.kind === "voice" ? (
          inThisCall ? (
            <CallPanel solo />
          ) : (
            <VoiceLobby channel={conv} />
          )
        ) : inThisCall ? (
          <CallPanel />
        ) : null}

        {conv.kind !== "voice" && (
          <div
            className="chat-column"
            onDragEnter={onDragEnter}
            onDragOver={(e) => {
              if (hasFiles(e)) e.preventDefault();
            }}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
          >
            {dragging && !blocked && (
              <div className="drop-overlay">
                <div className="drop-card">
                  <Icon name="paperclip" size={28} />
                  <strong>Solte para enviar</strong>
                  <span>em {title}</span>
                </div>
              </div>
            )}
            {!inThisCall && activeCall && activeCall.participants.length > 0 && (
              <div className="join-bar">
                <Icon name="volume" size={18} />
                <span className="join-bar-text">
                  <strong>Chamada em andamento</strong>
                  <small>
                    {activeCall.participants.length} {activeCall.participants.length === 1 ? "pessoa" : "pessoas"} na chamada
                  </small>
                </span>
                <button type="button" className="btn primary small" onClick={() => void calls.join(activeCall.id)}>
                  Entrar
                </button>
              </div>
            )}
            <MessageList conversationId={conversationId} onReply={setReplyTo} />
            <TypingIndicator conversationId={conversationId} />
            {blocked ? (
              <div className="composer disabled">Você bloqueou este usuário.</div>
            ) : !canSend ? (
              <div className="composer disabled">
                <Icon name="lock" size={14} /> Você não tem permissão para enviar mensagens em #{conv.name}.
              </div>
            ) : (
              <Composer
                conversationId={conversationId}
                replyTo={replyTo}
                onClearReply={() => setReplyTo(null)}
                dropped={dropped}
                onDroppedTaken={() => setDropped(null)}
              />
            )}
          </div>
        )}
      </div>
      {aside}
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
          <span className="typing-dot" />
          {names} {names.includes(",") ? "estão digitando…" : "está digitando…"}
        </>
      )}
    </div>
  );
}


function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes("Files");
}
