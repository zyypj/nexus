import { Fragment, type ReactNode } from "react";
import { openExternal } from "./platform";

const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;
const INLINE_RE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|~~[^~\n]+~~)/g;

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const tok = m[0];
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const k = `${key}-${i++}`;
    if (tok.startsWith("`")) out.push(<code key={k}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith("**")) out.push(<strong key={k}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("~~")) out.push(<s key={k}>{tok.slice(2, -2)}</s>);
    else out.push(<em key={k}>{tok.slice(1, -1)}</em>);
    last = at + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * Minimal, XSS-free formatting: links, `code`, **bold**, *italic*, ~~strike~~
 * and ``` blocks. Everything is rendered as React text nodes; no HTML parsing.
 */
export function RichText({ text }: { text: string }) {
  const blocks = text.split(/```/);
  return (
    <>
      {blocks.map((block, bi) =>
        bi % 2 === 1 ? (
          <pre key={bi}>
            <code>{block.replace(/^\w*\n/, "")}</code>
          </pre>
        ) : (
          <Fragment key={bi}>{linkify(block, `b${bi}`)}</Fragment>
        ),
      )}
    </>
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
