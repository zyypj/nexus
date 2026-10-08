use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use serde::Deserialize;
use serde_json::json;

use super::{
    common::{ApiJson, clean_text, validate_id},
    friends::{are_friends, is_blocked_either},
};
use crate::{
    auth::AuthUser,
    db::{Db, new_id, now_ms},
    error::{ApiError, ApiResult},
    gateway::events::{self, conversation_members},
    models::{Conversation, ConversationKind, ConversationView, PublicUser, UserRow},
    state::AppState,
};

pub const MAX_GROUP_MEMBERS: usize = 25;

#[derive(sqlx::FromRow)]
pub struct ConversationRow {
    pub id: String,
    pub kind: String,
    pub name: Option<String>,
    pub owner_id: Option<String>,
    pub last_message_id: Option<String>,
    pub created_at: i64,
    pub server_id: Option<String>,
    pub category_id: Option<String>,
    pub position: i64,
    pub topic: Option<String>,
}

/// Columns of [`ConversationRow`] (a macro so queries stay static strings).
#[macro_export]
macro_rules! conversation_columns {
    () => {
        "id, kind, name, owner_id, last_message_id, created_at, server_id, category_id, position, topic"
    };
}

pub fn kind_of(s: &str) -> ConversationKind {
    match s {
        "dm" => ConversationKind::Dm,
        "text" => ConversationKind::Text,
        "voice" => ConversationKind::Voice,
        _ => ConversationKind::Group,
    }
}

impl ConversationRow {
    /// A server channel (no member list: access comes from the server).
    pub fn into_channel(self) -> Conversation {
        Conversation {
            id: self.id,
            kind: kind_of(&self.kind),
            name: self.name,
            owner_id: None,
            members: Vec::new(),
            last_message_id: self.last_message_id,
            created_at: self.created_at,
            position: Some(self.position),
            server_id: self.server_id,
            category_id: self.category_id,
            topic: self.topic,
        }
    }
}

pub async fn load_conversation(db: &Db, id: &str) -> ApiResult<Conversation> {
    let row: Option<ConversationRow> = sqlx::query_as(concat!(
        "SELECT ",
        crate::conversation_columns!(),
        " FROM conversations WHERE id = ?"
    ))
    .bind(id)
    .fetch_optional(db)
    .await?;
    let row = row.ok_or(ApiError::NotFound("conversation"))?;
    if row.server_id.is_some() {
        return Ok(row.into_channel());
    }
    let members: Vec<UserRow> = sqlx::query_as(concat!(
        "SELECT ",
        crate::user_columns!(),
        " FROM conversation_members m JOIN users u ON u.id = m.user_id
         WHERE m.conversation_id = ? ORDER BY m.joined_at"
    ))
    .bind(id)
    .fetch_all(db)
    .await?;
    Ok(Conversation {
        id: row.id,
        kind: kind_of(&row.kind),
        name: row.name,
        owner_id: row.owner_id,
        members: members.into_iter().map(PublicUser::from).collect(),
        last_message_id: row.last_message_id,
        created_at: row.created_at,
        server_id: None,
        category_id: None,
        position: None,
        topic: None,
    })
}

/// Read state + unread count of a server channel for one user.
pub async fn channel_view(
    db: &Db,
    channel: Conversation,
    viewer: &str,
    permissions: i64,
) -> ApiResult<ConversationView> {
    let row: Option<(Option<String>,)> =
        sqlx::query_as("SELECT last_read_message_id FROM channel_reads WHERE channel_id = ? AND user_id = ?")
            .bind(&channel.id)
            .bind(viewer)
            .fetch_optional(db)
            .await?;
    let last_read = row.and_then(|r| r.0);
    // Text channels count unread; voice channels have no chat. Joining a
    // server seeds the read markers (see servers::seed_reads), so a new member
    // does not start with every old message unread.
    let unread_count = if channel.kind == ConversationKind::Text {
        unread_count(db, &channel.id, viewer, last_read.as_deref()).await?
    } else {
        0
    };
    Ok(ConversationView {
        conversation: channel,
        last_read_message_id: last_read,
        unread_count,
        permissions: Some(permissions),
    })
}

/// Moves a channel read marker forward (never backwards).
pub async fn mark_channel_read<'e, E: sqlx::SqliteExecutor<'e>>(
    db: E,
    channel_id: &str,
    user_id: &str,
    message_id: &str,
) -> ApiResult<()> {
    sqlx::query(
        "INSERT INTO channel_reads (channel_id, user_id, last_read_message_id) VALUES (?1, ?2, ?3)
         ON CONFLICT (channel_id, user_id) DO UPDATE SET last_read_message_id = excluded.last_read_message_id
         WHERE channel_reads.last_read_message_id IS NULL OR channel_reads.last_read_message_id < excluded.last_read_message_id",
    )
    .bind(channel_id)
    .bind(user_id)
    .bind(message_id)
    .execute(db)
    .await?;
    Ok(())
}

pub async fn conversation_view(db: &Db, id: &str, viewer: &str) -> ApiResult<ConversationView> {
    let conversation = load_conversation(db, id).await?;
    if let Some(server_id) = conversation.server_id.clone() {
        let perms = crate::permissions::channel_permissions(
            db,
            &server_id,
            conversation.category_id.as_deref(),
            &conversation.id,
            viewer,
        )
        .await?;
        if perms & crate::permissions::VIEW_CHANNEL == 0 {
            return Err(ApiError::NotFound("conversation"));
        }
        return channel_view(db, conversation, viewer, perms).await;
    }
    let row: Option<(Option<String>,)> = sqlx::query_as(
        "SELECT last_read_message_id FROM conversation_members WHERE conversation_id = ? AND user_id = ?",
    )
    .bind(id)
    .bind(viewer)
    .fetch_optional(db)
    .await?;
    let (last_read,) = row.ok_or(ApiError::NotFound("conversation"))?;
    let unread_count = unread_count(db, id, viewer, last_read.as_deref()).await?;
    Ok(ConversationView {
        conversation,
        last_read_message_id: last_read,
        unread_count,
        permissions: None,
    })
}

pub async fn unread_count(db: &Db, conversation_id: &str, viewer: &str, last_read: Option<&str>) -> ApiResult<i64> {
    // Capped: the UI shows "99+" anyway and this keeps the query bounded.
    let (n,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM (SELECT 1 FROM messages
         WHERE conversation_id = ? AND author_id != ? AND id > ? LIMIT 100)",
    )
    .bind(conversation_id)
    .bind(viewer)
    .bind(last_read.unwrap_or(""))
    .fetch_one(db)
    .await?;
    Ok(n)
}

pub async fn list_for_user(db: &Db, user_id: &str) -> ApiResult<Vec<ConversationView>> {
    let ids: Vec<(String,)> = sqlx::query_as(
        "SELECT c.id FROM conversation_members m JOIN conversations c ON c.id = m.conversation_id
         WHERE m.user_id = ? ORDER BY COALESCE(c.last_message_id, c.id) DESC",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;
    let mut out = Vec::with_capacity(ids.len());
    for (id,) in ids {
        out.push(conversation_view(db, &id, user_id).await?);
    }
    Ok(out)
}

/// Returns the conversation kind when `user_id` is a member (for server
/// channels: can view it), 404 otherwise (non-members cannot even learn that
/// the conversation exists).
pub async fn require_member(db: &Db, conversation_id: &str, user_id: &str) -> ApiResult<ConversationKind> {
    validate_id(conversation_id)?;
    let channel: Option<(String, Option<String>, Option<String>)> =
        sqlx::query_as("SELECT kind, server_id, category_id FROM conversations WHERE id = ?")
            .bind(conversation_id)
            .fetch_optional(db)
            .await?;
    if let Some((kind, Some(server_id), category_id)) = channel {
        let perms =
            crate::permissions::channel_permissions(db, &server_id, category_id.as_deref(), conversation_id, user_id)
                .await?;
        if perms & crate::permissions::VIEW_CHANNEL == 0 {
            return Err(ApiError::NotFound("conversation"));
        }
        return Ok(kind_of(&kind));
    }
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT c.kind FROM conversations c JOIN conversation_members m ON m.conversation_id = c.id
         WHERE c.id = ? AND m.user_id = ?",
    )
    .bind(conversation_id)
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    row.map(|r| kind_of(&r.0)).ok_or(ApiError::NotFound("conversation"))
}

/// For DMs: the other member's id.
pub async fn dm_peer(db: &Db, conversation_id: &str, user_id: &str) -> ApiResult<Option<String>> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id != ? LIMIT 1")
            .bind(conversation_id)
            .bind(user_id)
            .fetch_optional(db)
            .await?;
    Ok(row.map(|r| r.0))
}

/// Blocks in either direction freeze a DM (no messages, no calls).
pub async fn ensure_dm_not_blocked(
    db: &Db,
    conversation_id: &str,
    kind: ConversationKind,
    user_id: &str,
) -> ApiResult<()> {
    if kind == ConversationKind::Dm
        && let Some(peer) = dm_peer(db, conversation_id, user_id).await?
        && is_blocked_either(db, user_id, &peer).await?
    {
        return Err(ApiError::Forbidden("you cannot interact with this user"));
    }
    Ok(())
}

pub async fn list(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<Vec<ConversationView>>> {
    Ok(Json(list_for_user(&state.db, &user.id).await?))
}

pub async fn get(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> ApiResult<Json<ConversationView>> {
    require_member(&state.db, &id, &user.id).await?;
    Ok(Json(conversation_view(&state.db, &id, &user.id).await?))
}

#[derive(Deserialize)]
pub struct OpenDm {
    pub user_id: String,
}

pub async fn open_dm(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(body): ApiJson<OpenDm>,
) -> ApiResult<(StatusCode, Json<ConversationView>)> {
    validate_id(&body.user_id)?;
    if body.user_id == user.id {
        return Err(ApiError::bad("you cannot DM yourself"));
    }
    let (a, b) = if user.id < body.user_id {
        (user.id.as_str(), body.user_id.as_str())
    } else {
        (body.user_id.as_str(), user.id.as_str())
    };
    let dm_key = format!("{a}:{b}");
    let existing: Option<(String,)> = sqlx::query_as("SELECT id FROM conversations WHERE dm_key = ?")
        .bind(&dm_key)
        .fetch_optional(&state.db)
        .await?;
    if let Some((id,)) = existing {
        return Ok((StatusCode::OK, Json(conversation_view(&state.db, &id, &user.id).await?)));
    }
    if is_blocked_either(&state.db, &user.id, &body.user_id).await? {
        return Err(ApiError::Forbidden("you cannot message this user"));
    }
    if !are_friends(&state.db, &user.id, &body.user_id).await? {
        return Err(ApiError::Forbidden("you can only start a DM with a friend"));
    }

    let id = new_id();
    let now = now_ms();
    let mut tx = state.db.begin().await?;
    let res = sqlx::query("INSERT INTO conversations (id, kind, dm_key, created_at) VALUES (?, 'dm', ?, ?)")
        .bind(&id)
        .bind(&dm_key)
        .bind(now)
        .execute(&mut *tx)
        .await;
    if let Err(e) = res {
        if crate::db::is_unique_violation(&e) {
            // Lost a race with the other user opening the same DM.
            drop(tx);
            let (id,): (String,) = sqlx::query_as("SELECT id FROM conversations WHERE dm_key = ?")
                .bind(&dm_key)
                .fetch_one(&state.db)
                .await?;
            return Ok((StatusCode::OK, Json(conversation_view(&state.db, &id, &user.id).await?)));
        }
        return Err(e.into());
    }
    for member in [a, b] {
        sqlx::query("INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?, ?, ?)")
            .bind(&id)
            .bind(member)
            .bind(now)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    notify_created(&state, &id).await?;
    Ok((
        StatusCode::CREATED,
        Json(conversation_view(&state.db, &id, &user.id).await?),
    ))
}

async fn notify_created(state: &AppState, id: &str) -> ApiResult<()> {
    for member in conversation_members(&state.db, id).await? {
        let view = conversation_view(&state.db, id, &member).await?;
        state.hub.send_one(&member, events::CONVERSATION_CREATE, &view);
    }
    Ok(())
}

async fn notify_updated(state: &AppState, id: &str) -> ApiResult<()> {
    let conversation = load_conversation(&state.db, id).await?;
    let members = conversation_members(&state.db, id).await?;
    state.hub.send(
        members.iter().map(String::as_str),
        events::CONVERSATION_UPDATE,
        &conversation,
    );
    Ok(())
}

fn validate_group_name(raw: &str) -> ApiResult<Option<String>> {
    let n = clean_text(raw).replace('\n', " ");
    match n.chars().count() {
        0 => Ok(None),
        1..=64 => Ok(Some(n)),
        _ => Err(ApiError::bad("group name must be at most 64 characters")),
    }
}

#[derive(Deserialize)]
pub struct CreateGroup {
    pub name: Option<String>,
    #[serde(default)]
    pub member_ids: Vec<String>,
}

pub async fn create_group(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(body): ApiJson<CreateGroup>,
) -> ApiResult<(StatusCode, Json<ConversationView>)> {
    let name = validate_group_name(body.name.as_deref().unwrap_or(""))?;
    let mut members: Vec<String> = Vec::new();
    for m in body.member_ids {
        validate_id(&m)?;
        if m != user.id && !members.contains(&m) {
            members.push(m);
        }
    }
    if members.len() + 1 > MAX_GROUP_MEMBERS {
        return Err(ApiError::bad(format!(
            "a group can have at most {MAX_GROUP_MEMBERS} members"
        )));
    }
    for m in &members {
        if !are_friends(&state.db, &user.id, m).await? {
            return Err(ApiError::Forbidden("you can only add friends to a group"));
        }
    }

    let id = new_id();
    let now = now_ms();
    let mut tx = state.db.begin().await?;
    sqlx::query("INSERT INTO conversations (id, kind, name, owner_id, created_at) VALUES (?, 'group', ?, ?, ?)")
        .bind(&id)
        .bind(&name)
        .bind(&user.id)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    for m in std::iter::once(&user.id).chain(members.iter()) {
        sqlx::query("INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?, ?, ?)")
            .bind(&id)
            .bind(m)
            .bind(now)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    notify_created(&state, &id).await?;
    Ok((
        StatusCode::CREATED,
        Json(conversation_view(&state.db, &id, &user.id).await?),
    ))
}

#[derive(Deserialize)]
pub struct UpdateGroup {
    pub name: Option<String>,
}

pub async fn update_group(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<UpdateGroup>,
) -> ApiResult<Json<Conversation>> {
    if require_member(&state.db, &id, &user.id).await? != ConversationKind::Group {
        return Err(ApiError::bad("only groups can be renamed"));
    }
    let name = validate_group_name(body.name.as_deref().unwrap_or(""))?;
    sqlx::query("UPDATE conversations SET name = ? WHERE id = ?")
        .bind(&name)
        .bind(&id)
        .execute(&state.db)
        .await?;
    notify_updated(&state, &id).await?;
    Ok(Json(load_conversation(&state.db, &id).await?))
}

pub async fn add_member(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, member_id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    validate_id(&member_id)?;
    if require_member(&state.db, &id, &user.id).await? != ConversationKind::Group {
        return Err(ApiError::bad("members can only be added to groups"));
    }
    if !are_friends(&state.db, &user.id, &member_id).await? {
        return Err(ApiError::Forbidden("you can only add friends to a group"));
    }
    let members = conversation_members(&state.db, &id).await?;
    if members.contains(&member_id) {
        return Ok(StatusCode::NO_CONTENT);
    }
    if members.len() >= MAX_GROUP_MEMBERS {
        return Err(ApiError::bad(format!(
            "a group can have at most {MAX_GROUP_MEMBERS} members"
        )));
    }
    sqlx::query("INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?, ?, ?)")
        .bind(&id)
        .bind(&member_id)
        .bind(now_ms())
        .execute(&state.db)
        .await?;
    let view = conversation_view(&state.db, &id, &member_id).await?;
    state.hub.send_one(&member_id, events::CONVERSATION_CREATE, &view);
    notify_updated(&state, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Owner removes someone, or a member leaves (`member_id` == self).
pub async fn remove_member(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, member_id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    validate_id(&member_id)?;
    if require_member(&state.db, &id, &user.id).await? != ConversationKind::Group {
        return Err(ApiError::bad("you cannot leave a DM"));
    }
    let conversation = load_conversation(&state.db, &id).await?;
    if member_id != user.id && conversation.owner_id.as_deref() != Some(user.id.as_str()) {
        return Err(ApiError::Forbidden("only the group owner can remove members"));
    }
    if !conversation.members.iter().any(|m| m.id == member_id) {
        return Err(ApiError::NotFound("member"));
    }
    super::calls::leave_all_calls_in_conversation(&state, &id, &member_id).await?;
    sqlx::query("DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?")
        .bind(&id)
        .bind(&member_id)
        .execute(&state.db)
        .await?;
    state
        .hub
        .send_one(&member_id, events::CONVERSATION_DELETE, &json!({ "id": id }));

    let remaining = conversation_members(&state.db, &id).await?;
    if remaining.is_empty() {
        delete_conversation_files(&state, &id).await?;
        sqlx::query("DELETE FROM conversations WHERE id = ?")
            .bind(&id)
            .execute(&state.db)
            .await?;
        return Ok(StatusCode::NO_CONTENT);
    }
    if conversation.owner_id.as_deref() == Some(member_id.as_str()) {
        // Ownership passes to the longest-standing member.
        let (next_owner,): (String,) = sqlx::query_as(
            "SELECT user_id FROM conversation_members WHERE conversation_id = ? ORDER BY joined_at, user_id LIMIT 1",
        )
        .bind(&id)
        .fetch_one(&state.db)
        .await?;
        sqlx::query("UPDATE conversations SET owner_id = ? WHERE id = ?")
            .bind(&next_owner)
            .bind(&id)
            .execute(&state.db)
            .await?;
    }
    notify_updated(&state, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn delete_conversation_files(state: &AppState, conversation_id: &str) -> ApiResult<()> {
    let files: Vec<(String,)> =
        sqlx::query_as("SELECT storage_name FROM message_attachments WHERE conversation_id = ?")
            .bind(conversation_id)
            .fetch_all(&state.db)
            .await?;
    for (name,) in files {
        if let Some(p) = state.storage.file_path(&name) {
            let _ = tokio::fs::remove_file(p).await;
        }
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct Ack {
    pub message_id: String,
}

pub async fn ack(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<Ack>,
) -> ApiResult<StatusCode> {
    let kind = require_member(&state.db, &id, &user.id).await?;
    validate_id(&body.message_id)?;
    let exists: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM messages WHERE id = ? AND conversation_id = ?")
        .bind(&body.message_id)
        .bind(&id)
        .fetch_optional(&state.db)
        .await?;
    if exists.is_none() {
        return Err(ApiError::NotFound("message"));
    }
    if kind.is_channel() {
        mark_channel_read(&state.db, &id, &user.id, &body.message_id).await?;
        state.hub.send_one(
            &user.id,
            events::CONVERSATION_READ,
            &json!({ "conversation_id": id, "message_id": body.message_id }),
        );
        return Ok(StatusCode::NO_CONTENT);
    }
    // Never move the read marker backwards.
    sqlx::query(
        "UPDATE conversation_members SET last_read_message_id = ?1
         WHERE conversation_id = ?2 AND user_id = ?3
           AND (last_read_message_id IS NULL OR last_read_message_id < ?1)",
    )
    .bind(&body.message_id)
    .bind(&id)
    .bind(&user.id)
    .execute(&state.db)
    .await?;
    state.hub.send_one(
        &user.id,
        events::CONVERSATION_READ,
        &json!({ "conversation_id": id, "message_id": body.message_id }),
    );
    Ok(StatusCode::NO_CONTENT)
}
