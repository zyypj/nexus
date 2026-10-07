import type { AuthResponse, Id, Message } from "@nexus/protocol";
import { ApiClient, type TokenStore } from "./api";
import { GatewayClient } from "./gateway";
import {
  type ClientMessage,
  type MessageBucket,
  type NexusState,
  type NexusStore,
  TYPING_TTL_MS,
  applyFrame,
  createNexusStore,
  emptyBucket,
  initialState,
  isFromOther,
  upsertMessage,
} from "./store";

export interface NexusClientOptions {
  baseUrl: string;
  tokenStore: TokenStore;
  deviceName: string;
  /** Called for messages from others that the user is not looking at. */
  onNotify?: (message: Message, state: NexusState) => void;
  /** Called when the session is gone (revoked/expired): the app shows login. */
  onLoggedOut?: () => void;
  /** Whether the app window is focused/visible (unread + notification decisions). */
  isAppVisible?: () => boolean;
  WebSocketImpl?: typeof WebSocket;
}

const PAGE = 50;
const TYPING_RESEND_MS = 8_000;

let nonceCounter = 0;
const makeNonce = () => `${Date.now().toString(36)}-${(nonceCounter++).toString(36)}`;

export interface PendingUpload {
  file: Blob;
  name: string;
}

export class NexusClient {
  readonly api: ApiClient;
  readonly gateway: GatewayClient;
  readonly store: NexusStore = createNexusStore();
  private typingSentAt = new Map<Id, number>();
  private typingSweep: ReturnType<typeof setTimeout> | null = null;
  private ackTimer: ReturnType<typeof setTimeout> | null = null;
  private readyCount = 0;

  constructor(private readonly opts: NexusClientOptions) {
    this.api = new ApiClient({
      baseUrl: opts.baseUrl,
      tokenStore: opts.tokenStore,
      deviceName: opts.deviceName,
      onSessionExpired: () => this.handleLoggedOut(),
    });
    this.gateway = new GatewayClient({
      url: () => this.api.gatewayUrl(),
      getToken: () => this.api.getAccessToken(),
      refreshToken: () => this.api.refresh(),
      onStateChange: (connection) => this.store.setState({ connection }),
      WebSocketImpl: opts.WebSocketImpl,
    });
    this.gateway.onAny((frame) => {
      const before = this.store.getState();
      this.store.setState(applyFrame(before, frame));
      const after = this.store.getState();
      switch (frame.t) {
        case "READY":
          this.readyCount += 1;
          this.resyncAfterReady();
          break;
        case "MESSAGE_CREATE":
          this.afterMessage(frame.d, after);
          break;
        case "TYPING_START":
          this.scheduleTypingSweep();
          break;
        default:
          break;
      }
    });
  }

  get state(): NexusState {
    return this.store.getState();
  }

  // ---------- session ----------

  /** Restores a saved session. Returns false when the user must log in. */
  async restore(): Promise<boolean> {
    const ok = await this.api.refresh();
    if (ok) this.gateway.start();
    return ok;
  }

  async login(username: string, password: string): Promise<AuthResponse> {
    const res = await this.api.login(username, password);
    this.gateway.start();
    return res;
  }

  async register(username: string, password: string, invite: string, displayName?: string): Promise<AuthResponse> {
    const res = await this.api.register(username, password, invite, displayName);
    this.gateway.start();
    return res;
  }

  async logout(): Promise<void> {
    this.gateway.stop();
    try {
      await this.api.logout();
    } finally {
      this.reset();
    }
  }

  private handleLoggedOut() {
    this.gateway.stop();
    this.reset();
    this.opts.onLoggedOut?.();
  }

  private reset() {
    this.store.setState(initialState(), true);
    this.typingSentAt.clear();
    this.readyCount = 0;
  }

  // ---------- conversations ----------

  /** Selects a conversation, loading its history and marking it read. */
  async openConversation(id: Id | null): Promise<void> {
    this.store.setState({ activeConversationId: id });
    if (!id) return;
    const bucket = this.state.messages[id];
    if (!bucket?.loaded || bucket.stale) await this.loadLatest(id);
    this.markRead(id);
  }

  private setBucket(id: Id, fn: (b: MessageBucket) => MessageBucket) {
    const s = this.store.getState();
    this.store.setState({ messages: { ...s.messages, [id]: fn(s.messages[id] ?? emptyBucket()) } });
  }

  async loadLatest(id: Id): Promise<void> {
    this.setBucket(id, (b) => ({ ...b, loading: true }));
    try {
      const page = await this.api.messages(id, { limit: PAGE });
      this.setBucket(id, (b) => {
        // Keep older cached history when the fresh page overlaps it; drop the
        // window the server just re-sent (covers edits/deletes while offline).
        const firstNew = page[0]?.id;
        const older = firstNew && b.loaded ? b.items.filter((m) => !m.local && m.id < firstNew) : [];
        const pending = b.items.filter((m) => m.local);
        const contiguous = older.length > 0 && page.length === PAGE;
        return {
          items: [...(contiguous ? older : []), ...page, ...pending],
          hasMore: contiguous ? b.hasMore : page.length === PAGE,
          loaded: true,
          loading: false,
          stale: false,
        };
      });
    } catch (e) {
      this.setBucket(id, (b) => ({ ...b, loading: false }));
      throw e;
    }
  }

  async loadOlder(id: Id): Promise<void> {
    const bucket = this.state.messages[id];
    if (!bucket || bucket.loading || !bucket.hasMore) return;
    const first = bucket.items.find((m) => !m.local);
    if (!first) return;
    this.setBucket(id, (b) => ({ ...b, loading: true }));
    try {
      const page = await this.api.messages(id, { before: first.id, limit: PAGE });
      this.setBucket(id, (b) => ({
        ...b,
        items: [...page.filter((m) => !b.items.some((x) => x.id === m.id)), ...b.items],
        hasMore: page.length === PAGE,
        loading: false,
      }));
    } catch (e) {
      this.setBucket(id, (b) => ({ ...b, loading: false }));
      throw e;
    }
  }

  /** Acks the newest message (debounced so a burst produces one request). */
  markRead(id: Id): void {
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.ackTimer = setTimeout(() => {
      this.ackTimer = null;
      const conv = this.state.conversations[id];
      if (!conv?.last_message_id) return;
      if (conv.unread_count === 0 && conv.last_read_message_id === conv.last_message_id) return;
      const s = this.store.getState();
      this.store.setState({
        conversations: {
          ...s.conversations,
          [id]: { ...conv, unread_count: 0, last_read_message_id: conv.last_message_id },
        },
      });
      void this.api.ack(id, conv.last_message_id).catch(() => undefined);
    }, 300);
  }

  private afterMessage(m: Message, s: NexusState) {
    if (!isFromOther(s, m)) return;
    const visible = this.opts.isAppVisible?.() ?? true;
    if (s.activeConversationId === m.conversation_id && visible) {
      this.markRead(m.conversation_id);
    } else if (!s.blocked[m.author_id]) {
      this.opts.onNotify?.(m, s);
    }
  }

  /** After every reconnect: refresh the open conversation; others reload lazily. */
  private resyncAfterReady() {
    if (this.readyCount <= 1) return;
    const active = this.state.activeConversationId;
    if (active) void this.loadLatest(active).catch(() => undefined);
  }

  // ---------- messages ----------

  async sendMessage(conversationId: Id, content: string, opts: { replyTo?: Id | null; files?: PendingUpload[] } = {}) {
    const me = this.state.me;
    if (!me) throw new Error("not connected");
    const nonce = makeNonce();
    const optimistic: ClientMessage = {
      id: `local-${nonce}`,
      conversation_id: conversationId,
      author_id: me.id,
      content,
      reply_to: null,
      attachments: [],
      reactions: [],
      created_at: Date.now(),
      edited_at: null,
      nonce,
      local: "sending",
    };
    if (this.state.messages[conversationId]?.loaded) {
      this.setBucket(conversationId, (b) => ({ ...b, items: [...b.items, optimistic] }));
    }
    this.stopTyping(conversationId);
    try {
      const attachmentIds: Id[] = [];
      for (const f of opts.files ?? []) {
        const att = await this.api.uploadAttachment(conversationId, f.file, f.name);
        attachmentIds.push(att.id);
      }
      const msg = await this.api.sendMessage(conversationId, {
        content,
        reply_to_id: opts.replyTo ?? null,
        attachment_ids: attachmentIds,
        nonce,
      });
      // The gateway echo normally replaces the optimistic copy; this covers a
      // dropped socket.
      this.setBucket(conversationId, (b) => ({
        ...b,
        items: upsertMessage(
          b.items.filter((x) => x.id !== optimistic.id),
          msg,
        ),
      }));
      return msg;
    } catch (e) {
      this.setBucket(conversationId, (b) => ({
        ...b,
        items: b.items.map((x) => (x.id === optimistic.id ? { ...x, local: "failed" as const } : x)),
      }));
      throw e;
    }
  }

  discardFailed(conversationId: Id, localId: Id) {
    this.setBucket(conversationId, (b) => ({ ...b, items: b.items.filter((m) => m.id !== localId) }));
  }

  editMessage(conversationId: Id, messageId: Id, content: string) {
    return this.api.editMessage(conversationId, messageId, content);
  }

  deleteMessage(conversationId: Id, messageId: Id) {
    return this.api.deleteMessage(conversationId, messageId);
  }

  toggleReaction(conversationId: Id, messageId: Id, emoji: string) {
    const me = this.state.me?.id;
    const msg = this.state.messages[conversationId]?.items.find((m) => m.id === messageId);
    const mine = msg?.reactions.find((r) => r.emoji === emoji)?.user_ids.includes(me ?? "");
    return mine
      ? this.api.removeReaction(conversationId, messageId, emoji)
      : this.api.addReaction(conversationId, messageId, emoji);
  }

  // ---------- typing ----------

  /** Call on every keystroke; sends at most one TYPING_START per 8 s. */
  typing(conversationId: Id): void {
    const now = Date.now();
    const last = this.typingSentAt.get(conversationId) ?? 0;
    if (now - last < TYPING_RESEND_MS) return;
    if (this.gateway.send({ op: "TYPING_START", d: { conversation_id: conversationId } })) {
      this.typingSentAt.set(conversationId, now);
    }
  }

  stopTyping(conversationId: Id): void {
    if (!this.typingSentAt.has(conversationId)) return;
    this.typingSentAt.delete(conversationId);
    this.gateway.send({ op: "TYPING_STOP", d: { conversation_id: conversationId } });
  }

  /** One timeout for all typing indicators, only while any are showing. */
  private scheduleTypingSweep() {
    if (this.typingSweep) return;
    this.typingSweep = setTimeout(() => {
      this.typingSweep = null;
      const now = Date.now();
      const s = this.store.getState();
      let changed = false;
      let anyLeft = false;
      const typing: NexusState["typing"] = {};
      for (const [conv, users] of Object.entries(s.typing)) {
        const kept: Record<Id, number> = {};
        for (const [uid, exp] of Object.entries(users)) {
          if (exp > now) {
            kept[uid] = exp;
            anyLeft = true;
          } else changed = true;
        }
        typing[conv] = kept;
      }
      if (changed) this.store.setState({ typing });
      if (anyLeft) this.scheduleTypingSweep();
    }, TYPING_TTL_MS / 2);
  }
}
