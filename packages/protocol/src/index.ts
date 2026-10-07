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

export type ConversationKind = "dm" | "group";

export interface Conversation {
  id: Id;
  kind: ConversationKind;
  name: string | null;
  owner_id: Id | null;
  members: PublicUser[];
  last_message_id: Id | null;
  created_at: Timestamp;
}

export interface ConversationView extends Conversation {
  last_read_message_id: Id | null;
  /** Capped at 100 by the server. */
  unread_count: number;
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
