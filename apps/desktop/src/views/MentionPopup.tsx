import type { Id } from "@nexus/protocol";
import { type MentionCandidate, encodeMentions, filterCandidates, mentionCandidates } from "@nexus/shared";
import { type KeyboardEvent, type RefObject, useMemo, useRef, useState } from "react";
import { Avatar } from "../components/Avatar";
import { Icon } from "../components/Icon";
import { client, useNexus } from "../lib/nexus";

/** "@query" right before the caret (no spaces, like Discord). */
const QUERY_RE = /(^|\s)@([^\s@]{0,32})$/;

/**
 * Discord-style "@" autocomplete for a textarea: typing "@" lists members,
 * roles and @everyone/@here; ↑/↓ choose, Enter/Tab insert, Esc closes. The
 * text keeps a readable "@Name"; `encode` turns it into `<@id>` on send.
 */
export function useMentions(
  conversationId: Id,
  ref: RefObject<HTMLTextAreaElement | null>,
  text: string,
  setText: (t: string) => void,
) {
  const [query, setQuery] = useState<{ start: number; q: string } | null>(null);
  const [index, setIndex] = useState(0);
  // Picked names win when two people share a display name.
  const picked = useRef(new Map<string, MentionCandidate>());
  // Esc hides the list until the caret leaves that "@" (selection events
  // would reopen it right away otherwise).
  const dismissed = useRef<number | null>(null);

  const items = useMemo(
    () =>
      query ? filterCandidates(mentionCandidates(client().store.getState(), conversationId), query.q) : [],
    [query, conversationId],
  );

  /** Re-reads the "@query" at the caret (after typing, clicks, arrows). */
  const sync = (value = ref.current?.value ?? text) => {
    const el = ref.current;
    const caret = el?.selectionStart ?? value.length;
    if (el && el.selectionEnd !== caret) return setQuery(null);
    const m = QUERY_RE.exec(value.slice(0, caret));
    if (!m) {
      dismissed.current = null;
      return setQuery(null);
    }
    const q = m[2] ?? "";
    const start = caret - q.length - 1;
    if (dismissed.current === start) return setQuery(null);
    dismissed.current = null;
    if (query && query.q === q && query.start === start) return;
    setQuery({ start, q });
    setIndex(0);
  };

  const pick = (c: MentionCandidate) => {
    if (!query) return;
    const el = ref.current;
    const caret = el?.selectionStart ?? text.length;
    const insert = `@${c.label} `;
    const next = text.slice(0, query.start) + insert + text.slice(caret);
    if (c.kind !== "everyone") picked.current.set(c.label.toLowerCase(), c);
    setText(next);
    setQuery(null);
    const pos = query.start + insert.length;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  };

  /** Call first in onKeyDown; true = the key was used by the popup. */
  const onKeyDown = (e: KeyboardEvent): boolean => {
    if (!query || items.length === 0) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const d = e.key === "ArrowDown" ? 1 : -1;
      setIndex((i) => (i + d + items.length) % items.length);
      return true;
    }
    if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
      e.preventDefault();
      const c = items[Math.min(index, items.length - 1)];
      if (c) pick(c);
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      dismissed.current = query.start;
      setQuery(null);
      return true;
    }
    return false;
  };

  const encode = (value: string): string => {
    const all = mentionCandidates(client().store.getState(), conversationId);
    return encodeMentions(value, [...picked.current.values(), ...all]);
  };

  const popup =
    query && items.length > 0 ? (
      <MentionList items={items} index={index} onHover={setIndex} onPick={pick} />
    ) : null;

  return { popup, onKeyDown, sync, encode, close: () => setQuery(null) };
}

function MentionList({
  items,
  index,
  onHover,
  onPick,
}: {
  items: MentionCandidate[];
  index: number;
  onHover: (i: number) => void;
  onPick: (c: MentionCandidate) => void;
}) {
  return (
    <div className="mention-popup" role="listbox">
      <div className="mention-popup-title">Membros</div>
      {items.map((c, i) => (
        <button
          type="button"
          key={`${c.kind}-${c.id}`}
          role="option"
          aria-selected={i === index}
          className={`mention-option${i === index ? " selected" : ""}`}
          onMouseEnter={() => onHover(i)}
          // mousedown: keeps the textarea focused.
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(c);
          }}
        >
          {c.kind === "user" ? <UserAvatar id={c.id} /> : <span className="mention-option-icon"><Icon name="at" size={14} /></span>}
          <span className="mention-option-label" style={c.color ? { color: c.color } : undefined}>
            {c.kind === "user" ? c.label : `@${c.label}`}
          </span>
          <span className="mention-option-hint">{c.hint}</span>
        </button>
      ))}
    </div>
  );
}

function UserAvatar({ id }: { id: Id }) {
  const user = useNexus((s) => s.users[id]);
  return <Avatar user={user} size={22} />;
}
