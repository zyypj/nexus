//! Wire types shared by REST responses and gateway events. Field names are
//! snake_case; the TypeScript mirror lives in `packages/protocol`.

use serde::{Deserialize, Serialize};

use crate::storage::avatar_url;

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct UserRow {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub avatar: Option<String>,
    pub bio: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PublicUser {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
    pub bio: String,
}

impl From<UserRow> for PublicUser {
    fn from(r: UserRow) -> Self {
        Self {
            avatar_url: avatar_url(&r.avatar),
            id: r.id,
            username: r.username,
            display_name: r.display_name,
            bio: r.bio,
        }
    }
}

/// Column list for [`UserRow`] with the `users` table aliased as `u`. A macro so
/// it can be spliced into `concat!` and keep queries `&'static str`.
#[macro_export]
macro_rules! user_columns {
    () => {
        "u.id, u.username, u.display_name, u.avatar, u.bio"
    };
}

#[derive(Debug, Clone, Serialize)]
pub struct Me {
    #[serde(flatten)]
    pub user: PublicUser,
    pub status: UserStatus,
    pub is_admin: bool,
    pub created_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UserStatus {
    Online,
    Idle,
    Dnd,
    Invisible,
}

impl UserStatus {
    pub fn parse(s: &str) -> Self {
        match s {
            "idle" => Self::Idle,
            "dnd" => Self::Dnd,
            "invisible" => Self::Invisible,
            _ => Self::Online,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Online => "online",
            Self::Idle => "idle",
            Self::Dnd => "dnd",
            Self::Invisible => "invisible",
        }
    }
}

/// What other users see. `Invisible` is reported as `Offline`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Presence {
    Online,
    Idle,
    Dnd,
    Offline,
}

impl Presence {
    pub fn visible(connected: bool, status: UserStatus) -> Self {
        match (connected, status) {
            (false, _) | (true, UserStatus::Invisible) => Self::Offline,
            (true, UserStatus::Online) => Self::Online,
            (true, UserStatus::Idle) => Self::Idle,
            (true, UserStatus::Dnd) => Self::Dnd,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct PresenceUpdate {
    pub user_id: String,
    pub status: Presence,
}

#[derive(Debug, Clone, Serialize)]
pub struct Friend {
    pub user: PublicUser,
    pub since: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct FriendRequest {
    pub id: String,
    pub from: PublicUser,
    pub to: PublicUser,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Relationships {
    pub friends: Vec<Friend>,
    pub incoming: Vec<FriendRequest>,
    pub outgoing: Vec<FriendRequest>,
    pub blocked: Vec<PublicUser>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConversationKind {
    Dm,
    Group,
    /// Server text channel.
    Text,
    /// Server voice channel.
    Voice,
}

impl ConversationKind {
    pub fn is_channel(self) -> bool {
        matches!(self, Self::Text | Self::Voice)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Conversation {
    pub id: String,
    pub kind: ConversationKind,
    pub name: Option<String>,
    pub owner_id: Option<String>,
    pub members: Vec<PublicUser>,
    pub last_message_id: Option<String>,
    pub created_at: i64,
    /// Server channels only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topic: Option<String>,
}

/// Conversation plus per-viewer read state.
#[derive(Debug, Clone, Serialize)]
pub struct ConversationView {
    #[serde(flatten)]
    pub conversation: Conversation,
    pub last_read_message_id: Option<String>,
    pub unread_count: i64,
    /// Server channels: the viewer's effective permissions (see permissions.rs).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permissions: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ServerRole {
    pub id: String,
    pub name: String,
    /// 0xRRGGBB; 0 = no color.
    pub color: i64,
    pub position: i64,
    pub permissions: i64,
    /// Shown as its own group in the member list.
    pub hoist: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ServerCategory {
    pub id: String,
    pub name: String,
    pub position: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct PermissionOverwrite {
    /// Category or channel id.
    pub target_id: String,
    pub role_id: String,
    pub allow: i64,
    pub deny: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ServerMember {
    pub user: PublicUser,
    pub nickname: Option<String>,
    /// Without @everyone.
    pub role_ids: Vec<String>,
    pub joined_at: i64,
}

/// A server as seen by one member: only the channels they can view, with
/// their permissions in each.
#[derive(Debug, Clone, Serialize)]
pub struct ServerView {
    pub id: String,
    pub name: String,
    pub icon_url: Option<String>,
    pub owner_id: String,
    pub created_at: i64,
    /// The viewer's server-level permissions.
    pub permissions: i64,
    /// Highest first; the last one is @everyone (id = server id).
    pub roles: Vec<ServerRole>,
    pub categories: Vec<ServerCategory>,
    pub channels: Vec<ConversationView>,
    pub overwrites: Vec<PermissionOverwrite>,
    pub members: Vec<ServerMember>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ServerInvite {
    pub code: String,
    pub server_id: String,
    pub created_by: Option<String>,
    pub max_uses: Option<i64>,
    pub uses: i64,
    pub expires_at: Option<i64>,
    pub created_at: i64,
}

/// What someone holding an invite code sees before joining.
#[derive(Debug, Clone, Serialize)]
pub struct ServerInvitePreview {
    pub code: String,
    pub server_id: String,
    pub name: String,
    pub icon_url: Option<String>,
    pub member_count: i64,
    pub already_member: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ServerBan {
    pub user: PublicUser,
    pub reason: Option<String>,
    pub banned_by: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Attachment {
    pub id: String,
    pub file_name: String,
    pub content_type: String,
    pub size: i64,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Reaction {
    pub emoji: String,
    pub user_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReplyPreview {
    pub id: String,
    pub author_id: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Message {
    pub id: String,
    pub conversation_id: String,
    pub author_id: String,
    pub content: String,
    pub reply_to: Option<ReplyPreview>,
    pub attachments: Vec<Attachment>,
    pub reactions: Vec<Reaction>,
    pub created_at: i64,
    pub edited_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CallParticipant {
    pub user_id: String,
    pub joined_at: i64,
    pub muted: bool,
    pub deafened: bool,
    pub video: bool,
    pub screen: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Call {
    pub id: String,
    pub conversation_id: String,
    pub room_name: String,
    pub started_by: Option<String>,
    pub created_at: i64,
    pub ended_at: Option<i64>,
    pub participants: Vec<CallParticipant>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CallJoin {
    pub call: Call,
    pub livekit_url: String,
    pub livekit_token: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Invite {
    pub code: String,
    pub max_uses: Option<i64>,
    pub uses: i64,
    pub expires_at: Option<i64>,
    pub revoked: bool,
    pub created_at: i64,
}
