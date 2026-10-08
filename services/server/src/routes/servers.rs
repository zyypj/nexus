//! Servers (guilds): creation, invites, members, kicks/bans, roles,
//! categories, channels and permission overwrites.
//!
//! Every change is followed by `broadcast_server`, which sends each member
//! their own `ServerView` (only the channels they can see, with their
//! permissions). With a few dozen members per server, a full per-member view
//! is cheap and keeps every client trivially consistent.

use axum::{
    Json,
    extract::{Multipart, Path, State},
    http::StatusCode,
};
use serde::Deserialize;
use serde_json::json;

use super::{
    calls,
    common::{ApiJson, clean_text, validate_id},
    conversations::{ConversationRow, channel_view, delete_conversation_files},
};
use crate::{
    auth::AuthUser,
    db::{Db, is_unique_violation, new_id, now_ms},
    error::{ApiError, ApiResult},
    gateway::events,
    models::{
        PermissionOverwrite, PublicUser, ServerBan, ServerCategory, ServerInvite, ServerInvitePreview, ServerMember,
        ServerRole, ServerView, UserRow,
    },
    permissions::{self as perm, MemberCtx, Snapshot},
    rate_limit::rules,
    state::AppState,
    storage::{Storage, avatar_url, inline_image_mime},
};

pub const MAX_SERVERS_PER_USER: i64 = 100;
pub const MAX_MEMBERS: i64 = 1000;
pub const MAX_CHANNELS: i64 = 200;
pub const MAX_CATEGORIES: i64 = 50;
pub const MAX_ROLES: i64 = 100;
const INVITE_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

// ---------------------------------------------------------------- validation

fn name_1_64(raw: &str, what: &str) -> ApiResult<String> {
    let n = clean_text(raw).replace(['\n', '\t'], " ");
    let len = n.chars().count();
    if !(1..=64).contains(&len) {
        return Err(ApiError::bad(format!("{what} must be 1-64 characters")));
    }
    Ok(n)
}

/// Text channels: lowercase, spaces become dashes ("bate papo" → "bate-papo").
fn text_channel_name(raw: &str) -> ApiResult<String> {
    let n = name_1_64(raw, "channel name")?;
    let n: String = n.to_lowercase().split_whitespace().collect::<Vec<_>>().join("-");
    if n.is_empty() {
        return Err(ApiError::bad("channel name must be 1-64 characters"));
    }
    Ok(n)
}

fn role_name(raw: &str) -> ApiResult<String> {
    let n = clean_text(raw).replace(['\n', '\t'], " ");
    if !(1..=32).contains(&n.chars().count()) {
        return Err(ApiError::bad("role name must be 1-32 characters"));
    }
    Ok(n)
}

fn color(c: i64) -> ApiResult<i64> {
    if !(0..=0xFF_FFFF).contains(&c) {
        return Err(ApiError::bad("color must be 0xRRGGBB"));
    }
    Ok(c)
}

fn topic(raw: &str) -> ApiResult<Option<String>> {
    let t = clean_text(raw);
    if t.chars().count() > 1024 {
        return Err(ApiError::bad("topic must be at most 1024 characters"));
    }
    Ok(if t.is_empty() { None } else { Some(t) })
}

fn invite_code() -> String {
    let bytes: [u8; 8] = rand::random();
    bytes
        .iter()
        .map(|b| INVITE_ALPHABET[*b as usize % INVITE_ALPHABET.len()] as char)
        .collect()
}

// ---------------------------------------------------------------- views

#[derive(sqlx::FromRow)]
struct ServerRow {
    name: String,
    icon: Option<String>,
    owner_id: String,
    created_at: i64,
}

/// The server as `viewer` sees it, or None when they are not a member.
pub async fn server_view(db: &Db, server_id: &str, viewer: &str) -> ApiResult<Option<ServerView>> {
    let snap = Snapshot::load(db, server_id).await?;
    let Some(ctx) = snap.ctx(viewer) else {
        return Ok(None);
    };
    view_from(db, &snap, &ctx, viewer).await.map(Some)
}

async fn view_from(db: &Db, snap: &Snapshot, ctx: &MemberCtx, viewer: &str) -> ApiResult<ServerView> {
    let server: ServerRow = sqlx::query_as("SELECT name, icon, owner_id, created_at FROM servers WHERE id = ?")
        .bind(&snap.id)
        .fetch_one(db)
        .await?;
    let categories: Vec<(String, String, i64)> =
        sqlx::query_as("SELECT id, name, position FROM channel_categories WHERE server_id = ? ORDER BY position")
            .bind(&snap.id)
            .fetch_all(db)
            .await?;
    let rows: Vec<ConversationRow> = sqlx::query_as(concat!(
        "SELECT ",
        crate::conversation_columns!(),
        " FROM conversations WHERE server_id = ? ORDER BY position"
    ))
    .bind(&snap.id)
    .fetch_all(db)
    .await?;
    let mut channels = Vec::new();
    let mut visible = std::collections::HashSet::new();
    for row in rows {
        let p = snap.channel_perms(ctx, row.category_id.as_deref(), &row.id);
        if p & perm::VIEW_CHANNEL == 0 {
            continue;
        }
        visible.insert(row.id.clone());
        channels.push(channel_view(db, row.into_channel(), viewer, p).await?);
    }
    let server_perms = ctx.server();
    // Overwrites only matter to people who can edit them.
    let overwrites = if server_perms & (perm::MANAGE_ROLES | perm::MANAGE_CHANNELS) != 0 {
        snap.overwrites
            .iter()
            .filter(|o| visible.contains(&o.target_id) || categories.iter().any(|c| c.0 == o.target_id))
            .map(|o| PermissionOverwrite {
                target_id: o.target_id.clone(),
                role_id: o.role_id.clone(),
                allow: o.allow,
                deny: o.deny,
            })
            .collect()
    } else {
        Vec::new()
    };
    let members: Vec<(String, Option<String>, i64)> = sqlx::query_as(
        "SELECT user_id, nickname, joined_at FROM server_members WHERE server_id = ? ORDER BY joined_at",
    )
    .bind(&snap.id)
    .fetch_all(db)
    .await?;
    let users: Vec<UserRow> = sqlx::query_as(concat!(
        "SELECT ",
        crate::user_columns!(),
        " FROM server_members m JOIN users u ON u.id = m.user_id WHERE m.server_id = ?"
    ))
    .bind(&snap.id)
    .fetch_all(db)
    .await?;
    let mut by_id: std::collections::HashMap<String, PublicUser> =
        users.into_iter().map(|u| (u.id.clone(), PublicUser::from(u))).collect();
    let members = members
        .into_iter()
        .filter_map(|(uid, nickname, joined_at)| {
            let user = by_id.remove(&uid)?;
            Some(ServerMember {
                role_ids: snap.member_roles.get(&uid).cloned().unwrap_or_default(),
                user,
                nickname,
                joined_at,
            })
        })
        .collect();
    Ok(ServerView {
        id: snap.id.clone(),
        name: server.name,
        icon_url: avatar_url(&server.icon),
        owner_id: server.owner_id,
        created_at: server.created_at,
        permissions: server_perms,
        roles: snap
            .roles
            .iter()
            .map(|r| ServerRole {
                id: r.id.clone(),
                name: r.name.clone(),
                color: r.color,
                position: r.position,
                permissions: r.permissions,
                hoist: r.hoist,
            })
            .collect(),
        categories: categories
            .into_iter()
            .map(|(id, name, position)| ServerCategory { id, name, position })
            .collect(),
        channels,
        overwrites,
        members,
    })
}

/// Every server of the user (for READY).
pub async fn servers_for_user(db: &Db, user_id: &str) -> ApiResult<Vec<ServerView>> {
    let ids: Vec<(String,)> =
        sqlx::query_as("SELECT server_id FROM server_members WHERE user_id = ? ORDER BY joined_at")
            .bind(user_id)
            .fetch_all(db)
            .await?;
    let mut out = Vec::with_capacity(ids.len());
    for (id,) in ids {
        if let Some(v) = server_view(db, &id, user_id).await? {
            out.push(v);
        }
    }
    Ok(out)
}

/// Sends every member their own view of the server.
pub async fn broadcast_server(state: &AppState, server_id: &str) -> ApiResult<()> {
    let snap = Snapshot::load(&state.db, server_id).await?;
    for user_id in snap.member_roles.keys() {
        if !state.hub.is_online(user_id) {
            continue;
        }
        if let Some(ctx) = snap.ctx(user_id) {
            let view = view_from(&state.db, &snap, &ctx, user_id).await?;
            state.hub.send_one(user_id, events::SERVER_UPDATE, &view);
        }
    }
    Ok(())
}

/// Member + permissions of the caller, 404 when not a member.
async fn actor(db: &Db, server_id: &str, user_id: &str) -> ApiResult<(Snapshot, MemberCtx)> {
    validate_id(server_id)?;
    let snap = Snapshot::load(db, server_id).await?;
    let ctx = snap.ctx(user_id).ok_or(ApiError::NotFound("server"))?;
    Ok((snap, ctx))
}

fn need(ctx: &MemberCtx, p: i64, msg: &'static str) -> ApiResult<()> {
    if ctx.has(p) {
        Ok(())
    } else {
        Err(ApiError::Forbidden(msg))
    }
}

/// Text channels start "read" at the latest message for a new member.
async fn seed_reads(db: &Db, server_id: &str, user_id: &str) -> ApiResult<()> {
    sqlx::query(
        "INSERT INTO channel_reads (channel_id, user_id, last_read_message_id)
         SELECT id, ?1, last_message_id FROM conversations
         WHERE server_id = ?2 AND kind = 'text' AND last_message_id IS NOT NULL
         ON CONFLICT (channel_id, user_id) DO NOTHING",
    )
    .bind(user_id)
    .bind(server_id)
    .execute(db)
    .await?;
    Ok(())
}

async fn server_channel_ids(db: &Db, server_id: &str) -> ApiResult<Vec<String>> {
    let rows: Vec<(String,)> = sqlx::query_as("SELECT id FROM conversations WHERE server_id = ?")
        .bind(server_id)
        .fetch_all(db)
        .await?;
    Ok(rows.into_iter().map(|r| r.0).collect())
}

/// Removes a member (leave, kick or ban): leaves voice channels, forgets read
/// state and tells everyone.
async fn remove_member(state: &AppState, server_id: &str, user_id: &str) -> ApiResult<()> {
    for channel in server_channel_ids(&state.db, server_id).await? {
        calls::leave_all_calls_in_conversation(state, &channel, user_id).await?;
    }
    sqlx::query("DELETE FROM server_members WHERE server_id = ? AND user_id = ?")
        .bind(server_id)
        .bind(user_id)
        .execute(&state.db)
        .await?;
    sqlx::query(
        "DELETE FROM channel_reads WHERE user_id = ?1
         AND channel_id IN (SELECT id FROM conversations WHERE server_id = ?2)",
    )
    .bind(user_id)
    .bind(server_id)
    .execute(&state.db)
    .await?;
    state
        .hub
        .send_one(user_id, events::SERVER_DELETE, &json!({ "id": server_id }));
    broadcast_server(state, server_id).await
}

// ---------------------------------------------------------------- server

#[derive(Deserialize)]
pub struct CreateServer {
    pub name: String,
}

pub async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(body): ApiJson<CreateServer>,
) -> ApiResult<(StatusCode, Json<ServerView>)> {
    state.limiter.check("server", &user.id, rules::FRIEND)?;
    let name = name_1_64(&body.name, "server name")?;
    let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM server_members WHERE user_id = ?")
        .bind(&user.id)
        .fetch_one(&state.db)
        .await?;
    if count >= MAX_SERVERS_PER_USER {
        return Err(ApiError::Conflict("too many servers"));
    }
    let id = new_id();
    let now = now_ms();
    let (text_cat, voice_cat) = (new_id(), new_id());
    let mut tx = state.db.begin().await?;
    sqlx::query("INSERT INTO servers (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)")
        .bind(&id)
        .bind(&name)
        .bind(&user.id)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO server_roles (id, server_id, name, color, position, permissions, hoist, created_at)
         VALUES (?1, ?1, '@everyone', 0, 0, ?2, 0, ?3)",
    )
    .bind(&id)
    .bind(perm::DEFAULT_EVERYONE)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO server_members (server_id, user_id, joined_at) VALUES (?, ?, ?)")
        .bind(&id)
        .bind(&user.id)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    for (cat, cname, pos) in [(&text_cat, "Canais de texto", 0), (&voice_cat, "Canais de voz", 1)] {
        sqlx::query("INSERT INTO channel_categories (id, server_id, name, position) VALUES (?, ?, ?, ?)")
            .bind(cat)
            .bind(&id)
            .bind(cname)
            .bind(pos)
            .execute(&mut *tx)
            .await?;
    }
    for (kind, cname, cat) in [("text", "geral", &text_cat), ("voice", "Geral", &voice_cat)] {
        sqlx::query(
            "INSERT INTO conversations (id, kind, name, created_at, server_id, category_id, position)
             VALUES (?, ?, ?, ?, ?, ?, 0)",
        )
        .bind(new_id())
        .bind(kind)
        .bind(cname)
        .bind(now)
        .bind(&id)
        .bind(cat)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    let view = server_view(&state.db, &id, &user.id)
        .await?
        .ok_or(ApiError::NotFound("server"))?;
    state.hub.send_one(&user.id, events::SERVER_CREATE, &view);
    Ok((StatusCode::CREATED, Json(view)))
}

pub async fn get(State(state): State<AppState>, user: AuthUser, Path(id): Path<String>) -> ApiResult<Json<ServerView>> {
    validate_id(&id)?;
    server_view(&state.db, &id, &user.id)
        .await?
        .map(Json)
        .ok_or(ApiError::NotFound("server"))
}

#[derive(Deserialize)]
pub struct UpdateServer {
    pub name: Option<String>,
}

pub async fn update(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<UpdateServer>,
) -> ApiResult<StatusCode> {
    let (_, ctx) = actor(&state.db, &id, &user.id).await?;
    need(&ctx, perm::MANAGE_SERVER, "missing Manage Server")?;
    if let Some(name) = body.name {
        let name = name_1_64(&name, "server name")?;
        sqlx::query("UPDATE servers SET name = ? WHERE id = ?")
            .bind(name)
            .bind(&id)
            .execute(&state.db)
            .await?;
    }
    broadcast_server(&state, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn delete(State(state): State<AppState>, user: AuthUser, Path(id): Path<String>) -> ApiResult<StatusCode> {
    let (snap, ctx) = actor(&state.db, &id, &user.id).await?;
    if !ctx.owner {
        return Err(ApiError::Forbidden("only the owner can delete the server"));
    }
    for channel in server_channel_ids(&state.db, &id).await? {
        if let Some(call_id) = calls::active_call_id(&state.db, &channel).await? {
            calls::end_internal(&state, &call_id).await?;
        }
        delete_conversation_files(&state, &channel).await?;
    }
    let icon: Option<(Option<String>,)> = sqlx::query_as("SELECT icon FROM servers WHERE id = ?")
        .bind(&id)
        .fetch_optional(&state.db)
        .await?;
    sqlx::query("DELETE FROM servers WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;
    if let Some(p) = icon.and_then(|i| i.0).and_then(|i| state.storage.avatar_path(&i)) {
        let _ = tokio::fs::remove_file(p).await;
    }
    state.hub.send(
        snap.member_roles.keys().map(String::as_str),
        events::SERVER_DELETE,
        &json!({ "id": id }),
    );
    Ok(StatusCode::NO_CONTENT)
}

pub async fn upload_icon(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    mut multipart: Multipart,
) -> ApiResult<StatusCode> {
    state.limiter.check("upload", &user.id, rules::UPLOAD)?;
    let (_, ctx) = actor(&state.db, &id, &user.id).await?;
    need(&ctx, perm::MANAGE_SERVER, "missing Manage Server")?;
    let max = state.config.max_avatar_size as usize;
    let mut data: Option<Vec<u8>> = None;
    while let Some(mut field) = multipart.next_field().await.map_err(|e| ApiError::bad(e.body_text()))? {
        if field.name() != Some("file") {
            continue;
        }
        let mut buf = Vec::new();
        while let Some(chunk) = field.chunk().await.map_err(|e| ApiError::bad(e.body_text()))? {
            if buf.len() + chunk.len() > max {
                return Err(ApiError::PayloadTooLarge);
            }
            buf.extend_from_slice(&chunk);
        }
        data = Some(buf);
        break;
    }
    let data = data.ok_or_else(|| ApiError::bad("missing 'file' field"))?;
    if inline_image_mime(infer::get(&data).map(|t| t.mime_type())).is_none() {
        return Err(ApiError::UnsupportedMedia);
    }
    let size = imagesize::blob_size(&data).map_err(|_| ApiError::UnsupportedMedia)?;
    if size.width == 0 || size.height == 0 || size.width > 4096 || size.height > 4096 {
        return Err(ApiError::bad("icon must be at most 4096x4096"));
    }
    let name = Storage::new_storage_name();
    let path = state.storage.avatar_path(&name).ok_or(ApiError::bad("invalid name"))?;
    tokio::fs::write(&path, &data).await?;
    let (old,): (Option<String>,) = sqlx::query_as("SELECT icon FROM servers WHERE id = ?")
        .bind(&id)
        .fetch_one(&state.db)
        .await?;
    sqlx::query("UPDATE servers SET icon = ? WHERE id = ?")
        .bind(&name)
        .bind(&id)
        .execute(&state.db)
        .await?;
    if let Some(old_path) = old.as_deref().and_then(|o| state.storage.avatar_path(o)) {
        let _ = tokio::fs::remove_file(old_path).await;
    }
    broadcast_server(&state, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn delete_icon(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let (_, ctx) = actor(&state.db, &id, &user.id).await?;
    need(&ctx, perm::MANAGE_SERVER, "missing Manage Server")?;
    let (old,): (Option<String>,) = sqlx::query_as("SELECT icon FROM servers WHERE id = ?")
        .bind(&id)
        .fetch_one(&state.db)
        .await?;
    sqlx::query("UPDATE servers SET icon = NULL WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;
    if let Some(p) = old.as_deref().and_then(|o| state.storage.avatar_path(o)) {
        let _ = tokio::fs::remove_file(p).await;
    }
    broadcast_server(&state, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct Transfer {
    pub user_id: String,
}

pub async fn transfer(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<Transfer>,
) -> ApiResult<StatusCode> {
    let (snap, ctx) = actor(&state.db, &id, &user.id).await?;
    if !ctx.owner {
        return Err(ApiError::Forbidden("only the owner can transfer the server"));
    }
    if !snap.is_member(&body.user_id) {
        return Err(ApiError::NotFound("member"));
    }
    sqlx::query("UPDATE servers SET owner_id = ? WHERE id = ?")
        .bind(&body.user_id)
        .bind(&id)
        .execute(&state.db)
        .await?;
    broadcast_server(&state, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------- members

pub async fn leave(State(state): State<AppState>, user: AuthUser, Path(id): Path<String>) -> ApiResult<StatusCode> {
    let (_, ctx) = actor(&state.db, &id, &user.id).await?;
    if ctx.owner {
        return Err(ApiError::Conflict("the owner must transfer or delete the server"));
    }
    remove_member(&state, &id, &user.id).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct UpdateMember {
    /// Some(None) clears the nickname.
    #[serde(default, deserialize_with = "double_option")]
    pub nickname: Option<Option<String>>,
    pub role_ids: Option<Vec<String>>,
}

/// Distinguishes a missing field (None) from an explicit null (Some(None)).
fn double_option<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(d).map(Some)
}

pub async fn update_member(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, member_id)): Path<(String, String)>,
    ApiJson(body): ApiJson<UpdateMember>,
) -> ApiResult<StatusCode> {
    let (snap, ctx) = actor(&state.db, &id, &user.id).await?;
    validate_id(&member_id)?;
    if !snap.is_member(&member_id) {
        return Err(ApiError::NotFound("member"));
    }
    let is_self = member_id == user.id;
    let target_top = snap.top_of(&member_id);
    let target_is_owner = snap.owner_id == member_id;

    if let Some(nick) = body.nickname {
        if is_self {
            need(&ctx, perm::CHANGE_NICKNAME, "missing Change Nickname")?;
        } else {
            need(&ctx, perm::MANAGE_NICKNAMES, "missing Manage Nicknames")?;
            if target_is_owner || !ctx.outranks(target_top) {
                return Err(ApiError::Forbidden("that member is above you"));
            }
        }
        let nick = match nick {
            Some(n) => {
                let n = clean_text(&n).replace(['\n', '\t'], " ");
                if n.chars().count() > 32 {
                    return Err(ApiError::bad("nickname must be at most 32 characters"));
                }
                if n.is_empty() { None } else { Some(n) }
            }
            None => None,
        };
        sqlx::query("UPDATE server_members SET nickname = ? WHERE server_id = ? AND user_id = ?")
            .bind(nick)
            .bind(&id)
            .bind(&member_id)
            .execute(&state.db)
            .await?;
    }

    if let Some(wanted) = body.role_ids {
        need(&ctx, perm::MANAGE_ROLES, "missing Manage Roles")?;
        if !is_self && (target_is_owner || !ctx.outranks(target_top)) {
            return Err(ApiError::Forbidden("that member is above you"));
        }
        let current: Vec<String> = snap.member_roles.get(&member_id).cloned().unwrap_or_default();
        let wanted: std::collections::HashSet<String> = wanted.into_iter().collect();
        for rid in &wanted {
            let role = snap.role(rid).ok_or(ApiError::NotFound("role"))?;
            if role.id == id {
                return Err(ApiError::bad("@everyone cannot be assigned"));
            }
        }
        // Every role added or removed must be below the actor's top role.
        let changed = wanted
            .iter()
            .filter(|r| !current.contains(r))
            .chain(current.iter().filter(|r| !wanted.contains(*r)));
        for rid in changed {
            let pos = snap.role(rid).map(|r| r.position).unwrap_or(0);
            if !ctx.outranks(pos) {
                return Err(ApiError::Forbidden("you can only manage roles below your highest role"));
            }
        }
        let mut tx = state.db.begin().await?;
        sqlx::query("DELETE FROM member_roles WHERE server_id = ? AND user_id = ?")
            .bind(&id)
            .bind(&member_id)
            .execute(&mut *tx)
            .await?;
        for rid in &wanted {
            sqlx::query("INSERT INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)")
                .bind(&id)
                .bind(&member_id)
                .bind(rid)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
    }
    broadcast_server(&state, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Kick/ban checks: permission, not yourself, not the owner, strictly above.
fn can_moderate(
    snap: &Snapshot,
    ctx: &MemberCtx,
    actor_id: &str,
    target: &str,
    p: i64,
    msg: &'static str,
) -> ApiResult<()> {
    need(ctx, p, msg)?;
    if target == actor_id {
        return Err(ApiError::bad("you cannot do that to yourself"));
    }
    if target == snap.owner_id || (snap.is_member(target) && !ctx.outranks(snap.top_of(target))) {
        return Err(ApiError::Forbidden("that member is above you"));
    }
    Ok(())
}

pub async fn kick(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, member_id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let (snap, ctx) = actor(&state.db, &id, &user.id).await?;
    validate_id(&member_id)?;
    if !snap.is_member(&member_id) {
        return Err(ApiError::NotFound("member"));
    }
    can_moderate(
        &snap,
        &ctx,
        &user.id,
        &member_id,
        perm::KICK_MEMBERS,
        "missing Kick Members",
    )?;
    remove_member(&state, &id, &member_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize, Default)]
pub struct BanBody {
    pub reason: Option<String>,
}

pub async fn ban(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, target)): Path<(String, String)>,
    ApiJson(body): ApiJson<BanBody>,
) -> ApiResult<StatusCode> {
    let (snap, ctx) = actor(&state.db, &id, &user.id).await?;
    validate_id(&target)?;
    can_moderate(&snap, &ctx, &user.id, &target, perm::BAN_MEMBERS, "missing Ban Members")?;
    let exists: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM users WHERE id = ?")
        .bind(&target)
        .fetch_optional(&state.db)
        .await?;
    if exists.is_none() {
        return Err(ApiError::NotFound("user"));
    }
    let reason = body
        .reason
        .map(|r| clean_text(&r))
        .filter(|r| !r.is_empty())
        .map(|r| r.chars().take(512).collect::<String>());
    sqlx::query(
        "INSERT INTO server_bans (server_id, user_id, reason, banned_by, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (server_id, user_id) DO UPDATE SET reason = excluded.reason, banned_by = excluded.banned_by",
    )
    .bind(&id)
    .bind(&target)
    .bind(reason)
    .bind(&user.id)
    .bind(now_ms())
    .execute(&state.db)
    .await?;
    if snap.is_member(&target) {
        remove_member(&state, &id, &target).await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

pub async fn unban(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, target)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let (_, ctx) = actor(&state.db, &id, &user.id).await?;
    need(&ctx, perm::BAN_MEMBERS, "missing Ban Members")?;
    sqlx::query("DELETE FROM server_bans WHERE server_id = ? AND user_id = ?")
        .bind(&id)
        .bind(&target)
        .execute(&state.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn list_bans(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Vec<ServerBan>>> {
    let (_, ctx) = actor(&state.db, &id, &user.id).await?;
    need(&ctx, perm::BAN_MEMBERS, "missing Ban Members")?;
    #[derive(sqlx::FromRow)]
    struct Row {
        #[sqlx(flatten)]
        user: UserRow,
        reason: Option<String>,
        banned_by: Option<String>,
        created_at: i64,
    }
    let rows: Vec<Row> = sqlx::query_as(concat!(
        "SELECT ",
        crate::user_columns!(),
        ", b.reason, b.banned_by, b.created_at FROM server_bans b JOIN users u ON u.id = b.user_id
         WHERE b.server_id = ? ORDER BY b.created_at DESC"
    ))
    .bind(&id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|r| ServerBan {
                user: PublicUser::from(r.user),
                reason: r.reason,
                banned_by: r.banned_by,
                created_at: r.created_at,
            })
            .collect(),
    ))
}

// ---------------------------------------------------------------- invites

#[derive(Deserialize, Default)]
pub struct CreateInvite {
    pub max_uses: Option<i64>,
    pub expires_in_secs: Option<i64>,
}

#[derive(sqlx::FromRow)]
struct InviteRow {
    code: String,
    server_id: String,
    created_by: Option<String>,
    max_uses: Option<i64>,
    uses: i64,
    expires_at: Option<i64>,
    created_at: i64,
}

impl From<InviteRow> for ServerInvite {
    fn from(r: InviteRow) -> Self {
        Self {
            code: r.code,
            server_id: r.server_id,
            created_by: r.created_by,
            max_uses: r.max_uses,
            uses: r.uses,
            expires_at: r.expires_at,
            created_at: r.created_at,
        }
    }
}

macro_rules! invite_columns {
    () => {
        "code, server_id, created_by, max_uses, uses, expires_at, created_at"
    };
}

pub async fn create_invite(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<CreateInvite>,
) -> ApiResult<(StatusCode, Json<ServerInvite>)> {
    state.limiter.check("invite", &user.id, rules::FRIEND)?;
    let (_, ctx) = actor(&state.db, &id, &user.id).await?;
    need(&ctx, perm::CREATE_INVITE, "missing Create Invite")?;
    if let Some(m) = body.max_uses
        && !(1..=1000).contains(&m)
    {
        return Err(ApiError::bad("max_uses must be 1-1000"));
    }
    if let Some(s) = body.expires_in_secs
        && !(60..=30 * 24 * 3600).contains(&s)
    {
        return Err(ApiError::bad("expires_in_secs must be between 1 minute and 30 days"));
    }
    let now = now_ms();
    for _ in 0..5 {
        let code = invite_code();
        let res = sqlx::query(
            "INSERT INTO server_invites (code, server_id, created_by, max_uses, expires_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(&code)
        .bind(&id)
        .bind(&user.id)
        .bind(body.max_uses)
        .bind(body.expires_in_secs.map(|s| now + s * 1000))
        .bind(now)
        .execute(&state.db)
        .await;
        match res {
            Ok(_) => {
                let row: InviteRow = sqlx::query_as(concat!(
                    "SELECT ",
                    invite_columns!(),
                    " FROM server_invites WHERE code = ?"
                ))
                .bind(&code)
                .fetch_one(&state.db)
                .await?;
                return Ok((StatusCode::CREATED, Json(row.into())));
            }
            Err(e) if is_unique_violation(&e) => continue,
            Err(e) => return Err(e.into()),
        }
    }
    Err(ApiError::Internal(anyhow::anyhow!("could not generate an invite code")))
}

pub async fn list_invites(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Vec<ServerInvite>>> {
    let (_, ctx) = actor(&state.db, &id, &user.id).await?;
    need(&ctx, perm::MANAGE_SERVER, "missing Manage Server")?;
    let rows: Vec<InviteRow> = sqlx::query_as(concat!(
        "SELECT ",
        invite_columns!(),
        " FROM server_invites WHERE server_id = ? ORDER BY created_at DESC"
    ))
    .bind(&id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows.into_iter().map(Into::into).collect()))
}

async fn find_invite(db: &Db, code: &str) -> ApiResult<InviteRow> {
    let code = code.trim();
    if code.is_empty() || code.len() > 32 || !code.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err(ApiError::NotFound("invite"));
    }
    let row: Option<InviteRow> = sqlx::query_as(concat!(
        "SELECT ",
        invite_columns!(),
        " FROM server_invites WHERE code = ?"
    ))
    .bind(code)
    .fetch_optional(db)
    .await?;
    let row = row.ok_or(ApiError::NotFound("invite"))?;
    let expired = row.expires_at.is_some_and(|e| e <= now_ms());
    let used_up = row.max_uses.is_some_and(|m| row.uses >= m);
    if expired || used_up {
        return Err(ApiError::NotFound("invite"));
    }
    Ok(row)
}

pub async fn delete_invite(
    State(state): State<AppState>,
    user: AuthUser,
    Path(code): Path<String>,
) -> ApiResult<StatusCode> {
    let row: Option<InviteRow> = sqlx::query_as(concat!(
        "SELECT ",
        invite_columns!(),
        " FROM server_invites WHERE code = ?"
    ))
    .bind(code.trim())
    .fetch_optional(&state.db)
    .await?;
    let row = row.ok_or(ApiError::NotFound("invite"))?;
    let (_, ctx) = actor(&state.db, &row.server_id, &user.id).await?;
    if row.created_by.as_deref() != Some(user.id.as_str()) {
        need(&ctx, perm::MANAGE_SERVER, "missing Manage Server")?;
    }
    sqlx::query("DELETE FROM server_invites WHERE code = ?")
        .bind(&row.code)
        .execute(&state.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn preview_invite(
    State(state): State<AppState>,
    user: AuthUser,
    Path(code): Path<String>,
) -> ApiResult<Json<ServerInvitePreview>> {
    state.limiter.check("invite", &user.id, rules::FRIEND)?;
    let row = find_invite(&state.db, &code).await?;
    let (name, icon): (String, Option<String>) = sqlx::query_as("SELECT name, icon FROM servers WHERE id = ?")
        .bind(&row.server_id)
        .fetch_one(&state.db)
        .await?;
    let (member_count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM server_members WHERE server_id = ?")
        .bind(&row.server_id)
        .fetch_one(&state.db)
        .await?;
    let already: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?")
        .bind(&row.server_id)
        .bind(&user.id)
        .fetch_optional(&state.db)
        .await?;
    Ok(Json(ServerInvitePreview {
        code: row.code,
        server_id: row.server_id,
        name,
        icon_url: avatar_url(&icon),
        member_count,
        already_member: already.is_some(),
    }))
}

pub async fn join(
    State(state): State<AppState>,
    user: AuthUser,
    Path(code): Path<String>,
) -> ApiResult<Json<ServerView>> {
    state.limiter.check("invite", &user.id, rules::FRIEND)?;
    let row = find_invite(&state.db, &code).await?;
    let server_id = row.server_id.clone();
    if let Some(view) = server_view(&state.db, &server_id, &user.id).await? {
        return Ok(Json(view));
    }
    let banned: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM server_bans WHERE server_id = ? AND user_id = ?")
        .bind(&server_id)
        .bind(&user.id)
        .fetch_optional(&state.db)
        .await?;
    if banned.is_some() {
        return Err(ApiError::Forbidden("you are banned from this server"));
    }
    let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM server_members WHERE user_id = ?")
        .bind(&user.id)
        .fetch_one(&state.db)
        .await?;
    if count >= MAX_SERVERS_PER_USER {
        return Err(ApiError::Conflict("too many servers"));
    }
    let (members,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM server_members WHERE server_id = ?")
        .bind(&server_id)
        .fetch_one(&state.db)
        .await?;
    if members >= MAX_MEMBERS {
        return Err(ApiError::Conflict("this server is full"));
    }
    // Count the use atomically (two people racing for the last use).
    let used = sqlx::query(
        "UPDATE server_invites SET uses = uses + 1
         WHERE code = ? AND (max_uses IS NULL OR uses < max_uses)",
    )
    .bind(&row.code)
    .execute(&state.db)
    .await?;
    if used.rows_affected() == 0 {
        return Err(ApiError::NotFound("invite"));
    }
    sqlx::query("INSERT OR IGNORE INTO server_members (server_id, user_id, joined_at) VALUES (?, ?, ?)")
        .bind(&server_id)
        .bind(&user.id)
        .bind(now_ms())
        .execute(&state.db)
        .await?;
    seed_reads(&state.db, &server_id, &user.id).await?;
    let view = server_view(&state.db, &server_id, &user.id)
        .await?
        .ok_or(ApiError::NotFound("server"))?;
    state.hub.send_one(&user.id, events::SERVER_CREATE, &view);
    broadcast_server(&state, &server_id).await?;
    Ok(Json(view))
}

// ---------------------------------------------------------------- roles

#[derive(Deserialize)]
pub struct RoleBody {
    pub name: Option<String>,
    pub color: Option<i64>,
    pub permissions: Option<i64>,
    pub hoist: Option<bool>,
}

/// Non-admins cannot hand out permissions they do not have.
fn check_grant(ctx: &MemberCtx, permissions: i64) -> ApiResult<i64> {
    let permissions = permissions & perm::ALL;
    if ctx.server() != perm::ALL && permissions & !ctx.server() != 0 {
        return Err(ApiError::Forbidden("you cannot grant permissions you do not have"));
    }
    Ok(permissions)
}

pub async fn create_role(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<RoleBody>,
) -> ApiResult<(StatusCode, Json<ServerRole>)> {
    let (snap, ctx) = actor(&state.db, &id, &user.id).await?;
    need(&ctx, perm::MANAGE_ROLES, "missing Manage Roles")?;
    if snap.roles.len() as i64 >= MAX_ROLES {
        return Err(ApiError::Conflict("too many roles"));
    }
    let name = role_name(body.name.as_deref().unwrap_or("novo cargo"))?;
    let color = color(body.color.unwrap_or(0))?;
    let permissions = check_grant(&ctx, body.permissions.unwrap_or(0))?;
    let role_id = new_id();
    let mut tx = state.db.begin().await?;
    // New roles go right above @everyone.
    sqlx::query("UPDATE server_roles SET position = position + 1 WHERE server_id = ? AND position >= 1")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO server_roles (id, server_id, name, color, position, permissions, hoist, created_at)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?)",
    )
    .bind(&role_id)
    .bind(&id)
    .bind(&name)
    .bind(color)
    .bind(permissions)
    .bind(body.hoist.unwrap_or(false))
    .bind(now_ms())
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    broadcast_server(&state, &id).await?;
    Ok((
        StatusCode::CREATED,
        Json(ServerRole {
            id: role_id,
            name,
            color,
            position: 1,
            permissions,
            hoist: body.hoist.unwrap_or(false),
        }),
    ))
}

pub async fn update_role(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, role_id)): Path<(String, String)>,
    ApiJson(body): ApiJson<RoleBody>,
) -> ApiResult<StatusCode> {
    let (snap, ctx) = actor(&state.db, &id, &user.id).await?;
    need(&ctx, perm::MANAGE_ROLES, "missing Manage Roles")?;
    let role = snap.role(&role_id).ok_or(ApiError::NotFound("role"))?;
    let everyone = role.id == id;
    if !everyone && !ctx.outranks(role.position) {
        return Err(ApiError::Forbidden("you can only edit roles below your highest role"));
    }
    if let Some(name) = body.name {
        if everyone {
            return Err(ApiError::bad("@everyone cannot be renamed"));
        }
        sqlx::query("UPDATE server_roles SET name = ? WHERE id = ?")
            .bind(role_name(&name)?)
            .bind(&role_id)
            .execute(&state.db)
            .await?;
    }
    if let Some(c) = body.color {
        sqlx::query("UPDATE server_roles SET color = ? WHERE id = ?")
            .bind(color(c)?)
            .bind(&role_id)
            .execute(&state.db)
            .await?;
    }
    if let Some(p) = body.permissions {
        sqlx::query("UPDATE server_roles SET permissions = ? WHERE id = ?")
            .bind(check_grant(&ctx, p)?)
            .bind(&role_id)
            .execute(&state.db)
            .await?;
    }
    if let Some(h) = body.hoist {
        sqlx::query("UPDATE server_roles SET hoist = ? WHERE id = ?")
            .bind(h)
            .bind(&role_id)
            .execute(&state.db)
            .await?;
    }
    broadcast_server(&state, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn delete_role(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, role_id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let (snap, ctx) = actor(&state.db, &id, &user.id).await?;
    need(&ctx, perm::MANAGE_ROLES, "missing Manage Roles")?;
    let role = snap.role(&role_id).ok_or(ApiError::NotFound("role"))?;
    if role.id == id {
        return Err(ApiError::bad("@everyone cannot be deleted"));
    }
    if !ctx.outranks(role.position) {
        return Err(ApiError::Forbidden("you can only delete roles below your highest role"));
    }
    let position = role.position;
    let mut tx = state.db.begin().await?;
    sqlx::query("DELETE FROM server_roles WHERE id = ?")
        .bind(&role_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE server_roles SET position = position - 1 WHERE server_id = ? AND position > ?")
        .bind(&id)
        .bind(position)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    broadcast_server(&state, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct RoleOrder {
    /// Highest first, without @everyone.
    pub role_ids: Vec<String>,
}

/// Reorders roles. Only roles below the actor's top role may move, and they
/// must stay below it.
pub async fn order_roles(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<RoleOrder>,
) -> ApiResult<StatusCode> {
    let (snap, ctx) = actor(&state.db, &id, &user.id).await?;
    need(&ctx, perm::MANAGE_ROLES, "missing Manage Roles")?;
    let others: Vec<&perm::RoleRow> = snap.roles.iter().filter(|r| r.id != id).collect();
    if body.role_ids.len() != others.len() || !others.iter().all(|r| body.role_ids.contains(&r.id)) {
        return Err(ApiError::bad("role_ids must list every role except @everyone"));
    }
    let n = body.role_ids.len() as i64;
    let mut tx = state.db.begin().await?;
    for (i, rid) in body.role_ids.iter().enumerate() {
        let new_pos = n - i as i64;
        let old_pos = snap.role(rid).map(|r| r.position).unwrap_or(0);
        if new_pos != old_pos && !(ctx.outranks(old_pos) && ctx.outranks(new_pos)) {
            return Err(ApiError::Forbidden("you can only move roles below your highest role"));
        }
        sqlx::query("UPDATE server_roles SET position = ? WHERE id = ?")
            .bind(new_pos)
            .bind(rid)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    broadcast_server(&state, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------- channels

#[derive(Deserialize)]
pub struct CategoryBody {
    pub name: String,
}

pub async fn create_category(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<CategoryBody>,
) -> ApiResult<(StatusCode, Json<ServerCategory>)> {
    let (_, ctx) = actor(&state.db, &id, &user.id).await?;
    need(&ctx, perm::MANAGE_CHANNELS, "missing Manage Channels")?;
    let name = name_1_64(&body.name, "category name")?;
    let (count, max_pos): (i64, Option<i64>) =
        sqlx::query_as("SELECT COUNT(*), MAX(position) FROM channel_categories WHERE server_id = ?")
            .bind(&id)
            .fetch_one(&state.db)
            .await?;
    if count >= MAX_CATEGORIES {
        return Err(ApiError::Conflict("too many categories"));
    }
    let cat = ServerCategory {
        id: new_id(),
        name,
        position: max_pos.map_or(0, |p| p + 1),
    };
    sqlx::query("INSERT INTO channel_categories (id, server_id, name, position) VALUES (?, ?, ?, ?)")
        .bind(&cat.id)
        .bind(&id)
        .bind(&cat.name)
        .bind(cat.position)
        .execute(&state.db)
        .await?;
    broadcast_server(&state, &id).await?;
    Ok((StatusCode::CREATED, Json(cat)))
}

pub async fn update_category(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, category_id)): Path<(String, String)>,
    ApiJson(body): ApiJson<CategoryBody>,
) -> ApiResult<StatusCode> {
    let (_, ctx) = actor(&state.db, &id, &user.id).await?;
    need(&ctx, perm::MANAGE_CHANNELS, "missing Manage Channels")?;
    let res = sqlx::query("UPDATE channel_categories SET name = ? WHERE id = ? AND server_id = ?")
        .bind(name_1_64(&body.name, "category name")?)
        .bind(&category_id)
        .bind(&id)
        .execute(&state.db)
        .await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::NotFound("category"));
    }
    broadcast_server(&state, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn delete_category(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, category_id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let (_, ctx) = actor(&state.db, &id, &user.id).await?;
    need(&ctx, perm::MANAGE_CHANNELS, "missing Manage Channels")?;
    // Its channels stay, uncategorized (FK ON DELETE SET NULL).
    let res = sqlx::query("DELETE FROM channel_categories WHERE id = ? AND server_id = ?")
        .bind(&category_id)
        .bind(&id)
        .execute(&state.db)
        .await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::NotFound("category"));
    }
    sqlx::query("DELETE FROM permission_overwrites WHERE target_id = ?")
        .bind(&category_id)
        .execute(&state.db)
        .await?;
    broadcast_server(&state, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct CreateChannel {
    pub name: String,
    pub kind: String,
    pub category_id: Option<String>,
    pub topic: Option<String>,
}

async fn check_category(db: &Db, server_id: &str, category_id: Option<&str>) -> ApiResult<()> {
    if let Some(c) = category_id {
        let ok: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM channel_categories WHERE id = ? AND server_id = ?")
            .bind(c)
            .bind(server_id)
            .fetch_optional(db)
            .await?;
        if ok.is_none() {
            return Err(ApiError::NotFound("category"));
        }
    }
    Ok(())
}

pub async fn create_channel(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<CreateChannel>,
) -> ApiResult<StatusCode> {
    let (_, ctx) = actor(&state.db, &id, &user.id).await?;
    need(&ctx, perm::MANAGE_CHANNELS, "missing Manage Channels")?;
    let (kind, name) = match body.kind.as_str() {
        "text" => ("text", text_channel_name(&body.name)?),
        "voice" => ("voice", name_1_64(&body.name, "channel name")?),
        _ => return Err(ApiError::bad("kind must be 'text' or 'voice'")),
    };
    check_category(&state.db, &id, body.category_id.as_deref()).await?;
    let (count, max_pos): (i64, Option<i64>) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM conversations WHERE server_id = ?1),
                (SELECT MAX(position) FROM conversations WHERE server_id = ?1 AND category_id IS ?2)",
    )
    .bind(&id)
    .bind(body.category_id.as_deref())
    .fetch_one(&state.db)
    .await?;
    if count >= MAX_CHANNELS {
        return Err(ApiError::Conflict("too many channels"));
    }
    sqlx::query(
        "INSERT INTO conversations (id, kind, name, created_at, server_id, category_id, position, topic)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(new_id())
    .bind(kind)
    .bind(name)
    .bind(now_ms())
    .bind(&id)
    .bind(body.category_id.as_deref())
    .bind(max_pos.map_or(0, |p| p + 1))
    .bind(topic(body.topic.as_deref().unwrap_or(""))?)
    .execute(&state.db)
    .await?;
    broadcast_server(&state, &id).await?;
    Ok(StatusCode::CREATED)
}

#[derive(Deserialize)]
pub struct UpdateChannel {
    pub name: Option<String>,
    pub topic: Option<String>,
}

async fn channel_kind(db: &Db, server_id: &str, channel_id: &str) -> ApiResult<String> {
    validate_id(channel_id)?;
    let row: Option<(String,)> = sqlx::query_as("SELECT kind FROM conversations WHERE id = ? AND server_id = ?")
        .bind(channel_id)
        .bind(server_id)
        .fetch_optional(db)
        .await?;
    row.map(|r| r.0).ok_or(ApiError::NotFound("channel"))
}

pub async fn update_channel(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, channel_id)): Path<(String, String)>,
    ApiJson(body): ApiJson<UpdateChannel>,
) -> ApiResult<StatusCode> {
    let (_, ctx) = actor(&state.db, &id, &user.id).await?;
    need(&ctx, perm::MANAGE_CHANNELS, "missing Manage Channels")?;
    let kind = channel_kind(&state.db, &id, &channel_id).await?;
    if let Some(name) = body.name {
        let name = if kind == "text" {
            text_channel_name(&name)?
        } else {
            name_1_64(&name, "channel name")?
        };
        sqlx::query("UPDATE conversations SET name = ? WHERE id = ?")
            .bind(name)
            .bind(&channel_id)
            .execute(&state.db)
            .await?;
    }
    if let Some(t) = body.topic {
        sqlx::query("UPDATE conversations SET topic = ? WHERE id = ?")
            .bind(topic(&t)?)
            .bind(&channel_id)
            .execute(&state.db)
            .await?;
    }
    broadcast_server(&state, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn delete_channel(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, channel_id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let (_, ctx) = actor(&state.db, &id, &user.id).await?;
    need(&ctx, perm::MANAGE_CHANNELS, "missing Manage Channels")?;
    channel_kind(&state.db, &id, &channel_id).await?;
    if let Some(call_id) = calls::active_call_id(&state.db, &channel_id).await? {
        calls::end_internal(&state, &call_id).await?;
    }
    delete_conversation_files(&state, &channel_id).await?;
    sqlx::query("DELETE FROM conversations WHERE id = ?")
        .bind(&channel_id)
        .execute(&state.db)
        .await?;
    sqlx::query("DELETE FROM permission_overwrites WHERE target_id = ?")
        .bind(&channel_id)
        .execute(&state.db)
        .await?;
    broadcast_server(&state, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct LayoutCategory {
    pub id: String,
    pub position: i64,
}

#[derive(Deserialize)]
pub struct LayoutChannel {
    pub id: String,
    pub category_id: Option<String>,
    pub position: i64,
}

#[derive(Deserialize)]
pub struct Layout {
    #[serde(default)]
    pub categories: Vec<LayoutCategory>,
    #[serde(default)]
    pub channels: Vec<LayoutChannel>,
}

/// Moves categories and channels (order and channel → category).
pub async fn layout(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<Layout>,
) -> ApiResult<StatusCode> {
    let (_, ctx) = actor(&state.db, &id, &user.id).await?;
    need(&ctx, perm::MANAGE_CHANNELS, "missing Manage Channels")?;
    let mut tx = state.db.begin().await?;
    for c in &body.categories {
        sqlx::query("UPDATE channel_categories SET position = ? WHERE id = ? AND server_id = ?")
            .bind(c.position)
            .bind(&c.id)
            .bind(&id)
            .execute(&mut *tx)
            .await?;
    }
    for ch in &body.channels {
        if let Some(cat) = ch.category_id.as_deref() {
            let ok: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM channel_categories WHERE id = ? AND server_id = ?")
                .bind(cat)
                .bind(&id)
                .fetch_optional(&mut *tx)
                .await?;
            if ok.is_none() {
                return Err(ApiError::NotFound("category"));
            }
        }
        sqlx::query("UPDATE conversations SET category_id = ?, position = ? WHERE id = ? AND server_id = ?")
            .bind(ch.category_id.as_deref())
            .bind(ch.position)
            .bind(&ch.id)
            .bind(&id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    broadcast_server(&state, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct OverwriteBody {
    pub allow: i64,
    pub deny: i64,
}

async fn check_overwrite_target(db: &Db, server_id: &str, target_id: &str) -> ApiResult<()> {
    validate_id(target_id)?;
    let ok: Option<(i64,)> = sqlx::query_as(
        "SELECT 1 FROM channel_categories WHERE id = ?1 AND server_id = ?2
         UNION SELECT 1 FROM conversations WHERE id = ?1 AND server_id = ?2",
    )
    .bind(target_id)
    .bind(server_id)
    .fetch_optional(db)
    .await?;
    ok.map(|_| ()).ok_or(ApiError::NotFound("channel"))
}

pub async fn put_overwrite(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, target_id, role_id)): Path<(String, String, String)>,
    ApiJson(body): ApiJson<OverwriteBody>,
) -> ApiResult<StatusCode> {
    let (snap, ctx) = actor(&state.db, &id, &user.id).await?;
    need(&ctx, perm::MANAGE_ROLES, "missing Manage Roles")?;
    check_overwrite_target(&state.db, &id, &target_id).await?;
    let role = snap.role(&role_id).ok_or(ApiError::NotFound("role"))?;
    if role.id != id && !ctx.outranks(role.position) {
        return Err(ApiError::Forbidden("you can only edit roles below your highest role"));
    }
    let allow = check_grant(&ctx, body.allow & perm::CHANNEL_SCOPED)?;
    let deny = check_grant(&ctx, body.deny & perm::CHANNEL_SCOPED & !allow)?;
    sqlx::query(
        "INSERT INTO permission_overwrites (target_id, server_id, role_id, allow, deny) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (target_id, role_id) DO UPDATE SET allow = excluded.allow, deny = excluded.deny",
    )
    .bind(&target_id)
    .bind(&id)
    .bind(&role_id)
    .bind(allow)
    .bind(deny)
    .execute(&state.db)
    .await?;
    broadcast_server(&state, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn delete_overwrite(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, target_id, role_id)): Path<(String, String, String)>,
) -> ApiResult<StatusCode> {
    let (snap, ctx) = actor(&state.db, &id, &user.id).await?;
    need(&ctx, perm::MANAGE_ROLES, "missing Manage Roles")?;
    let role = snap.role(&role_id).ok_or(ApiError::NotFound("role"))?;
    if role.id != id && !ctx.outranks(role.position) {
        return Err(ApiError::Forbidden("you can only edit roles below your highest role"));
    }
    sqlx::query("DELETE FROM permission_overwrites WHERE target_id = ? AND role_id = ? AND server_id = ?")
        .bind(&target_id)
        .bind(&role_id)
        .bind(&id)
        .execute(&state.db)
        .await?;
    broadcast_server(&state, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}
