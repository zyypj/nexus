// Mentions, Discord syntax: `<@user id>`, `<@&role id>`, `@everyone`, `@here`.
// The server parses the same syntax (services/server/src/mentions.rs) and
// sends the result on each message (`mentions`, `mention_roles`,
// `mention_everyone`). Here: rendering, "does it mention me?" and turning the
// composer's readable `@Name` back into tokens.

import { type ConversationView, type Id, type Message, Permissions, hasPermission, isChannel } from "@nexus/protocol";
import type { NexusState } from "./store";

export type MentionPart =
  | { type: "text"; text: string }
  | { type: "user"; id: Id }
  | { type: "role"; id: Id }
  | { type: "everyone"; word: "everyone" | "here" };

// No lookbehind (Hermes): the leading character is captured and kept as text.
const MENTION_RE = /<@(&?)([0-9a-f-]{36})>|(^|[^\w])@(everyone|here)(?!\w)/g;

/** Splits plain text into text and mention parts (the caller skips code). */
export function splitMentions(text: string): MentionPart[] {
  const out: MentionPart[] = [];
  let last = 0;
  for (const m of text.matchAll(MENTION_RE)) {
    let at = m.index ?? 0;
    if (m[4]) at += m[3]?.length ?? 0;
    if (at > last) out.push({ type: "text", text: text.slice(last, at) });
    if (m[4]) out.push({ type: "everyone", word: m[4] as "everyone" | "here" });
    else if (m[1]) out.push({ type: "role", id: m[2] ?? "" });
    else out.push({ type: "user", id: m[2] ?? "" });
    last = (m.index ?? 0) + m[0].length;
  }
  if (last < text.length) out.push({ type: "text", text: text.slice(last) });
  return out;
}

/** Display name of a user in a conversation (server nickname first). */
export function mentionUserName(s: NexusState, serverId: Id | null | undefined, userId: Id): string {
  const server = serverId ? s.servers[serverId] : undefined;
  const nick = server?.members.find((m) => m.user.id === userId)?.nickname;
  return nick || s.users[userId]?.display_name || "usuário-desconhecido";
}

export function mentionRoleName(s: NexusState, serverId: Id | null | undefined, roleId: Id): string {
  const server = serverId ? s.servers[serverId] : undefined;
  return server?.roles.find((r) => r.id === roleId)?.name ?? "cargo-desconhecido";
}

/** The text with `<@id>` tokens as readable `@Name` (notifications, previews). */
export function mentionsToText(s: NexusState, serverId: Id | null | undefined, text: string): string {
  if (!text.includes("<@")) return text;
  return text.replace(/<@(&?)([0-9a-f-]{36})>/g, (_, role: string, id: string) =>
    role ? `@${mentionRoleName(s, serverId, id)}` : `@${mentionUserName(s, serverId, id)}`,
  );
}

/** Whether a message mentions the current user (directly, a role, @everyone/@here). */
export function mentionsMe(s: NexusState, m: Pick<Message, "author_id" | "conversation_id" | "mentions" | "mention_roles" | "mention_everyone">): boolean {
  const me = s.me?.id;
  if (!me || m.author_id === me) return false;
  if (m.mention_everyone || m.mentions?.includes(me)) return true;
  if (!m.mention_roles?.length) return false;
  const serverId = s.conversations[m.conversation_id]?.server_id;
  const member = serverId ? s.servers[serverId]?.members.find((x) => x.user.id === me) : undefined;
  return !!member && m.mention_roles.some((r) => member.role_ids.includes(r));
}

/** Red badge count of a conversation (servers older than 0.5 lack mention_count). */
export function badgeCount(c: ConversationView): number {
  return c.mention_count ?? (isChannel(c) ? 0 : c.unread_count);
}

// ---- composer ----

export interface MentionCandidate {
  kind: "user" | "role" | "everyone";
  /** User/role id; "everyone" | "here" for the special ones. */
  id: string;
  /** What is shown and inserted after "@". */
  label: string;
  /** Secondary text: username, or a description. */
  hint: string;
  /** Role color "#rrggbb" for roles/users with a colored role. */
  color?: string;
  /** The token sent to the server. */
  token: string;
}

const hex = (c: number) => `#${c.toString(16).padStart(6, "0")}`;

/** Who/what can be mentioned in a conversation, for the "@" popup. */
export function mentionCandidates(s: NexusState, conversationId: Id): MentionCandidate[] {
  const conv = s.conversations[conversationId];
  if (!conv) return [];
  const out: MentionCandidate[] = [];
  const server = conv.server_id ? s.servers[conv.server_id] : undefined;
  if (server) {
    for (const m of server.members) {
      const role = server.roles.find((r) => r.color !== 0 && m.role_ids.includes(r.id));
      out.push({
        kind: "user",
        id: m.user.id,
        label: m.nickname || s.users[m.user.id]?.display_name || m.user.display_name,
        hint: s.users[m.user.id]?.username ?? m.user.username,
        color: role ? hex(role.color) : undefined,
        token: `<@${m.user.id}>`,
      });
    }
    for (const r of server.roles) {
      if (r.id === server.id) continue;
      out.push({ kind: "role", id: r.id, label: r.name, hint: "Cargo", color: r.color ? hex(r.color) : undefined, token: `<@&${r.id}>` });
    }
    if (hasPermission(conv.permissions, Permissions.MENTION_EVERYONE)) {
      out.push({ kind: "everyone", id: "everyone", label: "everyone", hint: "Notifica todos que podem ver este canal", token: "@everyone" });
      out.push({ kind: "everyone", id: "here", label: "here", hint: "Notifica quem está online agora", token: "@here" });
    }
  } else {
    for (const u of conv.members) {
      const user = s.users[u.id] ?? u;
      out.push({ kind: "user", id: u.id, label: user.display_name, hint: user.username, token: `<@${u.id}>` });
    }
  }
  return out;
}

/** Candidates matching what was typed after "@" (best matches first). */
export function filterCandidates(list: MentionCandidate[], query: string, max = 10): MentionCandidate[] {
  const q = query.toLowerCase();
  const score = (c: MentionCandidate): number => {
    const label = c.label.toLowerCase();
    const hint = c.hint.toLowerCase();
    if (!q) return 1;
    if (label.startsWith(q) || (c.kind === "user" && hint.startsWith(q))) return 3;
    if (label.split(/\s+/).some((w) => w.startsWith(q))) return 2;
    if (label.includes(q) || (c.kind === "user" && hint.includes(q))) return 1;
    return 0;
  };
  const kindOrder = { user: 0, role: 1, everyone: 2 } as const;
  return list
    .map((c) => ({ c, s: score(c) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || kindOrder[a.c.kind] - kindOrder[b.c.kind] || a.c.label.localeCompare(b.c.label))
    .slice(0, max)
    .map((x) => x.c);
}

/** Applies `fn` to the parts of the text outside ``` blocks and `inline code`. */
function outsideCode(text: string, fn: (t: string) => string): string {
  return text
    .split("```")
    .map((block, bi) =>
      bi % 2 === 1
        ? block
        : block.replace(/(`[^`\n]+`)|([^`]+|`)/g, (_m, code: string | undefined, plain: string | undefined) =>
            code ?? fn(plain ?? ""),
          ),
    )
    .join("```");
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Turns the composer's readable mentions into tokens: `@Label` for each
 * candidate (longest first, so "@Ana Paula" wins over "@Ana"), and
 * `@username` for users.
 */
export function encodeMentions(text: string, candidates: MentionCandidate[]): string {
  if (!text.includes("@")) return text;
  const labels = new Map<string, string>();
  for (const c of candidates) {
    if (c.kind === "everyone") continue;
    if (!labels.has(c.label.toLowerCase())) labels.set(c.label.toLowerCase(), c.token);
    if (c.kind === "user" && !labels.has(c.hint.toLowerCase())) labels.set(c.hint.toLowerCase(), c.token);
  }
  if (labels.size === 0) return text;
  const keys = [...labels.keys()].filter(Boolean).sort((a, b) => b.length - a.length);
  const re = new RegExp(`(^|[^\\w<])@(${keys.map(escapeRe).join("|")})(?![\\w])`, "giu");
  return outsideCode(text, (t) => t.replace(re, (_m, lead: string, name: string) => `${lead}${labels.get(name.toLowerCase()) ?? `@${name}`}`));
}

/** Tokens back to readable `@Name` for editing a message. */
export function decodeMentions(s: NexusState, conversationId: Id, text: string): string {
  return mentionsToText(s, s.conversations[conversationId]?.server_id, text);
}
