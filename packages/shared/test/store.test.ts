import type { GatewayFrame, Message, Ready } from "@nexus/protocol";
import { describe, expect, it } from "vitest";
import { backoffDelay } from "../src/backoff";
import type { ConversationView, ServerView } from "@nexus/protocol";
import {
  type NexusState,
  applyFrame,
  emptyBucket,
  initialState,
  memberColor,
  serverChannels,
  sortedConversations,
  totalUnread,
  typingUsers,
  upsertMessage,
} from "../src/store";

const me = { id: "u-me", username: "me", display_name: "Eu", avatar_url: null, bio: "" };
const joao = { id: "u-joao", username: "joao", display_name: "João", avatar_url: null, bio: "" };

function ready(): Ready {
  return {
    session_id: "s1",
    user: { ...me, status: "online", is_admin: false, created_at: 0 },
    relationships: { friends: [{ user: joao, since: 0 }], incoming: [], outgoing: [], blocked: [] },
    conversations: [
      {
        id: "c1",
        kind: "dm",
        name: null,
        owner_id: null,
        members: [me, joao],
        last_message_id: "m1",
        created_at: 0,
        last_read_message_id: "m1",
        unread_count: 0,
      },
    ],
    presences: [{ user_id: "u-joao", status: "online" }],
    calls: [],
    servers: [],
    server: { name: "Nexus", version: "0.1.0", calls_enabled: true, max_upload_size: 1 },
  };
}

const msg = (id: string, author = "u-joao", extra: Partial<Message> = {}): Message => ({
  id,
  conversation_id: "c1",
  author_id: author,
  content: `content ${id}`,
  reply_to: null,
  attachments: [],
  reactions: [],
  created_at: 0,
  edited_at: null,
  ...extra,
});

function apply(s: NexusState, frame: GatewayFrame, now?: number): NexusState {
  return { ...s, ...applyFrame(s, frame, now) };
}

function withLoaded(s: NexusState, items: Message[]): NexusState {
  return { ...s, messages: { c1: { ...emptyBucket(), loaded: true, items } } };
}

describe("applyFrame", () => {
  it("builds state from READY", () => {
    const s = apply(initialState(), { t: "READY", d: ready() });
    expect(s.me?.id).toBe("u-me");
    expect(s.users["u-joao"]?.display_name).toBe("João");
    expect(s.presences["u-joao"]).toBe("online");
    expect(s.friends["u-joao"]).toBeDefined();
    expect(s.conversations.c1?.kind).toBe("dm");
  });

  it("marks cached buckets stale on a new READY (re-sync after reconnect)", () => {
    let s = apply(initialState(), { t: "READY", d: ready() });
    s = withLoaded(s, [msg("m1")]);
    s = apply(s, { t: "READY", d: ready() });
    expect(s.messages.c1?.stale).toBe(true);
    expect(s.messages.c1?.items).toHaveLength(1);
  });

  it("appends messages and counts unread only for others", () => {
    let s = withLoaded(apply(initialState(), { t: "READY", d: ready() }), [msg("m1")]);
    s = apply(s, { t: "MESSAGE_CREATE", d: msg("m2") });
    expect(s.messages.c1?.items.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(s.conversations.c1?.unread_count).toBe(1);
    s = apply(s, { t: "MESSAGE_CREATE", d: msg("m3", "u-me") });
    expect(s.conversations.c1?.unread_count).toBe(0);
    expect(s.conversations.c1?.last_message_id).toBe("m3");
  });

  it("replaces optimistic copies by nonce", () => {
    let s = withLoaded(apply(initialState(), { t: "READY", d: ready() }), [msg("m1")]);
    s = {
      ...s,
      messages: {
        c1: {
          ...s.messages.c1!,
          items: [...s.messages.c1!.items, { ...msg("local-x", "u-me"), nonce: "n1", local: "sending" }],
        },
      },
    };
    s = apply(s, { t: "MESSAGE_CREATE", d: msg("m2", "u-me", { nonce: "n1" }) });
    const ids = s.messages.c1!.items.map((m) => m.id);
    expect(ids).toEqual(["m1", "m2"]);
    expect(s.messages.c1!.items[1]).not.toHaveProperty("nonce");
  });

  it("edits, deletes and clears reply previews", () => {
    let s = withLoaded(apply(initialState(), { t: "READY", d: ready() }), [
      msg("m1"),
      msg("m2", "u-me", { reply_to: { id: "m1", author_id: "u-joao", content: "x" } }),
    ]);
    s = apply(s, { t: "MESSAGE_UPDATE", d: msg("m1", "u-joao", { content: "editado", edited_at: 5 }) });
    expect(s.messages.c1!.items[0]!.content).toBe("editado");
    s = apply(s, { t: "MESSAGE_DELETE", d: { id: "m1", conversation_id: "c1" } });
    expect(s.messages.c1!.items).toHaveLength(1);
    expect(s.messages.c1!.items[0]!.reply_to).toBeNull();
  });

  it("tracks reactions", () => {
    let s = withLoaded(apply(initialState(), { t: "READY", d: ready() }), [msg("m1")]);
    const r = { conversation_id: "c1", message_id: "m1", emoji: "👍" };
    s = apply(s, { t: "MESSAGE_REACTION_ADD", d: { ...r, user_id: "u-me" } });
    s = apply(s, { t: "MESSAGE_REACTION_ADD", d: { ...r, user_id: "u-joao" } });
    s = apply(s, { t: "MESSAGE_REACTION_ADD", d: { ...r, user_id: "u-joao" } });
    expect(s.messages.c1!.items[0]!.reactions).toEqual([{ emoji: "👍", user_ids: ["u-me", "u-joao"] }]);
    s = apply(s, { t: "MESSAGE_REACTION_REMOVE", d: { ...r, user_id: "u-me" } });
    s = apply(s, { t: "MESSAGE_REACTION_REMOVE", d: { ...r, user_id: "u-joao" } });
    expect(s.messages.c1!.items[0]!.reactions).toEqual([]);
  });

  it("expires typing indicators and clears them on message", () => {
    let s = apply(initialState(), { t: "READY", d: ready() });
    s = apply(s, { t: "TYPING_START", d: { conversation_id: "c1", user_id: "u-joao" } }, 1000);
    expect(typingUsers(s, "c1", 2000)).toEqual(["u-joao"]);
    expect(typingUsers(s, "c1", 1000 + 11_000)).toEqual([]);
    s = apply(s, { t: "MESSAGE_CREATE", d: msg("m2") });
    expect(typingUsers(s, "c1", 2000)).toEqual([]);
  });

  it("call participants move between calls", () => {
    let s = apply(initialState(), { t: "READY", d: ready() });
    const base = { conversation_id: "c1", room_name: "r", started_by: null, created_at: 0, ended_at: null };
    s = apply(s, { t: "CALL_CREATE", d: { ...base, id: "call1", participants: [] } });
    s = apply(s, { t: "CALL_CREATE", d: { ...base, id: "call2", conversation_id: "c2", participants: [] } });
    const p = { user_id: "u-joao", joined_at: 0, muted: false, deafened: false, video: false, screen: false };
    s = apply(s, { t: "CALL_JOIN", d: { call_id: "call1", conversation_id: "c1", participant: p } });
    expect(s.calls.call1!.participants).toHaveLength(1);
    s = apply(s, { t: "CALL_JOIN", d: { call_id: "call2", conversation_id: "c2", participant: p } });
    expect(s.calls.call1!.participants).toHaveLength(0);
    expect(s.calls.call2!.participants).toHaveLength(1);
    s = apply(s, {
      t: "CALL_STATE_UPDATE",
      d: { call_id: "call2", conversation_id: "c2", participant: { ...p, muted: true } },
    });
    expect(s.calls.call2!.participants[0]!.muted).toBe(true);
    s = apply(s, { t: "CALL_END", d: { call_id: "call2", conversation_id: "c2" } });
    expect(s.calls.call2).toBeUndefined();
  });

  it("removes conversations the user left", () => {
    let s = apply(initialState(), { t: "READY", d: ready() });
    s = { ...withLoaded(s, [msg("m1")]), activeConversationId: "c1" };
    s = apply(s, { t: "CONVERSATION_DELETE", d: { id: "c1" } });
    expect(s.conversations.c1).toBeUndefined();
    expect(s.messages.c1).toBeUndefined();
    expect(s.activeConversationId).toBeNull();
  });
});

describe("upsertMessage", () => {
  it("keeps id order for out-of-order arrivals", () => {
    const items = [msg("a1"), msg("a3")];
    expect(upsertMessage(items, msg("a2")).map((m) => m.id)).toEqual(["a1", "a2", "a3"]);
  });
});

describe("backoffDelay", () => {
  it("grows exponentially and is capped", () => {
    const max = () => 0.999999;
    expect(backoffDelay(0, { random: max })).toBe(999);
    expect(backoffDelay(3, { random: max })).toBe(7999);
    expect(backoffDelay(20, { random: max })).toBe(29_999);
    expect(backoffDelay(5, { random: () => 0 })).toBe(250);
  });
});

describe("servers", () => {
  const channel = (id: string, extra: Partial<ConversationView> = {}): ConversationView => ({
    id,
    kind: "text",
    name: id,
    owner_id: null,
    members: [],
    last_message_id: null,
    created_at: 0,
    last_read_message_id: null,
    unread_count: 0,
    server_id: "srv",
    category_id: "cat",
    position: 0,
    permissions: 0xffff,
    ...extra,
  });
  const server = (channels: ConversationView[]): ServerView => ({
    id: "srv",
    name: "Clube",
    icon_url: null,
    owner_id: "u-me",
    created_at: 0,
    permissions: 0x1ffff,
    roles: [
      { id: "mod", name: "Mod", color: 0x5b73f7, position: 1, permissions: 0, hoist: true },
      { id: "srv", name: "@everyone", color: 0, position: 0, permissions: 0, hoist: false },
    ],
    categories: [{ id: "cat", name: "Texto", position: 0 }],
    channels,
    overwrites: [],
    members: [
      { user: me, nickname: null, role_ids: [], joined_at: 0 },
      { user: joao, nickname: "Jão", role_ids: ["mod"], joined_at: 0 },
    ],
  });
  const withReady = (servers: ServerView[]) => {
    const s = { ...initialState(), ...applyFrame(initialState(), { t: "READY", d: { ...ready(), servers } }) };
    return s as NexusState;
  };

  it("READY puts channels next to DMs but keeps them out of the DM list and badge", () => {
    const s = withReady([server([channel("geral", { unread_count: 3 }), channel("voz", { kind: "voice", position: 1 })])]);
    expect(Object.keys(s.servers)).toEqual(["srv"]);
    expect(s.conversations.geral?.server_id).toBe("srv");
    expect(sortedConversations(s).map((c) => c.id)).toEqual(["c1"]);
    expect(totalUnread(s)).toBe(0);
    const groups = serverChannels(s, "srv");
    expect(groups.map((g) => g.category?.name ?? null)).toEqual(["Texto"]);
    expect(groups[0]?.channels.map((c) => c.id)).toEqual(["geral", "voz"]);
    expect(memberColor(s.servers.srv as ServerView, "u-joao")).toBe("#5b73f7");
    expect(memberColor(s.servers.srv as ServerView, "u-me")).toBeUndefined();
  });

  it("SERVER_UPDATE replaces the channel set (hidden channels disappear)", () => {
    let s = withReady([server([channel("geral"), channel("staff")])]);
    s = { ...s, activeConversationId: "staff" };
    s = { ...s, ...applyFrame(s, { t: "SERVER_UPDATE", d: server([channel("geral")]) }) };
    expect(s.conversations.staff).toBeUndefined();
    expect(s.conversations.geral).toBeDefined();
    expect(s.activeConversationId).toBeNull();
  });

  it("SERVER_DELETE removes the server and its channels only", () => {
    let s = withReady([server([channel("geral")])]);
    s = { ...s, ...applyFrame(s, { t: "SERVER_DELETE", d: { id: "srv" } }) };
    expect(s.servers.srv).toBeUndefined();
    expect(s.conversations.geral).toBeUndefined();
    expect(s.conversations.c1).toBeDefined();
  });
});
