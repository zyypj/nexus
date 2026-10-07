use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use serde::Deserialize;
use serde_json::json;

use super::{
    common::{ApiJson, validate_id},
    users::{load_user, user_status},
};
use crate::{
    auth::AuthUser,
    db::{Db, new_id, now_ms},
    error::{ApiError, ApiResult},
    gateway::events,
    models::{Friend, FriendRequest, Presence, PresenceUpdate, PublicUser, Relationships, UserRow},
    rate_limit::rules,
    state::AppState,
};

fn pair<'a>(a: &'a str, b: &'a str) -> (&'a str, &'a str) {
    if a < b { (a, b) } else { (b, a) }
}

pub async fn are_friends(db: &Db, a: &str, b: &str) -> ApiResult<bool> {
    let (x, y) = pair(a, b);
    let row: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM friendships WHERE user_a = ? AND user_b = ?")
        .bind(x)
        .bind(y)
        .fetch_optional(db)
        .await?;
    Ok(row.is_some())
}

/// True if either user blocked the other.
pub async fn is_blocked_either(db: &Db, a: &str, b: &str) -> ApiResult<bool> {
    let row: Option<(i64,)> = sqlx::query_as(
        "SELECT 1 FROM blocked_users WHERE (blocker_id = ?1 AND blocked_id = ?2) OR (blocker_id = ?2 AND blocked_id = ?1)",
    )
    .bind(a)
    .bind(b)
    .fetch_optional(db)
    .await?;
    Ok(row.is_some())
}

pub async fn load_relationships(db: &Db, user_id: &str) -> ApiResult<Relationships> {
    #[derive(sqlx::FromRow)]
    struct FriendRow {
        #[sqlx(flatten)]
        user: UserRow,
        since: i64,
    }
    let friends: Vec<FriendRow> = sqlx::query_as(concat!(
        "SELECT ",
        crate::user_columns!(),
        ", f.created_at AS since FROM friendships f
         JOIN users u ON u.id = CASE WHEN f.user_a = ?1 THEN f.user_b ELSE f.user_a END
         WHERE f.user_a = ?1 OR f.user_b = ?1 ORDER BY u.display_name"
    ))
    .bind(user_id)
    .fetch_all(db)
    .await?;

    let requests: Vec<(String, String, String, i64)> = sqlx::query_as(
        "SELECT id, from_user, to_user, created_at FROM friend_requests
         WHERE from_user = ?1 OR to_user = ?1 ORDER BY created_at DESC",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;
    let mut incoming = Vec::new();
    let mut outgoing = Vec::new();
    for (id, from, to, created_at) in requests {
        let req = FriendRequest {
            id,
            from: load_user(db, &from).await?,
            to: load_user(db, &to).await?,
            created_at,
        };
        if to == user_id {
            incoming.push(req);
        } else {
            outgoing.push(req);
        }
    }

    let blocked: Vec<UserRow> = sqlx::query_as(concat!(
        "SELECT ",
        crate::user_columns!(),
        " FROM blocked_users b JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = ?"
    ))
    .bind(user_id)
    .fetch_all(db)
    .await?;

    Ok(Relationships {
        friends: friends
            .into_iter()
            .map(|f| Friend {
                user: f.user.into(),
                since: f.since,
            })
            .collect(),
        incoming,
        outgoing,
        blocked: blocked.into_iter().map(PublicUser::from).collect(),
    })
}

pub async fn relationships(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<Relationships>> {
    Ok(Json(load_relationships(&state.db, &user.id).await?))
}

#[derive(Deserialize)]
pub struct SendRequest {
    pub username: String,
}

pub async fn send_request(
    State(state): State<AppState>,
    user: AuthUser,
    ApiJson(body): ApiJson<SendRequest>,
) -> ApiResult<(StatusCode, Json<serde_json::Value>)> {
    state.limiter.check("friend", &user.id, rules::FRIEND)?;
    let target: Option<(String,)> = sqlx::query_as("SELECT id FROM users WHERE username = ? AND disabled = 0")
        .bind(body.username.trim().to_ascii_lowercase())
        .fetch_optional(&state.db)
        .await?;
    let (target_id,) = target.ok_or(ApiError::NotFound("user"))?;
    if target_id == user.id {
        return Err(ApiError::bad("you cannot add yourself"));
    }
    if is_blocked_either(&state.db, &user.id, &target_id).await? {
        // Same message as "not found" would leak less, but a clear error is
        // more useful in a friends-only instance.
        return Err(ApiError::Forbidden("you cannot send a friend request to this user"));
    }
    if are_friends(&state.db, &user.id, &target_id).await? {
        return Err(ApiError::Conflict("already friends"));
    }

    // They already asked us: accept instead of creating a mirror request.
    let reverse: Option<(String,)> =
        sqlx::query_as("SELECT id FROM friend_requests WHERE from_user = ? AND to_user = ?")
            .bind(&target_id)
            .bind(&user.id)
            .fetch_optional(&state.db)
            .await?;
    if let Some((request_id,)) = reverse {
        let friend = accept_internal(&state, &request_id, &target_id, &user.id).await?;
        return Ok((StatusCode::OK, Json(json!({ "status": "accepted", "friend": friend }))));
    }

    let id = new_id();
    let now = now_ms();
    let res = sqlx::query("INSERT INTO friend_requests (id, from_user, to_user, created_at) VALUES (?, ?, ?, ?)")
        .bind(&id)
        .bind(&user.id)
        .bind(&target_id)
        .bind(now)
        .execute(&state.db)
        .await;
    match res {
        Err(e) if crate::db::is_unique_violation(&e) => return Err(ApiError::Conflict("request already sent")),
        r => r?,
    };
    let req = FriendRequest {
        id,
        from: load_user(&state.db, &user.id).await?,
        to: load_user(&state.db, &target_id).await?,
        created_at: now,
    };
    state
        .hub
        .send([user.id.as_str(), target_id.as_str()], events::FRIEND_REQUEST, &req);
    Ok((
        StatusCode::CREATED,
        Json(json!({ "status": "pending", "request": req })),
    ))
}

pub async fn accept_request(
    State(state): State<AppState>,
    user: AuthUser,
    Path(request_id): Path<String>,
) -> ApiResult<Json<Friend>> {
    validate_id(&request_id)?;
    let row: Option<(String, String)> = sqlx::query_as("SELECT from_user, to_user FROM friend_requests WHERE id = ?")
        .bind(&request_id)
        .fetch_optional(&state.db)
        .await?;
    let (from, to) = row.ok_or(ApiError::NotFound("friend request"))?;
    if to != user.id {
        return Err(ApiError::NotFound("friend request"));
    }
    Ok(Json(accept_internal(&state, &request_id, &from, &to).await?))
}

async fn accept_internal(state: &AppState, request_id: &str, from: &str, to: &str) -> ApiResult<Friend> {
    if is_blocked_either(&state.db, from, to).await? {
        return Err(ApiError::Forbidden("blocked"));
    }
    let now = now_ms();
    let (a, b) = pair(from, to);
    let mut tx = state.db.begin().await?;
    sqlx::query("DELETE FROM friend_requests WHERE id = ?")
        .bind(request_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT OR IGNORE INTO friendships (user_a, user_b, created_at) VALUES (?, ?, ?)")
        .bind(a)
        .bind(b)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    // Each side receives the *other* user as the new friend, plus their presence.
    for (me, other) in [(from, to), (to, from)] {
        let friend = Friend {
            user: load_user(&state.db, other).await?,
            since: now,
        };
        state.hub.send_one(
            me,
            events::FRIEND_ACCEPT,
            &json!({ "request_id": request_id, "friend": friend }),
        );
        let status = user_status(&state.db, other).await?;
        state.hub.send_one(
            me,
            events::PRESENCE_UPDATE,
            &PresenceUpdate {
                user_id: other.to_string(),
                status: Presence::visible(state.hub.is_online(other), status),
            },
        );
    }
    Ok(Friend {
        user: load_user(&state.db, from).await?,
        since: now,
    })
}

/// Declines (recipient) or cancels (sender) a pending request.
pub async fn delete_request(
    State(state): State<AppState>,
    user: AuthUser,
    Path(request_id): Path<String>,
) -> ApiResult<StatusCode> {
    validate_id(&request_id)?;
    let row: Option<(String, String)> = sqlx::query_as("SELECT from_user, to_user FROM friend_requests WHERE id = ?")
        .bind(&request_id)
        .fetch_optional(&state.db)
        .await?;
    let (from, to) = row.ok_or(ApiError::NotFound("friend request"))?;
    if from != user.id && to != user.id {
        return Err(ApiError::NotFound("friend request"));
    }
    sqlx::query("DELETE FROM friend_requests WHERE id = ?")
        .bind(&request_id)
        .execute(&state.db)
        .await?;
    state.hub.send(
        [from.as_str(), to.as_str()],
        events::FRIEND_REQUEST_DELETE,
        &json!({ "id": request_id }),
    );
    Ok(StatusCode::NO_CONTENT)
}

pub async fn remove_friend(
    State(state): State<AppState>,
    user: AuthUser,
    Path(friend_id): Path<String>,
) -> ApiResult<StatusCode> {
    validate_id(&friend_id)?;
    if !remove_friendship(&state, &user.id, &friend_id).await? {
        return Err(ApiError::NotFound("friend"));
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn remove_friendship(state: &AppState, a: &str, b: &str) -> ApiResult<bool> {
    let (x, y) = pair(a, b);
    let res = sqlx::query("DELETE FROM friendships WHERE user_a = ? AND user_b = ?")
        .bind(x)
        .bind(y)
        .execute(&state.db)
        .await?;
    if res.rows_affected() == 0 {
        return Ok(false);
    }
    state.hub.send_one(a, events::FRIEND_REMOVE, &json!({ "user_id": b }));
    state.hub.send_one(b, events::FRIEND_REMOVE, &json!({ "user_id": a }));
    Ok(true)
}

/// Blocking removes the friendship and pending requests in both directions.
pub async fn block(
    State(state): State<AppState>,
    user: AuthUser,
    Path(target_id): Path<String>,
) -> ApiResult<StatusCode> {
    validate_id(&target_id)?;
    if target_id == user.id {
        return Err(ApiError::bad("you cannot block yourself"));
    }
    let target = load_user(&state.db, &target_id).await?;
    remove_friendship(&state, &user.id, &target_id).await?;
    let requests: Vec<(String,)> = sqlx::query_as(
        "DELETE FROM friend_requests WHERE (from_user = ?1 AND to_user = ?2) OR (from_user = ?2 AND to_user = ?1) RETURNING id",
    )
    .bind(&user.id)
    .bind(&target_id)
    .fetch_all(&state.db)
    .await?;
    for (id,) in requests {
        state.hub.send(
            [user.id.as_str(), target_id.as_str()],
            events::FRIEND_REQUEST_DELETE,
            &json!({ "id": id }),
        );
    }
    sqlx::query("INSERT OR IGNORE INTO blocked_users (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)")
        .bind(&user.id)
        .bind(&target_id)
        .bind(now_ms())
        .execute(&state.db)
        .await?;
    state.hub.send_one(&user.id, events::USER_BLOCK, &target);
    Ok(StatusCode::NO_CONTENT)
}

pub async fn unblock(
    State(state): State<AppState>,
    user: AuthUser,
    Path(target_id): Path<String>,
) -> ApiResult<StatusCode> {
    validate_id(&target_id)?;
    let res = sqlx::query("DELETE FROM blocked_users WHERE blocker_id = ? AND blocked_id = ?")
        .bind(&user.id)
        .bind(&target_id)
        .execute(&state.db)
        .await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::NotFound("block"));
    }
    state
        .hub
        .send_one(&user.id, events::USER_UNBLOCK, &json!({ "user_id": target_id }));
    Ok(StatusCode::NO_CONTENT)
}
