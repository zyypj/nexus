pub mod password;
pub mod tokens;

use axum::{extract::FromRequestParts, http::request::Parts};

use crate::{error::ApiError, state::AppState};

/// Authenticated caller. Extracting it validates the access token *and* that
/// the session is still active and the account enabled, so logout and
/// `admin user disable` take effect immediately.
#[derive(Clone, Debug)]
pub struct AuthUser {
    pub id: String,
    pub session_id: String,
    pub is_admin: bool,
}

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let header = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .ok_or(ApiError::Unauthorized)?;
        let token = header.strip_prefix("Bearer ").ok_or(ApiError::Unauthorized)?;
        authenticate(state, token).await
    }
}

pub async fn authenticate(state: &AppState, token: &str) -> Result<AuthUser, ApiError> {
    let claims = tokens::verify_access(&state.config.jwt_secret, token).ok_or(ApiError::Unauthorized)?;
    let row: Option<(i64,)> = sqlx::query_as(
        "SELECT u.is_admin FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.id = ? AND s.user_id = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND u.disabled = 0",
    )
    .bind(&claims.sid)
    .bind(&claims.sub)
    .bind(crate::db::now_ms())
    .fetch_optional(&state.db)
    .await?;
    let (is_admin,) = row.ok_or(ApiError::Unauthorized)?;
    Ok(AuthUser {
        id: claims.sub,
        session_id: claims.sid,
        is_admin: is_admin != 0,
    })
}
