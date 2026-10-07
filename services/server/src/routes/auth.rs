use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};

use super::{
    common::{ApiJson, ClientIp, validate_device_name, validate_display_name, validate_password, validate_username},
    users::load_me,
};
use crate::{
    auth::{
        AuthUser, password,
        tokens::{RefreshToken, issue_access, secure_eq},
    },
    db::{is_unique_violation, new_id, now_ms},
    error::{ApiError, ApiResult},
    invites,
    models::Me,
    rate_limit::rules,
    state::AppState,
};

#[derive(Deserialize)]
pub struct RegisterBody {
    pub username: String,
    pub display_name: Option<String>,
    pub password: String,
    pub invite_code: Option<String>,
    pub device_name: Option<String>,
}

#[derive(Deserialize)]
pub struct LoginBody {
    pub username: String,
    pub password: String,
    pub device_name: Option<String>,
}

#[derive(Deserialize)]
pub struct RefreshBody {
    pub refresh_token: String,
}

#[derive(Serialize)]
pub struct AuthResponse {
    pub access_token: String,
    pub refresh_token: String,
    /// Seconds until the access token expires.
    pub expires_in: u64,
    pub session_id: String,
    pub user: Me,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct SessionInfo {
    pub id: String,
    pub device_name: String,
    pub created_at: i64,
    pub last_used_at: i64,
    #[sqlx(skip)]
    pub current: bool,
}

pub async fn register(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    ApiJson(body): ApiJson<RegisterBody>,
) -> ApiResult<(StatusCode, Json<AuthResponse>)> {
    state.limiter.check("auth", &ip, rules::AUTH)?;
    let username = validate_username(&body.username)?;
    let display_name = validate_display_name(body.display_name.as_deref().unwrap_or(&username))?;
    validate_password(&body.password)?;
    let invite = body.invite_code.as_deref().map(str::trim).filter(|c| !c.is_empty());
    if invite.is_none() && !state.config.allow_public_registration {
        return Err(ApiError::Forbidden("an invite code is required"));
    }

    let hash = password::hash(body.password).await?;
    let now = now_ms();
    let user_id = new_id();

    let mut tx = state.db.begin().await?;
    if let Some(code) = invite
        && !invites::consume(&mut tx, code).await?
    {
        return Err(ApiError::Forbidden("invalid or expired invite code"));
    }
    // The very first account administers the instance.
    let (user_count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM users").fetch_one(&mut *tx).await?;
    let res = sqlx::query(
        "INSERT INTO users (id, username, display_name, password_hash, is_admin, invite_code, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&user_id)
    .bind(&username)
    .bind(&display_name)
    .bind(&hash)
    .bind((user_count == 0) as i64)
    .bind(invite.map(invites::normalize_code))
    .bind(now)
    .bind(now)
    .execute(&mut *tx)
    .await;
    match res {
        Err(e) if is_unique_violation(&e) => return Err(ApiError::Conflict("username already taken")),
        r => r?,
    };
    tx.commit().await?;
    tracing::info!(user_id, username, "user registered");

    let resp = start_session(&state, &user_id, &validate_device_name(body.device_name.as_deref())).await?;
    Ok((StatusCode::CREATED, Json(resp)))
}

pub async fn login(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    ApiJson(body): ApiJson<LoginBody>,
) -> ApiResult<Json<AuthResponse>> {
    state.limiter.check("auth", &ip, rules::AUTH)?;
    let username = body.username.trim().to_ascii_lowercase();
    let row: Option<(String, String, i64)> =
        sqlx::query_as("SELECT id, password_hash, disabled FROM users WHERE username = ?")
            .bind(&username)
            .fetch_optional(&state.db)
            .await?;
    let Some((user_id, hash, disabled)) = row else {
        password::verify_dummy(body.password).await;
        return Err(ApiError::InvalidCredentials("invalid username or password"));
    };
    if !password::verify(body.password, hash).await {
        return Err(ApiError::InvalidCredentials("invalid username or password"));
    }
    if disabled != 0 {
        return Err(ApiError::Forbidden("this account is disabled"));
    }
    let resp = start_session(&state, &user_id, &validate_device_name(body.device_name.as_deref())).await?;
    Ok(Json(resp))
}

async fn start_session(state: &AppState, user_id: &str, device_name: &str) -> ApiResult<AuthResponse> {
    let session_id = new_id();
    let refresh = RefreshToken::generate(&session_id);
    let now = now_ms();
    sqlx::query(
        "INSERT INTO sessions (id, user_id, refresh_hash, device_name, created_at, last_used_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&session_id)
    .bind(user_id)
    .bind(refresh.hash())
    .bind(device_name)
    .bind(now)
    .bind(now)
    .bind(now + state.config.refresh_token_ttl.as_millis() as i64)
    .execute(&state.db)
    .await?;
    build_response(state, user_id, &session_id, &refresh).await
}

async fn build_response(
    state: &AppState,
    user_id: &str,
    session_id: &str,
    refresh: &RefreshToken,
) -> ApiResult<AuthResponse> {
    let ttl = state.config.access_token_ttl.as_secs();
    Ok(AuthResponse {
        access_token: issue_access(&state.config.jwt_secret, user_id, session_id, ttl as i64)?,
        refresh_token: refresh.encode(),
        expires_in: ttl,
        session_id: session_id.to_string(),
        user: load_me(&state.db, user_id).await?,
    })
}

/// Rotates the refresh token. Presenting an already-rotated token means it was
/// copied somewhere: the whole session is revoked.
pub async fn refresh(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    ApiJson(body): ApiJson<RefreshBody>,
) -> ApiResult<Json<AuthResponse>> {
    state.limiter.check("refresh", &ip, rules::AUTH)?;
    let presented = RefreshToken::parse(&body.refresh_token).ok_or(ApiError::Unauthorized)?;
    let now = now_ms();
    let row: Option<(String, String, i64, Option<i64>, i64)> = sqlx::query_as(
        "SELECT s.user_id, s.refresh_hash, s.expires_at, s.revoked_at, u.disabled
         FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?",
    )
    .bind(&presented.session_id)
    .fetch_optional(&state.db)
    .await?;
    let (user_id, stored_hash, expires_at, revoked_at, disabled) = row.ok_or(ApiError::Unauthorized)?;
    if revoked_at.is_some() || expires_at <= now || disabled != 0 {
        return Err(ApiError::Unauthorized);
    }
    if !secure_eq(&stored_hash, &presented.hash()) {
        tracing::warn!(
            session_id = presented.session_id,
            "refresh token reuse detected, revoking session"
        );
        revoke_session(&state, &presented.session_id).await?;
        return Err(ApiError::Unauthorized);
    }

    let next = RefreshToken::generate(&presented.session_id);
    // Compare-and-swap on the old hash so two concurrent refreshes cannot both win.
    let res = sqlx::query(
        "UPDATE sessions SET refresh_hash = ?, last_used_at = ?, expires_at = ?
         WHERE id = ? AND refresh_hash = ? AND revoked_at IS NULL",
    )
    .bind(next.hash())
    .bind(now)
    .bind(now + state.config.refresh_token_ttl.as_millis() as i64)
    .bind(&presented.session_id)
    .bind(&stored_hash)
    .execute(&state.db)
    .await?;
    if res.rows_affected() != 1 {
        return Err(ApiError::Unauthorized);
    }
    Ok(Json(
        build_response(&state, &user_id, &presented.session_id, &next).await?,
    ))
}

pub async fn logout(State(state): State<AppState>, user: AuthUser) -> ApiResult<StatusCode> {
    revoke_session(&state, &user.session_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn list_sessions(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<Vec<SessionInfo>>> {
    let mut sessions: Vec<SessionInfo> = sqlx::query_as(
        "SELECT id, device_name, created_at, last_used_at FROM sessions
         WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_used_at DESC",
    )
    .bind(&user.id)
    .bind(now_ms())
    .fetch_all(&state.db)
    .await?;
    for s in &mut sessions {
        s.current = s.id == user.session_id;
    }
    Ok(Json(sessions))
}

pub async fn delete_session(
    State(state): State<AppState>,
    user: AuthUser,
    Path(session_id): Path<String>,
) -> ApiResult<StatusCode> {
    let owned: Option<(String,)> = sqlx::query_as("SELECT id FROM sessions WHERE id = ? AND user_id = ?")
        .bind(&session_id)
        .bind(&user.id)
        .fetch_optional(&state.db)
        .await?;
    if owned.is_none() {
        return Err(ApiError::NotFound("session"));
    }
    revoke_session(&state, &session_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn revoke_session(state: &AppState, session_id: &str) -> ApiResult<()> {
    sqlx::query("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
        .bind(now_ms())
        .bind(session_id)
        .execute(&state.db)
        .await?;
    state.hub.close_session(session_id, "session revoked");
    Ok(())
}
