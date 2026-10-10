import type {
  AdminUser,
  ApiErrorBody,
  Attachment,
  AuthResponse,
  Call,
  CallJoin,
  CallParticipant,
  Conversation,
  ConversationView,
  Friend,
  FriendRequest,
  Id,
  Invite,
  Me,
  Message,
  PublicServerInfo,
  PublicUser,
  Relationships,
  ServerBan,
  ServerCategory,
  ServerInvite,
  ServerInvitePreview,
  ServerRole,
  ServerView,
  SessionInfo,
  UserStatus,
} from "@nexus/protocol";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Where the refresh token lives (OS keyring on desktop, Keystore on Android). */
export interface TokenStore {
  load(): Promise<string | null>;
  save(refreshToken: string): Promise<void>;
  clear(): Promise<void>;
}

export interface ApiClientOptions {
  baseUrl: string;
  tokenStore: TokenStore;
  deviceName?: string;
  /** Called when the session can no longer be refreshed (logged out elsewhere, revoked...). */
  onSessionExpired?: () => void;
  fetchImpl?: typeof fetch;
}

type Json = Record<string, unknown> | unknown[];

/** A file to upload: a Blob (desktop) or a native file reference (React Native). */
export type UploadSource = Blob | { uri: string; name: string; type: string };

function appendFile(form: FormData, file: UploadSource, fileName: string) {
  // DOM FormData takes (name, blob, fileName); React Native's takes
  // (name, {uri, name, type}). One structural type covers both.
  const f = form as unknown as { append(name: string, value: unknown, fileName?: string): void };
  if (typeof Blob !== "undefined" && file instanceof Blob) f.append("file", file, fileName);
  else f.append("file", file);
}

export class ApiClient {
  private accessToken: string | null = null;
  private accessExpiresAt = 0;
  private refreshing: Promise<boolean> | null = null;
  private readonly fetchImpl: typeof fetch;
  baseUrl: string;

  constructor(private readonly opts: ApiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  setBaseUrl(url: string): void {
    this.baseUrl = url.replace(/\/+$/, "");
  }

  /** Absolute URL for server-relative paths (avatars, signed files). */
  url(path: string | null | undefined): string | undefined {
    if (!path) return undefined;
    return /^https?:\/\//.test(path) ? path : `${this.baseUrl}${path}`;
  }

  gatewayUrl(): string {
    return `${this.baseUrl.replace(/^http/, "ws")}/gateway`;
  }

  get isAuthenticated(): boolean {
    return this.accessToken !== null;
  }

  /** Current access token, refreshed first when about to expire. */
  async getAccessToken(): Promise<string | null> {
    if (this.accessToken && Date.now() < this.accessExpiresAt - 60_000) return this.accessToken;
    const ok = await this.refresh();
    return ok ? this.accessToken : null;
  }

  private async applyAuth(res: AuthResponse): Promise<AuthResponse> {
    this.accessToken = res.access_token;
    this.accessExpiresAt = Date.now() + res.expires_in * 1000;
    await this.opts.tokenStore.save(res.refresh_token);
    return res;
  }

  /** Rotates the refresh token. Concurrent callers share one request. */
  refresh(): Promise<boolean> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        const token = await this.opts.tokenStore.load();
        if (!token) return false;
        const res = await this.fetchImpl(`${this.baseUrl}/api/auth/refresh`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ refresh_token: token }),
        });
        if (res.status === 401) {
          await this.opts.tokenStore.clear();
          this.accessToken = null;
          this.opts.onSessionExpired?.();
          return false;
        }
        if (!res.ok) return false;
        await this.applyAuth((await res.json()) as AuthResponse);
        return true;
      } catch {
        // Network error: keep the stored token and try again later.
        return false;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  async request<T>(method: string, path: string, body?: Json | FormData, retry = true): Promise<T> {
    const token = await this.getAccessToken();
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    let payload: FormData | string | undefined;
    if (body instanceof FormData) {
      payload = body;
    } else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { method, headers, body: payload });
    if (res.status === 401 && retry && token) {
      this.accessExpiresAt = 0;
      if (await this.refresh()) return this.request<T>(method, path, body, false);
    }
    if (!res.ok) {
      let code = "http_error";
      let message = `${res.status} ${res.statusText}`;
      try {
        const err = (await res.json()) as ApiErrorBody;
        code = err.error.code;
        message = err.error.message;
      } catch {
        // non-JSON error body
      }
      throw new ApiError(res.status, code, message);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  private async unauthenticated(path: string, body: Json): Promise<AuthResponse> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let err: ApiErrorBody | null = null;
      try {
        err = (await res.json()) as ApiErrorBody;
      } catch {
        /* ignore */
      }
      throw new ApiError(res.status, err?.error.code ?? "http_error", err?.error.message ?? res.statusText);
    }
    return this.applyAuth((await res.json()) as AuthResponse);
  }

  // ---- auth ----
  info(): Promise<PublicServerInfo> {
    return this.request("GET", "/api/info");
  }
  register(username: string, password: string, inviteCode: string, displayName?: string): Promise<AuthResponse> {
    return this.unauthenticated("/api/auth/register", {
      username,
      password,
      invite_code: inviteCode,
      display_name: displayName,
      device_name: this.opts.deviceName,
    });
  }
  login(username: string, password: string): Promise<AuthResponse> {
    return this.unauthenticated("/api/auth/login", { username, password, device_name: this.opts.deviceName });
  }
  async logout(): Promise<void> {
    try {
      await this.request("POST", "/api/auth/logout", {});
    } finally {
      this.accessToken = null;
      await this.opts.tokenStore.clear();
    }
  }
  sessions(): Promise<SessionInfo[]> {
    return this.request("GET", "/api/auth/sessions");
  }
  revokeSession(id: Id): Promise<void> {
    return this.request("DELETE", `/api/auth/sessions/${id}`);
  }

  // ---- users ----
  me(): Promise<Me> {
    return this.request("GET", "/api/users/@me");
  }
  updateMe(patch: { display_name?: string; bio?: string; status?: UserStatus }): Promise<Me> {
    return this.request("PATCH", "/api/users/@me", patch);
  }
  changePassword(current: string, next: string): Promise<void> {
    return this.request("PUT", "/api/users/@me/password", { current_password: current, new_password: next });
  }
  uploadAvatar(file: UploadSource, fileName: string): Promise<Me> {
    const form = new FormData();
    appendFile(form, file, fileName);
    return this.request("POST", "/api/users/@me/avatar", form);
  }
  deleteAvatar(): Promise<Me> {
    return this.request("DELETE", "/api/users/@me/avatar");
  }
  user(id: Id): Promise<PublicUser> {
    return this.request("GET", `/api/users/${id}`);
  }

  // ---- relationships ----
  relationships(): Promise<Relationships> {
    return this.request("GET", "/api/relationships");
  }
  sendFriendRequest(
    username: string,
  ): Promise<{ status: "pending"; request: FriendRequest } | { status: "accepted"; friend: Friend }> {
    return this.request("POST", "/api/friends/requests", { username });
  }
  acceptFriendRequest(id: Id): Promise<Friend> {
    return this.request("POST", `/api/friends/requests/${id}/accept`, {});
  }
  deleteFriendRequest(id: Id): Promise<void> {
    return this.request("DELETE", `/api/friends/requests/${id}`);
  }
  removeFriend(userId: Id): Promise<void> {
    return this.request("DELETE", `/api/friends/${userId}`);
  }
  block(userId: Id): Promise<void> {
    return this.request("PUT", `/api/blocks/${userId}`);
  }
  unblock(userId: Id): Promise<void> {
    return this.request("DELETE", `/api/blocks/${userId}`);
  }

  // ---- conversations ----
  conversations(): Promise<ConversationView[]> {
    return this.request("GET", "/api/conversations");
  }
  openDm(userId: Id): Promise<ConversationView> {
    return this.request("POST", "/api/conversations/dm", { user_id: userId });
  }
  createGroup(name: string, memberIds: Id[]): Promise<ConversationView> {
    return this.request("POST", "/api/conversations/group", { name, member_ids: memberIds });
  }
  renameGroup(id: Id, name: string): Promise<Conversation> {
    return this.request("PATCH", `/api/conversations/${id}`, { name });
  }
  addMember(id: Id, userId: Id): Promise<void> {
    return this.request("PUT", `/api/conversations/${id}/members/${userId}`);
  }
  removeMember(id: Id, userId: Id): Promise<void> {
    return this.request("DELETE", `/api/conversations/${id}/members/${userId}`);
  }
  ack(id: Id, messageId: Id): Promise<void> {
    return this.request("POST", `/api/conversations/${id}/ack`, { message_id: messageId });
  }

  // ---- messages ----
  messages(id: Id, q: { before?: Id; after?: Id; limit?: number } = {}): Promise<Message[]> {
    const params = new URLSearchParams();
    if (q.before) params.set("before", q.before);
    if (q.after) params.set("after", q.after);
    if (q.limit) params.set("limit", String(q.limit));
    const qs = params.toString();
    return this.request("GET", `/api/conversations/${id}/messages${qs ? `?${qs}` : ""}`);
  }
  sendMessage(
    id: Id,
    body: { content: string; reply_to_id?: Id | null; attachment_ids?: Id[]; nonce?: string },
  ): Promise<Message> {
    return this.request("POST", `/api/conversations/${id}/messages`, body);
  }
  editMessage(id: Id, messageId: Id, content: string): Promise<Message> {
    return this.request("PATCH", `/api/conversations/${id}/messages/${messageId}`, { content });
  }
  deleteMessage(id: Id, messageId: Id): Promise<void> {
    return this.request("DELETE", `/api/conversations/${id}/messages/${messageId}`);
  }
  addReaction(id: Id, messageId: Id, emoji: string): Promise<void> {
    return this.request("PUT", `/api/conversations/${id}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`);
  }
  removeReaction(id: Id, messageId: Id, emoji: string): Promise<void> {
    return this.request(
      "DELETE",
      `/api/conversations/${id}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`,
    );
  }
  uploadAttachment(
    id: Id,
    file: UploadSource,
    fileName: string,
    onProgress?: (sent: number, total: number) => void,
  ): Promise<Attachment> {
    const form = new FormData();
    appendFile(form, file, fileName);
    const path = `/api/conversations/${id}/attachments`;
    // fetch() has no upload progress; XHR does (browsers and React Native).
    if (onProgress && typeof XMLHttpRequest !== "undefined") return this.xhrUpload(path, form, onProgress);
    return this.request("POST", path, form);
  }

  private async xhrUpload<T>(
    path: string,
    form: FormData,
    onProgress: (sent: number, total: number) => void,
    retry = true,
  ): Promise<T> {
    const token = await this.getAccessToken();
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${this.baseUrl}${path}`);
      if (token) xhr.setRequestHeader("authorization", `Bearer ${token}`);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded, e.total);
      };
      xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText });
      xhr.onerror = () => reject(new ApiError(0, "network_error", "Falha de rede durante o envio."));
      xhr.send(form);
    });
    if (res.status === 401 && retry && token) {
      this.accessExpiresAt = 0;
      if (await this.refresh()) return this.xhrUpload<T>(path, form, onProgress, false);
    }
    if (res.status < 200 || res.status >= 300) {
      let code = "http_error";
      let message = `HTTP ${res.status}`;
      try {
        const err = JSON.parse(res.body) as ApiErrorBody;
        code = err.error.code;
        message = err.error.message;
      } catch {
        // non-JSON error body
      }
      throw new ApiError(res.status, code, message);
    }
    return JSON.parse(res.body) as T;
  }

  // ---- servers ----
  createServer(name: string): Promise<ServerView> {
    return this.request("POST", "/api/servers", { name });
  }
  updateServer(id: Id, body: { name?: string }): Promise<void> {
    return this.request("PATCH", `/api/servers/${id}`, body);
  }
  deleteServer(id: Id): Promise<void> {
    return this.request("DELETE", `/api/servers/${id}`);
  }
  uploadServerIcon(id: Id, file: UploadSource, fileName: string): Promise<void> {
    const form = new FormData();
    appendFile(form, file, fileName);
    return this.request("POST", `/api/servers/${id}/icon`, form);
  }
  deleteServerIcon(id: Id): Promise<void> {
    return this.request("DELETE", `/api/servers/${id}/icon`);
  }
  transferServer(id: Id, userId: Id): Promise<void> {
    return this.request("POST", `/api/servers/${id}/transfer`, { user_id: userId });
  }
  leaveServer(id: Id): Promise<void> {
    return this.request("DELETE", `/api/servers/${id}/members/@me`);
  }
  /** `nickname: null` clears it; omit a field to leave it unchanged. */
  updateServerMember(id: Id, userId: Id, body: { nickname?: string | null; role_ids?: Id[] }): Promise<void> {
    return this.request("PATCH", `/api/servers/${id}/members/${userId}`, body);
  }
  kickMember(id: Id, userId: Id): Promise<void> {
    return this.request("DELETE", `/api/servers/${id}/members/${userId}`);
  }
  banMember(id: Id, userId: Id, reason?: string): Promise<void> {
    return this.request("PUT", `/api/servers/${id}/bans/${userId}`, { reason: reason ?? null });
  }
  unbanMember(id: Id, userId: Id): Promise<void> {
    return this.request("DELETE", `/api/servers/${id}/bans/${userId}`);
  }
  listBans(id: Id): Promise<ServerBan[]> {
    return this.request("GET", `/api/servers/${id}/bans`);
  }
  createServerInvite(id: Id, body: { max_uses?: number; expires_in_secs?: number } = {}): Promise<ServerInvite> {
    return this.request("POST", `/api/servers/${id}/invites`, body);
  }
  listServerInvites(id: Id): Promise<ServerInvite[]> {
    return this.request("GET", `/api/servers/${id}/invites`);
  }
  previewServerInvite(code: string): Promise<ServerInvitePreview> {
    return this.request("GET", `/api/server-invites/${encodeURIComponent(code)}`);
  }
  joinServer(code: string): Promise<ServerView> {
    return this.request("POST", `/api/server-invites/${encodeURIComponent(code)}`, {});
  }
  deleteServerInvite(code: string): Promise<void> {
    return this.request("DELETE", `/api/server-invites/${encodeURIComponent(code)}`);
  }
  createRole(id: Id, body: { name?: string; color?: number; permissions?: number; hoist?: boolean }): Promise<ServerRole> {
    return this.request("POST", `/api/servers/${id}/roles`, body);
  }
  updateRole(
    id: Id,
    roleId: Id,
    body: { name?: string; color?: number; permissions?: number; hoist?: boolean },
  ): Promise<void> {
    return this.request("PATCH", `/api/servers/${id}/roles/${roleId}`, body);
  }
  deleteRole(id: Id, roleId: Id): Promise<void> {
    return this.request("DELETE", `/api/servers/${id}/roles/${roleId}`);
  }
  /** Highest first, every role except @everyone. */
  orderRoles(id: Id, roleIds: Id[]): Promise<void> {
    return this.request("PUT", `/api/servers/${id}/roles/order`, { role_ids: roleIds });
  }
  createCategory(id: Id, name: string): Promise<ServerCategory> {
    return this.request("POST", `/api/servers/${id}/categories`, { name });
  }
  updateCategory(id: Id, categoryId: Id, name: string): Promise<void> {
    return this.request("PATCH", `/api/servers/${id}/categories/${categoryId}`, { name });
  }
  deleteCategory(id: Id, categoryId: Id): Promise<void> {
    return this.request("DELETE", `/api/servers/${id}/categories/${categoryId}`);
  }
  createChannel(id: Id, body: { name: string; kind: "text" | "voice"; category_id?: Id | null; topic?: string }): Promise<void> {
    return this.request("POST", `/api/servers/${id}/channels`, body);
  }
  updateChannel(id: Id, channelId: Id, body: { name?: string; topic?: string }): Promise<void> {
    return this.request("PATCH", `/api/servers/${id}/channels/${channelId}`, body);
  }
  deleteChannel(id: Id, channelId: Id): Promise<void> {
    return this.request("DELETE", `/api/servers/${id}/channels/${channelId}`);
  }
  setServerLayout(
    id: Id,
    body: { categories?: { id: Id; position: number }[]; channels?: { id: Id; category_id: Id | null; position: number }[] },
  ): Promise<void> {
    return this.request("PUT", `/api/servers/${id}/layout`, body);
  }
  /** Moves a member who is in a voice channel of the server to another one (Move Members). */
  moveVoiceMember(id: Id, userId: Id, channelId: Id): Promise<void> {
    return this.request("POST", `/api/servers/${id}/voice/move`, { user_id: userId, channel_id: channelId });
  }
  putOverwrite(id: Id, targetId: Id, roleId: Id, allow: number, deny: number): Promise<void> {
    return this.request("PUT", `/api/servers/${id}/overwrites/${targetId}/${roleId}`, { allow, deny });
  }
  deleteOverwrite(id: Id, targetId: Id, roleId: Id): Promise<void> {
    return this.request("DELETE", `/api/servers/${id}/overwrites/${targetId}/${roleId}`);
  }

  // ---- calls ----
  activeCalls(): Promise<Call[]> {
    return this.request("GET", "/api/calls");
  }
  startCall(conversationId: Id): Promise<CallJoin> {
    return this.request("POST", `/api/conversations/${conversationId}/call`, {});
  }
  joinCall(callId: Id): Promise<CallJoin> {
    return this.request("POST", `/api/calls/${callId}/join`, {});
  }
  leaveCall(callId: Id): Promise<void> {
    return this.request("POST", `/api/calls/${callId}/leave`, {});
  }
  endCall(callId: Id): Promise<void> {
    return this.request("POST", `/api/calls/${callId}/end`, {});
  }
  updateCallState(
    callId: Id,
    state: Partial<Pick<CallParticipant, "muted" | "deafened" | "video" | "screen">>,
  ): Promise<CallParticipant> {
    return this.request("PATCH", `/api/calls/${callId}/state`, state);
  }

  // ---- admin ----
  createInvite(opts: { max_uses?: number; expires_in?: string }): Promise<Invite> {
    return this.request("POST", "/api/admin/invites", opts);
  }
  invites(): Promise<Invite[]> {
    return this.request("GET", "/api/admin/invites");
  }
  revokeInvite(code: string): Promise<void> {
    return this.request("DELETE", `/api/admin/invites/${encodeURIComponent(code)}`);
  }
  adminUsers(): Promise<AdminUser[]> {
    return this.request("GET", "/api/admin/users");
  }
  setUserDisabled(id: Id, disabled: boolean): Promise<void> {
    return this.request("POST", `/api/admin/users/${id}/${disabled ? "disable" : "enable"}`, {});
  }
}
