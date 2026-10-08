import { type Attachment, type Id, Permissions, hasPermission } from "@nexus/protocol";
import { type ClientMessage, formatBytes, formatDay, formatTime, memberColor, memberName, sameDay } from "@nexus/shared";
import { QUICK_REACTIONS } from "@nexus/ui";
import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Avatar } from "../components/Avatar";
import { type MenuEntry, openContextMenu } from "../components/ContextMenu";
import { Icon } from "../components/Icon";
import { AudioPlayer, VideoPlayer, mediaKind } from "../components/MediaPlayers";
import { openProfile } from "../lib/dialogs";
import { client, useNexus } from "../lib/nexus";
import { openExternal } from "../lib/platform";
import { RichText } from "../lib/richText";
import { userMenu } from "./menus";

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
  // Server channels: nickname, role color and per-channel permissions.
  const channelPerms = useNexus((s) => s.conversations[m.conversation_id]?.permissions);
  const authorName = useNexus((s) => {
    const sid = s.conversations[m.conversation_id]?.server_id;
    return sid ? memberName(s, s.servers[sid], m.author_id) : (s.users[m.author_id]?.display_name ?? "Usuário");
  });
  const authorColor = useNexus((s) => {
    const sid = s.conversations[m.conversation_id]?.server_id;
    const sv = sid ? s.servers[sid] : undefined;
    return sv ? memberColor(sv, m.author_id) : undefined;
  });
  const canReact = channelPerms === undefined || hasPermission(channelPerms, Permissions.ADD_REACTIONS);
  const canModerate = channelPerms !== undefined && hasPermission(channelPerms, Permissions.MANAGE_MESSAGES);
  const authorBlocked = useNexus((s) => !!s.blocked[m.author_id]);
  const replyAuthor = useNexus((s) => (m.reply_to ? s.users[m.reply_to.author_id]?.display_name : undefined));
  const [editing, setEditing] = useState(false);
  const [picker, setPicker] = useState<HTMLElement | null>(null);
  const [revealed, setRevealed] = useState(false);
  const mine = m.author_id === myId;
  const serverId = useNexus((s) => s.conversations[m.conversation_id]?.server_id ?? null);
  const canDelete = mine || isOwner || canModerate;
  const remove = () => confirm("Apagar esta mensagem?") && void client().deleteMessage(m.conversation_id, m.id);

  const messageMenu = (e: React.MouseEvent) => {
    if (m.local) return;
    // Selected text inside the message: copy the selection, not the whole text.
    const selection = window.getSelection()?.toString() ?? "";
    openContextMenu(e, (): MenuEntry[] => [
      canReact && {
        reactions: QUICK_REACTIONS,
        pick: (emoji) => void client().toggleReaction(m.conversation_id, m.id, emoji),
      },
      { label: "Responder", icon: "reply", run: () => onReply(m.id) },
      mine && !!m.content && { label: "Editar mensagem", icon: "edit", run: () => setEditing(true) },
      (!!selection || !!m.content) && {
        label: selection ? "Copiar seleção" : "Copiar texto",
        icon: "copy",
        run: () => void navigator.clipboard.writeText(selection || m.content).catch(() => undefined),
      },
      canDelete && { separator: true },
      canDelete && { label: "Apagar mensagem", icon: "trash", danger: true, run: remove },
    ]);
  };
  const authorProfile = (e: React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    openProfile({ userId: m.author_id, serverId, x: r.right, y: r.top });
  };
  const authorMenu = (e: React.MouseEvent) => {
    const at = { x: e.clientX, y: e.clientY };
    openContextMenu(e, () => userMenu(m.author_id, at, serverId));
  };

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
    <div
      className={`message${compact ? " compact" : ""}${m.local ? ` local ${m.local}` : ""}${picker ? " picking" : ""}`}
      onContextMenu={messageMenu}
    >
      {!compact && (
        <button type="button" className="author-avatar" onClick={authorProfile} onContextMenu={authorMenu} aria-label="Ver perfil">
          <Avatar user={author} size={38} />
        </button>
      )}
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
            <button
              type="button"
              className="author-name"
              style={authorColor ? { color: authorColor } : undefined}
              onClick={authorProfile}
              onContextMenu={authorMenu}
            >
              {authorName}
            </button>
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
          {canReact && (
            <button type="button" className="icon-btn small" title="Reagir" onClick={(e) => {
                const btn = e.currentTarget;
                setPicker((p) => (p ? null : btn));
              }}
            >
              <Icon name="smile" size={16} />
            </button>
          )}
          <button type="button" className="icon-btn small" title="Responder" onClick={() => onReply(m.id)}>
            <Icon name="reply" size={16} />
          </button>
          {mine && (
            <button type="button" className="icon-btn small" title="Editar" onClick={() => setEditing(true)}>
              <Icon name="edit" size={16} />
            </button>
          )}
          {canDelete && (
            <button type="button" className="icon-btn small danger" title="Apagar" onClick={remove}>
              <Icon name="trash" size={16} />
            </button>
          )}
          {picker && (
            <ReactionPicker
              anchor={picker}
              onClose={() => setPicker(null)}
              onPick={(e) => {
                setPicker(null);
                void client().toggleReaction(m.conversation_id, m.id, e);
              }}
            />
          )}
        </div>
      )}
    </div>
  );
});

/**
 * Quick reactions, rendered in a portal so the scrolling message list never
 * clips it. Opens below the button, or above it when there is no room.
 */
function ReactionPicker({
  anchor,
  onPick,
  onClose,
}: { anchor: HTMLElement; onPick: (emoji: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; up: boolean } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const a = anchor.getBoundingClientRect();
    const margin = 8;
    const below = a.bottom + 6;
    const up = below + el.offsetHeight + margin > window.innerHeight;
    setPos({
      left: Math.min(Math.max(margin, a.right - el.offsetWidth), window.innerWidth - el.offsetWidth - margin),
      top: up ? Math.max(margin, a.top - el.offsetHeight - 6) : below,
      up,
    });
  }, [anchor]);

  // Latest onClose without re-subscribing on every render.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !anchor.contains(t)) close.current();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && close.current();
    const dismiss = () => close.current();
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    document.addEventListener("scroll", dismiss, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
      document.removeEventListener("scroll", dismiss, true);
    };
  }, [anchor]);

  return createPortal(
    <div
      ref={ref}
      className={`emoji-picker${pos?.up ? " up" : ""}`}
      role="menu"
      style={pos ? { left: pos.left, top: pos.top } : { visibility: "hidden" }}
    >
      {QUICK_REACTIONS.map((e) => (
        <button type="button" role="menuitem" key={e} title={`Reagir com ${e}`} onClick={() => onPick(e)}>
          {e}
        </button>
      ))}
    </div>,
    document.body,
  );
}

/**
 * Full-window image viewer. Portaled to <body>: the message list uses
 * `contain: strict` and transformed rows, which would otherwise trap a fixed
 * overlay inside the list (under the call panel and later messages).
 */
function Lightbox({ url, alt, onClose }: { url: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return createPortal(
    <div className="lightbox" role="dialog" aria-label={alt} onClick={onClose}>
      <img src={url} alt={alt} />
    </div>,
    document.body,
  );
}

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
        {zoom && <Lightbox url={url} alt={a.file_name} onClose={() => setZoom(false)} />}
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
