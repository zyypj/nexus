//! LiveKit access tokens and webhook verification.
//!
//! LiveKit tokens are HS256 JWTs signed with the API secret
//! (https://docs.livekit.io/home/get-started/authentication/). Implementing
//! the claims directly avoids pulling the full LiveKit SDK into the server.

use base64::Engine;
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::config::LiveKitConfig;

#[derive(Debug, Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VideoGrant {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub room: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub room_join: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub room_admin: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub room_create: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub can_publish: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub can_subscribe: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub can_publish_data: Option<bool>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub can_publish_sources: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub iss: String,
    #[serde(default)]
    pub sub: String,
    pub nbf: i64,
    pub exp: i64,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub metadata: String,
    #[serde(default)]
    pub video: VideoGrant,
    /// Present on webhook tokens: base64(SHA-256(body)).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub sha256: String,
}

/// Lifetime of a join token. It only needs to be valid when connecting;
/// LiveKit refreshes it for the client during the session.
pub const JOIN_TOKEN_TTL_SECS: i64 = 10 * 60;

pub const PUBLISH_SOURCES: [&str; 4] = ["microphone", "camera", "screen_share", "screen_share_audio"];

/// A token that only allows joining `room`. Identity = Nexus user id, so
/// clients map LiveKit participants back to users without extra lookups.
pub fn join_token(cfg: &LiveKitConfig, room: &str, identity: &str, name: &str) -> anyhow::Result<String> {
    join_token_with(cfg, room, identity, name, &PUBLISH_SOURCES)
}

/// Like `join_token`, limited to `sources` (server channel permissions: no
/// SPEAK → no microphone, no VIDEO → no camera/screen). Empty = listen only.
pub fn join_token_with(
    cfg: &LiveKitConfig,
    room: &str,
    identity: &str,
    name: &str,
    sources: &[&str],
) -> anyhow::Result<String> {
    let now = crate::db::now_ms() / 1000;
    let claims = Claims {
        iss: cfg.api_key.clone(),
        sub: identity.to_string(),
        nbf: now - 5,
        exp: now + JOIN_TOKEN_TTL_SECS,
        name: name.to_string(),
        metadata: String::new(),
        video: VideoGrant {
            room: Some(room.to_string()),
            room_join: true,
            can_publish: Some(!sources.is_empty()),
            can_subscribe: Some(true),
            can_publish_data: Some(true),
            can_publish_sources: sources.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        },
        sha256: String::new(),
    };
    Ok(jsonwebtoken::encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(cfg.api_secret.as_bytes()),
    )?)
}

fn admin_token(cfg: &LiveKitConfig, room: &str) -> anyhow::Result<String> {
    let now = crate::db::now_ms() / 1000;
    let claims = Claims {
        iss: cfg.api_key.clone(),
        sub: String::new(),
        nbf: now - 5,
        exp: now + 60,
        name: String::new(),
        metadata: String::new(),
        video: VideoGrant {
            room: Some(room.to_string()),
            room_admin: true,
            room_create: true,
            ..Default::default()
        },
        sha256: String::new(),
    };
    Ok(jsonwebtoken::encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(cfg.api_secret.as_bytes()),
    )?)
}

/// Minimal Twirp client for the two RoomService calls the server needs.
async fn room_service(
    http: &reqwest::Client,
    cfg: &LiveKitConfig,
    method: &str,
    room: &str,
    body: serde_json::Value,
) -> anyhow::Result<()> {
    let res = http
        .post(format!("{}/twirp/livekit.RoomService/{method}", cfg.api_url))
        .bearer_auth(admin_token(cfg, room)?)
        .json(&body)
        .send()
        .await?;
    let status = res.status();
    // "not_found" just means the participant/room is already gone.
    if status.is_success() || status == reqwest::StatusCode::NOT_FOUND {
        Ok(())
    } else {
        anyhow::bail!("LiveKit {method} failed with {status}")
    }
}

/// Kicks a user out of a room (e.g. removed from the group mid-call). Without
/// this the LiveKit session would survive because LiveKit refreshes tokens.
pub async fn remove_participant(
    http: &reqwest::Client,
    cfg: &LiveKitConfig,
    room: &str,
    identity: &str,
) -> anyhow::Result<()> {
    room_service(
        http,
        cfg,
        "RemoveParticipant",
        room,
        serde_json::json!({ "room": room, "identity": identity }),
    )
    .await
}

/// Whether `identity` is currently connected to `room` (authoritative check
/// used before acting on a possibly stale `participant_left` webhook).
pub async fn participant_present(
    http: &reqwest::Client,
    cfg: &LiveKitConfig,
    room: &str,
    identity: &str,
) -> anyhow::Result<bool> {
    #[derive(Deserialize)]
    struct Listed {
        #[serde(default)]
        participants: Vec<WebhookParticipant>,
    }
    let res = http
        .post(format!("{}/twirp/livekit.RoomService/ListParticipants", cfg.api_url))
        .bearer_auth(admin_token(cfg, room)?)
        .json(&serde_json::json!({ "room": room }))
        .send()
        .await?;
    if res.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(false);
    }
    if !res.status().is_success() {
        anyhow::bail!("LiveKit ListParticipants failed with {}", res.status());
    }
    let listed: Listed = res.json().await?;
    Ok(listed.participants.iter().any(|p| p.identity == identity))
}

pub async fn delete_room(http: &reqwest::Client, cfg: &LiveKitConfig, room: &str) -> anyhow::Result<()> {
    room_service(http, cfg, "DeleteRoom", room, serde_json::json!({ "room": room })).await
}

pub fn decode(cfg: &LiveKitConfig, token: &str) -> Option<Claims> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.leeway = 60;
    validation.set_required_spec_claims(&["exp", "iss"]);
    validation.set_issuer(&[cfg.api_key.as_str()]);
    jsonwebtoken::decode::<Claims>(token, &DecodingKey::from_secret(cfg.api_secret.as_bytes()), &validation)
        .ok()
        .map(|d| d.claims)
}

/// Validates the `Authorization` JWT of a LiveKit webhook and that its
/// `sha256` claim matches the raw body.
pub fn verify_webhook(cfg: &LiveKitConfig, auth_header: &str, body: &[u8]) -> bool {
    let token = auth_header.strip_prefix("Bearer ").unwrap_or(auth_header).trim();
    let Some(claims) = decode(cfg, token) else {
        return false;
    };
    let digest = base64::engine::general_purpose::STANDARD.encode(Sha256::digest(body));
    crate::auth::tokens::secure_eq(&digest, &claims.sha256)
}

#[derive(Debug, Deserialize)]
pub struct WebhookEvent {
    pub event: String,
    #[serde(default)]
    pub room: Option<WebhookRoom>,
    #[serde(default)]
    pub participant: Option<WebhookParticipant>,
}

#[derive(Debug, Deserialize)]
pub struct WebhookRoom {
    pub name: String,
}

#[derive(Debug, Deserialize)]
pub struct WebhookParticipant {
    pub identity: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> LiveKitConfig {
        LiveKitConfig {
            url: "ws://localhost:7880".into(),
            api_url: "http://localhost:7880".into(),
            api_key: "APIkey".into(),
            api_secret: "secret-secret-secret-secret-secret-1234".into(),
        }
    }

    #[test]
    fn join_token_is_room_scoped() {
        let c = cfg();
        let t = join_token(&c, "nexus-call-abc", "user-1", "João").unwrap();
        let claims = decode(&c, &t).unwrap();
        assert_eq!(claims.sub, "user-1");
        assert_eq!(claims.iss, "APIkey");
        assert_eq!(claims.video.room.as_deref(), Some("nexus-call-abc"));
        assert!(claims.video.room_join);
        // Must not carry admin/create/list grants.
        let raw: serde_json::Value = {
            let payload = t.split('.').nth(1).unwrap();
            let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(payload)
                .unwrap();
            serde_json::from_slice(&bytes).unwrap()
        };
        let video = raw["video"].as_object().unwrap();
        assert!(!video.contains_key("roomAdmin"));
        assert!(!video.contains_key("roomCreate"));
        assert!(!video.contains_key("roomList"));
        assert_eq!(video["roomJoin"], true);
    }

    #[test]
    fn webhook_signature() {
        let c = cfg();
        let body = br#"{"event":"participant_left","room":{"name":"r"},"participant":{"identity":"u"}}"#;
        let now = crate::db::now_ms() / 1000;
        let claims = Claims {
            iss: c.api_key.clone(),
            sub: String::new(),
            nbf: now,
            exp: now + 60,
            name: String::new(),
            metadata: String::new(),
            video: VideoGrant::default(),
            sha256: base64::engine::general_purpose::STANDARD.encode(Sha256::digest(body)),
        };
        let token = jsonwebtoken::encode(
            &Header::new(Algorithm::HS256),
            &claims,
            &EncodingKey::from_secret(c.api_secret.as_bytes()),
        )
        .unwrap();
        assert!(verify_webhook(&c, &token, body));
        assert!(!verify_webhook(&c, &token, b"tampered"));
        assert!(!verify_webhook(&c, "garbage", body));
    }
}
