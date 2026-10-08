use axum::{
    Json,
    extract::{Multipart, Path, Query, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use tokio::io::AsyncWriteExt;
use tower::ServiceExt;
use tower_http::services::ServeFile;

use super::{
    common::validate_id,
    conversations::{ensure_dm_not_blocked, require_member},
};
use crate::{
    auth::AuthUser,
    db::{new_id, now_ms},
    error::{ApiError, ApiResult},
    models::Attachment,
    rate_limit::rules,
    state::AppState,
    storage::{Storage, content_disposition, inline_image_mime, inline_media_mime, sanitize_file_name},
};

/// Bytes kept in memory for type sniffing and image dimension parsing.
const SNIFF_BYTES: usize = 64 * 1024;

/// Pending uploads that were never attached to a message are purged after this.
pub const PENDING_TTL_MS: i64 = 24 * 60 * 60 * 1000;

/// How often (bytes written) the free disk space is re-checked mid-upload.
const DISK_CHECK_EVERY: u64 = 64 * 1024 * 1024;

/// Free space left on the uploads volume (None if it cannot be read).
fn free_disk(state: &AppState) -> Option<u64> {
    fs4::available_space(state.storage.root()).ok()
}

/// Streams the upload to disk (never buffering the whole file), enforcing
/// MAX_UPLOAD_SIZE (0 = no limit) and keeping UPLOAD_MIN_FREE_DISK free.
pub async fn upload(
    State(state): State<AppState>,
    user: AuthUser,
    Path(conversation_id): Path<String>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> ApiResult<(StatusCode, Json<Attachment>)> {
    state.limiter.check("upload", &user.id, rules::UPLOAD)?;
    let kind = require_member(&state.db, &conversation_id, &user.id).await?;
    ensure_dm_not_blocked(&state.db, &conversation_id, kind, &user.id).await?;
    if kind.is_channel() {
        crate::permissions::require_channel_perm(
            &state.db,
            &conversation_id,
            &user.id,
            crate::permissions::SEND_MESSAGES | crate::permissions::ATTACH_FILES,
            "you cannot attach files in this channel",
        )
        .await?;
    }
    let max = match state.config.max_upload_size {
        0 => u64::MAX,
        n => n,
    };
    let reserve = state.config.min_free_disk;
    // Refuse up front when the declared body would not fit.
    let declared = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    if let (Some(len), Some(free)) = (declared, free_disk(&state))
        && free < len.saturating_add(reserve)
    {
        return Err(ApiError::InsufficientStorage);
    }

    let mut field = loop {
        match multipart.next_field().await.map_err(|e| ApiError::bad(e.body_text()))? {
            Some(f) if f.name() == Some("file") => break f,
            Some(_) => continue,
            None => return Err(ApiError::bad("missing 'file' field")),
        }
    };
    let file_name = sanitize_file_name(field.file_name().unwrap_or("file"));

    let tmp = state.storage.temp_path();
    let mut out = tokio::fs::File::create(&tmp).await?;
    let mut size: u64 = 0;
    let mut head: Vec<u8> = Vec::with_capacity(4096);
    let result: ApiResult<()> = async {
        let mut next_check = DISK_CHECK_EVERY;
        while let Some(chunk) = field.chunk().await.map_err(|e| ApiError::bad(e.body_text()))? {
            size += chunk.len() as u64;
            if size > max {
                return Err(ApiError::PayloadTooLarge);
            }
            if size >= next_check {
                next_check = size + DISK_CHECK_EVERY;
                if free_disk(&state).is_some_and(|free| free < reserve) {
                    return Err(ApiError::InsufficientStorage);
                }
            }
            if head.len() < SNIFF_BYTES {
                let take = (SNIFF_BYTES - head.len()).min(chunk.len());
                head.extend_from_slice(&chunk[..take]);
            }
            out.write_all(&chunk).await?;
        }
        out.flush().await?;
        Ok(())
    }
    .await;
    drop(out);
    if let Err(e) = result {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(e);
    }
    if size == 0 {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(ApiError::bad("empty file"));
    }

    let sniffed = infer::get(&head).map(|t| t.mime_type());
    let (content_type, width, height) = match inline_image_mime(sniffed) {
        Some(mime) => match imagesize::blob_size(&head) {
            Ok(dim) => (mime.to_string(), Some(dim.width as i64), Some(dim.height as i64)),
            Err(_) => (mime.to_string(), None, None),
        },
        // Recorded for display only; non-images are always served as downloads.
        None => (sniffed.unwrap_or("application/octet-stream").to_string(), None, None),
    };

    let storage_name = Storage::new_storage_name();
    let final_path = state
        .storage
        .file_path(&storage_name)
        .ok_or(ApiError::bad("invalid name"))?;
    tokio::fs::rename(&tmp, &final_path).await?;

    let id = new_id();
    let now = now_ms();
    let res = sqlx::query(
        "INSERT INTO message_attachments
            (id, message_id, conversation_id, uploader_id, file_name, storage_name, content_type, size, width, height, created_at)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&conversation_id)
    .bind(&user.id)
    .bind(&file_name)
    .bind(&storage_name)
    .bind(&content_type)
    .bind(size as i64)
    .bind(width)
    .bind(height)
    .bind(now)
    .execute(&state.db)
    .await;
    if let Err(e) = res {
        let _ = tokio::fs::remove_file(&final_path).await;
        return Err(e.into());
    }
    Ok((
        StatusCode::CREATED,
        Json(Attachment {
            url: state.storage.signed_file_url(&id, &file_name, now),
            id,
            file_name,
            content_type,
            size: size as i64,
            width,
            height,
        }),
    ))
}

#[derive(Deserialize)]
pub struct SignedQuery {
    pub exp: i64,
    pub sig: String,
}

pub async fn serve(
    State(state): State<AppState>,
    Path((attachment_id, _name)): Path<(String, String)>,
    Query(q): Query<SignedQuery>,
    request: Request,
) -> ApiResult<Response> {
    validate_id(&attachment_id)?;
    if !state.storage.verify_signature(&attachment_id, q.exp, &q.sig, now_ms()) {
        return Err(ApiError::Forbidden("invalid or expired link"));
    }
    let row: Option<(String, String, String)> =
        sqlx::query_as("SELECT storage_name, content_type, file_name FROM message_attachments WHERE id = ?")
            .bind(&attachment_id)
            .fetch_optional(&state.db)
            .await?;
    let (storage_name, content_type, file_name) = row.ok_or(ApiError::NotFound("file"))?;
    let path = state
        .storage
        .file_path(&storage_name)
        .ok_or(ApiError::NotFound("file"))?;

    // ServeFile gives us Range and conditional request support for free.
    let mut res = ServeFile::new(path)
        .oneshot(request)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e)))?
        .into_response();
    if res.status() == StatusCode::NOT_FOUND {
        return Err(ApiError::NotFound("file"));
    }
    let inline_type = inline_image_mime(Some(&content_type)).or_else(|| inline_media_mime(Some(&content_type)));
    let inline = inline_type.is_some();
    let headers = res.headers_mut();
    let ct = inline_type.unwrap_or("application/octet-stream");
    if let Ok(v) = HeaderValue::from_str(ct) {
        headers.insert(header::CONTENT_TYPE, v);
    }
    if let Ok(v) = HeaderValue::from_str(&content_disposition(&file_name, inline)) {
        headers.insert(header::CONTENT_DISPOSITION, v);
    }
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'none'; sandbox"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=86400"),
    );
    Ok(res)
}

/// Deletes uploads that were never sent. Runs periodically from `lib.rs`.
pub async fn purge_pending(state: &AppState) -> anyhow::Result<u64> {
    let cutoff = now_ms() - PENDING_TTL_MS;
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT id, storage_name FROM message_attachments WHERE message_id IS NULL AND created_at < ?")
            .bind(cutoff)
            .fetch_all(&state.db)
            .await?;
    for (id, name) in &rows {
        if let Some(p) = state.storage.file_path(name) {
            let _ = tokio::fs::remove_file(p).await;
        }
        sqlx::query("DELETE FROM message_attachments WHERE id = ?")
            .bind(id)
            .execute(&state.db)
            .await?;
    }
    Ok(rows.len() as u64)
}
