use std::collections::HashMap;

use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use serde::Deserialize;
use serde_json::json;

use super::{
    common::{ApiJson, clean_text, validate_id},
    conversations::{ensure_dm_not_blocked, require_member},
};
use crate::{
    auth::AuthUser,
    db::{Db, new_id, now_ms},
    error::{ApiError, ApiResult},
    gateway::events::{self, conversation_members},
    models::{Attachment, ConversationKind, Message, Reaction, ReplyPreview},
    rate_limit::rules,
    state::AppState,
    storage::Storage,
};

pub const MAX_CONTENT_CHARS: usize = 4000;
pub const MAX_ATTACHMENTS: usize = 10;
const MAX_DISTINCT_REACTIONS: i64 = 20;

#[derive(sqlx::FromRow)]
struct MessageRow {
    id: String,
    conversation_id: String,
    author_id: String,
    content: String,
    reply_to_id: Option<String>,
    reply_author_id: Option<String>,
    reply_content: Option<String>,
    created_at: i64,
    edited_at: Option<i64>,
}

macro_rules! message_select {
    () => {
        "SELECT m.id, m.conversation_id, m.author_id, m.content, m.reply_to_id,
        r.author_id AS reply_author_id, r.content AS reply_content, m.created_at, m.edited_at
    FROM messages m LEFT JOIN messages r ON r.id = m.reply_to_id"
    };
}

#[derive(sqlx::FromRow)]
struct AttachmentRow {
    id: String,
    message_id: Option<String>,
    file_name: String,
    content_type: String,
    size: i64,
    width: Option<i64>,
    height: Option<i64>,
}

fn attachment_from_row(storage: &Storage, r: AttachmentRow, now: i64) -> Attachment {
    Attachment {
        url: storage.signed_file_url(&r.id, &r.file_name, now),
        id: r.id,
        file_name: r.file_name,
        content_type: r.content_type,
        size: r.size,
        width: r.width,
        height: r.height,
    }
}

fn placeholders(n: usize) -> String {
    vec!["?"; n].join(",")
}

/// Hydrates rows with attachments and reactions using two batched queries.
async fn hydrate(db: &Db, storage: &Storage, rows: Vec<MessageRow>) -> ApiResult<Vec<Message>> {
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
    let ph = placeholders(ids.len());

    let sql = format!(
        "SELECT id, message_id, file_name, content_type, size, width, height
         FROM message_attachments WHERE message_id IN ({ph}) ORDER BY id"
    );
    // Only "?" placeholders are interpolated; values are bound.
    let mut q = sqlx::query_as::<_, AttachmentRow>(sqlx::AssertSqlSafe(sql));
    for id in &ids {
        q = q.bind(*id);
    }
    let now = now_ms();
    let mut attachments: HashMap<String, Vec<Attachment>> = HashMap::new();
    for a in q.fetch_all(db).await? {
        let mid = a.message_id.clone().unwrap_or_default();
        attachments
            .entry(mid)
            .or_default()
            .push(attachment_from_row(storage, a, now));
    }

    let sql = format!(
        "SELECT message_id, emoji, user_id FROM message_reactions
         WHERE message_id IN ({ph}) ORDER BY created_at"
    );
    let mut q = sqlx::query_as::<_, (String, String, String)>(sqlx::AssertSqlSafe(sql));
    for id in &ids {
        q = q.bind(*id);
    }
    let mut reactions: HashMap<String, Vec<Reaction>> = HashMap::new();
    for (mid, emoji, uid) in q.fetch_all(db).await? {
        let list = reactions.entry(mid).or_default();
        match list.iter_mut().find(|r| r.emoji == emoji) {
            Some(r) => r.user_ids.push(uid),
            None => list.push(Reaction {
                emoji,
                user_ids: vec![uid],
            }),
        }
    }

    Ok(rows
        .into_iter()
        .map(|r| Message {
            attachments: attachments.remove(&r.id).unwrap_or_default(),
            reactions: reactions.remove(&r.id).unwrap_or_default(),
            reply_to: match (r.reply_to_id, r.reply_author_id, r.reply_content) {
                (Some(id), Some(author_id), Some(content)) => Some(ReplyPreview {
                    id,
                    author_id,
                    content: content.chars().take(200).collect(),
                }),
                _ => None,
            },
            id: r.id,
            conversation_id: r.conversation_id,
            author_id: r.author_id,
            content: r.content,
            created_at: r.created_at,
            edited_at: r.edited_at,
        })
        .collect())
}

pub async fn load_message(db: &Db, storage: &Storage, conversation_id: &str, message_id: &str) -> ApiResult<Message> {
    let row: Option<MessageRow> =
        sqlx::query_as(concat!(message_select!(), " WHERE m.id = ? AND m.conversation_id = ?"))
            .bind(message_id)
            .bind(conversation_id)
            .fetch_optional(db)
            .await?;
    let row = row.ok_or(ApiError::NotFound("message"))?;
    Ok(hydrate(db, storage, vec![row]).await?.remove(0))
}

#[derive(Deserialize)]
pub struct HistoryQuery {
    pub before: Option<String>,
    pub after: Option<String>,
    pub limit: Option<i64>,
}

/// Newest-first pages with `before`, oldest-first with `after` (used to
/// re-sync after a reconnect). Results are always returned oldest-first.
pub async fn history(
    State(state): State<AppState>,
    user: AuthUser,
    Path(conversation_id): Path<String>,
    Query(q): Query<HistoryQuery>,
) -> ApiResult<Json<Vec<Message>>> {
    require_member(&state.db, &conversation_id, &user.id).await?;
    let limit = q.limit.unwrap_or(50).clamp(1, 100);
    let rows: Vec<MessageRow> = if let Some(after) = q.after {
        sqlx::query_as(concat!(
            message_select!(),
            " WHERE m.conversation_id = ? AND m.id > ? ORDER BY m.id ASC LIMIT ?"
        ))
        .bind(&conversation_id)
        .bind(after)
        .bind(limit)
        .fetch_all(&state.db)
        .await?
    } else {
        let mut rows: Vec<MessageRow> = sqlx::query_as(concat!(
            message_select!(),
            " WHERE m.conversation_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?"
        ))
        .bind(&conversation_id)
        // 'g' sorts after every hex digit, i.e. "no upper bound".
        .bind(q.before.unwrap_or_else(|| "g".into()))
        .bind(limit)
        .fetch_all(&state.db)
        .await?;
        rows.reverse();
        rows
    };
    Ok(Json(hydrate(&state.db, &state.storage, rows).await?))
}

#[derive(Deserialize)]
pub struct CreateMessage {
    #[serde(default)]
    pub content: String,
    pub reply_to_id: Option<String>,
    #[serde(default)]
    pub attachment_ids: Vec<String>,
    /// Echoed back in MESSAGE_CREATE so the sender can match its optimistic copy.
    pub nonce: Option<String>,
}

fn validate_content(raw: &str) -> ApiResult<String> {
    let content = clean_text(raw);
    if content.chars().count() > MAX_CONTENT_CHARS {
        return Err(ApiError::bad(format!(
            "message must be at most {MAX_CONTENT_CHARS} characters"
        )));
    }
    Ok(content)
}

pub async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    Path(conversation_id): Path<String>,
    ApiJson(body): ApiJson<CreateMessage>,
) -> ApiResult<(StatusCode, Json<Message>)> {
    state.limiter.check("message", &user.id, rules::MESSAGE)?;
    let kind = require_member(&state.db, &conversation_id, &user.id).await?;
    ensure_dm_not_blocked(&state.db, &conversation_id, kind, &user.id).await?;
    if kind == ConversationKind::Voice {
        return Err(ApiError::bad("voice channels have no chat"));
    }
    if kind.is_channel() {
        let p = crate::permissions::require_channel_perm(
            &state.db,
            &conversation_id,
            &user.id,
            crate::permissions::SEND_MESSAGES,
            "you cannot send messages in this channel",
        )
        .await?;
        if !body.attachment_ids.is_empty() && p & crate::permissions::ATTACH_FILES == 0 {
            return Err(ApiError::Forbidden("you cannot attach files in this channel"));
        }
    }
    let content = validate_content(&body.content)?;
    if body.attachment_ids.len() > MAX_ATTACHMENTS {
        return Err(ApiError::bad(format!(
            "at most {MAX_ATTACHMENTS} attachments per message"
        )));
    }
    if content.is_empty() && body.attachment_ids.is_empty() {
        return Err(ApiError::bad("message cannot be empty"));
    }
    if let Some(reply) = &body.reply_to_id {
        validate_id(reply)?;
        let ok: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM messages WHERE id = ? AND conversation_id = ?")
            .bind(reply)
            .bind(&conversation_id)
            .fetch_optional(&state.db)
            .await?;
        if ok.is_none() {
            return Err(ApiError::bad("reply target not found"));
        }
    }

    let id = new_id();
    let now = now_ms();
    let mut tx = state.db.begin().await?;
    sqlx::query(
        "INSERT INTO messages (id, conversation_id, author_id, content, reply_to_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&conversation_id)
    .bind(&user.id)
    .bind(&content)
    .bind(&body.reply_to_id)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    for att in &body.attachment_ids {
        validate_id(att).map_err(|_| ApiError::bad("invalid attachment id"))?;
        let res = sqlx::query(
            "UPDATE message_attachments SET message_id = ?
             WHERE id = ? AND uploader_id = ? AND conversation_id = ? AND message_id IS NULL",
        )
        .bind(&id)
        .bind(att)
        .bind(&user.id)
        .bind(&conversation_id)
        .execute(&mut *tx)
        .await?;
        if res.rows_affected() != 1 {
            return Err(ApiError::bad("attachment not found or already used"));
        }
    }
    sqlx::query("UPDATE conversations SET last_message_id = ? WHERE id = ?")
        .bind(&id)
        .bind(&conversation_id)
        .execute(&mut *tx)
        .await?;
    // Your own message counts as read.
    if kind.is_channel() {
        super::conversations::mark_channel_read(&mut *tx, &conversation_id, &user.id, &id).await?;
    } else {
        sqlx::query(
            "UPDATE conversation_members SET last_read_message_id = ? WHERE conversation_id = ? AND user_id = ?",
        )
        .bind(&id)
        .bind(&conversation_id)
        .bind(&user.id)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    let message = load_message(&state.db, &state.storage, &conversation_id, &id).await?;
    let members = conversation_members(&state.db, &conversation_id).await?;
    let mut payload = serde_json::to_value(&message).map_err(anyhow::Error::from)?;
    if let Some(nonce) = body.nonce.filter(|n| n.len() <= 64) {
        payload["nonce"] = json!(nonce);
    }
    state
        .hub
        .send(members.iter().map(String::as_str), events::MESSAGE_CREATE, &payload);
    Ok((StatusCode::CREATED, Json(message)))
}

#[derive(Deserialize)]
pub struct EditMessage {
    pub content: String,
}

pub async fn edit(
    State(state): State<AppState>,
    user: AuthUser,
    Path((conversation_id, message_id)): Path<(String, String)>,
    ApiJson(body): ApiJson<EditMessage>,
) -> ApiResult<Json<Message>> {
    state.limiter.check("message", &user.id, rules::MESSAGE)?;
    let kind = require_member(&state.db, &conversation_id, &user.id).await?;
    ensure_dm_not_blocked(&state.db, &conversation_id, kind, &user.id).await?;
    validate_id(&message_id)?;
    let existing = load_message(&state.db, &state.storage, &conversation_id, &message_id).await?;
    if existing.author_id != user.id {
        return Err(ApiError::Forbidden("you can only edit your own messages"));
    }
    let content = validate_content(&body.content)?;
    if content.is_empty() && existing.attachments.is_empty() {
        return Err(ApiError::bad("message cannot be empty"));
    }
    if content == existing.content {
        return Ok(Json(existing));
    }
    sqlx::query("UPDATE messages SET content = ?, edited_at = ? WHERE id = ?")
        .bind(&content)
        .bind(now_ms())
        .bind(&message_id)
        .execute(&state.db)
        .await?;
    let message = load_message(&state.db, &state.storage, &conversation_id, &message_id).await?;
    let members = conversation_members(&state.db, &conversation_id).await?;
    state
        .hub
        .send(members.iter().map(String::as_str), events::MESSAGE_UPDATE, &message);
    Ok(Json(message))
}

pub async fn delete(
    State(state): State<AppState>,
    user: AuthUser,
    Path((conversation_id, message_id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let kind = require_member(&state.db, &conversation_id, &user.id).await?;
    validate_id(&message_id)?;
    let row: Option<(String,)> = sqlx::query_as("SELECT author_id FROM messages WHERE id = ? AND conversation_id = ?")
        .bind(&message_id)
        .bind(&conversation_id)
        .fetch_optional(&state.db)
        .await?;
    let (author_id,) = row.ok_or(ApiError::NotFound("message"))?;
    if author_id != user.id {
        let owner: Option<(Option<String>,)> = sqlx::query_as("SELECT owner_id FROM conversations WHERE id = ?")
            .bind(&conversation_id)
            .fetch_optional(&state.db)
            .await?;
        let is_owner = kind == ConversationKind::Group && owner.and_then(|o| o.0).as_deref() == Some(user.id.as_str());
        let moderator = kind.is_channel()
            && crate::permissions::require_channel_perm(
                &state.db,
                &conversation_id,
                &user.id,
                crate::permissions::MANAGE_MESSAGES,
                "",
            )
            .await
            .is_ok();
        if !is_owner && !moderator {
            return Err(ApiError::Forbidden("you can only delete your own messages"));
        }
    }

    let files: Vec<(String,)> = sqlx::query_as("SELECT storage_name FROM message_attachments WHERE message_id = ?")
        .bind(&message_id)
        .fetch_all(&state.db)
        .await?;
    let mut tx = state.db.begin().await?;
    sqlx::query("DELETE FROM messages WHERE id = ?")
        .bind(&message_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "UPDATE conversations SET last_message_id =
            (SELECT MAX(id) FROM messages WHERE conversation_id = ?1) WHERE id = ?1",
    )
    .bind(&conversation_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    for (name,) in files {
        if let Some(p) = state.storage.file_path(&name) {
            let _ = tokio::fs::remove_file(p).await;
        }
    }

    let members = conversation_members(&state.db, &conversation_id).await?;
    state.hub.send(
        members.iter().map(String::as_str),
        events::MESSAGE_DELETE,
        &json!({ "id": message_id, "conversation_id": conversation_id }),
    );
    Ok(StatusCode::NO_CONTENT)
}

fn validate_emoji(raw: &str) -> ApiResult<&str> {
    let ok = !raw.is_empty()
        && raw.len() <= 64
        && raw.chars().count() <= 16
        && !raw.chars().any(|c| c.is_whitespace() || c.is_control())
        && !raw.is_ascii();
    if ok {
        Ok(raw)
    } else {
        Err(ApiError::bad("invalid emoji"))
    }
}

pub async fn add_reaction(
    State(state): State<AppState>,
    user: AuthUser,
    Path((conversation_id, message_id, emoji)): Path<(String, String, String)>,
) -> ApiResult<StatusCode> {
    state.limiter.check("message", &user.id, rules::MESSAGE)?;
    let kind = require_member(&state.db, &conversation_id, &user.id).await?;
    ensure_dm_not_blocked(&state.db, &conversation_id, kind, &user.id).await?;
    if kind.is_channel() {
        crate::permissions::require_channel_perm(
            &state.db,
            &conversation_id,
            &user.id,
            crate::permissions::ADD_REACTIONS,
            "you cannot react in this channel",
        )
        .await?;
    }
    validate_id(&message_id)?;
    let emoji = validate_emoji(&emoji)?;
    let exists: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM messages WHERE id = ? AND conversation_id = ?")
        .bind(&message_id)
        .bind(&conversation_id)
        .fetch_optional(&state.db)
        .await?;
    if exists.is_none() {
        return Err(ApiError::NotFound("message"));
    }
    let (distinct,): (i64,) =
        sqlx::query_as("SELECT COUNT(DISTINCT emoji) FROM message_reactions WHERE message_id = ? AND emoji != ?")
            .bind(&message_id)
            .bind(emoji)
            .fetch_one(&state.db)
            .await?;
    if distinct >= MAX_DISTINCT_REACTIONS {
        return Err(ApiError::bad("too many different reactions on this message"));
    }
    let res = sqlx::query(
        "INSERT OR IGNORE INTO message_reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(&message_id)
    .bind(&user.id)
    .bind(emoji)
    .bind(now_ms())
    .execute(&state.db)
    .await?;
    if res.rows_affected() == 1 {
        let members = conversation_members(&state.db, &conversation_id).await?;
        state.hub.send(
            members.iter().map(String::as_str),
            events::MESSAGE_REACTION_ADD,
            &json!({ "conversation_id": conversation_id, "message_id": message_id, "user_id": user.id, "emoji": emoji }),
        );
    }
    Ok(StatusCode::NO_CONTENT)
}

pub async fn remove_reaction(
    State(state): State<AppState>,
    user: AuthUser,
    Path((conversation_id, message_id, emoji)): Path<(String, String, String)>,
) -> ApiResult<StatusCode> {
    require_member(&state.db, &conversation_id, &user.id).await?;
    validate_id(&message_id)?;
    let res = sqlx::query("DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?")
        .bind(&message_id)
        .bind(&user.id)
        .bind(&emoji)
        .execute(&state.db)
        .await?;
    if res.rows_affected() == 1 {
        let members = conversation_members(&state.db, &conversation_id).await?;
        state.hub.send(
            members.iter().map(String::as_str),
            events::MESSAGE_REACTION_REMOVE,
            &json!({ "conversation_id": conversation_id, "message_id": message_id, "user_id": user.id, "emoji": emoji }),
        );
    }
    Ok(StatusCode::NO_CONTENT)
}
