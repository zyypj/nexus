use std::net::{IpAddr, SocketAddr};

use axum::{
    extract::{ConnectInfo, FromRequest, FromRequestParts, Request, rejection::JsonRejection},
    http::request::Parts,
};
use serde::de::DeserializeOwned;

use crate::{error::ApiError, state::AppState};

/// `Json<T>` whose rejections use our error format instead of plain text.
pub struct ApiJson<T>(pub T);

impl<T: DeserializeOwned, S: Send + Sync> FromRequest<S> for ApiJson<T> {
    type Rejection = ApiError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        match axum::Json::<T>::from_request(req, state).await {
            Ok(axum::Json(v)) => Ok(Self(v)),
            Err(JsonRejection::JsonDataError(e)) => Err(ApiError::bad(e.body_text())),
            Err(e) => Err(ApiError::bad(e.body_text())),
        }
    }
}

/// Caller IP for rate limiting. Uses `X-Forwarded-For` only when TRUST_PROXY is set.
pub struct ClientIp(pub String);

impl FromRequestParts<AppState> for ClientIp {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        if state.config.trust_proxy
            && let Some(ip) = parts
                .headers
                .get("x-forwarded-for")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.split(',').next())
                .and_then(|v| v.trim().parse::<IpAddr>().ok())
        {
            return Ok(Self(ip.to_string()));
        }
        let ip = parts
            .extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map(|c| c.0.ip().to_string())
            .unwrap_or_else(|| "unknown".into());
        Ok(Self(ip))
    }
}

pub fn clean_text(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
        .collect::<String>()
        .trim()
        .to_string()
}

pub fn validate_username(raw: &str) -> Result<String, ApiError> {
    let u = raw.trim().to_ascii_lowercase();
    let ok_chars = u
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'.');
    if !(2..=32).contains(&u.len()) || !ok_chars || u.starts_with('.') || u.ends_with('.') || u.contains("..") {
        return Err(ApiError::bad(
            "username must be 2-32 characters: lowercase letters, digits, '_' or '.'",
        ));
    }
    Ok(u)
}

pub fn validate_display_name(raw: &str) -> Result<String, ApiError> {
    let n: String = clean_text(raw).replace(['\n', '\t'], " ");
    let len = n.chars().count();
    if !(1..=32).contains(&len) {
        return Err(ApiError::bad("display name must be 1-32 characters"));
    }
    Ok(n)
}

pub fn validate_password(p: &str) -> Result<(), ApiError> {
    let len = p.chars().count();
    if !(8..=128).contains(&len) {
        return Err(ApiError::bad("password must be 8-128 characters"));
    }
    Ok(())
}

pub fn validate_device_name(raw: Option<&str>) -> String {
    raw.map(clean_text).unwrap_or_default().chars().take(64).collect()
}

pub fn validate_id(id: &str) -> Result<(), ApiError> {
    if id.len() == 36 && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
        Ok(())
    } else {
        Err(ApiError::NotFound("resource"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usernames() {
        assert_eq!(validate_username(" Joao_1 ").unwrap(), "joao_1");
        assert!(validate_username("a").is_err());
        assert!(validate_username("bad name").is_err());
        assert!(validate_username("..x").is_err());
        assert!(validate_username("joão").is_err());
    }

    #[test]
    fn display_names() {
        assert_eq!(validate_display_name("  João\u{0}  ").unwrap(), "João");
        assert!(validate_display_name("   ").is_err());
    }
}
