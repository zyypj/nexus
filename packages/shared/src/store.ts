import type {
  Call,
  ConversationView,
  Friend,
  FriendRequest,
  GatewayFrame,
  Id,
  Me,
  Message,
  Presence,
  PublicUser,
  ServerInfo,
} from "@nexus/protocol";
import { createStore } from "zustand/vanilla";
import type { GatewayState } from "./gateway";

/** Message as held by the client; `local` marks optimistic sends. */
export type ClientMessage = Message & { local?: "sending" | "failed" };

export interface MessageBucket {
  items: ClientMessage[];
  /** More history exists before items[0]. */
  hasMore: boolean;
  loaded: boolean;
  loading: boolean;
  /** Set after a reconnect: refetch before trusting the cache. */
  stale: boolean;
}

export interface NexusState {
  connection: GatewayState;
  me: Me | null;
  server: ServerInfo | null;
  users: Record<Id, PublicUser>;
  presences: Record<Id, Presence>;
  friends: Record<Id, Friend>;
  incoming: FriendRequest[];
  outgoing: FriendRequest[];
  blocked: Record<Id, PublicUser>;
  conversations: Record<Id, ConversationView>;
  messages: Record<Id, MessageBucket>;
  /** conversation -> user -> expiry timestamp */
  typing: Record<Id, Record<Id, number>>;
  calls: Record<Id, Call>;
  activeConversationId: Id | null;
}

export const initialState = (): NexusState => ({
  connection: "idle",
  me: null,
  server: null,
  users: {},
  presences: {},
  friends: {},
  incoming: [],
  outgoing: [],
  blocked: {},
  conversations: {},
  messages: {},
  typing: {},
  calls: {},
  activeConversationId: null,
});

export const createNexusStore = () => createStore<NexusState>()(() => initialState());
export type NexusStore = ReturnType<typeof createNexusStore>;

/** Max messages kept per inactive conversation; older ones are reloaded on demand. */
export const BUCKET_LIMIT = 300;
export const TYPING_TTL_MS = 10_000;

export const emptyBucket = (): MessageBucket => ({
  items: [],
  hasMore: true,
  loaded: false,
  loading: false,
  stale: false,
});

function indexUsers(users: Record<Id, PublicUser>, list: PublicUser[]): Record<Id, PublicUser> {
  let next = users;
  for (const u of list) {
    const prev = next[u.id];
    if (
      !prev ||
      prev.display_name !== u.display_name ||
      prev.avatar_url !== u.avatar_url ||
      prev.bio !== u.bio ||
      prev.username !== u.username
    ) {
      if (next === users) next = { ...users };
      next[u.id] = { id: u.id, username: u.username, display_name: u.display_name, avatar_url: u.avatar_url, bio: u.bio };
    }
  }
  return next;
}

/** Inserts or replaces by id, keeping ascending id order (UUIDv7 = time order). */
export function upsertMessage(items: ClientMessage[], msg: ClientMessage): ClientMessage[] {
  const idx = items.findIndex((m) => m.id === msg.id);
  if (idx >= 0) {
    const next = items.slice();
    next[idx] = msg;
    return next;
  }
  const last = items[items.length - 1];
  if (!last || last.id < msg.id || last.local) {
    // Common case: newest message. Optimistic (local) items stay at the end.
    const firstLocal = items.findIndex((m) => m.local);
    if (firstLocal === -1 || msg.local) return [...items, msg];
    return [...items.slice(0, firstLocal), msg, ...items.slice(firstLocal)];
  }
  const next = items.slice();
  let i = next.length;
  while (i > 0 && (next[i - 1] as ClientMessage).id > msg.id) i--;
  next.splice(i, 0, msg);
  return next;
}

function updateBucket(
  s: NexusState,
  conversationId: Id,
  fn: (b: MessageBucket) => MessageBucket,
): Record<Id, MessageBucket> | undefined {
  const bucket = s.messages[conversationId];
  if (!bucket) return undefined;
  const next = fn(bucket);
  return next === bucket ? undefined : { ...s.messages, [conversationId]: next };
}

function mutateMessage(
  s: NexusState,
  conversationId: Id,
  messageId: Id,
  fn: (m: ClientMessage) => ClientMessage,
): Partial<NexusState> {
  const messages = updateBucket(s, conversationId, (b) => {
    const idx = b.items.findIndex((m) => m.id === messageId);
    if (idx < 0) return b;
    const items = b.items.slice();
    items[idx] = fn(items[idx] as ClientMessage);
    return { ...b, items };
  });
  return messages ? { messages } : {};
}

export function isFromOther(s: NexusState, m: Message): boolean {
  return m.author_id !== s.me?.id;
}

/**
 * Pure reducer for gateway dispatches. Returns a partial state to merge.
 * Side effects (acks, notifications, refetches) live in NexusClient.
 */
export function applyFrame(s: NexusState, frame: GatewayFrame, now = Date.now()): Partial<NexusState> {
  switch (frame.t) {
    case "READY": {
      const d = frame.d;
      let users = indexUsers({}, [d.user]);
      users = indexUsers(users, d.relationships.friends.map((f) => f.user));
      users = indexUsers(users, d.relationships.blocked);
      users = indexUsers(users, d.relationships.incoming.map((r) => r.from));
      users = indexUsers(users, d.relationships.outgoing.map((r) => r.to));
      const conversations: Record<Id, ConversationView> = {};
      for (const c of d.conversations) {
        conversations[c.id] = c;
        users = indexUsers(users, c.members);
      }
      const presences: Record<Id, Presence> = {};
      for (const p of d.presences) presences[p.user_id] = p.status;
      const calls: Record<Id, Call> = {};
      for (const c of d.calls) calls[c.id] = c;
      const friends: Record<Id, Friend> = {};
      for (const f of d.relationships.friends) friends[f.user.id] = f;
      const blocked: Record<Id, PublicUser> = {};
      for (const b of d.relationships.blocked) blocked[b.id] = b;
      // Cached history may have missed edits/deletes while offline.
      const messages: Record<Id, MessageBucket> = {};
      for (const [id, b] of Object.entries(s.messages)) {
        if (conversations[id]) messages[id] = { ...b, stale: true, loading: false };
      }
      return {
        me: d.user,
        server: d.server,
        users,
        presences,
        friends,
        incoming: d.relationships.incoming,
        outgoing: d.relationships.outgoing,
        blocked,
        conversations,
        calls,
        messages,
        typing: {},
        activeConversationId:
          s.activeConversationId && conversations[s.activeConversationId] ? s.activeConversationId : null,
      };
    }

    case "MESSAGE_CREATE": {
      const m = frame.d;
      const conv = s.conversations[m.conversation_id];
      const out: Partial<NexusState> = {};
      const bucket = s.messages[m.conversation_id];
      if (bucket?.loaded) {
        // Replace the optimistic copy carrying the same nonce.
        let items = m.nonce ? bucket.items.filter((x) => !(x.local && x.nonce === m.nonce)) : bucket.items;
        const { nonce: _nonce, ...clean } = m;
        items = upsertMessage(items, clean);
        if (items.length > BUCKET_LIMIT && s.activeConversationId !== m.conversation_id) {
          items = items.slice(items.length - BUCKET_LIMIT);
          out.messages = { ...s.messages, [m.conversation_id]: { ...bucket, items, hasMore: true } };
        } else {
          out.messages = { ...s.messages, [m.conversation_id]: { ...bucket, items } };
        }
      }
      if (conv) {
        const fromOther = isFromOther(s, m);
        out.conversations = {
          ...s.conversations,
          [conv.id]: {
            ...conv,
            last_message_id: m.id,
            unread_count: fromOther ? Math.min(conv.unread_count + 1, 100) : 0,
            last_read_message_id: fromOther ? conv.last_read_message_id : m.id,
          },
        };
      }
      const typingConv = s.typing[m.conversation_id];
      if (typingConv?.[m.author_id]) {
        const { [m.author_id]: _gone, ...rest } = typingConv;
        out.typing = { ...s.typing, [m.conversation_id]: rest };
      }
      return out;
    }

    case "MESSAGE_UPDATE":
      return mutateMessage(s, frame.d.conversation_id, frame.d.id, () => frame.d);

    case "MESSAGE_DELETE": {
      const { id, conversation_id } = frame.d;
      const out: Partial<NexusState> = {};
      const messages = updateBucket(s, conversation_id, (b) => {
        const items = b.items.filter((m) => m.id !== id);
        if (items.length === b.items.length) return b;
        // Replies to the deleted message lose their preview, as on the server.
        return {
          ...b,
          items: items.map((m) => (m.reply_to?.id === id ? { ...m, reply_to: null } : m)),
        };
      });
      if (messages) out.messages = messages;
      return out;
    }

    case "MESSAGE_REACTION_ADD":
    case "MESSAGE_REACTION_REMOVE": {
      const { conversation_id, message_id, user_id, emoji } = frame.d;
      const add = frame.t === "MESSAGE_REACTION_ADD";
      return mutateMessage(s, conversation_id, message_id, (m) => {
        const reactions = m.reactions.map((r) => ({ ...r, user_ids: [...r.user_ids] }));
        const r = reactions.find((x) => x.emoji === emoji);
        if (add) {
          if (r) {
            if (!r.user_ids.includes(user_id)) r.user_ids.push(user_id);
          } else reactions.push({ emoji, user_ids: [user_id] });
        } else if (r) {
          r.user_ids = r.user_ids.filter((u) => u !== user_id);
        }
        return { ...m, reactions: reactions.filter((x) => x.user_ids.length > 0) };
      });
    }

    case "CONVERSATION_READ": {
      const conv = s.conversations[frame.d.conversation_id];
      if (!conv) return {};
      const caughtUp = !conv.last_message_id || frame.d.message_id >= conv.last_message_id;
      return {
        conversations: {
          ...s.conversations,
          [conv.id]: {
            ...conv,
            last_read_message_id: frame.d.message_id,
            unread_count: caughtUp ? 0 : conv.unread_count,
          },
        },
      };
    }

    case "TYPING_START": {
      const { conversation_id, user_id } = frame.d;
      return {
        typing: {
          ...s.typing,
          [conversation_id]: { ...s.typing[conversation_id], [user_id]: now + TYPING_TTL_MS },
        },
      };
    }

    case "TYPING_STOP": {
      const conv = s.typing[frame.d.conversation_id];
      if (!conv?.[frame.d.user_id]) return {};
      const { [frame.d.user_id]: _gone, ...rest } = conv;
      return { typing: { ...s.typing, [frame.d.conversation_id]: rest } };
    }

    case "FRIEND_REQUEST": {
      const r = frame.d;
      const users = indexUsers(s.users, [r.from, r.to]);
      if (r.to.id === s.me?.id) {
        return { users, incoming: [r, ...s.incoming.filter((x) => x.id !== r.id)] };
      }
      return { users, outgoing: [r, ...s.outgoing.filter((x) => x.id !== r.id)] };
    }

    case "FRIEND_REQUEST_DELETE":
      return {
        incoming: s.incoming.filter((r) => r.id !== frame.d.id),
        outgoing: s.outgoing.filter((r) => r.id !== frame.d.id),
      };

    case "FRIEND_ACCEPT": {
      const { friend, request_id } = frame.d;
      return {
        users: indexUsers(s.users, [friend.user]),
        friends: { ...s.friends, [friend.user.id]: friend },
        incoming: s.incoming.filter((r) => r.id !== request_id),
        outgoing: s.outgoing.filter((r) => r.id !== request_id),
      };
    }

    case "FRIEND_REMOVE": {
      if (!s.friends[frame.d.user_id]) return {};
      const { [frame.d.user_id]: _gone, ...friends } = s.friends;
      return { friends };
    }

    case "USER_BLOCK":
      return {
        users: indexUsers(s.users, [frame.d]),
        blocked: { ...s.blocked, [frame.d.id]: frame.d },
      };

    case "USER_UNBLOCK": {
      const { [frame.d.user_id]: _gone, ...blocked } = s.blocked;
      return { blocked };
    }

    case "USER_UPDATE": {
      const u = frame.d;
      const out: Partial<NexusState> = { users: indexUsers(s.users, [u]) };
      if (u.id === s.me?.id && "status" in u) out.me = u;
      // Keep member lists inside conversations in sync.
      let changed = false;
      const conversations = { ...s.conversations };
      for (const c of Object.values(s.conversations)) {
        if (c.members.some((m) => m.id === u.id)) {
          changed = true;
          conversations[c.id] = {
            ...c,
            members: c.members.map((m) =>
              m.id === u.id
                ? { id: u.id, username: u.username, display_name: u.display_name, avatar_url: u.avatar_url, bio: u.bio }
                : m,
            ),
          };
        }
      }
      if (changed) out.conversations = conversations;
      const friend = s.friends[u.id];
      if (friend) out.friends = { ...s.friends, [u.id]: { ...friend, user: { ...friend.user, ...u } } };
      return out;
    }

    case "PRESENCE_UPDATE":
      if (s.presences[frame.d.user_id] === frame.d.status) return {};
      return { presences: { ...s.presences, [frame.d.user_id]: frame.d.status } };

    case "CONVERSATION_CREATE":
      return {
        users: indexUsers(s.users, frame.d.members),
        conversations: { ...s.conversations, [frame.d.id]: frame.d },
      };

    case "CONVERSATION_UPDATE": {
      const prev = s.conversations[frame.d.id];
      if (!prev) return {};
      return {
        users: indexUsers(s.users, frame.d.members),
        conversations: { ...s.conversations, [frame.d.id]: { ...prev, ...frame.d } },
      };
    }

    case "CONVERSATION_DELETE": {
      const { [frame.d.id]: _c, ...conversations } = s.conversations;
      const { [frame.d.id]: _m, ...messages } = s.messages;
      const calls = Object.fromEntries(Object.entries(s.calls).filter(([, c]) => c.conversation_id !== frame.d.id));
      return {
        conversations,
        messages,
        calls,
        activeConversationId: s.activeConversationId === frame.d.id ? null : s.activeConversationId,
      };
    }

    case "CALL_CREATE":
      return { calls: { ...s.calls, [frame.d.id]: frame.d } };

    case "CALL_JOIN":
    case "CALL_STATE_UPDATE": {
      const call = s.calls[frame.d.call_id];
      if (!call) return {};
      const p = frame.d.participant;
      const exists = call.participants.some((x) => x.user_id === p.user_id);
      const participants = exists
        ? call.participants.map((x) => (x.user_id === p.user_id ? p : x))
        : [...call.participants, p];
      // A user is in one call at a time: drop them from any other call.
      const calls: Record<Id, Call> = {};
      for (const [id, c] of Object.entries(s.calls)) {
        calls[id] =
          id === call.id
            ? { ...call, participants }
            : frame.t === "CALL_JOIN" && c.participants.some((x) => x.user_id === p.user_id)
              ? { ...c, participants: c.participants.filter((x) => x.user_id !== p.user_id) }
              : c;
      }
      return { calls };
    }

    case "CALL_LEAVE": {
      const call = s.calls[frame.d.call_id];
      if (!call) return {};
      return {
        calls: {
          ...s.calls,
          [call.id]: { ...call, participants: call.participants.filter((p) => p.user_id !== frame.d.user_id) },
        },
      };
    }

    case "CALL_END": {
      const { [frame.d.call_id]: _gone, ...calls } = s.calls;
      return { calls };
    }

    default:
      return {};
  }
}

// ---- selectors ----

export function conversationTitle(s: NexusState, c: ConversationView): string {
  if (c.kind === "group") {
    if (c.name) return c.name;
    const others = c.members.filter((m) => m.id !== s.me?.id).map((m) => s.users[m.id]?.display_name ?? m.display_name);
    return others.join(", ") || "Grupo vazio";
  }
  const peer = dmPeer(s, c);
  return peer ? (s.users[peer.id]?.display_name ?? peer.display_name) : "Conversa";
}

export function dmPeer(s: NexusState, c: ConversationView): PublicUser | undefined {
  return c.members.find((m) => m.id !== s.me?.id);
}

export function sortedConversations(s: NexusState): ConversationView[] {
  return Object.values(s.conversations).sort((a, b) => {
    const ka = a.last_message_id ?? a.id;
    const kb = b.last_message_id ?? b.id;
    return ka < kb ? 1 : ka > kb ? -1 : 0;
  });
}

export function callForConversation(s: NexusState, conversationId: Id): Call | undefined {
  return Object.values(s.calls).find((c) => c.conversation_id === conversationId);
}

export function myCall(s: NexusState): Call | undefined {
  const me = s.me?.id;
  return Object.values(s.calls).find((c) => c.participants.some((p) => p.user_id === me));
}

export function typingUsers(s: NexusState, conversationId: Id, now = Date.now()): Id[] {
  const t = s.typing[conversationId];
  if (!t) return [];
  return Object.entries(t)
    .filter(([uid, exp]) => exp > now && uid !== s.me?.id)
    .map(([uid]) => uid);
}

export function totalUnread(s: NexusState): number {
  return Object.values(s.conversations).reduce((n, c) => n + c.unread_count, 0);
}
