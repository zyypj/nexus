mod common;

use common::{TestServer, TestUser};
use reqwest::{Method, StatusCode};
use serde_json::json;

#[tokio::test]
async fn register_requires_invite_when_registration_is_private() {
    let s = TestServer::start().await;
    let (status, body) = s
        .raw(
            Method::POST,
            "/api/auth/register",
            None,
            Some(json!({ "username": "joao", "password": "password123" })),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");

    let (status, _) = s
        .raw(
            Method::POST,
            "/api/auth/register",
            None,
            Some(json!({ "username": "joao", "password": "password123", "invite_code": "NEXUS-AAAA-BBBB" })),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn public_registration_flag_allows_signup_without_invite() {
    let s = TestServer::start_with(|c| c.allow_public_registration = true).await;
    let (status, body) = s
        .raw(
            Method::POST,
            "/api/auth/register",
            None,
            Some(json!({ "username": "joao", "password": "password123" })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
}

#[tokio::test]
async fn invite_respects_max_uses_and_expiry() {
    let s = TestServer::start().await;
    let invite = nexus_server::invites::create(&s.state.db, "NEXUS", Some(2), None, None)
        .await
        .unwrap();
    for (i, expected) in [
        (0, StatusCode::CREATED),
        (1, StatusCode::CREATED),
        (2, StatusCode::FORBIDDEN),
    ] {
        let (status, body) = s
            .raw(
                Method::POST,
                "/api/auth/register",
                None,
                Some(json!({ "username": format!("user{i}"), "password": "password123", "invite_code": invite.code.to_lowercase() })),
            )
            .await;
        assert_eq!(status, expected, "use #{i}: {body}");
    }

    let expired = nexus_server::invites::create(&s.state.db, "NEXUS", None, Some(1), None)
        .await
        .unwrap();
    let (status, _) = s
        .raw(
            Method::POST,
            "/api/auth/register",
            None,
            Some(json!({ "username": "late", "password": "password123", "invite_code": expired.code })),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let revoked = nexus_server::invites::create(&s.state.db, "NEXUS", None, None, None)
        .await
        .unwrap();
    nexus_server::invites::revoke(&s.state.db, &revoked.code).await.unwrap();
    let (status, _) = s
        .raw(
            Method::POST,
            "/api/auth/register",
            None,
            Some(json!({ "username": "revoked", "password": "password123", "invite_code": revoked.code })),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn failed_signup_does_not_burn_invite() {
    let s = TestServer::start().await;
    s.register("taken").await;
    let code = s.invite().await;
    let (status, _) = s
        .raw(
            Method::POST,
            "/api/auth/register",
            None,
            Some(json!({ "username": "taken", "password": "password123", "invite_code": code })),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (status, body) = s
        .raw(
            Method::POST,
            "/api/auth/register",
            None,
            Some(json!({ "username": "fresh", "password": "password123", "invite_code": code })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
}

#[tokio::test]
async fn first_user_is_admin_and_password_is_hashed() {
    let s = TestServer::start().await;
    let first = s.register("first").await;
    let second = s.register("second").await;
    assert_eq!(first.get("/api/users/@me").await.1["is_admin"], true);
    assert_eq!(second.get("/api/users/@me").await.1["is_admin"], false);

    let (hash,): (String,) = sqlx::query_as("SELECT password_hash FROM users WHERE username = 'first'")
        .fetch_one(&s.state.db)
        .await
        .unwrap();
    assert!(hash.starts_with("$argon2id$"));
    assert!(!hash.contains("password123"));
}

#[tokio::test]
async fn validation_rejects_bad_input() {
    let s = TestServer::start().await;
    for body in [
        json!({ "username": "x", "password": "password123" }),
        json!({ "username": "has space", "password": "password123" }),
        json!({ "username": "okname", "password": "short" }),
        json!({ "username": 5, "password": "password123" }),
    ] {
        let mut b = body.clone();
        b["invite_code"] = json!(s.invite().await);
        let (status, resp) = s.raw(Method::POST, "/api/auth/register", None, Some(b)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body} -> {resp}");
        assert!(resp["error"]["code"].is_string());
    }
}

#[tokio::test]
async fn login_logout_and_session_revocation() {
    let s = TestServer::start().await;
    let u = s.register("maria").await;

    let (status, _) = s
        .raw(
            Method::POST,
            "/api/auth/login",
            None,
            Some(json!({ "username": "maria", "password": "wrong-password" })),
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = s
        .raw(
            Method::POST,
            "/api/auth/login",
            None,
            Some(json!({ "username": "nobody", "password": "password123" })),
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, body) = s
        .raw(
            Method::POST,
            "/api/auth/login",
            None,
            Some(json!({ "username": "MARIA", "password": "password123", "device_name": "laptop" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let second = TestUser::from_auth(&s, &body);

    let (_, sessions) = u.get("/api/auth/sessions").await;
    assert_eq!(sessions.as_array().unwrap().len(), 2);

    // Logging out kills the access token immediately, not at expiry.
    assert_eq!(
        second.post("/api/auth/logout", json!({})).await.0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(second.get("/api/users/@me").await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(u.get("/api/users/@me").await.0, StatusCode::OK);
    let (status, _) = s
        .raw(
            Method::POST,
            "/api/auth/refresh",
            None,
            Some(json!({ "refresh_token": second.refresh })),
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn refresh_rotates_and_detects_reuse() {
    let s = TestServer::start().await;
    let u = s.register("pedro").await;

    let (status, body) = s
        .raw(
            Method::POST,
            "/api/auth/refresh",
            None,
            Some(json!({ "refresh_token": u.refresh })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let rotated = TestUser::from_auth(&s, &body);
    assert_ne!(rotated.refresh, u.refresh);
    assert_eq!(rotated.get("/api/users/@me").await.0, StatusCode::OK);

    // Replaying the old refresh token = theft signal: the session dies.
    let (status, _) = s
        .raw(
            Method::POST,
            "/api/auth/refresh",
            None,
            Some(json!({ "refresh_token": u.refresh })),
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(rotated.get("/api/users/@me").await.0, StatusCode::UNAUTHORIZED);
    let (status, _) = s
        .raw(
            Method::POST,
            "/api/auth/refresh",
            None,
            Some(json!({ "refresh_token": rotated.refresh })),
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn disabled_user_is_locked_out() {
    let s = TestServer::start().await;
    let admin = s.register("admin").await;
    let u = s.register("lucas").await;
    assert_eq!(
        admin
            .post(&format!("/api/admin/users/{}/disable", u.id), json!({}))
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(u.get("/api/users/@me").await.0, StatusCode::UNAUTHORIZED);
    let (status, _) = s
        .raw(
            Method::POST,
            "/api/auth/login",
            None,
            Some(json!({ "username": "lucas", "password": "password123" })),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    // Non-admins cannot use admin endpoints.
    let other = s.register("other").await;
    assert_eq!(other.get("/api/admin/users").await.0, StatusCode::FORBIDDEN);
    assert_eq!(
        other.post("/api/admin/invites", json!({})).await.0,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn admin_api_manages_invites() {
    let s = TestServer::start().await;
    let admin = s.register("admin").await;
    let (status, body) = admin
        .post("/api/admin/invites", json!({ "max_uses": 3, "expires_in": "7d" }))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let code = body["code"].as_str().unwrap().to_string();
    assert!(code.starts_with("NEXUS-"));
    let (_, list) = admin.get("/api/admin/invites").await;
    assert!(list.as_array().unwrap().iter().any(|i| i["code"] == code));
    assert_eq!(
        admin.delete(&format!("/api/admin/invites/{code}")).await.0,
        StatusCode::NO_CONTENT
    );
}

#[tokio::test]
async fn password_change_signs_out_other_sessions() {
    let s = TestServer::start().await;
    let u = s.register("ana").await;
    let (_, body) = s
        .raw(
            Method::POST,
            "/api/auth/login",
            None,
            Some(json!({ "username": "ana", "password": "password123" })),
        )
        .await;
    let other = TestUser::from_auth(&s, &body);
    let (status, _) = u
        .req(
            Method::PUT,
            "/api/users/@me/password",
            Some(json!({ "current_password": "password123", "new_password": "new-password-456" })),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(other.get("/api/users/@me").await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(u.get("/api/users/@me").await.0, StatusCode::OK);
}

#[tokio::test]
async fn garbage_tokens_are_rejected() {
    let s = TestServer::start().await;
    for t in ["", "abc", "Bearer", "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0."] {
        let (status, _) = s.raw(Method::GET, "/api/users/@me", Some(t), None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "token {t:?}");
    }
}

#[tokio::test]
async fn rate_limit_blocks_login_bursts() {
    let s = TestServer::start_with(|c| c.rate_limit_enabled = true).await;
    let mut limited = false;
    for _ in 0..15 {
        let (status, _) = s
            .raw(
                Method::POST,
                "/api/auth/login",
                None,
                Some(json!({ "username": "x", "password": "password123" })),
            )
            .await;
        if status == StatusCode::TOO_MANY_REQUESTS {
            limited = true;
            break;
        }
    }
    assert!(limited);
}
