//! Single WebSocket per client.
//!
//! Protocol:
//! 1. server -> `HELLO { heartbeat_interval_ms }`
//! 2. client -> `{ "op": "IDENTIFY", "d": { "token": "<access token>" } }` (within 10 s)
//! 3. server -> `READY { ...full state... }` — also the re-sync after reconnects
//! 4. client -> `{ "op": "HEARTBEAT" }` every interval, server -> `HEARTBEAT_ACK`
//! 5. server -> `{ "t": EVENT, "d": ... }` dispatches
//!
//! The token travels inside the socket, never in the URL, so it cannot end up
//! in proxy access logs.

pub mod events;
pub mod hub;

use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

use axum::{
    extract::{
        State, WebSocketUpgrade,
        ws::{CloseFrame, Message, WebSocket},
    },
    response::Response,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::mpsc;

use self::hub::{OUTBOUND_QUEUE, Outbound, encode};
use crate::{
    auth::{AuthUser, authenticate},
    error::ApiResult,
    models::{Call, ConversationView, Me, Presence, PresenceUpdate, Relationships, UserStatus},
    routes::{
        calls::{active_calls_for_user, leave_calls_if_still_offline},
        conversations::{list_for_user, require_member},
        friends::load_relationships,
        users::{broadcast_presence, load_me, user_status},
    },
    state::AppState,
};

pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
const IDENTIFY_TIMEOUT: Duration = Duration::from_secs(10);
const TYPING_THROTTLE: Duration = Duration::from_secs(3);
const MAX_FRAME: usize = 16 * 1024;

#[derive(Deserialize)]
#[serde(tag = "op", content = "d", rename_all = "SCREAMING_SNAKE_CASE")]
enum ClientOp {
    Identify { token: String },
    Heartbeat,
    TypingStart { conversation_id: String },
    TypingStop { conversation_id: String },
}

#[derive(Serialize)]
pub struct Ready {
    pub session_id: String,
    pub user: Me,
    pub relationships: Relationships,
    pub conversations: Vec<ConversationView>,
    pub presences: Vec<PresenceUpdate>,
    pub calls: Vec<Call>,
    pub server: ServerInfo,
}

#[derive(Serialize)]
pub struct ServerInfo {
    pub name: String,
    pub version: &'static str,
    pub calls_enabled: bool,
    pub max_upload_size: u64,
}

pub async fn upgrade(State(state): State<AppState>, ws: WebSocketUpgrade) -> Response {
    ws.max_message_size(MAX_FRAME)
        .max_frame_size(MAX_FRAME)
        .on_upgrade(move |socket| run(state, socket))
}

async fn run(state: AppState, mut socket: WebSocket) {
    let hello = encode(
        events::HELLO,
        &json!({ "heartbeat_interval_ms": HEARTBEAT_INTERVAL.as_millis() as u64 }),
    );
    if socket.send(Message::Text(hello)).await.is_err() {
        return;
    }

    let user = match identify(&state, &mut socket).await {
        Some(u) => u,
        None => {
            let _ = socket
                .send(Message::Text(encode(events::INVALID_SESSION, &json!({}))))
                .await;
            let _ = socket
                .send(Message::Close(Some(CloseFrame {
                    code: 4004,
                    reason: "authentication failed".into(),
                })))
                .await;
            return;
        }
    };

    let (tx, rx) = mpsc::channel(OUTBOUND_QUEUE);
    let (conn_id, first) = state.hub.register(&user.id, &user.session_id, tx);

    match build_ready(&state, &user).await {
        Ok(ready) => {
            if socket.send(Message::Text(encode(events::READY, &ready))).await.is_err() {
                disconnect(&state, &user, conn_id).await;
                return;
            }
        }
        Err(e) => {
            tracing::error!(error = ?e, "failed to build READY");
            disconnect(&state, &user, conn_id).await;
            return;
        }
    }
    if first && let Ok(status) = user_status(&state.db, &user.id).await {
        let _ = broadcast_presence(&state, &user.id, status).await;
    }

    session_loop(&state, &user, &mut socket, rx).await;
    disconnect(&state, &user, conn_id).await;
}

async fn identify(state: &AppState, socket: &mut WebSocket) -> Option<AuthUser> {
    let msg = tokio::time::timeout(IDENTIFY_TIMEOUT, socket.recv())
        .await
        .ok()??
        .ok()?;
    let Message::Text(text) = msg else { return None };
    match serde_json::from_str::<ClientOp>(&text).ok()? {
        ClientOp::Identify { token } => authenticate(state, &token).await.ok(),
        _ => None,
    }
}

pub async fn build_ready(state: &AppState, user: &AuthUser) -> ApiResult<Ready> {
    let me = load_me(&state.db, &user.id).await?;
    let relationships = load_relationships(&state.db, &user.id).await?;
    let conversations = list_for_user(&state.db, &user.id).await?;
    let audience = events::user_audience(&state.db, &user.id).await?;
    let mut presences = Vec::new();
    for uid in audience.iter().filter(|u| **u != user.id) {
        if state.hub.is_online(uid) {
            let status = user_status(&state.db, uid).await?;
            let visible = Presence::visible(true, status);
            if visible != Presence::Offline {
                presences.push(PresenceUpdate {
                    user_id: uid.clone(),
                    status: visible,
                });
            }
        }
    }
    Ok(Ready {
        session_id: user.session_id.clone(),
        user: me,
        relationships,
        conversations,
        presences,
        calls: active_calls_for_user(&state.db, &user.id).await?,
        server: ServerInfo {
            name: state.config.app_name.clone(),
            version: env!("CARGO_PKG_VERSION"),
            calls_enabled: state.config.livekit.is_some(),
            max_upload_size: state.config.max_upload_size,
        },
    })
}

async fn session_loop(state: &AppState, user: &AuthUser, socket: &mut WebSocket, mut rx: mpsc::Receiver<Outbound>) {
    let heartbeat_deadline = HEARTBEAT_INTERVAL * 2 + Duration::from_secs(5);
    let mut last_heartbeat = Instant::now();
    let mut typing_sent: HashMap<String, Instant> = HashMap::new();

    loop {
        let deadline = tokio::time::Instant::from_std(last_heartbeat + heartbeat_deadline);
        tokio::select! {
            incoming = socket.recv() => {
                let Some(Ok(msg)) = incoming else { return };
                match msg {
                    Message::Text(text) => {
                        let Ok(op) = serde_json::from_str::<ClientOp>(&text) else {
                            let _ = socket.send(close(4002, "invalid payload")).await;
                            return;
                        };
                        match op {
                            ClientOp::Heartbeat => {
                                last_heartbeat = Instant::now();
                                let ack = encode(events::HEARTBEAT_ACK, &json!({}));
                                if socket.send(Message::Text(ack)).await.is_err() {
                                    return;
                                }
                            }
                            ClientOp::TypingStart { conversation_id } => {
                                let now = Instant::now();
                                let throttled = typing_sent
                                    .get(&conversation_id)
                                    .is_some_and(|t| now.duration_since(*t) < TYPING_THROTTLE);
                                if !throttled {
                                    typing_sent.insert(conversation_id.clone(), now);
                                    typing(state, user, &conversation_id, events::TYPING_START).await;
                                }
                            }
                            ClientOp::TypingStop { conversation_id } => {
                                typing_sent.remove(&conversation_id);
                                typing(state, user, &conversation_id, events::TYPING_STOP).await;
                            }
                            ClientOp::Identify { .. } => {
                                let _ = socket.send(close(4005, "already identified")).await;
                                return;
                            }
                        }
                    }
                    Message::Close(_) => return,
                    // Binary frames are not part of the protocol; ping/pong is handled by axum.
                    Message::Binary(_) => {
                        let _ = socket.send(close(4002, "binary frames not supported")).await;
                        return;
                    }
                    _ => {}
                }
            }
            outbound = rx.recv() => {
                match outbound {
                    Some(Outbound::Event(payload)) => {
                        if socket.send(Message::Text(payload)).await.is_err() {
                            return;
                        }
                    }
                    Some(Outbound::Close(reason)) => {
                        let _ = socket.send(close(4001, reason)).await;
                        return;
                    }
                    None => return,
                }
            }
            _ = tokio::time::sleep_until(deadline) => {
                let _ = socket.send(close(4003, "heartbeat timeout")).await;
                return;
            }
        }
    }
}

fn close(code: u16, reason: &'static str) -> Message {
    Message::Close(Some(CloseFrame {
        code,
        reason: reason.into(),
    }))
}

async fn typing(state: &AppState, user: &AuthUser, conversation_id: &str, event: &str) {
    if require_member(&state.db, conversation_id, &user.id).await.is_err() {
        return;
    }
    let Ok(members) = events::conversation_members(&state.db, conversation_id).await else {
        return;
    };
    state.hub.send(
        members.iter().map(String::as_str).filter(|m| *m != user.id),
        event,
        &json!({ "conversation_id": conversation_id, "user_id": user.id }),
    );
}

async fn disconnect(state: &AppState, user: &AuthUser, conn_id: u64) {
    if state.hub.unregister(&user.id, conn_id) {
        // Last connection gone: everyone else sees the user go offline.
        let _ = broadcast_presence(state, &user.id, UserStatus::Online).await;
        tokio::spawn(leave_calls_if_still_offline(state.clone(), user.id.clone()));
    }
}
