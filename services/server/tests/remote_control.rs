mod common;
use common::{Gateway, TestServer, TestUser};
use nexus_server::permissions as p;
use reqwest::StatusCode;
use serde_json::{Value, json};

fn caps(pointer: bool) -> Value {
    json!({"pointer": pointer,"click":false,"scroll":false,"text":false})
}
async fn cmd(user: &TestUser, call: &str, body: Value) -> (StatusCode, Value) {
    user.post(&format!("/api/calls/{call}/remote-control"), body).await
}
async fn start(user: &TestUser, conversation: &str) -> String {
    let (status, join) = user
        .post(&format!("/api/conversations/{conversation}/call"), json!({}))
        .await;
    assert!(status.is_success(), "{join}");
    join["call"]["id"].as_str().unwrap().into()
}
async fn request(owner: &TestUser, controller: &TestUser, call: &str) -> String {
    assert!(
        owner
            .patch(&format!("/api/calls/{call}/state"), json!({"screen":true}))
            .await
            .0
            .is_success()
    );
    assert_eq!(
        cmd(owner, call, json!({"action":"offer","enabled":true})).await.0,
        StatusCode::OK
    );
    assert_eq!(
        cmd(controller, call, json!({"action":"request","owner_id":owner.id}))
            .await
            .0,
        StatusCode::OK
    );
    let (_, view) = owner.get(&format!("/api/calls/{call}/remote-control")).await;
    view["shares"][0]["request_id"].as_str().unwrap().into()
}
async fn accept(owner: &TestUser, call: &str, id: &str) {
    assert_eq!(
        cmd(
            owner,
            call,
            json!({"action":"respond","request_id":id,"accept":true,"permissions":caps(true)})
        )
        .await
        .0,
        StatusCode::OK
    );
}
fn movement(id: &str, seq: u64) -> Value {
    json!({"action":"input","request_id":id,"sequence":seq,"input":{"kind":"move","x":0.5,"y":0.5}})
}

#[tokio::test]
async fn private_control_requires_offer_consent_capabilities_and_bound_device() {
    let s = TestServer::start().await;
    let (users, conversation) = s.group("ctrl", 3).await;
    let (owner, controller, other) = (&users[0], &users[1], &users[2]);
    let call = start(owner, &conversation).await;
    start(controller, &conversation).await;
    start(other, &conversation).await;
    assert_eq!(
        cmd(controller, &call, json!({"action":"request","owner_id":owner.id}))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let id = request(owner, controller, &call).await;
    assert_eq!(cmd(controller, &call, movement(&id, 1)).await.0, StatusCode::FORBIDDEN);
    assert_eq!(
        cmd(
            controller,
            &call,
            json!({"action":"respond","request_id":id,"accept":true,"permissions":caps(true)})
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    accept(owner, &call, &id).await;
    let (mut gw, _) = Gateway::connect(&s, &owner.token).await;
    let (_, login_owner) = s
        .raw(
            reqwest::Method::POST,
            "/api/auth/login",
            None,
            Some(json!({"username":owner.username,"password":"password123","device_name":"second-owner-device"})),
        )
        .await;
    let owner_second = login_owner["access_token"].as_str().unwrap();
    let (mut second_gw, _) = Gateway::connect(&s, owner_second).await;
    assert_eq!(
        s.raw(
            reqwest::Method::POST,
            &format!("/api/calls/{call}/remote-control"),
            Some(owner_second),
            Some(json!({"action":"respond","request_id":id,"accept":true,"permissions":caps(true)}))
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(cmd(other, &call, movement(&id, 1)).await.0, StatusCode::FORBIDDEN);
    assert_eq!(
        cmd(
            controller,
            &call,
            json!({"action":"input","request_id":id,"sequence":1,"input":{"kind":"text","text":"abc"}})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(cmd(controller, &call, movement(&id, 1)).await.0, StatusCode::OK);
    let packet = gw.next_event("REMOTE_CONTROL_INPUT").await;
    assert_eq!(packet["request_id"], id);
    assert_eq!(packet["sequence"], 1);
    assert!(
        tokio::time::timeout(
            std::time::Duration::from_millis(80),
            second_gw.next_event("REMOTE_CONTROL_INPUT")
        )
        .await
        .is_err(),
        "the owner's other device must never receive input events"
    );
    let (status, duplicate) = cmd(controller, &call, movement(&id, 1)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(duplicate["discarded"], true, "duplicate packets are never delivered");
    let (_, login) = s
        .raw(
            reqwest::Method::POST,
            "/api/auth/login",
            None,
            Some(json!({"username":controller.username,"password":"password123","device_name":"other-device"})),
        )
        .await;
    let second = login["access_token"].as_str().unwrap();
    assert_eq!(
        s.raw(
            reqwest::Method::POST,
            &format!("/api/calls/{call}/remote-control"),
            Some(second),
            Some(movement(&id, 2))
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(cmd(owner, &call, json!({"action":"stop"})).await.0, StatusCode::OK);
    assert_eq!(cmd(controller, &call, movement(&id, 2)).await.0, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn rejection_timeout_and_stopping_share_never_keep_a_grant() {
    let s = TestServer::start().await;
    let (users, conversation) = s.group("endctrl", 2).await;
    let (owner, controller) = (&users[0], &users[1]);
    let call = start(owner, &conversation).await;
    start(controller, &conversation).await;
    let id = request(owner, controller, &call).await;
    assert_eq!(
        cmd(
            owner,
            &call,
            json!({"action":"respond","request_id":id,"accept":false,"permissions":caps(false)})
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(cmd(controller, &call, movement(&id, 1)).await.0, StatusCode::NOT_FOUND);
    cmd(owner, &call, json!({"action":"stop"})).await;
    let id = request(owner, controller, &call).await;
    {
        let mut controls = s.state.controls.lock().unwrap();
        controls
            .get_mut(&(call.clone(), owner.id.clone()))
            .unwrap()
            .view
            .expires_at = 0;
    }
    assert_eq!(
        cmd(
            owner,
            &call,
            json!({"action":"respond","request_id":id,"accept":true,"permissions":caps(true)})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    cmd(owner, &call, json!({"action":"stop"})).await;
    let id = request(owner, controller, &call).await;
    accept(owner, &call, &id).await;
    owner
        .patch(&format!("/api/calls/{call}/state"), json!({"screen":false}))
        .await;
    owner
        .patch(&format!("/api/calls/{call}/state"), json!({"screen":true}))
        .await;
    assert_eq!(cmd(controller, &call, movement(&id, 1)).await.0, StatusCode::NOT_FOUND);
    let id = request(owner, controller, &call).await;
    accept(owner, &call, &id).await;
    controller.post(&format!("/api/calls/{call}/leave"), json!({})).await;
    start(controller, &conversation).await;
    assert_eq!(cmd(controller, &call, movement(&id, 1)).await.0, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn server_permission_and_channel_overwrite_are_rechecked_after_acceptance() {
    let s = TestServer::start().await;
    let owner = s.register("ctrl_owner").await;
    let controller = s.register("ctrl_guest").await;
    let (_, server) = owner.post("/api/servers", json!({"name":"Controle"})).await;
    let sid = server["id"].as_str().unwrap();
    let voice = server["channels"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["kind"] == "voice")
        .unwrap()["id"]
        .as_str()
        .unwrap();
    let (_, invite) = owner.post(&format!("/api/servers/{sid}/invites"), json!({})).await;
    controller
        .post(
            &format!("/api/server-invites/{}", invite["code"].as_str().unwrap()),
            json!({}),
        )
        .await;
    let call = start(&owner, voice).await;
    start(&controller, voice).await;
    owner
        .patch(&format!("/api/calls/{call}/state"), json!({"screen":true}))
        .await;
    cmd(&owner, &call, json!({"action":"offer","enabled":true})).await;
    assert_eq!(
        cmd(&controller, &call, json!({"action":"request","owner_id":owner.id}))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    owner
        .req(
            reqwest::Method::PUT,
            &format!("/api/servers/{sid}/overwrites/{voice}/{sid}"),
            Some(json!({"allow":p::REQUEST_CONTROL,"deny":0})),
        )
        .await;
    assert_eq!(
        cmd(&controller, &call, json!({"action":"request","owner_id":owner.id}))
            .await
            .0,
        StatusCode::OK
    );
    let (_, view) = owner.get(&format!("/api/calls/{call}/remote-control")).await;
    let id = view["shares"][0]["request_id"].as_str().unwrap();
    accept(&owner, &call, id).await;
    owner
        .req(
            reqwest::Method::PUT,
            &format!("/api/servers/{sid}/overwrites/{voice}/{sid}"),
            Some(json!({"allow":0,"deny":p::REQUEST_CONTROL})),
        )
        .await;
    assert_eq!(cmd(&controller, &call, movement(id, 1)).await.0, StatusCode::FORBIDDEN);
    assert_eq!(
        cmd(&owner, &call, json!({"action":"heartbeat","epoch":1})).await.0,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn changes_are_pushed_and_the_heartbeat_returns_the_owner_view() {
    let s = TestServer::start().await;
    let (users, conversation) = s.group("pushctrl", 3).await;
    let (owner, controller, viewer) = (&users[0], &users[1], &users[2]);
    let call = start(owner, &conversation).await;
    start(controller, &conversation).await;
    start(viewer, &conversation).await;
    let (mut owner_gw, _) = Gateway::connect(&s, &owner.token).await;
    let (mut viewer_gw, _) = Gateway::connect(&s, &viewer.token).await;

    // Offer and request reach everyone in the call without polling.
    let id = request(owner, controller, &call).await;
    assert_eq!(
        viewer_gw.next_event("REMOTE_CONTROL_UPDATE").await["call_id"],
        call.as_str()
    );
    assert_eq!(
        owner_gw.next_event("REMOTE_CONTROL_UPDATE").await["call_id"],
        call.as_str()
    );

    let (status, beat) = cmd(owner, &call, json!({"action":"heartbeat","epoch":3})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        beat["share"]["request_id"],
        id.as_str(),
        "pending request in the heartbeat"
    );
    assert_eq!(beat["share"]["accepted"], false);

    accept(owner, &call, &id).await;
    let (_, beat) = cmd(owner, &call, json!({"action":"heartbeat","epoch":3})).await;
    assert_eq!(beat["share"]["accepted"], true);
    assert_eq!(cmd(controller, &call, movement(&id, 1)).await.0, StatusCode::OK);
    let packet = owner_gw.next_event("REMOTE_CONTROL_INPUT").await;
    assert_eq!(packet["epoch"], 3, "inputs carry the epoch of the last heartbeat");

    // Right clicks are refused: their menus are windows the guard blocks.
    let right =
        json!({"action":"input","request_id":id,"sequence":2,"input":{"kind":"click","x":0.5,"y":0.5,"button":1}});
    assert_eq!(cmd(controller, &call, right).await.0, StatusCode::FORBIDDEN);

    // Leaving revokes at once, even with a fresh cached authorization.
    controller.post(&format!("/api/calls/{call}/leave"), json!({})).await;
    assert_eq!(cmd(controller, &call, movement(&id, 3)).await.0, StatusCode::NOT_FOUND);
}
