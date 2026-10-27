//! Ephemeral, attended control. No input travels over an unauthenticated data channel.
use std::{
    collections::HashMap,
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

use axum::{
    Json,
    extract::{Path, State},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{
    calls::load_call,
    common::ApiJson,
    conversations::{ensure_dm_not_blocked, load_conversation, require_member},
};
use crate::{
    auth::AuthUser,
    db::{new_id, now_ms},
    error::{ApiError, ApiResult},
    permissions,
    rate_limit::Rule,
    state::AppState,
};

pub const EVENT: &str = "REMOTE_CONTROL_INPUT";
/// Something about the call's control state changed: clients fetch the status
/// again instead of polling it (only the sharing owner keeps a heartbeat).
pub const UPDATE: &str = "REMOTE_CONTROL_UPDATE";
pub type Controls = Mutex<HashMap<(String, String), Share>>;

/// How long a full permission check covers the inputs that follow it. The
/// owner's heartbeat (every ~500 ms) renews it; role, channel and membership
/// changes drop it at once (see [`invalidate`]).
const AUTH_TTL_MS: i64 = 1500;
/// Bumped by [`invalidate`]: a check that started before a permission change
/// must not mark a share as authorized after it.
static AUTH_GENERATION: AtomicU64 = AtomicU64::new(0);

/// Server roles, overwrites or members changed: the next input of every
/// session goes through the full permission check again.
pub fn invalidate(state: &AppState) {
    AUTH_GENERATION.fetch_add(1, Ordering::SeqCst);
    for s in state.controls.lock().unwrap_or_else(|e| e.into_inner()).values_mut() {
        s.authorized_until = 0;
    }
}

fn notify<'a>(state: &AppState, users: impl IntoIterator<Item = &'a str>, call_id: &str) {
    state.hub.send(users, UPDATE, &json!({ "call_id": call_id }));
}

fn transport_configured(public_url: &str) -> bool {
    reqwest::Url::parse(public_url).is_ok_and(|u| {
        u.scheme() == "https"
            || (u.scheme() == "http" && matches!(u.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")))
    })
}

pub fn revoke(state: &AppState, call: &str, user: Option<&str>) {
    let mut affected: Vec<String> = Vec::new();
    state
        .controls
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|(c, owner), s| {
            let keep = c != call || user.is_some_and(|u| u != owner && s.view.controller_id.as_deref() != Some(u));
            if !keep {
                affected.push(owner.clone());
                affected.extend(s.view.controller_id.clone());
            }
            keep
        });
    if !affected.is_empty() {
        notify(state, affected.iter().map(String::as_str), call);
    }
}

#[derive(Clone)]
pub struct Share {
    owner_session: String,
    lease: i64,
    request_after: i64,
    pub view: ControlView,
    controller_session: Option<String>,
    epoch: u64,
    sequence: u64,
    /// Inputs before this time skip the database checks (see [`AUTH_TTL_MS`]).
    authorized_until: i64,
}

#[derive(Clone, Serialize)]
pub struct ControlView {
    pub owner_id: String,
    pub request_id: Option<String>,
    pub controller_id: Option<String>,
    pub accepted: bool,
    pub expires_at: i64,
    pub permissions: Capabilities,
}

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Capabilities {
    pub pointer: bool,
    pub click: bool,
    pub scroll: bool,
    pub text: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Input {
    Move { x: f64, y: f64 },
    Click { x: f64, y: f64, button: u8 },
    Scroll { x: f64, y: f64, delta: i32 },
    Text { text: String },
}

impl Input {
    pub fn allowed(&self, p: Capabilities) -> bool {
        let point =
            |x: f64, y: f64| x.is_finite() && y.is_finite() && (0.0..=1.0).contains(&x) && (0.0..=1.0).contains(&y);
        match self {
            Self::Move { x, y } => p.pointer && point(*x, *y),
            Self::Click { x, y, button } => p.click && *button == 0 && point(*x, *y),
            Self::Scroll { x, y, delta } => p.scroll && delta.abs_diff(0) <= 480 && point(*x, *y),
            Self::Text { text } => {
                p.text && !text.is_empty() && text.len() <= 64 && !text.chars().any(char::is_control)
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum Command {
    Offer {
        enabled: bool,
    },
    Request {
        owner_id: String,
    },
    Respond {
        request_id: String,
        accept: bool,
        permissions: Capabilities,
    },
    Heartbeat {
        epoch: u64,
    },
    Stop,
    Input {
        request_id: String,
        sequence: u64,
        input: Input,
    },
}

async fn participants(state: &AppState, call_id: &str, user: &AuthUser) -> ApiResult<crate::models::Call> {
    let call = load_call(&state.db, call_id).await?;
    require_member(&state.db, &call.conversation_id, &user.id).await?;
    ensure_dm_not_blocked(
        &state.db,
        &call.conversation_id,
        load_conversation(&state.db, &call.conversation_id).await?.kind,
        &user.id,
    )
    .await?;
    if call.ended_at.is_some() || !call.participants.iter().any(|p| p.user_id == user.id) {
        return Err(ApiError::Forbidden("Entre na chamada primeiro."));
    }
    Ok(call)
}

async fn can_request(state: &AppState, call: &crate::models::Call, user_id: &str) -> ApiResult<()> {
    // Also rechecked on EVERY input and on acceptance, after role/overwrite changes.
    require_member(&state.db, &call.conversation_id, user_id).await?;
    let conv = load_conversation(&state.db, &call.conversation_id).await?;
    ensure_dm_not_blocked(&state.db, &conv.id, conv.kind, user_id).await?;
    if conv.server_id.is_some() {
        permissions::require_channel_perm(
            &state.db,
            &call.conversation_id,
            user_id,
            permissions::CONNECT | permissions::REQUEST_CONTROL,
            "Sem permissão para solicitar controle neste canal.",
        )
        .await?;
    }
    Ok(())
}

fn sweep(controls: &mut HashMap<(String, String), Share>, now: i64) {
    controls.retain(|_, s| s.lease > now);
    for s in controls.values_mut() {
        if s.view.expires_at <= now {
            s.view.request_id = None;
            s.view.controller_id = None;
            s.view.accepted = false;
            s.controller_session = None;
        }
    }
}

pub async fn status(State(state): State<AppState>, user: AuthUser, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let call = participants(&state, &id, &user).await?;
    let allowed = transport_configured(&state.config.public_url) && can_request(&state, &call, &user.id).await.is_ok();
    let mut controls = state.controls.lock().unwrap_or_else(|e| e.into_inner());
    sweep(&mut controls, now_ms());
    let shares: Vec<_> = controls
        .iter()
        .filter(|((c, _), s)| {
            c == &id
                && call
                    .participants
                    .iter()
                    .any(|p| p.user_id == s.view.owner_id && p.screen)
        })
        .map(|(_, s)| s.view.clone())
        .collect();
    Ok(Json(json!({ "can_request": allowed, "shares": shares })))
}

pub async fn command(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    ApiJson(cmd): ApiJson<Command>,
) -> ApiResult<Json<Value>> {
    if !matches!(cmd, Command::Stop | Command::Offer { enabled: false })
        && !transport_configured(&state.config.public_url)
    {
        return Err(ApiError::Forbidden(
            "Configure NEXUS_PUBLIC_URL com HTTPS para controle remoto.",
        ));
    }
    state.limiter.check("remote", &user.id, Rule::per_second(40, 30))?;
    if let Command::Input {
        request_id,
        sequence,
        input,
    } = cmd
    {
        return deliver_input(&state, &user, &id, &request_id, sequence, input).await;
    }
    let call = participants(&state, &id, &user).await?;
    // Generation before the checks: a permission change during them keeps the
    // share unauthorized (see `invalidate`).
    let generation = AUTH_GENERATION.load(Ordering::SeqCst);
    // All database work precedes the synchronous lock; never hold it across await.
    match &cmd {
        Command::Request { .. } => {
            if let Err(e) = can_request(&state, &call, &user.id).await {
                revoke(&state, &id, Some(&user.id));
                return Err(e);
            }
        }
        Command::Heartbeat { .. } | Command::Respond { accept: true, .. } => {
            let controller = {
                let controls = state.controls.lock().unwrap_or_else(|e| e.into_inner());
                controls
                    .get(&(id.clone(), user.id.clone()))
                    .and_then(|s| s.view.controller_id.clone())
            };
            if let Some(controller) = controller
                && (can_request(&state, &call, &controller).await.is_err()
                    || !call.participants.iter().any(|p| p.user_id == controller))
            {
                revoke(&state, &id, Some(&user.id));
                return Err(ApiError::Forbidden(
                    "O solicitante perdeu acesso à chamada ou ao controle.",
                ));
            }
        }
        _ => {}
    }
    let now = now_ms();
    let mut controls = state.controls.lock().unwrap_or_else(|e| e.into_inner());
    sweep(&mut controls, now);
    let key = (id.clone(), user.id.clone());
    match cmd {
        Command::Offer { enabled: true } => {
            if !call.participants.iter().any(|p| p.user_id == user.id && p.screen) {
                return Err(ApiError::Forbidden("Compartilhe uma janela primeiro."));
            }
            if controls.contains_key(&key) {
                return Err(ApiError::Conflict("Desative o controle anterior primeiro."));
            }
            if controls.len() >= 4096 {
                return Err(ApiError::Unavailable("Controle indisponível."));
            }
            controls.insert(
                key,
                Share {
                    owner_session: user.session_id,
                    lease: now + 4000,
                    request_after: 0,
                    view: ControlView {
                        owner_id: user.id,
                        request_id: None,
                        controller_id: None,
                        accepted: false,
                        expires_at: 0,
                        permissions: Capabilities::default(),
                    },
                    controller_session: None,
                    epoch: 0,
                    sequence: 0,
                    authorized_until: 0,
                },
            );
        }
        Command::Offer { enabled: false } | Command::Stop => {
            controls.retain(|(c, owner), s| {
                c != &id || (owner != &user.id && s.view.controller_id.as_ref() != Some(&user.id))
            });
        }
        Command::Request { owner_id } => {
            if owner_id == user.id {
                return Err(ApiError::bad("Não é possível controlar a si mesmo."));
            }
            if !call.participants.iter().any(|p| p.user_id == owner_id && p.screen) {
                return Err(ApiError::Forbidden("Transmissão encerrada."));
            }
            let s = controls
                .get_mut(&(id.clone(), owner_id))
                .ok_or(ApiError::Forbidden("O dono não liberou solicitações."))?;
            if s.view.request_id.is_some() || now < s.request_after {
                return Err(ApiError::Conflict("Aguarde antes de solicitar novamente."));
            }
            s.request_after = now + 30_000;
            s.view.request_id = Some(new_id());
            s.view.controller_id = Some(user.id);
            s.controller_session = Some(user.session_id);
            s.view.accepted = false;
            s.view.expires_at = now + 30_000;
            s.sequence = 0;
            s.authorized_until = 0;
        }
        Command::Respond {
            request_id,
            accept,
            permissions,
        } => {
            let s = controls.get_mut(&key).ok_or(ApiError::NotFound("share"))?;
            if s.owner_session != user.session_id
                || s.view.request_id.as_deref() != Some(&request_id)
                || s.view.accepted
            {
                return Err(ApiError::Forbidden("Solicitação inválida."));
            }
            if accept {
                s.view.accepted = true;
                s.view.permissions = permissions;
                s.view.expires_at = now + 300_000;
                if generation == AUTH_GENERATION.load(Ordering::SeqCst) {
                    s.authorized_until = now + AUTH_TTL_MS;
                }
            } else {
                s.view.request_id = None;
                s.view.controller_id = None;
                s.controller_session = None;
                s.authorized_until = 0;
            }
        }
        Command::Heartbeat { epoch } => {
            let s = controls.get_mut(&key).ok_or(ApiError::NotFound("share"))?;
            if s.owner_session != user.session_id || !call.participants.iter().any(|p| p.user_id == user.id && p.screen)
            {
                return Err(ApiError::Forbidden("Transmissão encerrada."));
            }
            s.lease = now + 4000;
            s.epoch = epoch;
            if s.view.accepted && generation == AUTH_GENERATION.load(Ordering::SeqCst) {
                s.authorized_until = now + AUTH_TTL_MS;
            }
            // The owner's own view, so it does not have to poll the status too.
            return Ok(Json(json!({ "ok": true, "share": s.view })));
        }
        Command::Input { .. } => unreachable!("handled above"),
    }
    drop(controls);
    // Everyone in the call: viewers learn who offers control, the owner sees
    // requests, the controller sees the answer. Nobody has to poll for it.
    notify(&state, call.participants.iter().map(|p| p.user_id.as_str()), &id);
    Ok(Json(json!({ "ok": true })))
}

/// Inputs: authorization lives in memory. The full database check (call,
/// membership, blocks, role/channel permission, the owner still sharing) runs
/// only when the last one is older than [`AUTH_TTL_MS`] or was invalidated.
/// Leaving the call, stopping the share and ending the call revoke the share
/// itself, so a cached check never outlives them.
async fn deliver_input(
    state: &AppState,
    user: &AuthUser,
    call_id: &str,
    request_id: &str,
    sequence: u64,
    input: Input,
) -> ApiResult<Json<Value>> {
    let generation = AUTH_GENERATION.load(Ordering::SeqCst);
    let fresh = {
        let mut controls = state.controls.lock().unwrap_or_else(|e| e.into_inner());
        let now = now_ms();
        sweep(&mut controls, now);
        let s = find_session(&mut controls, call_id, request_id, user)?;
        if !input.allowed(s.view.permissions) {
            return Err(ApiError::Forbidden("Entrada não autorizada."));
        }
        s.authorized_until > now
    };
    if !fresh {
        let checked = async {
            let call = participants(state, call_id, user).await?;
            can_request(state, &call, &user.id).await?;
            Ok::<_, ApiError>(call)
        }
        .await;
        let call = match checked {
            Ok(call) => call,
            Err(e) => {
                revoke(state, call_id, Some(&user.id));
                return Err(e);
            }
        };
        let mut controls = state.controls.lock().unwrap_or_else(|e| e.into_inner());
        let s = find_session(&mut controls, call_id, request_id, user)?;
        if !call
            .participants
            .iter()
            .any(|p| p.user_id == s.view.owner_id && p.screen)
        {
            return Err(ApiError::Forbidden("Entrada não autorizada."));
        }
        if generation == AUTH_GENERATION.load(Ordering::SeqCst) {
            s.authorized_until = now_ms() + AUTH_TTL_MS;
        }
    }
    let mut controls = state.controls.lock().unwrap_or_else(|e| e.into_inner());
    let s = find_session(&mut controls, call_id, request_id, user)?;
    if sequence <= s.sequence {
        // Normal when a click overtakes a move; acknowledge without delivering/replaying it.
        return Ok(Json(json!({ "ok": true, "discarded": true })));
    }
    s.sequence = sequence;
    // Deliver only to the consenting device's authenticated gateway session.
    state.hub.send_session(
        &s.view.owner_id,
        &s.owner_session,
        EVENT,
        &json!({ "call_id": call_id, "request_id": request_id, "sequence": sequence, "epoch": s.epoch, "input": input }),
    );
    Ok(Json(json!({ "ok": true })))
}

/// The accepted session `request_id` of this call, controlled by this device.
fn find_session<'a>(
    controls: &'a mut HashMap<(String, String), Share>,
    call_id: &str,
    request_id: &str,
    user: &AuthUser,
) -> ApiResult<&'a mut Share> {
    let s = controls
        .iter_mut()
        .find(|((c, _), s)| c == call_id && s.view.request_id.as_deref() == Some(request_id))
        .map(|(_, s)| s)
        .ok_or(ApiError::NotFound("control"))?;
    if !s.view.accepted
        || s.view.controller_id.as_deref() != Some(user.id.as_str())
        || s.controller_session.as_deref() != Some(user.session_id.as_str())
    {
        return Err(ApiError::Forbidden("Entrada não autorizada."));
    }
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn requires_https_outside_loopback() {
        assert!(!transport_configured("http://192.168.1.2:3000"));
        assert!(!transport_configured("http://localhost.evil.example"));
        assert!(transport_configured("https://nexus.example"));
        assert!(transport_configured("http://127.0.0.1:3000"));
    }
    #[test]
    fn capability_and_payload_limits() {
        let all = Capabilities {
            pointer: true,
            click: true,
            scroll: true,
            text: true,
        };
        assert!(!Input::Move { x: f64::NAN, y: 0.5 }.allowed(all));
        assert!(
            !Input::Click {
                x: 0.5,
                y: 0.5,
                button: 2
            }
            .allowed(all)
        );
        // Right click opens menus, which are separate windows the guard blocks.
        assert!(
            !Input::Click {
                x: 0.5,
                y: 0.5,
                button: 1
            }
            .allowed(all)
        );
        assert!(!Input::Text { text: "cmd\n".into() }.allowed(all));
        assert!(!Input::Text { text: "abc".into() }.allowed(Capabilities::default()));
        assert!(
            !Input::Scroll {
                x: 0.0,
                y: 1.0,
                delta: i32::MIN
            }
            .allowed(all)
        );
        assert!(Input::Text { text: "Olá".into() }.allowed(all));
    }
}
