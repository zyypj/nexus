//! Call orchestration tests (signalling side). Media-level checks against a
//! real LiveKit server live in `tests/calls/` at the repo root.

mod common;

use base64::Engine;
use common::{Gateway, TestServer, TestUser};
use nexus_server::livekit;
use reqwest::StatusCode;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn room_of(s: &TestServer, join: &Value) -> String {
    let cfg = s.state.config.livekit.as_ref().unwrap();
    let claims = livekit::decode(cfg, join["livekit_token"].as_str().unwrap()).expect("valid LiveKit token");
    claims.video.room.unwrap()
}

async fn start(u: &TestUser, conversation: &str) -> Value {
    let (status, body) = u
        .post(&format!("/api/conversations/{conversation}/call"), json!({}))
        .await;
    assert!(status.is_success(), "{body}");
    body
}

async fn participants(u: &TestUser, call_id: &str) -> Vec<String> {
    let (_, calls) = u.get("/api/calls").await;
    calls
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == call_id)
        .map(|c| {
            c["participants"]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| p["user_id"].as_str().unwrap().to_string())
                .collect()
        })
        .unwrap_or_default()
}

async fn n_users_in_one_call(n: usize) {
    let s = TestServer::start().await;
    let (users, gid) = s.group(&format!("call{n}_"), n).await;
    let first = start(&users[0], &gid).await;
    let call_id = first["call"]["id"].as_str().unwrap().to_string();
    let room = room_of(&s, &first);
    assert!(room.starts_with("nexus-call-"));

    for u in &users[1..] {
        let join = start(u, &gid).await;
        assert_eq!(join["call"]["id"], call_id.as_str(), "joins the running call");
        assert_eq!(room_of(&s, &join), room, "same LiveKit room");
        let claims = livekit::decode(
            s.state.config.livekit.as_ref().unwrap(),
            join["livekit_token"].as_str().unwrap(),
        )
        .unwrap();
        assert_eq!(claims.sub, u.id, "identity is the user id");
    }
    assert_eq!(participants(&users[0], &call_id).await.len(), n);
}

#[tokio::test]
async fn two_users_in_the_same_call() {
    n_users_in_one_call(2).await;
}

#[tokio::test]
async fn five_users_in_the_same_call() {
    n_users_in_one_call(5).await;
}

#[tokio::test]
async fn ten_users_in_the_same_call() {
    n_users_in_one_call(10).await;
}

#[tokio::test]
async fn simultaneous_calls_are_isolated() {
    let s = TestServer::start().await;
    // Group A: João, Pedro, Lucas. Group B: Carlos, Marcos.
    let (a, ga) = s.group("a", 3).await;
    let (b, gb) = s.group("b", 2).await;

    let a0 = start(&a[0], &ga).await;
    let b0 = start(&b[0], &gb).await;
    for u in &a[1..] {
        start(u, &ga).await;
    }
    start(&b[1], &gb).await;

    let room_a = room_of(&s, &a0);
    let room_b = room_of(&s, &b0);
    assert_ne!(room_a, room_b);
    assert_ne!(a0["call"]["id"], b0["call"]["id"]);

    let call_a = a0["call"]["id"].as_str().unwrap();
    let call_b = b0["call"]["id"].as_str().unwrap();
    assert_eq!(participants(&a[0], call_a).await.len(), 3);
    assert_eq!(participants(&b[0], call_b).await.len(), 2);

    // Group B members cannot see or join group A's call.
    assert!(participants(&b[0], call_a).await.is_empty());
    assert_eq!(
        b[0].post(&format!("/api/calls/{call_a}/join"), json!({})).await.0,
        StatusCode::NOT_FOUND
    );

    // Leaving one call does not touch the other.
    a[2].post(&format!("/api/calls/{call_a}/leave"), json!({})).await;
    assert_eq!(participants(&a[0], call_a).await.len(), 2);
    assert_eq!(participants(&b[0], call_b).await.len(), 2);
}

#[tokio::test]
async fn non_member_cannot_get_a_token() {
    let s = TestServer::start().await;
    let (users, gid) = s.group("priv", 2).await;
    let outsider = s.register("penetra").await;
    let join = start(&users[0], &gid).await;
    let call_id = join["call"]["id"].as_str().unwrap();
    let (status, body) = outsider.post(&format!("/api/calls/{call_id}/join"), json!({})).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(body.get("livekit_token").is_none());
    assert_eq!(
        outsider
            .post(&format!("/api/conversations/{gid}/call"), json!({}))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        outsider
            .patch(&format!("/api/calls/{call_id}/state"), json!({ "muted": true }))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn join_leave_events_and_auto_end() {
    let s = TestServer::start().await;
    let (users, gid) = s.group("ev", 2).await;
    let (mut g0, _) = Gateway::connect(&s, &users[0].token).await;
    let (mut g1, _) = Gateway::connect(&s, &users[1].token).await;

    let join = start(&users[0], &gid).await;
    let call_id = join["call"]["id"].as_str().unwrap().to_string();
    let created = g1.next_event("CALL_CREATE").await;
    assert_eq!(created["id"], call_id.as_str());
    let joined = g1.next_event("CALL_JOIN").await;
    assert_eq!(joined["participant"]["user_id"], users[0].id.as_str());

    // The caller's own devices also get their CALL_JOIN.
    assert_eq!(
        g0.next_event("CALL_JOIN").await["participant"]["user_id"],
        users[0].id.as_str()
    );
    users[1].post(&format!("/api/calls/{call_id}/join"), json!({})).await;
    assert_eq!(
        g0.next_event("CALL_JOIN").await["participant"]["user_id"],
        users[1].id.as_str()
    );

    users[1].post(&format!("/api/calls/{call_id}/leave"), json!({})).await;
    assert_eq!(g0.next_event("CALL_LEAVE").await["user_id"], users[1].id.as_str());

    users[0].post(&format!("/api/calls/{call_id}/leave"), json!({})).await;
    assert_eq!(g1.next_event("CALL_END").await["call_id"], call_id.as_str());
    let (_, calls) = users[0].get("/api/calls").await;
    assert!(calls.as_array().unwrap().is_empty());

    // A new call afterwards gets a fresh room.
    let again = start(&users[1], &gid).await;
    assert_ne!(again["call"]["id"], call_id.as_str());
    assert_ne!(room_of(&s, &again), room_of(&s, &join));
}

#[tokio::test]
async fn mute_and_deafen_state() {
    let s = TestServer::start().await;
    let (users, gid) = s.group("mute", 2).await;
    let join = start(&users[0], &gid).await;
    let call_id = join["call"]["id"].as_str().unwrap().to_string();
    start(&users[1], &gid).await;
    let (mut g1, _) = Gateway::connect(&s, &users[1].token).await;

    let (_, p) = users[0]
        .patch(&format!("/api/calls/{call_id}/state"), json!({ "muted": true }))
        .await;
    assert_eq!(p["muted"], true);
    assert_eq!(p["deafened"], false);
    let ev = g1.next_event("CALL_STATE_UPDATE").await;
    assert_eq!(ev["participant"]["muted"], true);

    // Deafen forces mute; un-deafening keeps the explicit mute state.
    let (_, p) = users[0]
        .patch(
            &format!("/api/calls/{call_id}/state"),
            json!({ "muted": false, "deafened": true }),
        )
        .await;
    assert_eq!(p["deafened"], true);
    assert_eq!(p["muted"], true);
    let (_, p) = users[0]
        .patch(
            &format!("/api/calls/{call_id}/state"),
            json!({ "deafened": false, "muted": false }),
        )
        .await;
    assert_eq!(p["deafened"], false);
    assert_eq!(p["muted"], false);

    let (_, p) = users[0]
        .patch(
            &format!("/api/calls/{call_id}/state"),
            json!({ "video": true, "screen": true }),
        )
        .await;
    assert_eq!(p["video"], true);
    assert_eq!(p["screen"], true);
}

#[tokio::test]
async fn joining_another_call_leaves_the_first() {
    let s = TestServer::start().await;
    let a = s.register("multi_a").await;
    let b = s.register("multi_b").await;
    let c = s.register("multi_c").await;
    let dm_ab = s.dm(&a, &b).await;
    let dm_ac = s.dm(&a, &c).await;
    let first = start(&a, &dm_ab).await;
    start(&b, &dm_ab).await;
    let call1 = first["call"]["id"].as_str().unwrap().to_string();
    start(&c, &dm_ac).await;
    start(&a, &dm_ac).await;
    let p1 = participants(&b, &call1).await;
    assert_eq!(p1, vec![b.id.clone()], "a left call 1 when joining call 2");
}

#[tokio::test]
async fn reconnect_rejoins_same_room() {
    let s = TestServer::start().await;
    let (users, gid) = s.group("rc", 2).await;
    let first = start(&users[0], &gid).await;
    start(&users[1], &gid).await;
    let call_id = first["call"]["id"].as_str().unwrap();
    // Network drop: the client asks for a new token for the same call.
    let (status, again) = users[0].post(&format!("/api/calls/{call_id}/join"), json!({})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(room_of(&s, &again), room_of(&s, &first));
    assert_eq!(
        participants(&users[0], call_id).await.len(),
        2,
        "no duplicate participant"
    );
}

#[tokio::test]
async fn removed_member_is_dropped_from_call() {
    let s = TestServer::start().await;
    let (users, gid) = s.group("kick", 3).await;
    let join = start(&users[0], &gid).await;
    let call_id = join["call"]["id"].as_str().unwrap().to_string();
    start(&users[2], &gid).await;
    users[0]
        .delete(&format!("/api/conversations/{gid}/members/{}", users[2].id))
        .await;
    assert_eq!(participants(&users[0], &call_id).await, vec![users[0].id.clone()]);
    assert_eq!(
        users[2].post(&format!("/api/calls/{call_id}/join"), json!({})).await.0,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn group_call_end_permissions() {
    let s = TestServer::start().await;
    let (users, gid) = s.group("end", 3).await;
    let join = start(&users[1], &gid).await; // started by a non-owner
    let call_id = join["call"]["id"].as_str().unwrap().to_string();
    start(&users[2], &gid).await;
    assert_eq!(
        users[2].post(&format!("/api/calls/{call_id}/end"), json!({})).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        users[0].post(&format!("/api/calls/{call_id}/end"), json!({})).await.0,
        StatusCode::NO_CONTENT
    );
    let (_, calls) = users[1].get("/api/calls").await;
    assert!(calls.as_array().unwrap().is_empty());
}

fn signed_webhook(s: &TestServer, body: &str) -> String {
    let cfg = s.state.config.livekit.as_ref().unwrap();
    let now = nexus_server::db::now_ms() / 1000;
    let claims = livekit::Claims {
        iss: cfg.api_key.clone(),
        sub: String::new(),
        nbf: now,
        exp: now + 60,
        name: String::new(),
        metadata: String::new(),
        video: Default::default(),
        sha256: base64::engine::general_purpose::STANDARD.encode(Sha256::digest(body.as_bytes())),
    };
    jsonwebtoken::encode(
        &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::HS256),
        &claims,
        &jsonwebtoken::EncodingKey::from_secret(cfg.api_secret.as_bytes()),
    )
    .unwrap()
}

#[tokio::test]
async fn livekit_webhook_reconciles_crashed_clients() {
    let s = TestServer::start().await;
    let (users, gid) = s.group("wh", 2).await;
    let join = start(&users[0], &gid).await;
    start(&users[1], &gid).await;
    let call_id = join["call"]["id"].as_str().unwrap();
    let room = room_of(&s, &join);

    let body =
        json!({ "event": "participant_left", "room": { "name": room }, "participant": { "identity": users[1].id } })
            .to_string();
    // Unsigned / wrongly signed webhooks are rejected.
    let res = s
        .http
        .post(format!("{}/api/livekit/webhook", s.base))
        .header("content-type", "application/webhook+json")
        .header("authorization", "nope")
        .body(body.clone())
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);

    let res = s
        .http
        .post(format!("{}/api/livekit/webhook", s.base))
        .header("content-type", "application/webhook+json")
        .header("authorization", signed_webhook(&s, &body))
        .body(body)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(participants(&users[0], call_id).await, vec![users[0].id.clone()]);

    let body = json!({ "event": "room_finished", "room": { "name": room } }).to_string();
    let res = s
        .http
        .post(format!("{}/api/livekit/webhook", s.base))
        .header("authorization", signed_webhook(&s, &body))
        .body(body)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let (_, calls) = users[0].get("/api/calls").await;
    assert!(calls.as_array().unwrap().is_empty());
}

#[tokio::test]
async fn calls_disabled_without_livekit() {
    let s = TestServer::start_with(|c| c.livekit = None).await;
    let a = s.register("nolk1").await;
    let b = s.register("nolk2").await;
    let dm = s.dm(&a, &b).await;
    assert_eq!(
        a.post(&format!("/api/conversations/{dm}/call"), json!({})).await.0,
        StatusCode::SERVICE_UNAVAILABLE
    );
}
