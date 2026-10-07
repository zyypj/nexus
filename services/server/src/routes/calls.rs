//! Calls. Each call is one LiveKit room (`nexus-call-<random>`), so calls in
//! different conversations are fully independent. The server decides who may
//! join and mints room-scoped tokens; LiveKit only moves media.

use axum::{
    Json,
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
};
use serde::Deserialize;
use serde_json::json;

use super::{
    common::{ApiJson, validate_id},
    conversations::{ensure_dm_not_blocked, load_conversation, require_member},
    users::load_user,
};
use crate::{
    auth::AuthUser,
    config::LiveKitConfig,
    db::{Db, new_id, now_ms},
    error::{ApiError, ApiResult},
    gateway::events::{self, conversation_members},
    livekit,
    models::{Call, CallJoin, CallParticipant, ConversationKind},
    rate_limit::rules,
    state::AppState,
};

#[derive(sqlx::FromRow)]
struct CallRow {
    id: String,
    conversation_id: String,
    room_name: String,
    started_by: Option<String>,
    created_at: i64,
    ended_at: Option<i64>,
}

#[derive(sqlx::FromRow)]
struct ParticipantRow {
    user_id: String,
    joined_at: i64,
    muted: i64,
    deafened: i64,
    video: i64,
    screen: i64,
}

impl From<ParticipantRow> for CallParticipant {
    fn from(r: ParticipantRow) -> Self {
        Self {
            user_id: r.user_id,
            joined_at: r.joined_at,
            muted: r.muted != 0,
            deafened: r.deafened != 0,
            video: r.video != 0,
            screen: r.screen != 0,
        }
    }
}

pub fn new_room_name() -> String {
    format!("nexus-call-{}", hex::encode(rand::random::<[u8; 6]>()))
}

pub async fn load_call(db: &Db, call_id: &str) -> ApiResult<Call> {
    let row: Option<CallRow> = sqlx::query_as(
        "SELECT id, conversation_id, room_name, started_by, created_at, ended_at FROM calls WHERE id = ?",
    )
    .bind(call_id)
    .fetch_optional(db)
    .await?;
    let row = row.ok_or(ApiError::NotFound("call"))?;
    let participants: Vec<ParticipantRow> = sqlx::query_as(
        "SELECT user_id, joined_at, muted, deafened, video, screen FROM call_participants
         WHERE call_id = ? AND left_at IS NULL ORDER BY joined_at",
    )
    .bind(call_id)
    .fetch_all(db)
    .await?;
    Ok(Call {
        id: row.id,
        conversation_id: row.conversation_id,
        room_name: row.room_name,
        started_by: row.started_by,
        created_at: row.created_at,
        ended_at: row.ended_at,
        participants: participants.into_iter().map(Into::into).collect(),
    })
}

async fn active_call_id(db: &Db, conversation_id: &str) -> ApiResult<Option<String>> {
    let row: Option<(String,)> = sqlx::query_as("SELECT id FROM calls WHERE conversation_id = ? AND ended_at IS NULL")
        .bind(conversation_id)
        .fetch_optional(db)
        .await?;
    Ok(row.map(|r| r.0))
}

/// Active calls in every conversation the user belongs to (for READY).
pub async fn active_calls_for_user(db: &Db, user_id: &str) -> ApiResult<Vec<Call>> {
    let ids: Vec<(String,)> = sqlx::query_as(
        "SELECT c.id FROM calls c JOIN conversation_members m ON m.conversation_id = c.conversation_id
         WHERE m.user_id = ? AND c.ended_at IS NULL ORDER BY c.created_at",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;
    let mut out = Vec::with_capacity(ids.len());
    for (id,) in ids {
        out.push(load_call(db, &id).await?);
    }
    Ok(out)
}

fn livekit_cfg(state: &AppState) -> ApiResult<&LiveKitConfig> {
    state
        .config
        .livekit
        .as_ref()
        .ok_or(ApiError::Unavailable("calls are not configured on this server"))
}

async fn broadcast(state: &AppState, conversation_id: &str, event: &str, data: &serde_json::Value) -> ApiResult<()> {
    let members = conversation_members(&state.db, conversation_id).await?;
    state.hub.send(members.iter().map(String::as_str), event, data);
    Ok(())
}

pub async fn list_active(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<Vec<Call>>> {
    Ok(Json(active_calls_for_user(&state.db, &user.id).await?))
}

/// Starts a call in the conversation, or joins the one already running.
pub async fn start(
    State(state): State<AppState>,
    user: AuthUser,
    Path(conversation_id): Path<String>,
) -> ApiResult<(StatusCode, Json<CallJoin>)> {
    state.limiter.check("call", &user.id, rules::CALL)?;
    livekit_cfg(&state)?;
    let kind = require_member(&state.db, &conversation_id, &user.id).await?;
    ensure_dm_not_blocked(&state.db, &conversation_id, kind, &user.id).await?;

    if let Some(call_id) = active_call_id(&state.db, &conversation_id).await? {
        return Ok((StatusCode::OK, Json(join_internal(&state, &user, &call_id).await?)));
    }
    let call_id = new_id();
    let res = sqlx::query(
        "INSERT INTO calls (id, conversation_id, room_name, started_by, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&call_id)
    .bind(&conversation_id)
    .bind(new_room_name())
    .bind(&user.id)
    .bind(now_ms())
    .execute(&state.db)
    .await;
    match res {
        Ok(_) => {}
        Err(e) if crate::db::is_unique_violation(&e) => {
            // Someone else started it a moment ago: join theirs.
            let existing = active_call_id(&state.db, &conversation_id)
                .await?
                .ok_or(ApiError::Conflict("call state changed, retry"))?;
            return Ok((StatusCode::OK, Json(join_internal(&state, &user, &existing).await?)));
        }
        Err(e) => return Err(e.into()),
    }
    let call = load_call(&state.db, &call_id).await?;
    broadcast(&state, &conversation_id, events::CALL_CREATE, &json!(call)).await?;
    spawn_empty_call_reaper(state.clone(), call_id.clone());
    Ok((StatusCode::CREATED, Json(join_internal(&state, &user, &call_id).await?)))
}

pub async fn join(
    State(state): State<AppState>,
    user: AuthUser,
    Path(call_id): Path<String>,
) -> ApiResult<Json<CallJoin>> {
    state.limiter.check("call", &user.id, rules::CALL)?;
    validate_id(&call_id)?;
    Ok(Json(join_internal(&state, &user, &call_id).await?))
}

async fn join_internal(state: &AppState, user: &AuthUser, call_id: &str) -> ApiResult<CallJoin> {
    let lk = livekit_cfg(state)?;
    let call = load_call(&state.db, call_id).await?;
    // Membership is the permission: a non-member gets 404, never a token.
    let kind = require_member(&state.db, &call.conversation_id, &user.id)
        .await
        .map_err(|_| ApiError::NotFound("call"))?;
    ensure_dm_not_blocked(&state.db, &call.conversation_id, kind, &user.id).await?;
    if call.ended_at.is_some() {
        return Err(ApiError::Conflict("call has ended"));
    }

    // One call at a time: joining here leaves any other call.
    let other_calls: Vec<(String,)> =
        sqlx::query_as("SELECT call_id FROM call_participants WHERE user_id = ? AND left_at IS NULL AND call_id != ?")
            .bind(&user.id)
            .bind(call_id)
            .fetch_all(&state.db)
            .await?;
    for (other,) in other_calls {
        leave_internal(state, &other, &user.id, true).await?;
    }

    let already: Option<(i64,)> =
        sqlx::query_as("SELECT 1 FROM call_participants WHERE call_id = ? AND user_id = ? AND left_at IS NULL")
            .bind(call_id)
            .bind(&user.id)
            .fetch_optional(&state.db)
            .await?;
    if already.is_none() {
        let now = now_ms();
        let res = sqlx::query("INSERT INTO call_participants (call_id, user_id, joined_at) VALUES (?, ?, ?)")
            .bind(call_id)
            .bind(&user.id)
            .bind(now)
            .execute(&state.db)
            .await;
        match res {
            Ok(_) => {
                let participant = CallParticipant {
                    user_id: user.id.clone(),
                    joined_at: now,
                    muted: false,
                    deafened: false,
                    video: false,
                    screen: false,
                };
                broadcast(
                    state,
                    &call.conversation_id,
                    events::CALL_JOIN,
                    &json!({ "call_id": call_id, "conversation_id": call.conversation_id, "participant": participant }),
                )
                .await?;
            }
            Err(e) if crate::db::is_unique_violation(&e) => {}
            Err(e) => return Err(e.into()),
        }
    }

    let profile = load_user(&state.db, &user.id).await?;
    let token = livekit::join_token(lk, &call.room_name, &user.id, &profile.display_name)?;
    Ok(CallJoin {
        call: load_call(&state.db, call_id).await?,
        livekit_url: lk.url.clone(),
        livekit_token: token,
    })
}

pub async fn leave(
    State(state): State<AppState>,
    user: AuthUser,
    Path(call_id): Path<String>,
) -> ApiResult<StatusCode> {
    validate_id(&call_id)?;
    leave_internal(&state, &call_id, &user.id, false).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Marks the participant as gone, broadcasts CALL_LEAVE and ends the call when
/// it becomes empty. `kick` also disconnects the LiveKit session.
pub async fn leave_internal(state: &AppState, call_id: &str, user_id: &str, kick: bool) -> ApiResult<bool> {
    let res =
        sqlx::query("UPDATE call_participants SET left_at = ? WHERE call_id = ? AND user_id = ? AND left_at IS NULL")
            .bind(now_ms())
            .bind(call_id)
            .bind(user_id)
            .execute(&state.db)
            .await?;
    if res.rows_affected() == 0 {
        return Ok(false);
    }
    let call = load_call(&state.db, call_id).await?;
    broadcast(
        state,
        &call.conversation_id,
        events::CALL_LEAVE,
        &json!({ "call_id": call_id, "conversation_id": call.conversation_id, "user_id": user_id }),
    )
    .await?;
    if kick {
        kick_from_room(state, &call.room_name, user_id);
    }
    if call.participants.is_empty() && call.ended_at.is_none() {
        end_internal(state, call_id).await?;
    }
    Ok(true)
}

fn kick_from_room(state: &AppState, room: &str, user_id: &str) {
    let Some(lk) = state.config.livekit.clone() else { return };
    let http = state.http.clone();
    let room = room.to_string();
    let user_id = user_id.to_string();
    tokio::spawn(async move {
        if let Err(e) = livekit::remove_participant(&http, &lk, &room, &user_id).await {
            tracing::warn!(error = %e, room, "could not remove participant from LiveKit room");
        }
    });
}

pub async fn end_internal(state: &AppState, call_id: &str) -> ApiResult<()> {
    let now = now_ms();
    let res = sqlx::query("UPDATE calls SET ended_at = ? WHERE id = ? AND ended_at IS NULL")
        .bind(now)
        .bind(call_id)
        .execute(&state.db)
        .await?;
    if res.rows_affected() == 0 {
        return Ok(());
    }
    sqlx::query("UPDATE call_participants SET left_at = ? WHERE call_id = ? AND left_at IS NULL")
        .bind(now)
        .bind(call_id)
        .execute(&state.db)
        .await?;
    let call = load_call(&state.db, call_id).await?;
    broadcast(
        state,
        &call.conversation_id,
        events::CALL_END,
        &json!({ "call_id": call_id, "conversation_id": call.conversation_id }),
    )
    .await?;
    if let Some(lk) = state.config.livekit.clone() {
        let http = state.http.clone();
        let room = call.room_name.clone();
        tokio::spawn(async move {
            if let Err(e) = livekit::delete_room(&http, &lk, &room).await {
                tracing::debug!(error = %e, room, "DeleteRoom failed (room may already be gone)");
            }
        });
    }
    Ok(())
}

/// Ends the call explicitly. In DMs any participant may hang up for both; in
/// groups only the starter or the group owner may end it for everyone.
pub async fn end(State(state): State<AppState>, user: AuthUser, Path(call_id): Path<String>) -> ApiResult<StatusCode> {
    validate_id(&call_id)?;
    let call = load_call(&state.db, &call_id).await?;
    let kind = require_member(&state.db, &call.conversation_id, &user.id)
        .await
        .map_err(|_| ApiError::NotFound("call"))?;
    let allowed = match kind {
        ConversationKind::Dm => true,
        ConversationKind::Group => {
            let conv = load_conversation(&state.db, &call.conversation_id).await?;
            call.started_by.as_deref() == Some(user.id.as_str()) || conv.owner_id.as_deref() == Some(user.id.as_str())
        }
    };
    if !allowed {
        return Err(ApiError::Forbidden("only the caller or group owner can end this call"));
    }
    end_internal(&state, &call_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct VoiceState {
    pub muted: Option<bool>,
    pub deafened: Option<bool>,
    pub video: Option<bool>,
    pub screen: Option<bool>,
}

pub async fn update_state(
    State(state): State<AppState>,
    user: AuthUser,
    Path(call_id): Path<String>,
    ApiJson(body): ApiJson<VoiceState>,
) -> ApiResult<Json<CallParticipant>> {
    validate_id(&call_id)?;
    let row: Option<ParticipantRow> = sqlx::query_as(
        "SELECT user_id, joined_at, muted, deafened, video, screen FROM call_participants
         WHERE call_id = ? AND user_id = ? AND left_at IS NULL",
    )
    .bind(&call_id)
    .bind(&user.id)
    .fetch_optional(&state.db)
    .await?;
    let mut p: CallParticipant = row.ok_or(ApiError::NotFound("call participant"))?.into();
    if let Some(v) = body.muted {
        p.muted = v;
    }
    if let Some(v) = body.deafened {
        p.deafened = v;
    }
    // Deafen implies mute, mirroring the client behaviour.
    if p.deafened {
        p.muted = true;
    }
    if let Some(v) = body.video {
        p.video = v;
    }
    if let Some(v) = body.screen {
        p.screen = v;
    }
    sqlx::query(
        "UPDATE call_participants SET muted = ?, deafened = ?, video = ?, screen = ?
         WHERE call_id = ? AND user_id = ? AND left_at IS NULL",
    )
    .bind(p.muted as i64)
    .bind(p.deafened as i64)
    .bind(p.video as i64)
    .bind(p.screen as i64)
    .bind(&call_id)
    .bind(&user.id)
    .execute(&state.db)
    .await?;
    let call = load_call(&state.db, &call_id).await?;
    broadcast(
        &state,
        &call.conversation_id,
        events::CALL_STATE_UPDATE,
        &json!({ "call_id": call_id, "conversation_id": call.conversation_id, "participant": p }),
    )
    .await?;
    Ok(Json(p))
}

/// Called when a member is removed from a group.
pub async fn leave_all_calls_in_conversation(state: &AppState, conversation_id: &str, user_id: &str) -> ApiResult<()> {
    if let Some(call_id) = active_call_id(&state.db, conversation_id).await? {
        leave_internal(state, &call_id, user_id, true).await?;
    }
    Ok(())
}

/// A call nobody joins (e.g. caller's client crashed before connecting)
/// would otherwise stay "active" forever.
const EMPTY_CALL_GRACE: std::time::Duration = std::time::Duration::from_secs(60);

fn spawn_empty_call_reaper(state: AppState, call_id: String) {
    tokio::spawn(async move {
        tokio::time::sleep(EMPTY_CALL_GRACE).await;
        if let Ok(call) = load_call(&state.db, &call_id).await
            && call.ended_at.is_none()
            && call.participants.is_empty()
            && let Err(e) = end_internal(&state, &call_id).await
        {
            tracing::warn!(error = ?e, "failed to end empty call");
        }
    });
}

/// Grace period after a user's last gateway connection drops before they are
/// removed from their call (covers short network blips and app restarts).
pub const DISCONNECT_GRACE: std::time::Duration = std::time::Duration::from_secs(45);

pub async fn leave_calls_if_still_offline(state: AppState, user_id: String) {
    tokio::time::sleep(DISCONNECT_GRACE).await;
    if state.hub.is_online(&user_id) {
        return;
    }
    let calls: Vec<(String,)> =
        match sqlx::query_as("SELECT call_id FROM call_participants WHERE user_id = ? AND left_at IS NULL")
            .bind(&user_id)
            .fetch_all(&state.db)
            .await
        {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(error = %e, "could not load calls for offline user");
                return;
            }
        };
    for (call_id,) in calls {
        if let Err(e) = leave_internal(&state, &call_id, &user_id, true).await {
            tracing::warn!(error = ?e, "could not remove offline user from call");
        }
    }
}

/// LiveKit webhook receiver: the source of truth for crashes and network
/// drops that never reach our API (`participant_left`, `room_finished`).
pub async fn livekit_webhook(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> ApiResult<StatusCode> {
    let lk = livekit_cfg(&state)?;
    let auth = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .ok_or(ApiError::Unauthorized)?;
    if !livekit::verify_webhook(lk, auth, &body) {
        return Err(ApiError::Unauthorized);
    }
    let event: livekit::WebhookEvent =
        serde_json::from_slice(&body).map_err(|e| ApiError::bad(format!("invalid webhook body: {e}")))?;
    let Some(room) = event.room else {
        return Ok(StatusCode::OK);
    };
    let call: Option<(String,)> = sqlx::query_as("SELECT id FROM calls WHERE room_name = ? AND ended_at IS NULL")
        .bind(&room.name)
        .fetch_optional(&state.db)
        .await?;
    let Some((call_id,)) = call else {
        return Ok(StatusCode::OK);
    };
    match event.event.as_str() {
        "participant_left" => {
            if let Some(p) = event.participant {
                leave_internal(&state, &call_id, &p.identity, false).await?;
            }
        }
        "room_finished" => end_internal(&state, &call_id).await?,
        _ => {}
    }
    Ok(StatusCode::OK)
}
