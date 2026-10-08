import { MAX_ATTACHMENTS, MAX_MESSAGE_LENGTH, type Id } from "@nexus/protocol";
import { formatBytes } from "@nexus/shared";
import { type ClipboardEvent, type DragEvent, useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { client, useNexus } from "../lib/nexus";

interface Props {
  conversationId: Id;
  replyTo: Id | null;
  onClearReply: () => void;
}

export function Composer({ conversationId, replyTo, onClearReply }: Props) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const maxUpload = useNexus((s) => s.server?.max_upload_size ?? 25 * 1024 * 1024);
  const reply = useNexus((s) =>
    replyTo ? s.messages[conversationId]?.items.find((m) => m.id === replyTo) : undefined,
  );
  const replyAuthor = useNexus((s) => (reply ? s.users[reply.author_id]?.display_name : undefined));
  const lastOwn = useNexus((s) => {
    const items = s.messages[conversationId]?.items ?? [];
    for (let i = items.length - 1; i >= 0; i--) {
      const m = items[i];
      if (m && m.author_id === s.me?.id && !m.local) return m;
    }
    return undefined;
  });

  useEffect(() => {
    ref.current?.focus();
  }, [conversationId, replyTo]);

  // Auto-grow up to ~10 lines without a resize observer.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  function addFiles(list: FileList | File[]) {
    setError(null);
    const next = [...files];
    for (const f of Array.from(list)) {
      if (f.size > maxUpload) {
        setError(`${f.name} é maior que o limite de ${formatBytes(maxUpload)}.`);
        continue;
      }
      if (next.length >= MAX_ATTACHMENTS) {
        setError(`No máximo ${MAX_ATTACHMENTS} anexos por mensagem.`);
        break;
      }
      next.push(f);
    }
    setFiles(next);
  }

  async function send() {
    const content = text.trim();
    if (!content && files.length === 0) return;
    if (content.length > MAX_MESSAGE_LENGTH) {
      setError(`Mensagem muito longa (máx. ${MAX_MESSAGE_LENGTH} caracteres).`);
      return;
    }
    const toSend = files;
    setText("");
    setFiles([]);
    onClearReply();
    try {
      await client().sendMessage(conversationId, content, {
        replyTo,
        files: toSend.map((f) => ({ file: f, name: f.name })),
      });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const onPaste = (e: ClipboardEvent) => {
    if (e.clipboardData.files.length > 0) {
      e.preventDefault();
      addFiles(e.clipboardData.files);
    }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  };

  return (
    <div
      className={`composer${dragging ? " dragging" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      {reply && (
        <div className="composer-reply">
          <Icon name="reply" size={14} />
          Respondendo a <strong>{replyAuthor}</strong>: {reply.content.slice(0, 80) || "Anexo"}
          <button type="button" className="icon-btn small" onClick={onClearReply}>
            <Icon name="x" size={14} />
          </button>
        </div>
      )}
      {files.length > 0 && (
        <div className="composer-files">
          {files.map((f, i) => (
            <span key={`${f.name}-${i}`} className="chip">
              {f.name} <small>{formatBytes(f.size)}</small>
              <button type="button" onClick={() => setFiles(files.filter((_, j) => j !== i))} aria-label="Remover">
                <Icon name="x" size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      {error && <div className="form-error">{error}</div>}
      <div className="composer-row">
        <button type="button" className="icon-btn" title="Anexar arquivo" onClick={() => fileInput.current?.click()}>
          <Icon name="paperclip" />
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder="Escreva uma mensagem"
          maxLength={MAX_MESSAGE_LENGTH}
          onPaste={onPaste}
          onChange={(e) => {
            setText(e.target.value);
            if (e.target.value) client().typing(conversationId);
            else client().stopTyping(conversationId);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            } else if (e.key === "ArrowUp" && !text && lastOwn) {
              // Quick edit of the last own message.
              e.preventDefault();
              const next = prompt("Editar mensagem", lastOwn.content);
              if (next !== null && next.trim() !== lastOwn.content)
                void client().editMessage(conversationId, lastOwn.id, next.trim());
            } else if (e.key === "Escape" && replyTo) onClearReply();
          }}
        />
        <button type="button" className="icon-btn" title="Enviar" onClick={() => void send()}>
          <Icon name="send" />
        </button>
      </div>
    </div>
  );
}
