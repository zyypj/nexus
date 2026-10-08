mod common;

use common::TestServer;
use reqwest::StatusCode;
use serde_json::json;

#[tokio::test]
async fn friend_request_flow() {
    let s = TestServer::start().await;
    let a = s.register("joao").await;
    let b = s.register("pedro").await;

    assert_eq!(
        a.post("/api/friends/requests", json!({ "username": "joao" })).await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        a.post("/api/friends/requests", json!({ "username": "ghost" })).await.0,
        StatusCode::NOT_FOUND
    );
    let (status, body) = a.post("/api/friends/requests", json!({ "username": "pedro" })).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(
        a.post("/api/friends/requests", json!({ "username": "pedro" })).await.0,
        StatusCode::CONFLICT
    );
    let rid = body["request"]["id"].as_str().unwrap();
    // Only the recipient can accept.
    assert_eq!(
        a.post(&format!("/api/friends/requests/{rid}/accept"), json!({}))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    let (_, rel) = b.get("/api/relationships").await;
    assert_eq!(rel["incoming"].as_array().unwrap().len(), 1);
    assert_eq!(
        b.post(&format!("/api/friends/requests/{rid}/accept"), json!({}))
            .await
            .0,
        StatusCode::OK
    );
    let (_, rel) = a.get("/api/relationships").await;
    assert_eq!(rel["friends"][0]["user"]["username"], "pedro");
    assert!(rel["outgoing"].as_array().unwrap().is_empty());

    assert_eq!(
        a.delete(&format!("/api/friends/{}", b.id)).await.0,
        StatusCode::NO_CONTENT
    );
    let (_, rel) = b.get("/api/relationships").await;
    assert!(rel["friends"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn mutual_requests_auto_accept() {
    let s = TestServer::start().await;
    let a = s.register("ana").await;
    let b = s.register("bia").await;
    a.post("/api/friends/requests", json!({ "username": "bia" })).await;
    let (status, body) = b.post("/api/friends/requests", json!({ "username": "ana" })).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "accepted");
}

#[tokio::test]
async fn blocking_cuts_contact() {
    let s = TestServer::start().await;
    let a = s.register("carlos").await;
    let b = s.register("marcos").await;
    let dm = s.dm(&a, &b).await;
    assert!(
        b.post(&format!("/api/conversations/{dm}/messages"), json!({ "content": "oi" }))
            .await
            .0
            .is_success()
    );

    assert_eq!(a.put(&format!("/api/blocks/{}", b.id)).await.0, StatusCode::NO_CONTENT);
    let (_, rel) = a.get("/api/relationships").await;
    assert!(rel["friends"].as_array().unwrap().is_empty());
    assert_eq!(rel["blocked"][0]["id"], b.id.as_str());

    // Blocked user cannot message, react, call or befriend again.
    assert_eq!(
        b.post(
            &format!("/api/conversations/{dm}/messages"),
            json!({ "content": "oi?" })
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        b.post(&format!("/api/conversations/{dm}/call"), json!({})).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        b.post("/api/friends/requests", json!({ "username": "carlos" })).await.0,
        StatusCode::FORBIDDEN
    );
    // Unblocking restores messaging in the existing DM.
    assert_eq!(
        a.delete(&format!("/api/blocks/{}", b.id)).await.0,
        StatusCode::NO_CONTENT
    );
    assert!(
        b.post(
            &format!("/api/conversations/{dm}/messages"),
            json!({ "content": "voltei" })
        )
        .await
        .0
        .is_success()
    );
}

#[tokio::test]
async fn dm_requires_friendship_and_is_unique() {
    let s = TestServer::start().await;
    let a = s.register("u1").await;
    let b = s.register("u2").await;
    assert_eq!(
        a.post("/api/conversations/dm", json!({ "user_id": b.id })).await.0,
        StatusCode::FORBIDDEN
    );
    let dm1 = s.dm(&a, &b).await;
    let (_, again) = b.post("/api/conversations/dm", json!({ "user_id": a.id })).await;
    assert_eq!(again["id"], dm1.as_str());
}

#[tokio::test]
async fn non_members_cannot_see_conversations() {
    let s = TestServer::start().await;
    let a = s.register("a1").await;
    let b = s.register("b1").await;
    let outsider = s.register("intruso").await;
    let dm = s.dm(&a, &b).await;
    a.post(
        &format!("/api/conversations/{dm}/messages"),
        json!({ "content": "segredo" }),
    )
    .await;

    for path in [
        format!("/api/conversations/{dm}"),
        format!("/api/conversations/{dm}/messages"),
    ] {
        assert_eq!(outsider.get(&path).await.0, StatusCode::NOT_FOUND, "{path}");
    }
    assert_eq!(
        outsider
            .post(&format!("/api/conversations/{dm}/messages"), json!({ "content": "x" }))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        outsider
            .upload(&format!("/api/conversations/{dm}/attachments"), "a.txt", b"hi".to_vec())
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        outsider
            .post(&format!("/api/conversations/{dm}/call"), json!({}))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn message_lifecycle() {
    let s = TestServer::start().await;
    let a = s.register("autor").await;
    let b = s.register("leitor").await;
    let dm = s.dm(&a, &b).await;
    let base = format!("/api/conversations/{dm}/messages");

    assert_eq!(
        a.post(&base, json!({ "content": "   " })).await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        a.post(&base, json!({ "content": "x".repeat(4001) })).await.0,
        StatusCode::BAD_REQUEST
    );

    let (status, m1) = a.post(&base, json!({ "content": "olá **mundo**" })).await;
    assert_eq!(status, StatusCode::CREATED);
    let m1_id = m1["id"].as_str().unwrap();

    let (_, reply) = b
        .post(&base, json!({ "content": "resposta", "reply_to_id": m1_id }))
        .await;
    assert_eq!(reply["reply_to"]["id"], m1_id);
    assert_eq!(reply["reply_to"]["content"], "olá **mundo**");

    // Only the author edits.
    assert_eq!(
        b.patch(&format!("{base}/{m1_id}"), json!({ "content": "hack" }))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let (_, edited) = a
        .patch(&format!("{base}/{m1_id}"), json!({ "content": "editado" }))
        .await;
    assert_eq!(edited["content"], "editado");
    assert!(edited["edited_at"].is_i64());

    // Reactions.
    let thumbs = "%F0%9F%91%8D"; // 👍
    assert_eq!(
        b.put(&format!("{base}/{m1_id}/reactions/{thumbs}")).await.0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        a.put(&format!("{base}/{m1_id}/reactions/{thumbs}")).await.0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        a.put(&format!("{base}/{m1_id}/reactions/abc")).await.0,
        StatusCode::BAD_REQUEST
    );
    let (_, history) = a.get(&base).await;
    let first = &history[0];
    assert_eq!(first["reactions"][0]["emoji"], "👍");
    assert_eq!(first["reactions"][0]["user_ids"].as_array().unwrap().len(), 2);
    assert_eq!(
        a.delete(&format!("{base}/{m1_id}/reactions/{thumbs}")).await.0,
        StatusCode::NO_CONTENT
    );

    // Delete: only author; reply loses its reference.
    assert_eq!(b.delete(&format!("{base}/{m1_id}")).await.0, StatusCode::FORBIDDEN);
    assert_eq!(a.delete(&format!("{base}/{m1_id}")).await.0, StatusCode::NO_CONTENT);
    let (_, history) = a.get(&base).await;
    assert_eq!(history.as_array().unwrap().len(), 1);
    assert!(history[0]["reply_to"].is_null());
}

#[tokio::test]
async fn history_pagination_and_unread() {
    let s = TestServer::start().await;
    let a = s.register("emissor").await;
    let b = s.register("receptor").await;
    let dm = s.dm(&a, &b).await;
    let base = format!("/api/conversations/{dm}/messages");
    let mut ids = Vec::new();
    for i in 0..25 {
        let (_, m) = a.post(&base, json!({ "content": format!("msg {i}") })).await;
        ids.push(m["id"].as_str().unwrap().to_string());
    }

    let (_, page) = b.get(&format!("{base}?limit=10")).await;
    let page = page.as_array().unwrap();
    assert_eq!(page.len(), 10);
    assert_eq!(page[9]["content"], "msg 24");
    assert_eq!(page[0]["content"], "msg 15");
    let oldest = page[0]["id"].as_str().unwrap();
    let (_, older) = b.get(&format!("{base}?limit=10&before={oldest}")).await;
    assert_eq!(older[9]["content"], "msg 14");
    let (_, after) = b.get(&format!("{base}?after={}", ids[22])).await;
    assert_eq!(after.as_array().unwrap().len(), 2);

    let (_, conv) = b.get(&format!("/api/conversations/{dm}")).await;
    assert_eq!(conv["unread_count"], 25);
    let (_, conv_a) = a.get(&format!("/api/conversations/{dm}")).await;
    assert_eq!(conv_a["unread_count"], 0, "own messages are read");

    assert_eq!(
        b.post(
            &format!("/api/conversations/{dm}/ack"),
            json!({ "message_id": ids[19] })
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    let (_, conv) = b.get(&format!("/api/conversations/{dm}")).await;
    assert_eq!(conv["unread_count"], 5);
    // The marker never moves backwards.
    b.post(&format!("/api/conversations/{dm}/ack"), json!({ "message_id": ids[2] }))
        .await;
    let (_, conv) = b.get(&format!("/api/conversations/{dm}")).await;
    assert_eq!(conv["unread_count"], 5);
}

#[tokio::test]
async fn groups_membership_rules() {
    let s = TestServer::start().await;
    let (users, gid) = s.group("grp", 3).await;
    let stranger = s.register("estranho").await;

    let (_, conv) = users[1].get(&format!("/api/conversations/{gid}")).await;
    assert_eq!(conv["members"].as_array().unwrap().len(), 3);
    assert_eq!(conv["owner_id"], users[0].id.as_str());

    // Can only add friends.
    assert_eq!(
        users[0]
            .put(&format!("/api/conversations/{gid}/members/{}", stranger.id))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    // Non-owner cannot kick.
    assert_eq!(
        users[1]
            .delete(&format!("/api/conversations/{gid}/members/{}", users[2].id))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    // Rename.
    let (_, renamed) = users[2]
        .patch(&format!("/api/conversations/{gid}"), json!({ "name": "Amigos" }))
        .await;
    assert_eq!(renamed["name"], "Amigos");
    // Owner leaves: ownership passes on.
    assert_eq!(
        users[0]
            .delete(&format!("/api/conversations/{gid}/members/{}", users[0].id))
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        users[0].get(&format!("/api/conversations/{gid}")).await.0,
        StatusCode::NOT_FOUND
    );
    let (_, conv) = users[1].get(&format!("/api/conversations/{gid}")).await;
    assert_eq!(conv["owner_id"], users[1].id.as_str());
    // New owner kicks.
    assert_eq!(
        users[1]
            .delete(&format!("/api/conversations/{gid}/members/{}", users[2].id))
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        users[2].get(&format!("/api/conversations/{gid}/messages")).await.0,
        StatusCode::NOT_FOUND
    );
}

fn png_1x1() -> Vec<u8> {
    vec![
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00,
        0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00,
        0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0xF8, 0xCF, 0xC0, 0xF0, 0x1F, 0x00, 0x05, 0x00, 0x01, 0xFF,
        0x89, 0x99, 0x3D, 0x1D, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ]
}

#[tokio::test]
async fn attachments_upload_download_and_access_control() {
    let s = TestServer::start().await;
    let a = s.register("fotografo").await;
    let b = s.register("amigo").await;
    let dm = s.dm(&a, &b).await;

    let (status, img) = a
        .upload(
            &format!("/api/conversations/{dm}/attachments"),
            "../../etc/foto.png",
            png_1x1(),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{img}");
    assert_eq!(img["content_type"], "image/png");
    assert_eq!(img["width"], 1);
    assert_eq!(img["file_name"], "foto.png");

    // A ".png" that is really HTML is served as an opaque download.
    let (_, fake) = a
        .upload(
            &format!("/api/conversations/{dm}/attachments"),
            "evil.png",
            b"<html><script>alert(1)</script></html>".to_vec(),
        )
        .await;
    assert_ne!(fake["content_type"], "image/png");

    // Someone else cannot attach my pending upload.
    let (status, _) = b
        .post(
            &format!("/api/conversations/{dm}/messages"),
            json!({ "attachment_ids": [img["id"]] }),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, msg) = a
        .post(
            &format!("/api/conversations/{dm}/messages"),
            json!({ "content": "", "attachment_ids": [img["id"], fake["id"]] }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{msg}");
    let url = msg["attachments"][0]["url"].as_str().unwrap().to_string();

    let res = s.http.get(format!("{}{url}", s.base)).send().await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers()["content-type"], "image/png");
    assert_eq!(res.headers()["x-content-type-options"], "nosniff");
    assert_eq!(res.bytes().await.unwrap().to_vec(), png_1x1());

    let fake_url = msg["attachments"][1]["url"].as_str().unwrap();
    let res = s.http.get(format!("{}{fake_url}", s.base)).send().await.unwrap();
    assert_eq!(res.headers()["content-type"], "application/octet-stream");
    assert!(
        res.headers()["content-disposition"]
            .to_str()
            .unwrap()
            .starts_with("attachment")
    );

    // Tampered signature.
    let tampered = url.replace("sig=", "sig=00");
    let res = s.http.get(format!("{}{tampered}", s.base)).send().await.unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);

    // Attachments cannot be reused.
    let (status, _) = a
        .post(
            &format!("/api/conversations/{dm}/messages"),
            json!({ "attachment_ids": [img["id"]] }),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Deleting the message removes the file from disk.
    let (count_before,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM message_attachments")
        .fetch_one(&s.state.db)
        .await
        .unwrap();
    assert_eq!(count_before, 2);
    let mid = msg["id"].as_str().unwrap();
    a.delete(&format!("/api/conversations/{dm}/messages/{mid}")).await;
    let files = std::fs::read_dir(s.state.storage.root().join("files")).unwrap().count();
    assert_eq!(files, 0);
}

#[tokio::test]
async fn upload_size_limit() {
    let s = TestServer::start_with(|c| c.max_upload_size = 1000).await;
    let a = s.register("grande").await;
    let b = s.register("pequeno").await;
    let dm = s.dm(&a, &b).await;
    let (status, _) = a
        .upload(
            &format!("/api/conversations/{dm}/attachments"),
            "big.bin",
            vec![7u8; 5000],
        )
        .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    let tmp = std::fs::read_dir(s.state.storage.root().join("tmp")).unwrap().count();
    assert_eq!(tmp, 0, "temp file cleaned up");
    let (status, _) = a
        .upload(
            &format!("/api/conversations/{dm}/attachments"),
            "ok.bin",
            vec![7u8; 500],
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
}

#[tokio::test]
async fn videos_play_inline_with_range_requests() {
    let s = TestServer::start().await;
    let a = s.register("cineasta").await;
    let b = s.register("plateia").await;
    let dm = s.dm(&a, &b).await;
    // Minimal ISO-BMFF header ("ftyp isom") followed by filler.
    let mut mp4 = vec![
        0x00, 0x00, 0x00, 0x18, b'f', b't', b'y', b'p', b'i', b's', b'o', b'm', 0x00, 0x00, 0x02, 0x00, b'i', b's',
        b'o', b'm', b'i', b's', b'o', b'2',
    ];
    mp4.extend(std::iter::repeat_n(0u8, 4000));
    let (status, att) = a
        .upload(&format!("/api/conversations/{dm}/attachments"), "clipe.mp4", mp4)
        .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(att["content_type"], "video/mp4");
    let (status, msg) = a
        .post(
            &format!("/api/conversations/{dm}/messages"),
            json!({ "content": "", "attachment_ids": [att["id"]] }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{msg}");
    let url = msg["attachments"][0]["url"].as_str().unwrap();
    // What a <video> element sends to start playing / seek.
    let res = s
        .http
        .get(format!("{}{url}", s.base))
        .header("range", "bytes=0-99")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(res.headers()["content-type"], "video/mp4");
    assert!(
        res.headers()["content-disposition"]
            .to_str()
            .unwrap()
            .starts_with("inline")
    );
    assert_eq!(res.bytes().await.unwrap().len(), 100);
}

#[tokio::test]
async fn upload_without_limit() {
    // 0 = no size limit: a file far above the default test limit goes through.
    let s = TestServer::start_with(|c| c.max_upload_size = 0).await;
    let a = s.register("semlimite").await;
    let b = s.register("outro").await;
    let dm = s.dm(&a, &b).await;
    let (status, att) = a
        .upload(
            &format!("/api/conversations/{dm}/attachments"),
            "video.mp4",
            vec![1u8; 3 * 1024 * 1024],
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(att["size"], 3 * 1024 * 1024);
}

#[tokio::test]
async fn upload_refused_when_disk_would_fill() {
    // Asking for more free space than any disk has: every upload is refused
    // and nothing is left behind in tmp/.
    let s = TestServer::start_with(|c| {
        c.max_upload_size = 0;
        c.min_free_disk = u64::MAX / 2;
    })
    .await;
    let a = s.register("discocheio").await;
    let b = s.register("vizinho").await;
    let dm = s.dm(&a, &b).await;
    let (status, body) = a
        .upload(
            &format!("/api/conversations/{dm}/attachments"),
            "x.bin",
            vec![1u8; 1000],
        )
        .await;
    assert_eq!(status, StatusCode::INSUFFICIENT_STORAGE);
    assert_eq!(body["error"]["code"], "insufficient_storage");
    let tmp = std::fs::read_dir(s.state.storage.root().join("tmp")).unwrap().count();
    assert_eq!(tmp, 0);
}

#[tokio::test]
async fn avatar_upload_and_profile_update() {
    let s = TestServer::start().await;
    let a = s.register("perfil").await;
    let (status, me) = a
        .patch("/api/users/@me", json!({ "display_name": "Perfil Legal", "bio": "oi" }))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(me["display_name"], "Perfil Legal");

    let (status, _) = a
        .upload("/api/users/@me/avatar", "a.txt", b"not an image".to_vec())
        .await;
    assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
    let (status, me) = a.upload("/api/users/@me/avatar", "a.png", png_1x1()).await;
    assert_eq!(status, StatusCode::OK);
    let url = me["avatar_url"].as_str().unwrap();
    let res = s.http.get(format!("{}{url}", s.base)).send().await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers()["content-type"], "image/png");
    // Path traversal in avatar names is impossible.
    let res = s
        .http
        .get(format!("{}/api/avatars/..%2F..%2Fnexus.db", s.base))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}
