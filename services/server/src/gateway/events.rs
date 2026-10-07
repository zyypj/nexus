//! Gateway event names and audience resolution.

use crate::{db::Db, error::ApiResult};

// Server -> client control frames.
pub const HELLO: &str = "HELLO";
pub const READY: &str = "READY";
pub const HEARTBEAT_ACK: &str = "HEARTBEAT_ACK";
pub const INVALID_SESSION: &str = "INVALID_SESSION";

// Dispatch events.
pub const MESSAGE_CREATE: &str = "MESSAGE_CREATE";
pub const MESSAGE_UPDATE: &str = "MESSAGE_UPDATE";
pub const MESSAGE_DELETE: &str = "MESSAGE_DELETE";
pub const MESSAGE_REACTION_ADD: &str = "MESSAGE_REACTION_ADD";
pub const MESSAGE_REACTION_REMOVE: &str = "MESSAGE_REACTION_REMOVE";
pub const CONVERSATION_READ: &str = "CONVERSATION_READ";
pub const TYPING_START: &str = "TYPING_START";
pub const TYPING_STOP: &str = "TYPING_STOP";
pub const FRIEND_REQUEST: &str = "FRIEND_REQUEST";
pub const FRIEND_REQUEST_DELETE: &str = "FRIEND_REQUEST_DELETE";
pub const FRIEND_ACCEPT: &str = "FRIEND_ACCEPT";
pub const FRIEND_REMOVE: &str = "FRIEND_REMOVE";
pub const USER_BLOCK: &str = "USER_BLOCK";
pub const USER_UNBLOCK: &str = "USER_UNBLOCK";
pub const USER_UPDATE: &str = "USER_UPDATE";
pub const PRESENCE_UPDATE: &str = "PRESENCE_UPDATE";
pub const CONVERSATION_CREATE: &str = "CONVERSATION_CREATE";
pub const CONVERSATION_UPDATE: &str = "CONVERSATION_UPDATE";
pub const CONVERSATION_DELETE: &str = "CONVERSATION_DELETE";
pub const CALL_CREATE: &str = "CALL_CREATE";
pub const CALL_JOIN: &str = "CALL_JOIN";
pub const CALL_LEAVE: &str = "CALL_LEAVE";
pub const CALL_STATE_UPDATE: &str = "CALL_STATE_UPDATE";
pub const CALL_END: &str = "CALL_END";

pub async fn conversation_members(db: &Db, conversation_id: &str) -> ApiResult<Vec<String>> {
    let rows: Vec<(String,)> = sqlx::query_as("SELECT user_id FROM conversation_members WHERE conversation_id = ?")
        .bind(conversation_id)
        .fetch_all(db)
        .await?;
    Ok(rows.into_iter().map(|r| r.0).collect())
}

/// Users who may see `user_id`'s presence and profile: friends plus anyone
/// sharing a conversation. Includes the user themself (other devices).
pub async fn user_audience(db: &Db, user_id: &str) -> ApiResult<Vec<String>> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT user_b FROM friendships WHERE user_a = ?1
         UNION SELECT user_a FROM friendships WHERE user_b = ?1
         UNION SELECT DISTINCT m2.user_id FROM conversation_members m1
               JOIN conversation_members m2 ON m2.conversation_id = m1.conversation_id
               WHERE m1.user_id = ?1",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;
    let mut out: Vec<String> = rows.into_iter().map(|r| r.0).collect();
    if !out.iter().any(|u| u == user_id) {
        out.push(user_id.to_string());
    }
    Ok(out)
}
