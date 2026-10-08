pub mod admin;
pub mod attachments;
pub mod auth;
pub mod calls;
pub mod common;
pub mod conversations;
pub mod friends;
pub mod messages;
pub mod servers;
pub mod users;

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    http::{HeaderValue, Method, Request, header},
    routing::{delete, get, patch, post, put},
};
use serde_json::{Value, json};
use tower_http::{
    cors::{AllowOrigin, CorsLayer},
    set_header::SetResponseHeaderLayer,
    trace::TraceLayer,
};

use crate::{gateway, state::AppState};

const JSON_LIMIT: usize = 64 * 1024;

/// Origins the Tauri WebView uses on Windows (prod and `tauri dev`).
const TAURI_ORIGINS: [&str; 4] = [
    "http://tauri.localhost",
    "https://tauri.localhost",
    "tauri://localhost",
    "http://localhost:1420",
];

pub fn router(state: AppState) -> Router {
    // Attachments stream to disk, so "no limit" is safe memory-wise; the disk
    // itself is protected by UPLOAD_MIN_FREE_DISK in the handler.
    let upload_limit = match state.config.max_upload_size {
        0 => DefaultBodyLimit::disable(),
        max => DefaultBodyLimit::max((max as usize).saturating_add(64 * 1024)),
    };
    let avatar_limit = DefaultBodyLimit::max(state.config.max_avatar_size as usize + 64 * 1024);

    let api = Router::new()
        .route("/info", get(info))
        // auth
        .route("/auth/register", post(auth::register))
        .route("/auth/login", post(auth::login))
        .route("/auth/refresh", post(auth::refresh))
        .route("/auth/logout", post(auth::logout))
        .route("/auth/sessions", get(auth::list_sessions))
        .route("/auth/sessions/{id}", delete(auth::delete_session))
        // users
        .route("/users/@me", get(users::me).patch(users::update_me))
        .route("/users/@me/password", put(users::change_password))
        .route(
            "/users/@me/avatar",
            post(users::upload_avatar)
                .delete(users::delete_avatar)
                .layer(avatar_limit),
        )
        .route("/users/search", get(users::search))
        .route("/users/{id}", get(users::get_user))
        .route("/avatars/{name}", get(users::serve_avatar))
        // relationships
        .route("/relationships", get(friends::relationships))
        .route("/friends/requests", post(friends::send_request))
        .route("/friends/requests/{id}/accept", post(friends::accept_request))
        .route("/friends/requests/{id}", delete(friends::delete_request))
        .route("/friends/{user_id}", delete(friends::remove_friend))
        .route("/blocks/{user_id}", put(friends::block).delete(friends::unblock))
        // conversations
        .route("/conversations", get(conversations::list))
        .route("/conversations/dm", post(conversations::open_dm))
        .route("/conversations/group", post(conversations::create_group))
        .route(
            "/conversations/{id}",
            get(conversations::get).patch(conversations::update_group),
        )
        .route(
            "/conversations/{id}/members/{user_id}",
            put(conversations::add_member).delete(conversations::remove_member),
        )
        .route("/conversations/{id}/ack", post(conversations::ack))
        // messages
        .route(
            "/conversations/{id}/messages",
            get(messages::history).post(messages::create),
        )
        .route(
            "/conversations/{id}/messages/{message_id}",
            patch(messages::edit).delete(messages::delete),
        )
        .route(
            "/conversations/{id}/messages/{message_id}/reactions/{emoji}",
            put(messages::add_reaction).delete(messages::remove_reaction),
        )
        .route(
            "/conversations/{id}/attachments",
            post(attachments::upload).layer(upload_limit),
        )
        .route("/files/{id}/{name}", get(attachments::serve))
        // calls
        .route("/calls", get(calls::list_active))
        .route("/conversations/{id}/call", post(calls::start))
        .route("/calls/{id}/join", post(calls::join))
        .route("/calls/{id}/leave", post(calls::leave))
        .route("/calls/{id}/end", post(calls::end))
        .route("/calls/{id}/state", patch(calls::update_state))
        .route("/livekit/webhook", post(calls::livekit_webhook))
        // servers
        .route("/servers", post(servers::create))
        .route(
            "/servers/{id}",
            get(servers::get).patch(servers::update).delete(servers::delete),
        )
        .route(
            "/servers/{id}/icon",
            post(servers::upload_icon)
                .delete(servers::delete_icon)
                .layer(avatar_limit),
        )
        .route("/servers/{id}/transfer", post(servers::transfer))
        .route("/servers/{id}/members/@me", delete(servers::leave))
        .route(
            "/servers/{id}/members/{user_id}",
            patch(servers::update_member).delete(servers::kick),
        )
        .route("/servers/{id}/bans", get(servers::list_bans))
        .route("/servers/{id}/bans/{user_id}", put(servers::ban).delete(servers::unban))
        .route(
            "/servers/{id}/invites",
            get(servers::list_invites).post(servers::create_invite),
        )
        .route(
            "/server-invites/{code}",
            get(servers::preview_invite)
                .post(servers::join)
                .delete(servers::delete_invite),
        )
        .route("/servers/{id}/roles", post(servers::create_role))
        .route("/servers/{id}/roles/order", put(servers::order_roles))
        .route(
            "/servers/{id}/roles/{role_id}",
            patch(servers::update_role).delete(servers::delete_role),
        )
        .route("/servers/{id}/categories", post(servers::create_category))
        .route(
            "/servers/{id}/categories/{category_id}",
            patch(servers::update_category).delete(servers::delete_category),
        )
        .route("/servers/{id}/channels", post(servers::create_channel))
        .route(
            "/servers/{id}/channels/{channel_id}",
            patch(servers::update_channel).delete(servers::delete_channel),
        )
        .route("/servers/{id}/layout", put(servers::layout))
        .route(
            "/servers/{id}/overwrites/{target_id}/{role_id}",
            put(servers::put_overwrite).delete(servers::delete_overwrite),
        )
        // admin
        .route("/admin/invites", get(admin::list_invites).post(admin::create_invite))
        .route("/admin/invites/{code}", delete(admin::revoke_invite))
        .route("/admin/users", get(admin::list_users))
        .route("/admin/users/{id}/disable", post(admin::disable_user))
        .route("/admin/users/{id}/enable", post(admin::enable_user));

    let mut origins: Vec<HeaderValue> = TAURI_ORIGINS.iter().map(|o| HeaderValue::from_static(o)).collect();
    for o in &state.config.extra_cors_origins {
        if let Ok(v) = HeaderValue::from_str(o) {
            origins.push(v);
        }
    }
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::PATCH, Method::DELETE])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE])
        .max_age(std::time::Duration::from_secs(3600));

    Router::new()
        .nest("/api", api)
        .route("/gateway", get(gateway::upgrade))
        .route("/health", get(health))
        .layer(DefaultBodyLimit::max(JSON_LIMIT))
        .layer(cors)
        .layer(SetResponseHeaderLayer::if_not_present(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .layer(
            // Log the path only: query strings carry signed-URL signatures.
            TraceLayer::new_for_http().make_span_with(
                |req: &Request<_>| tracing::info_span!("http", method = %req.method(), path = %req.uri().path()),
            ),
        )
        .with_state(state)
}

async fn info(State(state): State<AppState>) -> Json<Value> {
    Json(json!({
        "name": state.config.app_name,
        "version": env!("CARGO_PKG_VERSION"),
        "public_registration": state.config.allow_public_registration,
        "calls_enabled": state.config.livekit.is_some(),
        "max_upload_size": state.config.max_upload_size,
    }))
}

async fn health(State(state): State<AppState>) -> Json<Value> {
    let db_ok = sqlx::query("SELECT 1").execute(&state.db).await.is_ok();
    Json(json!({ "ok": db_ok, "connections": state.hub.connection_count() }))
}
