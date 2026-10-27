import type { Id } from "@nexus/protocol";
import { type MentionPart, mentionRoleName, mentionUserName, splitMentions } from "@nexus/shared";
import { Fragment, type ReactNode, createContext, useContext } from "react";
import { openProfile } from "./dialogs";
import { useNexus } from "./nexus";
import { openExternal } from "./platform";

/** Server of the text being rendered (nicknames and roles of mentions). */
const ServerCtx = createContext<Id | null>(null);

function Mention({ part }: { part: Exclude<MentionPart, { type: "text" }> }) {
  const serverId = useContext(ServerCtx);
  const label = useNexus((s) =>
    part.type === "user"
      ? mentionUserName(s, serverId, part.id)
      : part.type === "role"
        ? mentionRoleName(s, serverId, part.id)
        : part.word,
  );
  const color = useNexus((s) => {
    if (part.type !== "role" || !serverId) return undefined;
    const c = s.servers[serverId]?.roles.find((r) => r.id === part.id)?.color;
    return c ? `#${c.toString(16).padStart(6, "0")}` : undefined;
  });
  if (part.type === "user") {
    return (
      <button
        type="button"
        className="mention"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          openProfile({ userId: part.id, serverId, x: r.right, y: r.top });
        }}
      >
        @{label}
      </button>
    );
  }
  return (
    <span className="mention" style={color ? { color, background: `${color}26` } : undefined}>
      @{label}
    </span>
  );
}

/** Plain text with mentions as chips. */
function mentionify(text: string, key: string): ReactNode[] {
  if (!text.includes("@")) return [text];
  return splitMentions(text).map((p, i) =>
    p.type === "text" ? p.text : <Mention key={`${key}-m${i}`} part={p} />,
  );
}

const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;
const INLINE_RE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|~~[^~\n]+~~)/g;

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const tok = m[0];
    const at = m.index ?? 0;
    if (at > last) out.push(...mentionify(text.slice(last, at), `${key}-p${i}`));
    const k = `${key}-${i++}`;
    if (tok.startsWith("`")) out.push(<code key={k}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith("**")) out.push(<strong key={k}>{mentionify(tok.slice(2, -2), k)}</strong>);
    else if (tok.startsWith("~~")) out.push(<s key={k}>{mentionify(tok.slice(2, -2), k)}</s>);
    else out.push(<em key={k}>{mentionify(tok.slice(1, -1), k)}</em>);
    last = at + tok.length;
  }
  if (last < text.length) out.push(...mentionify(text.slice(last), `${key}-end`));
  return out;
}

/**
 * Minimal, XSS-free formatting: links, `code`, **bold**, *italic*, ~~strike~~,
 * ``` blocks and mentions. Everything is rendered as React text nodes; no
 * HTML parsing.
 */
export function RichText({ text, serverId = null }: { text: string; serverId?: Id | null }) {
  const blocks = text.split(/```/);
  return (
    <ServerCtx.Provider value={serverId}>
      {blocks.map((block, bi) =>
        bi % 2 === 1 ? (
          <pre key={bi}>
            <code>{block.replace(/^\w*\n/, "")}</code>
          </pre>
        ) : (
          <Fragment key={bi}>{linkify(block, `b${bi}`)}</Fragment>
        ),
      )}
    </ServerCtx.Provider>
  );
}

function linkify(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(URL_RE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(...inline(text.slice(last, at), `${key}-t${i}`));
    const url = m[0];
    out.push(
      <a
        key={`${key}-l${i}`}
        href={url}
        onClick={(e) => {
          e.preventDefault();
          void openExternal(url);
        }}
      >
        {url}
      </a>,
    );
    last = at + url.length;
    i++;
  }
  if (last < text.length) out.push(...inline(text.slice(last), `${key}-end`));
  return out;
}
