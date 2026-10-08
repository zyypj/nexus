import type { Attachment, Id } from "@nexus/protocol";
import { type ClientMessage, formatBytes, formatDay, formatTime, sameDay } from "@nexus/shared";
import { QUICK_REACTIONS } from "@nexus/ui";
import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Avatar } from "../components/Avatar";
import { Icon } from "../components/Icon";
import { AudioPlayer, VideoPlayer, mediaKind } from "../components/MediaPlayers";
import { client, useNexus } from "../lib/nexus";
import { openExternal } from "../lib/platform";
import { RichText } from "../lib/richText";

const GROUP_WINDOW_MS = 5 * 60_000;
const EMPTY: ClientMessage[] = [];

/**
 * Virtualized: only the visible messages (plus a small overscan) exist in the
 * DOM, so long histories cost no memory or layout time.
 */
export function MessageList({ conversationId, onReply }: { conversationId: Id; onReply: (id: Id) => void }) {
  const items = useNexus((s) => s.messages[conversationId]?.items ?? EMPTY);
  const hasMore = useNexus((s) => s.messages[conversationId]?.hasMore ?? false);
  const loading = useNexus((s) => s.messages[conversationId]?.loading ?? false);
  const loaded = useNexus((s) => s.messages[conversationId]?.loaded ?? false);
  const parentRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const firstId = useRef<string | undefined>(undefined);
  const prevCount = useRef(0);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 48,
    overscan: 8,
    getItemKey: (i) => items[i]?.id ?? i,
  });

  // Keep the view pinned to the newest message unless the user scrolled up;
  // keep the reading position when older history is prepended.
  useLayoutEffect(() => {
    const count = items.length;
    const newFirst = items[0]?.id;
    if (count === 0) return;
    if (firstId.current && newFirst !== firstId.current && count > prevCount.current) {
      const added = items.findIndex((m) => m.id === firstId.current);
      if (added > 0) virtualizer.scrollToIndex(added, { align: "start" });
    } else if (atBottom.current) {
      virtualizer.scrollToIndex(count - 1, { align: "end" });
    }
    firstId.current = newFirst;
    prevCount.current = count;
  }, [items, virtualizer]);

  const onScroll = () => {
    const el = parentRef.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 300 && hasMore && !loading) void client().loadOlder(conversationId);
  };

  return (
    <div className="messages" ref={parentRef} onScroll={onScroll}>
      {!loaded && <div className="messages-loading">Carregando…</div>}
      {loaded && !hasMore && items.length === 0 && (
        <div className="messages-empty">Nenhuma mensagem ainda. Diga oi! 👋</div>
      )}
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((row) => {
          const m = items[row.index];
          if (!m) return null;
          const prev = items[row.index - 1];
          const newDay = !prev || !sameDay(prev.created_at, m.created_at);
          const compact =
            !newDay && !!prev && prev.author_id === m.author_id && m.created_at - prev.created_at < GROUP_WINDOW_MS && !m.reply_to;
          return (
            <div
              key={row.key}
              data-index={row.index}
              ref={virtualizer.measureElement}
              style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${row.start}px)` }}
            >
              {newDay && (
                <div className="day-separator">
                  <span>{formatDay(m.created_at)}</span>
                </div>
              )}
              <MessageItem message={m} compact={compact} onReply={onReply} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

const MessageItem = memo(function MessageItem({
  message: m,
  compact,
  onReply,
}: {
  message: ClientMessage;
  compact: boolean;
  onReply: (id: Id) => void;
}) {
  const author = useNexus((s) => s.users[m.author_id]);
  const myId = useNexus((s) => s.me?.id);
  const isOwner = useNexus((s) => s.conversations[m.conversation_id]?.owner_id === s.me?.id);
  const authorBlocked = useNexus((s) => !!s.blocked[m.author_id]);
  const replyAuthor = useNexus((s) => (m.reply_to ? s.users[m.reply_to.author_id]?.display_name : undefined));
  const [editing, setEditing] = useState(false);
  const [picker, setPicker] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const mine = m.author_id === myId;

  if (authorBlocked && !revealed) {
    return (
      <div className="message compact blocked">
        <button type="button" className="link" onClick={() => setRevealed(true)}>
          Mensagem de usuário bloqueado — mostrar
        </button>
      </div>
    );
  }

  return (
    <div className={`message${compact ? " compact" : ""}${m.local ? ` local ${m.local}` : ""}`}>
      {!compact && <Avatar user={author} size={38} />}
      {compact && <time className="gutter-time">{formatTime(m.created_at)}</time>}
      <div className="message-main">
        {m.reply_to && (
          <div className="reply-ref">
            <Icon name="reply" size={12} />
            <strong>{replyAuthor ?? "?"}</strong> {m.reply_to.content || "Anexo"}
          </div>
        )}
        {!compact && (
          <div className="message-head">
            <strong>{author?.display_name ?? "Usuário"}</strong>
            <time>{formatTime(m.created_at)}</time>
          </div>
        )}
        {editing ? (
          <EditBox message={m} onDone={() => setEditing(false)} />
        ) : (
          m.content && (
            <div className="message-text">
              <RichText text={m.content} />
              {m.edited_at && <small className="edited"> (editada)</small>}
            </div>
          )
        )}
        {m.attachments.length > 0 && (
          <div className="attachments">
            {m.attachments.map((a) => (
              <AttachmentView key={a.id} a={a} />
            ))}
          </div>
        )}
        {m.reactions.length > 0 && (
          <div className="reactions">
            {m.reactions.map((r) => (
              <button
                type="button"
                key={r.emoji}
                className={`reaction${myId && r.user_ids.includes(myId) ? " mine" : ""}`}
                onClick={() => void client().toggleReaction(m.conversation_id, m.id, r.emoji)}
              >
                {r.emoji} <span>{r.user_ids.length}</span>
              </button>
            ))}
          </div>
        )}
        {m.local === "sending" && m.upload && (
          <div className="upload-progress">
            <div className="upload-progress-text">
              Enviando {m.upload.file} · {Math.floor((m.upload.sent / Math.max(1, m.upload.total)) * 100)}% de{" "}
              {formatBytes(m.upload.total)}
            </div>
            <div className="upload-progress-bar">
              <div style={{ width: `${(m.upload.sent / Math.max(1, m.upload.total)) * 100}%` }} />
            </div>
          </div>
        )}
        {m.local === "failed" && (
          <div className="failed">
            Falha ao enviar.{" "}
            <button type="button" className="link" onClick={() => client().discardFailed(m.conversation_id, m.id)}>
              Descartar
            </button>
          </div>
        )}
      </div>
      {!m.local && !editing && (
        <div className="message-actions">
          <button type="button" className="icon-btn small" title="Reagir" onClick={() => setPicker((p) => !p)}>
            <Icon name="smile" size={16} />
          </button>
          <button type="button" className="icon-btn small" title="Responder" onClick={() => onReply(m.id)}>
            <Icon name="reply" size={16} />
          </button>
          {mine && (
            <button type="button" className="icon-btn small" title="Editar" onClick={() => setEditing(true)}>
              <Icon name="edit" size={16} />
            </button>
          )}
          {(mine || isOwner) && (
            <button
              type="button"
              className="icon-btn small danger"
              title="Apagar"
              onClick={() =>
                confirm("Apagar esta mensagem?") && void client().deleteMessage(m.conversation_id, m.id)
              }
            >
              <Icon name="trash" size={16} />
            </button>
          )}
          {picker && (
            <div className="emoji-picker" onMouseLeave={() => setPicker(false)}>
              {QUICK_REACTIONS.map((e) => (
                <button
                  type="button"
                  key={e}
                  onClick={() => {
                    setPicker(false);
                    void client().toggleReaction(m.conversation_id, m.id, e);
                  }}
                >
                  {e}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

function EditBox({ message, onDone }: { message: ClientMessage; onDone: () => void }) {
  const [text, setText] = useState(message.content);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, []);
  const save = async () => {
    if (text.trim() !== message.content) await client().editMessage(message.conversation_id, message.id, text.trim());
    onDone();
  };
  return (
    <div className="edit-box">
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void save();
          } else if (e.key === "Escape") onDone();
        }}
      />
      <small>Enter para salvar · Esc para cancelar</small>
    </div>
  );
}

function AttachmentView({ a }: { a: Attachment }) {
  const url = client().api.url(a.url) ?? "";
  const [zoom, setZoom] = useState(false);
  if (a.content_type.startsWith("image/")) {
    const w = a.width ?? 320;
    const h = a.height ?? 240;
    const scale = Math.min(1, 380 / w, 300 / h);
    return (
      <>
        <button type="button" className="attachment-image" onClick={() => setZoom(true)}>
          <img
            src={url}
            alt={a.file_name}
            width={Math.round(w * scale)}
            height={Math.round(h * scale)}
            loading="lazy"
            decoding="async"
          />
        </button>
        {zoom && (
          <div className="lightbox" onClick={() => setZoom(false)}>
            <img src={url} alt={a.file_name} />
          </div>
        )}
      </>
    );
  }
  const kind = mediaKind(a);
  if (kind === "video") return <VideoPlayer a={a} url={url} />;
  if (kind === "audio" || kind === "voice") return <AudioPlayer a={a} url={url} voice={kind === "voice"} />;
  return (
    <button type="button" className="attachment-file" onClick={() => void openExternal(url)}>
      <Icon name="file" size={28} />
      <span>
        <strong>{a.file_name}</strong>
        <small>{formatBytes(a.size)}</small>
      </span>
    </button>
  );
}
