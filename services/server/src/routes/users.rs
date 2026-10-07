use axum::{
    Json,
    body::Body,
    extract::{Multipart, Path, Query, State},
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::Deserialize;

use super::common::{ApiJson, clean_text, validate_display_name, validate_id, validate_password};
use crate::{
    auth::{AuthUser, password},
    db::{Db, now_ms},
    error::{ApiError, ApiResult},
    gateway::events::{self, user_audience},
    models::{Me, Presence, PresenceUpdate, PublicUser, UserRow, UserStatus},
    state::AppState,
    storage::{Storage, inline_image_mime},
};

#[derive(sqlx::FromRow)]
struct MeRow {
    #[sqlx(flatten)]
    user: UserRow,
    status: String,
    is_admin: i64,
    created_at: i64,
}

pub async fn load_me(db: &Db, user_id: &str) -> ApiResult<Me> {
    let row: Option<MeRow> = sqlx::query_as(
        "SELECT id, username, display_name, avatar, bio, status, is_admin, created_at FROM users WHERE id = ?",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    let row = row.ok_or(ApiError::NotFound("user"))?;
    Ok(Me {
        user: row.user.into(),
        status: UserStatus::parse(&row.status),
        is_admin: row.is_admin != 0,
        created_at: row.created_at,
    })
}

pub async fn load_user(db: &Db, user_id: &str) -> ApiResult<PublicUser> {
    let row: Option<UserRow> = sqlx::query_as(concat!(
        "SELECT ",
        crate::user_columns!(),
        " FROM users u WHERE u.id = ?"
    ))
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    row.map(Into::into).ok_or(ApiError::NotFound("user"))
}

pub async fn user_status(db: &Db, user_id: &str) -> ApiResult<UserStatus> {
    let row: Option<(String,)> = sqlx::query_as("SELECT status FROM users WHERE id = ?")
        .bind(user_id)
        .fetch_optional(db)
        .await?;
    Ok(row.map(|r| UserStatus::parse(&r.0)).unwrap_or(UserStatus::Online))
}

pub async fn me(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<Me>> {
    Ok(Json(load_me(&state.db, &user.id).await?))
}

#[derive(Deserialize)]
pub struct UpdateMe {
    pub display_name: Option<String>,
    pub bio: Option<String>,
    pub status: Option<UserStatus>,
}

pub async fn update_me(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(body): ApiJson<UpdateMe>,
) -> ApiResult<Json<Me>> {
    let before = load_me(&state.db, &user.id).await?;
    let display_name = match body.display_name {
        Some(n) => validate_display_name(&n)?,
        None => before.user.display_name.clone(),
    };
    let bio = match body.bio {
        Some(b) => {
            let b = clean_text(&b);
            if b.chars().count() > 190 {
                return Err(ApiError::bad("bio must be at most 190 characters"));
            }
            b
        }
        None => before.user.bio.clone(),
    };
    let status = body.status.unwrap_or(before.status);
    sqlx::query("UPDATE users SET display_name = ?, bio = ?, status = ?, updated_at = ? WHERE id = ?")
        .bind(&display_name)
        .bind(&bio)
        .bind(status.as_str())
        .bind(now_ms())
        .bind(&user.id)
        .execute(&state.db)
        .await?;
    let after = load_me(&state.db, &user.id).await?;
    broadcast_user_update(&state, &after).await?;
    if status != before.status {
        broadcast_presence(&state, &user.id, status).await?;
    }
    Ok(Json(after))
}

/// Others get the public profile; the user's own devices get the full `Me`
/// (including the raw status, e.g. invisible).
pub async fn broadcast_user_update(state: &AppState, me: &Me) -> ApiResult<()> {
    let audience = user_audience(&state.db, &me.user.id).await?;
    state.hub.send(
        audience.iter().map(String::as_str).filter(|u| *u != me.user.id),
        events::USER_UPDATE,
        &me.user,
    );
    state.hub.send_one(&me.user.id, events::USER_UPDATE, me);
    Ok(())
}

pub async fn broadcast_presence(state: &AppState, user_id: &str, status: UserStatus) -> ApiResult<()> {
    let audience = user_audience(&state.db, user_id).await?;
    let update = PresenceUpdate {
        user_id: user_id.to_string(),
        status: Presence::visible(state.hub.is_online(user_id), status),
    };
    state
        .hub
        .send(audience.iter().map(String::as_str), events::PRESENCE_UPDATE, &update);
    Ok(())
}

#[derive(Deserialize)]
pub struct ChangePassword {
    pub current_password: String,
    pub new_password: String,
}

/// Changing the password signs out every other session.
pub async fn change_password(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(body): ApiJson<ChangePassword>,
) -> ApiResult<StatusCode> {
    validate_password(&body.new_password)?;
    let (hash,): (String,) = sqlx::query_as("SELECT password_hash FROM users WHERE id = ?")
        .bind(&user.id)
        .fetch_one(&state.db)
        .await?;
    if !password::verify(body.current_password, hash).await {
        return Err(ApiError::InvalidCredentials("current password is incorrect"));
    }
    let new_hash = password::hash(body.new_password).await?;
    sqlx::query("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
        .bind(new_hash)
        .bind(now_ms())
        .bind(&user.id)
        .execute(&state.db)
        .await?;
    let others: Vec<(String,)> =
        sqlx::query_as("SELECT id FROM sessions WHERE user_id = ? AND id != ? AND revoked_at IS NULL")
            .bind(&user.id)
            .bind(&user.session_id)
            .fetch_all(&state.db)
            .await?;
    for (sid,) in others {
        super::auth::revoke_session(&state, &sid).await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

pub async fn get_user(
    State(state): State<AppState>,
    _user: AuthUser,
    Path(user_id): Path<String>,
) -> ApiResult<Json<PublicUser>> {
    validate_id(&user_id)?;
    Ok(Json(load_user(&state.db, &user_id).await?))
}

#[derive(Deserialize)]
pub struct SearchQuery {
    pub username: String,
}

/// Exact username lookup (used by "add friend"); no directory browsing.
pub async fn search(
    State(state): State<AppState>,
    _user: AuthUser,
    Query(q): Query<SearchQuery>,
) -> ApiResult<Json<PublicUser>> {
    let row: Option<UserRow> = sqlx::query_as(concat!(
        "SELECT ",
        crate::user_columns!(),
        " FROM users u WHERE u.username = ? AND u.disabled = 0"
    ))
    .bind(q.username.trim().to_ascii_lowercase())
    .fetch_optional(&state.db)
    .await?;
    row.map(|r| Json(r.into())).ok_or(ApiError::NotFound("user"))
}

pub async fn upload_avatar(
    State(state): State<AppState>,
    user: AuthUser,
    mut multipart: Multipart,
) -> ApiResult<Json<Me>> {
    state
        .limiter
        .check("upload", &user.id, crate::rate_limit::rules::UPLOAD)?;
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
        return Err(ApiError::bad("avatar must be at most 4096x4096"));
    }

    let name = Storage::new_storage_name();
    let path = state.storage.avatar_path(&name).ok_or(ApiError::bad("invalid name"))?;
    tokio::fs::write(&path, &data).await?;

    let (old,): (Option<String>,) = sqlx::query_as("SELECT avatar FROM users WHERE id = ?")
        .bind(&user.id)
        .fetch_one(&state.db)
        .await?;
    sqlx::query("UPDATE users SET avatar = ?, updated_at = ? WHERE id = ?")
        .bind(&name)
        .bind(now_ms())
        .bind(&user.id)
        .execute(&state.db)
        .await?;
    if let Some(old_path) = old.as_deref().and_then(|o| state.storage.avatar_path(o)) {
        let _ = tokio::fs::remove_file(old_path).await;
    }
    let me = load_me(&state.db, &user.id).await?;
    broadcast_user_update(&state, &me).await?;
    Ok(Json(me))
}

pub async fn delete_avatar(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<Me>> {
    let (old,): (Option<String>,) = sqlx::query_as("SELECT avatar FROM users WHERE id = ?")
        .bind(&user.id)
        .fetch_one(&state.db)
        .await?;
    sqlx::query("UPDATE users SET avatar = NULL, updated_at = ? WHERE id = ?")
        .bind(now_ms())
        .bind(&user.id)
        .execute(&state.db)
        .await?;
    if let Some(old_path) = old.as_deref().and_then(|o| state.storage.avatar_path(o)) {
        let _ = tokio::fs::remove_file(old_path).await;
    }
    let me = load_me(&state.db, &user.id).await?;
    broadcast_user_update(&state, &me).await?;
    Ok(Json(me))
}

/// Avatars use unguessable names and are cacheable forever (a new upload gets a new name).
pub async fn serve_avatar(State(state): State<AppState>, Path(name): Path<String>) -> ApiResult<Response> {
    let path = state.storage.avatar_path(&name).ok_or(ApiError::NotFound("avatar"))?;
    let data = tokio::fs::read(&path).await.map_err(|_| ApiError::NotFound("avatar"))?;
    let mime = inline_image_mime(infer::get(&data).map(|t| t.mime_type())).unwrap_or("application/octet-stream");
    let mut res = Body::from(data).into_response();
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=31536000, immutable"),
    );
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    Ok(res)
}
