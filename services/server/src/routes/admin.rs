use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};

use super::common::{ApiJson, validate_id};
use crate::{
    auth::AuthUser,
    db::{Db, now_ms},
    error::{ApiError, ApiResult},
    invites,
    models::Invite,
    state::AppState,
};

fn require_admin(user: &AuthUser) -> ApiResult<()> {
    if user.is_admin {
        Ok(())
    } else {
        Err(ApiError::Forbidden("administrator only"))
    }
}

#[derive(Deserialize)]
pub struct CreateInvite {
    pub max_uses: Option<i64>,
    /// e.g. "7d", "12h"
    pub expires_in: Option<String>,
}

pub async fn create_invite(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(body): ApiJson<CreateInvite>,
) -> ApiResult<(StatusCode, Json<Invite>)> {
    require_admin(&user)?;
    if body.max_uses.is_some_and(|n| n < 1) {
        return Err(ApiError::bad("max_uses must be at least 1"));
    }
    let expires_at = match body.expires_in.as_deref() {
        Some(s) => Some(
            now_ms()
                + invites::parse_duration_ms(s)
                    .ok_or_else(|| ApiError::bad("expires_in must look like 30m, 12h or 7d"))?,
        ),
        None => None,
    };
    let invite = invites::create(
        &state.db,
        &state.config.invite_prefix,
        body.max_uses,
        expires_at,
        Some(&user.id),
    )
    .await?;
    Ok((StatusCode::CREATED, Json(invite)))
}

pub async fn list_invites(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<Vec<Invite>>> {
    require_admin(&user)?;
    Ok(Json(invites::list(&state.db).await?))
}

pub async fn revoke_invite(
    State(state): State<AppState>,
    user: AuthUser,
    Path(code): Path<String>,
) -> ApiResult<StatusCode> {
    require_admin(&user)?;
    if invites::revoke(&state.db, &code).await? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::NotFound("invite"))
    }
}

#[derive(Serialize, sqlx::FromRow)]
pub struct AdminUser {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub is_admin: bool,
    pub disabled: bool,
    pub invite_code: Option<String>,
    pub created_at: i64,
}

pub async fn all_users(db: &Db) -> anyhow::Result<Vec<AdminUser>> {
    Ok(sqlx::query_as(
        "SELECT id, username, display_name, is_admin, disabled, invite_code, created_at FROM users ORDER BY created_at",
    )
    .fetch_all(db)
    .await?)
}

pub async fn list_users(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<Vec<AdminUser>>> {
    require_admin(&user)?;
    Ok(Json(all_users(&state.db).await?))
}

pub async fn set_disabled(db: &Db, user_id: &str, disabled: bool) -> anyhow::Result<bool> {
    let res = sqlx::query("UPDATE users SET disabled = ?, updated_at = ? WHERE id = ?")
        .bind(disabled as i64)
        .bind(now_ms())
        .bind(user_id)
        .execute(db)
        .await?;
    if disabled {
        sqlx::query("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
            .bind(now_ms())
            .bind(user_id)
            .execute(db)
            .await?;
    }
    Ok(res.rows_affected() == 1)
}

pub async fn disable_user(
    State(state): State<AppState>,
    user: AuthUser,
    Path(user_id): Path<String>,
) -> ApiResult<StatusCode> {
    require_admin(&user)?;
    validate_id(&user_id)?;
    if user_id == user.id {
        return Err(ApiError::bad("you cannot disable yourself"));
    }
    if !set_disabled(&state.db, &user_id, true).await? {
        return Err(ApiError::NotFound("user"));
    }
    state.hub.close_user(&user_id, "account disabled");
    Ok(StatusCode::NO_CONTENT)
}

pub async fn enable_user(
    State(state): State<AppState>,
    user: AuthUser,
    Path(user_id): Path<String>,
) -> ApiResult<StatusCode> {
    require_admin(&user)?;
    validate_id(&user_id)?;
    if !set_disabled(&state.db, &user_id, false).await? {
        return Err(ApiError::NotFound("user"));
    }
    Ok(StatusCode::NO_CONTENT)
}
