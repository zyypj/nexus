// Wire types for the Nexus API. Keep in sync with services/server/src/models.rs
// and services/server/src/gateway/events.rs.

export type Id = string;
/** Unix milliseconds. */
export type Timestamp = number;

export interface PublicUser {
  id: Id;
  username: string;
  display_name: string;
  avatar_url: string | null;
  bio: string;
}

export type UserStatus = "online" | "idle" | "dnd" | "invisible";
export type Presence = "online" | "idle" | "dnd" | "offline";

export interface Me extends PublicUser {
  status: UserStatus;
  is_admin: boolean;
  created_at: Timestamp;
}

export interface PresenceUpdate {
  user_id: Id;
  status: Presence;
}

export interface Friend {
  user: PublicUser;
  since: Timestamp;
}

export interface FriendRequest {
  id: Id;
  from: PublicUser;
  to: PublicUser;
  created_at: Timestamp;
}

export interface Relationships {
  friends: Friend[];
  incoming: FriendRequest[];
  outgoing: FriendRequest[];
  blocked: PublicUser[];
}

/** "text"/"voice" are server channels; "dm"/"group" are private conversations. */
export type ConversationKind = "dm" | "group" | "text" | "voice";

export interface Conversation {
  id: Id;
  kind: ConversationKind;
  name: string | null;
  owner_id: Id | null;
  /** Empty for server channels (access comes from the server). */
  members: PublicUser[];
  last_message_id: Id | null;
  created_at: Timestamp;
  /** Server channels only. */
  server_id?: Id;
  category_id?: Id | null;
  position?: number;
  topic?: string | null;
}

export interface ConversationView extends Conversation {
  last_read_message_id: Id | null;
  /** Capped at 100 by the server. */
  unread_count: number;
  /** Server channels: the viewer's effective permissions (see `Permissions`). */
  permissions?: number;
}

export const isChannel = (c: Pick<Conversation, "kind">): boolean => c.kind === "text" || c.kind === "voice";

// ---- servers (guilds) ----

/** Permission bits; mirror of services/server/src/permissions.rs. */
export const Permissions = {
  VIEW_CHANNEL: 1 << 0,
  SEND_MESSAGES: 1 << 1,
  ATTACH_FILES: 1 << 2,
  ADD_REACTIONS: 1 << 3,
  MANAGE_MESSAGES: 1 << 4,
  CONNECT: 1 << 5,
  SPEAK: 1 << 6,
  /** Camera and screen share in voice channels. */
  VIDEO: 1 << 7,
  CREATE_INVITE: 1 << 8,
  KICK_MEMBERS: 1 << 9,
  BAN_MEMBERS: 1 << 10,
  MANAGE_CHANNELS: 1 << 11,
  MANAGE_ROLES: 1 << 12,
  MANAGE_SERVER: 1 << 13,
  ADMINISTRATOR: 1 << 14,
  CHANGE_NICKNAME: 1 << 15,
  MANAGE_NICKNAMES: 1 << 16,
  /** Move other members between voice channels. */
  MOVE_MEMBERS: 1 << 17,
} as const;
export type PermissionName = keyof typeof Permissions;
export const ALL_PERMISSIONS = (1 << 18) - 1;
/** Permissions that can be overridden per channel/category. */
export const CHANNEL_PERMISSIONS =
  Permissions.VIEW_CHANNEL |
  Permissions.SEND_MESSAGES |
  Permissions.ATTACH_FILES |
  Permissions.ADD_REACTIONS |
  Permissions.MANAGE_MESSAGES |
  Permissions.CONNECT |
  Permissions.SPEAK |
  Permissions.VIDEO;

export const hasPermission = (perms: number | undefined, p: number): boolean => ((perms ?? 0) & p) === p;

export interface ServerRole {
  id: Id;
  name: string;
  /** 0xRRGGBB; 0 = no color. */
  color: number;
  position: number;
  permissions: number;
  hoist: boolean;
}

export interface ServerCategory {
  id: Id;
  name: string;
  position: number;
}

export interface PermissionOverwrite {
  /** Category or channel id. */
  target_id: Id;
  role_id: Id;
  allow: number;
  deny: number;
}

export interface ServerMember {
  user: PublicUser;
  nickname: string | null;
  /** Without @everyone. */
  role_ids: Id[];
  joined_at: Timestamp;
}

/** A server as the current user sees it (only channels they can view). */
export interface ServerView {
  id: Id;
  name: string;
  icon_url: string | null;
  owner_id: Id;
  created_at: Timestamp;
  /** The current user's server-level permissions. */
  permissions: number;
  /** Highest first; the last one is @everyone (id = server id). */
  roles: ServerRole[];
  categories: ServerCategory[];
  channels: ConversationView[];
  /** Only filled for members who can manage roles/channels. */
  overwrites: PermissionOverwrite[];
  members: ServerMember[];
}

export interface ServerInvite {
  code: string;
  server_id: Id;
  created_by: Id | null;
  max_uses: number | null;
  uses: number;
  expires_at: Timestamp | null;
  created_at: Timestamp;
}

export interface ServerInvitePreview {
  code: string;
  server_id: Id;
  name: string;
  icon_url: string | null;
  member_count: number;
  already_member: boolean;
}

export interface ServerBan {
  user: PublicUser;
  reason: string | null;
  banned_by: Id | null;
  created_at: Timestamp;
}

export interface Attachment {
  id: Id;
  file_name: string;
  content_type: string;
  size: number;
  width: number | null;
  height: number | null;
  /** Relative signed URL; prefix with the server base URL. */
  url: string;
}

export interface Reaction {
  emoji: string;
  user_ids: Id[];
}

export interface ReplyPreview {
  id: Id;
  author_id: Id;
  content: string;
}

export interface Message {
  id: Id;
  conversation_id: Id;
  author_id: Id;
  content: string;
  reply_to: ReplyPreview | null;
  attachments: Attachment[];
  reactions: Reaction[];
  created_at: Timestamp;
  edited_at: Timestamp | null;
  /** Only on MESSAGE_CREATE sent back to the author's devices. */
  nonce?: string;
}

export interface CallParticipant {
  user_id: Id;
  joined_at: Timestamp;
  muted: boolean;
  deafened: boolean;
  video: boolean;
  screen: boolean;
}

export interface Call {
  id: Id;
  conversation_id: Id;
  room_name: string;
  started_by: Id | null;
  created_at: Timestamp;
  ended_at: Timestamp | null;
  participants: CallParticipant[];
}

export interface CallJoin {
  call: Call;
  livekit_url: string;
  livekit_token: string;
}

export interface Invite {
  code: string;
  max_uses: number | null;
  uses: number;
  expires_at: Timestamp | null;
  revoked: boolean;
  created_at: Timestamp;
}

export interface AdminUser {
  id: Id;
  username: string;
  display_name: string;
  is_admin: boolean;
  disabled: boolean;
  invite_code: string | null;
  created_at: Timestamp;
}

export interface SessionInfo {
  id: Id;
  device_name: string;
  created_at: Timestamp;
  last_used_at: Timestamp;
  current: boolean;
}

export interface AuthResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  session_id: Id;
  user: Me;
}

export interface ServerInfo {
  name: string;
  version: string;
  calls_enabled: boolean;
  max_upload_size: number;
}

export interface PublicServerInfo extends ServerInfo {
  public_registration: boolean;
}

export interface Ready {
  session_id: Id;
  user: Me;
  relationships: Relationships;
  conversations: ConversationView[];
  presences: PresenceUpdate[];
  calls: Call[];
  servers: ServerView[];
  server: ServerInfo;
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}

/** Dispatch events: name -> payload. */
export interface GatewayEvents {
  HELLO: { heartbeat_interval_ms: number };
  READY: Ready;
  HEARTBEAT_ACK: Record<string, never>;
  INVALID_SESSION: Record<string, never>;
  MESSAGE_CREATE: Message;
  MESSAGE_UPDATE: Message;
  MESSAGE_DELETE: { id: Id; conversation_id: Id };
  MESSAGE_REACTION_ADD: { conversation_id: Id; message_id: Id; user_id: Id; emoji: string };
  MESSAGE_REACTION_REMOVE: { conversation_id: Id; message_id: Id; user_id: Id; emoji: string };
  CONVERSATION_READ: { conversation_id: Id; message_id: Id };
  TYPING_START: { conversation_id: Id; user_id: Id };
  TYPING_STOP: { conversation_id: Id; user_id: Id };
  FRIEND_REQUEST: FriendRequest;
  FRIEND_REQUEST_DELETE: { id: Id };
  FRIEND_ACCEPT: { request_id: Id; friend: Friend };
  FRIEND_REMOVE: { user_id: Id };
  USER_BLOCK: PublicUser;
  USER_UNBLOCK: { user_id: Id };
  /** `Me` when it is about the current user, `PublicUser` otherwise. */
  USER_UPDATE: PublicUser | Me;
  PRESENCE_UPDATE: PresenceUpdate;
  CONVERSATION_CREATE: ConversationView;
  CONVERSATION_UPDATE: Conversation;
  CONVERSATION_DELETE: { id: Id };
  CALL_CREATE: Call;
  CALL_JOIN: { call_id: Id; conversation_id: Id; participant: CallParticipant };
  CALL_LEAVE: { call_id: Id; conversation_id: Id; user_id: Id };
  CALL_STATE_UPDATE: { call_id: Id; conversation_id: Id; participant: CallParticipant };
  CALL_END: { call_id: Id; conversation_id: Id };
  /**
   * Only for the member being moved to another voice channel: the device that
   * is in `from_call_id` joins `call_id` (which leaves the old call).
   */
  CALL_MOVE: { call_id: Id; conversation_id: Id; from_call_id: Id; moved_by: Id };
  /** Joined or created a server. */
  SERVER_CREATE: ServerView;
  /** Anything changed (members, roles, channels…): the full view again. */
  SERVER_UPDATE: ServerView;
  /** Left, kicked, banned or the server was deleted. */
  SERVER_DELETE: { id: Id };
}

export type GatewayEventName = keyof GatewayEvents;

export type GatewayFrame = {
  [K in GatewayEventName]: { t: K; d: GatewayEvents[K] };
}[GatewayEventName];

export type ClientOp =
  | { op: "IDENTIFY"; d: { token: string } }
  | { op: "HEARTBEAT" }
  | { op: "TYPING_START"; d: { conversation_id: Id } }
  | { op: "TYPING_STOP"; d: { conversation_id: Id } };

/** WebSocket close codes used by the server. */
export const CloseCodes = {
  /** Session revoked, account disabled or slow consumer. */
  SERVER_CLOSED: 4001,
  INVALID_PAYLOAD: 4002,
  HEARTBEAT_TIMEOUT: 4003,
  AUTH_FAILED: 4004,
  ALREADY_IDENTIFIED: 4005,
} as const;

export const MAX_MESSAGE_LENGTH = 4000;
export const MAX_ATTACHMENTS = 10;
export const MAX_GROUP_MEMBERS = 25;
