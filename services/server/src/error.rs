use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("{0}")]
    BadRequest(String),
    #[error("authentication required")]
    Unauthorized,
    #[error("{0}")]
    InvalidCredentials(&'static str),
    #[error("{0}")]
    Forbidden(&'static str),
    #[error("{0} not found")]
    NotFound(&'static str),
    #[error("{0}")]
    Conflict(&'static str),
    #[error("file too large")]
    PayloadTooLarge,
    #[error("not enough free disk space on the server")]
    InsufficientStorage,
    #[error("unsupported file type")]
    UnsupportedMedia,
    #[error("too many requests")]
    RateLimited { retry_after_secs: u64 },
    #[error("{0}")]
    Unavailable(&'static str),
    #[error("internal error")]
    Internal(#[from] anyhow::Error),
}

impl ApiError {
    pub fn bad(msg: impl Into<String>) -> Self {
        Self::BadRequest(msg.into())
    }

    fn status_and_code(&self) -> (StatusCode, &'static str) {
        match self {
            Self::BadRequest(_) => (StatusCode::BAD_REQUEST, "bad_request"),
            Self::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized"),
            Self::InvalidCredentials(_) => (StatusCode::UNAUTHORIZED, "invalid_credentials"),
            Self::Forbidden(_) => (StatusCode::FORBIDDEN, "forbidden"),
            Self::NotFound(_) => (StatusCode::NOT_FOUND, "not_found"),
            Self::Conflict(_) => (StatusCode::CONFLICT, "conflict"),
            Self::PayloadTooLarge => (StatusCode::PAYLOAD_TOO_LARGE, "payload_too_large"),
            Self::InsufficientStorage => (StatusCode::INSUFFICIENT_STORAGE, "insufficient_storage"),
            Self::UnsupportedMedia => (StatusCode::UNSUPPORTED_MEDIA_TYPE, "unsupported_media"),
            Self::RateLimited { .. } => (StatusCode::TOO_MANY_REQUESTS, "rate_limited"),
            Self::Unavailable(_) => (StatusCode::SERVICE_UNAVAILABLE, "unavailable"),
            Self::Internal(_) => (StatusCode::INTERNAL_SERVER_ERROR, "internal"),
        }
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(err: sqlx::Error) -> Self {
        Self::Internal(err.into())
    }
}

impl From<std::io::Error> for ApiError {
    fn from(err: std::io::Error) -> Self {
        Self::Internal(err.into())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, code) = self.status_and_code();
        if let Self::Internal(err) = &self {
            tracing::error!(error = ?err, "internal error");
        }
        let body = Json(json!({ "error": { "code": code, "message": self.to_string() } }));
        let mut res = (status, body).into_response();
        if let Self::RateLimited { retry_after_secs } = self
            && let Ok(v) = retry_after_secs.to_string().parse()
        {
            res.headers_mut().insert("retry-after", v);
        }
        res
    }
}

pub type ApiResult<T> = Result<T, ApiError>;
