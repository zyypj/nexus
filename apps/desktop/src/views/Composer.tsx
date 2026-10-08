import { MAX_ATTACHMENTS, MAX_MESSAGE_LENGTH, type Id } from "@nexus/protocol";
import { formatBytes } from "@nexus/shared";
import { type ClipboardEvent, useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { client, useNexus } from "../lib/nexus";

interface Props {
  conversationId: Id;
  replyTo: Id | null;
  onClearReply: () => void;
  /** Files dropped anywhere on the conversation (ChatView). */
  dropped?: File[] | null;
  onDroppedTaken?: () => void;
}

/** Server error codes worth a clearer message than the raw API text. */
function sendError(e: unknown): string {
  const code = (e as { code?: string }).code;
  if (code === "insufficient_storage") return "O servidor está sem espaço em disco para este arquivo.";
  if (code === "payload_too_large") return "Arquivo maior que o limite configurado no servidor.";
  return (e as Error).message;
}

export function Composer({ conversationId, replyTo, onClearReply, dropped, onDroppedTaken }: Props) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // 0 = no limit (default since 0.1.2).
  const maxUpload = useNexus((s) => s.server?.max_upload_size ?? 0);
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
      if (f.size === 0) {
        // Folders and empty files: the server rejects them and the whole
        // message would fail.
        setError(`${f.name} está vazio (ou é uma pasta) e não pode ser enviado.`);
        continue;
      }
      if (maxUpload > 0 && f.size > maxUpload) {
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
      setError(sendError(e));
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: addFiles reads the latest state on purpose
  useEffect(() => {
    if (!dropped?.length) return;
    addFiles(dropped);
    onDroppedTaken?.();
    ref.current?.focus();
  }, [dropped]);

  const onPaste = (e: ClipboardEvent) => {
    if (e.clipboardData.files.length > 0) {
      e.preventDefault();
      addFiles(e.clipboardData.files);
    }
  };
  return (
    <div className="composer">
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
