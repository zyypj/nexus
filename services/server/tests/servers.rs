//! Servers (guilds): structure, invites, channels, roles, permissions,
//! moderation and voice channels.

mod common;

use common::{Gateway, TestServer, TestUser};
use nexus_server::{livekit, permissions as p};
use reqwest::StatusCode;
use serde_json::{Value, json};

async fn create_server(owner: &TestUser, name: &str) -> Value {
    let (status, view) = owner.post("/api/servers", json!({ "name": name })).await;
    assert_eq!(status, StatusCode::CREATED, "{view}");
    view
}

fn channel<'a>(view: &'a Value, name: &str) -> &'a Value {
    view["channels"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == name)
        .unwrap_or_else(|| panic!("channel {name} not in {view}"))
}

fn has_channel(view: &Value, name: &str) -> bool {
    view["channels"].as_array().unwrap().iter().any(|c| c["name"] == name)
}

/// Creates an invite and makes `user` join; returns the joined view.
async fn join(owner: &TestUser, server_id: &str, user: &TestUser) -> Value {
    let (status, inv) = owner
        .post(&format!("/api/servers/{server_id}/invites"), json!({}))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{inv}");
    let code = inv["code"].as_str().unwrap();
    let (status, view) = user.post(&format!("/api/server-invites/{code}"), json!({})).await;
    assert_eq!(status, StatusCode::OK, "{view}");
    view
}

async fn create_role(owner: &TestUser, server_id: &str, name: &str, permissions: i64) -> String {
    let (status, role) = owner
        .post(
            &format!("/api/servers/{server_id}/roles"),
            json!({ "name": name, "permissions": permissions, "color": 0x5b73f7 }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{role}");
    role["id"].as_str().unwrap().to_string()
}

async fn set_roles(actor: &TestUser, server_id: &str, user_id: &str, roles: &[&str]) -> StatusCode {
    actor
        .patch(
            &format!("/api/servers/{server_id}/members/{user_id}"),
            json!({ "role_ids": roles }),
        )
        .await
        .0
}

#[tokio::test]
async fn new_server_has_default_layout_and_appears_in_ready() {
    let s = TestServer::start().await;
    let owner = s.register("dono").await;
    let view = create_server(&owner, "Os Amigos").await;
    assert_eq!(view["name"], "Os Amigos");
    assert_eq!(view["owner_id"], owner.id);
    assert_eq!(view["permissions"], p::ALL);
    assert_eq!(view["categories"].as_array().unwrap().len(), 2);
    assert_eq!(channel(&view, "geral")["kind"], "text");
    assert_eq!(channel(&view, "Geral")["kind"], "voice");
    let roles = view["roles"].as_array().unwrap();
    assert_eq!(roles.len(), 1);
    assert_eq!(roles[0]["id"], view["id"], "@everyone has the server id");

    let (_, ready) = Gateway::connect(&s, &owner.token).await;
    let servers = ready["servers"].as_array().unwrap();
    assert_eq!(servers.len(), 1);
    assert_eq!(servers[0]["id"], view["id"]);
    // Server channels are not DMs: they stay out of the conversation list.
    assert!(ready["conversations"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn invites_join_messages_and_events() {
    let s = TestServer::start().await;
    let owner = s.register("anfitriao").await;
    let guest = s.register("convidado").await;
    let outsider = s.register("intruso").await;
    let view = create_server(&owner, "Clube").await;
    let sid = view["id"].as_str().unwrap();
    let geral = channel(&view, "geral")["id"].as_str().unwrap().to_string();

    // Outsiders cannot see or post in the channel.
    let (status, _) = outsider
        .post(
            &format!("/api/conversations/{geral}/messages"),
            json!({ "content": "oi" }),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Preview, then join; the owner hears about it.
    let (mut owner_gw, _) = Gateway::connect(&s, &owner.token).await;
    let (_, inv) = owner
        .post(&format!("/api/servers/{sid}/invites"), json!({ "max_uses": 1 }))
        .await;
    let code = inv["code"].as_str().unwrap();
    let (status, preview) = guest.get(&format!("/api/server-invites/{code}")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(preview["name"], "Clube");
    assert_eq!(preview["member_count"], 1);
    let (status, joined) = guest.post(&format!("/api/server-invites/{code}"), json!({})).await;
    assert_eq!(status, StatusCode::OK, "{joined}");
    assert_eq!(joined["members"].as_array().unwrap().len(), 2);
    let update = owner_gw.next_event("SERVER_UPDATE").await;
    assert_eq!(update["members"].as_array().unwrap().len(), 2);
    // max_uses = 1: the code is spent.
    let (status, _) = outsider.post(&format!("/api/server-invites/{code}"), json!({})).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Channel messages reach members through the gateway.
    let (status, msg) = guest
        .post(
            &format!("/api/conversations/{geral}/messages"),
            json!({ "content": "olá servidor" }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{msg}");
    let ev = owner_gw.next_event("MESSAGE_CREATE").await;
    assert_eq!(ev["content"], "olá servidor");
    assert_eq!(ev["conversation_id"], geral);
    let (status, history) = owner.get(&format!("/api/conversations/{geral}/messages")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(history.as_array().unwrap().len(), 1);

    // Unread + ack for channels.
    let (_, view) = owner.get(&format!("/api/servers/{sid}")).await;
    assert_eq!(channel(&view, "geral")["unread_count"], 1);
    let (status, _) = owner
        .post(
            &format!("/api/conversations/{geral}/ack"),
            json!({ "message_id": msg["id"] }),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_, view) = owner.get(&format!("/api/servers/{sid}")).await;
    assert_eq!(channel(&view, "geral")["unread_count"], 0);

    // A new member does not start with old messages unread.
    let late = s.register("atrasado").await;
    let view = join(&owner, sid, &late).await;
    assert_eq!(channel(&view, "geral")["unread_count"], 0);

    // Voice channels have no chat.
    let voice = channel(&view, "Geral")["id"].as_str().unwrap().to_string();
    let (status, _) = guest
        .post(
            &format!("/api/conversations/{voice}/messages"),
            json!({ "content": "x" }),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn private_channels_follow_roles_and_overwrites() {
    let s = TestServer::start().await;
    let owner = s.register("chefe").await;
    let member = s.register("membro").await;
    let view = create_server(&owner, "Privado").await;
    let sid = view["id"].as_str().unwrap().to_string();
    join(&owner, &sid, &member).await;

    let (status, _) = owner
        .post(
            &format!("/api/servers/{sid}/channels"),
            json!({ "name": "Só Staff", "kind": "text" }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let (_, view) = owner.get(&format!("/api/servers/{sid}")).await;
    let staff_chan = channel(&view, "só-staff")["id"].as_str().unwrap().to_string();
    let staff = create_role(&owner, &sid, "Staff", 0).await;
    // Hidden for @everyone, visible for Staff.
    for (role, allow, deny) in [(&sid, 0, p::VIEW_CHANNEL), (&staff, p::VIEW_CHANNEL, 0)] {
        let (status, body) = owner
            .req(
                reqwest::Method::PUT,
                &format!("/api/servers/{sid}/overwrites/{staff_chan}/{role}"),
                Some(json!({ "allow": allow, "deny": deny })),
            )
            .await;
        assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    }
    let (_, mview) = member.get(&format!("/api/servers/{sid}")).await;
    assert!(!has_channel(&mview, "só-staff"));
    let (status, _) = member
        .post(
            &format!("/api/conversations/{staff_chan}/messages"),
            json!({ "content": "?" }),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "hidden channels do not exist for them");

    // The member's gateway gets the channel once they have the role.
    let (mut gw, _) = Gateway::connect(&s, &member.token).await;
    assert_eq!(
        set_roles(&owner, &sid, &member.id, &[&staff]).await,
        StatusCode::NO_CONTENT
    );
    let update = gw.next_event("SERVER_UPDATE").await;
    assert!(has_channel(&update, "só-staff"));
    let (status, _) = member
        .post(
            &format!("/api/conversations/{staff_chan}/messages"),
            json!({ "content": "entrei" }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);

    // Read-only for @everyone in #geral.
    let geral = channel(&update, "geral")["id"].as_str().unwrap().to_string();
    owner
        .req(
            reqwest::Method::PUT,
            &format!("/api/servers/{sid}/overwrites/{geral}/{sid}"),
            Some(json!({ "allow": 0, "deny": p::SEND_MESSAGES })),
        )
        .await;
    assert_eq!(set_roles(&owner, &sid, &member.id, &[]).await, StatusCode::NO_CONTENT);
    let (status, _) = member
        .post(
            &format!("/api/conversations/{geral}/messages"),
            json!({ "content": "x" }),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (_, mview) = member.get(&format!("/api/servers/{sid}")).await;
    assert_eq!(
        channel(&mview, "geral")["permissions"].as_i64().unwrap() & p::SEND_MESSAGES,
        0
    );
}

#[tokio::test]
async fn hierarchy_kick_ban_and_grants() {
    let s = TestServer::start().await;
    let owner = s.register("rei").await;
    let modr = s.register("moderador").await;
    let pleb = s.register("plebeu").await;
    let other_mod = s.register("outromod").await;
    let view = create_server(&owner, "Reino").await;
    let sid = view["id"].as_str().unwrap().to_string();
    for u in [&modr, &pleb, &other_mod] {
        join(&owner, &sid, u).await;
    }
    let mod_role = create_role(&owner, &sid, "Mod", p::KICK_MEMBERS | p::BAN_MEMBERS | p::MANAGE_ROLES).await;
    assert_eq!(
        set_roles(&owner, &sid, &modr.id, &[&mod_role]).await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        set_roles(&owner, &sid, &other_mod.id, &[&mod_role]).await,
        StatusCode::NO_CONTENT
    );

    // Cannot hand out what you do not have, nor touch equal/higher members.
    let (status, _) = modr
        .post(
            &format!("/api/servers/{sid}/roles"),
            json!({ "name": "Admin", "permissions": p::ADMINISTRATOR }),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = modr
        .delete(&format!("/api/servers/{sid}/members/{}", other_mod.id))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "same rank");
    let (status, _) = modr.delete(&format!("/api/servers/{sid}/members/{}", owner.id)).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "owner");
    assert_eq!(
        set_roles(&modr, &sid, &modr.id, &[]).await,
        StatusCode::FORBIDDEN,
        "cannot remove a role at your own top"
    );

    // Kick: removed and told so.
    let (mut pleb_gw, _) = Gateway::connect(&s, &pleb.token).await;
    let (status, _) = modr.delete(&format!("/api/servers/{sid}/members/{}", pleb.id)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let del = pleb_gw.next_event("SERVER_DELETE").await;
    assert_eq!(del["id"], sid);
    let (status, _) = pleb.get(&format!("/api/servers/{sid}")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Ban: cannot rejoin until unbanned.
    join(&owner, &sid, &pleb).await;
    let (status, _) = modr
        .req(
            reqwest::Method::PUT,
            &format!("/api/servers/{sid}/bans/{}", pleb.id),
            Some(json!({ "reason": "spam" })),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_, inv) = owner.post(&format!("/api/servers/{sid}/invites"), json!({})).await;
    let code = inv["code"].as_str().unwrap();
    let (status, _) = pleb.post(&format!("/api/server-invites/{code}"), json!({})).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (_, bans) = owner.get(&format!("/api/servers/{sid}/bans")).await;
    assert_eq!(bans[0]["reason"], "spam");
    let (status, _) = modr.delete(&format!("/api/servers/{sid}/bans/{}", pleb.id)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = pleb.post(&format!("/api/server-invites/{code}"), json!({})).await;
    assert_eq!(status, StatusCode::OK);

    // The owner cannot leave without transferring.
    let (status, _) = owner.delete(&format!("/api/servers/{sid}/members/@me")).await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (status, _) = owner
        .post(&format!("/api/servers/{sid}/transfer"), json!({ "user_id": modr.id }))
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = owner.delete(&format!("/api/servers/{sid}/members/@me")).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn voice_channels_respect_connect_speak_and_video() {
    let s = TestServer::start().await;
    let owner = s.register("dj").await;
    let listener = s.register("ouvinte").await;
    let view = create_server(&owner, "Rádio").await;
    let sid = view["id"].as_str().unwrap().to_string();
    let voice = channel(&view, "Geral")["id"].as_str().unwrap().to_string();
    let text = channel(&view, "geral")["id"].as_str().unwrap().to_string();
    join(&owner, &sid, &listener).await;

    let (status, _) = owner.post(&format!("/api/conversations/{text}/call"), json!({})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "no calls in text channels");

    // @everyone may connect but not speak nor share video here.
    owner
        .req(
            reqwest::Method::PUT,
            &format!("/api/servers/{sid}/overwrites/{voice}/{sid}"),
            Some(json!({ "allow": 0, "deny": p::SPEAK | p::VIDEO })),
        )
        .await;
    let (status, owner_join) = owner.post(&format!("/api/conversations/{voice}/call"), json!({})).await;
    assert!(status.is_success(), "{owner_join}");
    let (status, join) = listener
        .post(&format!("/api/conversations/{voice}/call"), json!({}))
        .await;
    assert!(status.is_success(), "{join}");
    let cfg = s.state.config.livekit.as_ref().unwrap();
    let grant = |j: &Value| {
        livekit::decode(cfg, j["livekit_token"].as_str().unwrap())
            .unwrap()
            .video
    };
    assert_eq!(
        grant(&owner_join).can_publish_sources.len(),
        4,
        "owner keeps everything"
    );
    let g = grant(&join);
    assert_eq!(g.can_publish, Some(false));
    assert!(g.can_publish_sources.is_empty());
    assert_eq!(join["call"]["participants"].as_array().unwrap().len(), 2);

    // No CONNECT: no token at all.
    owner
        .req(
            reqwest::Method::PUT,
            &format!("/api/servers/{sid}/overwrites/{voice}/{sid}"),
            Some(json!({ "allow": 0, "deny": p::CONNECT })),
        )
        .await;
    let other = s.register("barrado").await;
    join_server(&owner, &sid, &other).await;
    let (status, _) = other.post(&format!("/api/conversations/{voice}/call"), json!({})).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

async fn join_server(owner: &TestUser, sid: &str, u: &TestUser) {
    join(owner, sid, u).await;
}

#[tokio::test]
async fn deleting_a_server_removes_it_for_everyone() {
    let s = TestServer::start().await;
    let owner = s.register("criador").await;
    let member = s.register("visitante").await;
    let view = create_server(&owner, "Temporário").await;
    let sid = view["id"].as_str().unwrap().to_string();
    let geral = channel(&view, "geral")["id"].as_str().unwrap().to_string();
    join(&owner, &sid, &member).await;
    let (status, _) = member.delete(&format!("/api/servers/{sid}")).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "only the owner");
    let (mut gw, _) = Gateway::connect(&s, &member.token).await;
    let (status, _) = owner.delete(&format!("/api/servers/{sid}")).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(gw.next_event("SERVER_DELETE").await["id"], sid);
    let (status, _) = owner.get(&format!("/api/conversations/{geral}/messages")).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "channels are gone");
}
