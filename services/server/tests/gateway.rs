mod common;

use common::{Gateway, TestServer};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio_tungstenite::tungstenite::Message;

#[tokio::test]
async fn identify_and_ready_snapshot() {
    let s = TestServer::start().await;
    let a = s.register("joao").await;
    let b = s.register("pedro").await;
    let dm = s.dm(&a, &b).await;
    b.post(&format!("/api/conversations/{dm}/messages"), json!({ "content": "oi" }))
        .await;

    let (gw, ready) = Gateway::connect(&s, &a.token).await;
    assert_eq!(ready["user"]["username"], "joao");
    assert_eq!(ready["conversations"][0]["id"], dm.as_str());
    assert_eq!(ready["conversations"][0]["unread_count"], 1);
    assert_eq!(ready["relationships"]["friends"][0]["user"]["id"], b.id.as_str());
    assert_eq!(ready["server"]["calls_enabled"], true);
    gw.close().await;
}

#[tokio::test]
async fn invalid_token_is_rejected() {
    let s = TestServer::start().await;
    let (mut ws, _) = tokio_tungstenite::connect_async(&s.ws_url).await.unwrap();
    let _hello = ws.next().await;
    ws.send(Message::Text(
        json!({ "op": "IDENTIFY", "d": { "token": "bad" } }).to_string().into(),
    ))
    .await
    .unwrap();
    let msg = ws.next().await.unwrap().unwrap();
    assert!(msg.to_text().unwrap().contains("INVALID_SESSION"));
    match ws.next().await {
        Some(Ok(Message::Close(Some(frame)))) => assert_eq!(u16::from(frame.code), 4004),
        other => panic!("expected close, got {other:?}"),
    }
}

#[tokio::test]
async fn heartbeat_is_acknowledged() {
    let s = TestServer::start().await;
    let a = s.register("hb").await;
    let (mut gw, _) = Gateway::connect(&s, &a.token).await;
    gw.send(json!({ "op": "HEARTBEAT" })).await;
    gw.next_event("HEARTBEAT_ACK").await;
}

#[tokio::test]
async fn realtime_messages_typing_and_reactions() {
    let s = TestServer::start().await;
    let a = s.register("ana").await;
    let b = s.register("bia").await;
    let dm = s.dm(&a, &b).await;
    let (mut ga, _) = Gateway::connect(&s, &a.token).await;
    let (mut gb, _) = Gateway::connect(&s, &b.token).await;

    gb.send(json!({ "op": "TYPING_START", "d": { "conversation_id": dm } }))
        .await;
    let typing = ga.next_event("TYPING_START").await;
    assert_eq!(typing["user_id"], b.id.as_str());
    gb.send(json!({ "op": "TYPING_STOP", "d": { "conversation_id": dm } }))
        .await;
    ga.next_event("TYPING_STOP").await;

    let (_, msg) = b
        .post(
            &format!("/api/conversations/{dm}/messages"),
            json!({ "content": "tempo real", "nonce": "n-1" }),
        )
        .await;
    let created = ga.next_event("MESSAGE_CREATE").await;
    assert_eq!(created["content"], "tempo real");
    let own = gb.next_event("MESSAGE_CREATE").await;
    assert_eq!(own["nonce"], "n-1");

    let mid = msg["id"].as_str().unwrap();
    b.patch(
        &format!("/api/conversations/{dm}/messages/{mid}"),
        json!({ "content": "editada" }),
    )
    .await;
    assert_eq!(ga.next_event("MESSAGE_UPDATE").await["content"], "editada");

    a.put(&format!(
        "/api/conversations/{dm}/messages/{mid}/reactions/%E2%9D%A4%EF%B8%8F"
    ))
    .await;
    let r = gb.next_event("MESSAGE_REACTION_ADD").await;
    assert_eq!(r["emoji"], "❤️");

    b.delete(&format!("/api/conversations/{dm}/messages/{mid}")).await;
    assert_eq!(ga.next_event("MESSAGE_DELETE").await["id"], mid);
}

#[tokio::test]
async fn events_do_not_leak_to_non_members() {
    let s = TestServer::start().await;
    let a = s.register("x1").await;
    let b = s.register("x2").await;
    let c = s.register("x3").await;
    let dm = s.dm(&a, &b).await;
    let (mut gc, _) = Gateway::connect(&s, &c.token).await;
    // Typing into a conversation you are not part of is ignored.
    gc.send(json!({ "op": "TYPING_START", "d": { "conversation_id": dm } }))
        .await;
    a.post(
        &format!("/api/conversations/{dm}/messages"),
        json!({ "content": "privado" }),
    )
    .await;
    gc.assert_no_event("MESSAGE_CREATE", 400).await;
}

/// Next PRESENCE_UPDATE about `user_id` (a user also receives their own).
async fn presence_of(gw: &mut Gateway, user_id: &str) -> String {
    loop {
        let p = gw.next_event("PRESENCE_UPDATE").await;
        if p["user_id"] == user_id {
            return p["status"].as_str().unwrap().to_string();
        }
    }
}

#[tokio::test]
async fn presence_follows_connections() {
    let s = TestServer::start().await;
    let a = s.register("online1").await;
    let b = s.register("online2").await;
    s.make_friends(&a, &b).await;
    let (mut ga, _) = Gateway::connect(&s, &a.token).await;

    let (gb, ready_b) = Gateway::connect(&s, &b.token).await;
    assert_eq!(ready_b["presences"][0]["user_id"], a.id.as_str());
    assert_eq!(presence_of(&mut ga, &b.id).await, "online");

    gb.close().await;
    assert_eq!(presence_of(&mut ga, &b.id).await, "offline");

    // Invisible looks offline to others.
    let (mut gb, _) = Gateway::connect(&s, &b.token).await;
    assert_eq!(presence_of(&mut ga, &b.id).await, "online");
    b.patch("/api/users/@me", json!({ "status": "invisible" })).await;
    assert_eq!(presence_of(&mut ga, &b.id).await, "offline");
    // ...but the user's own devices see the real status.
    assert_eq!(gb.next_event("USER_UPDATE").await["status"], "invisible");
}

#[tokio::test]
async fn friend_events_are_pushed() {
    let s = TestServer::start().await;
    let a = s.register("f1").await;
    let b = s.register("f2").await;
    let (mut gb, _) = Gateway::connect(&s, &b.token).await;
    let (_, req) = a.post("/api/friends/requests", json!({ "username": "f2" })).await;
    let ev = gb.next_event("FRIEND_REQUEST").await;
    assert_eq!(ev["from"]["id"], a.id.as_str());
    let rid = req["request"]["id"].as_str().unwrap();
    let (mut ga, _) = Gateway::connect(&s, &a.token).await;
    b.post(&format!("/api/friends/requests/{rid}/accept"), json!({})).await;
    let ev = ga.next_event("FRIEND_ACCEPT").await;
    assert_eq!(ev["friend"]["user"]["id"], b.id.as_str());
}

#[tokio::test]
async fn logout_closes_the_socket() {
    let s = TestServer::start().await;
    let a = s.register("sair").await;
    let (mut gw, _) = Gateway::connect(&s, &a.token).await;
    a.post("/api/auth/logout", json!({})).await;
    loop {
        match tokio::time::timeout(std::time::Duration::from_secs(5), gw.ws.next())
            .await
            .unwrap()
        {
            Some(Ok(Message::Close(Some(frame)))) => {
                assert_eq!(u16::from(frame.code), 4001);
                break;
            }
            Some(Ok(_)) => continue,
            other => panic!("expected close frame, got {other:?}"),
        }
    }
}

#[tokio::test]
async fn reconnect_resyncs_missed_messages() {
    let s = TestServer::start().await;
    let a = s.register("r1").await;
    let b = s.register("r2").await;
    let dm = s.dm(&a, &b).await;
    let (gw, ready) = Gateway::connect(&s, &a.token).await;
    assert_eq!(ready["conversations"][0]["unread_count"], 0);
    let (_, last_seen) = a
        .post(
            &format!("/api/conversations/{dm}/messages"),
            json!({ "content": "antes" }),
        )
        .await;
    gw.close().await;

    // Messages sent while disconnected...
    for i in 0..3 {
        b.post(
            &format!("/api/conversations/{dm}/messages"),
            json!({ "content": format!("offline {i}") }),
        )
        .await;
    }
    // ...show up in READY counters and via `after` on reconnect.
    let (_gw, ready) = Gateway::connect(&s, &a.token).await;
    assert_eq!(ready["conversations"][0]["unread_count"], 3);
    let last = last_seen["id"].as_str().unwrap();
    let (_, missed) = a.get(&format!("/api/conversations/{dm}/messages?after={last}")).await;
    assert_eq!(missed.as_array().unwrap().len(), 3);
}

#[tokio::test]
async fn multiple_devices_receive_events() {
    let s = TestServer::start().await;
    let a = s.register("multi").await;
    let b = s.register("multi2").await;
    let dm = s.dm(&a, &b).await;
    let (mut g1, _) = Gateway::connect(&s, &a.token).await;
    let (mut g2, _) = Gateway::connect(&s, &a.token).await;
    b.post(
        &format!("/api/conversations/{dm}/messages"),
        json!({ "content": "dois" }),
    )
    .await;
    g1.next_event("MESSAGE_CREATE").await;
    g2.next_event("MESSAGE_CREATE").await;
    assert_eq!(s.state.hub.connection_count(), 2);
}
