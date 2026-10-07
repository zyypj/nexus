#![allow(dead_code)]

use std::{net::SocketAddr, time::Duration};

use futures_util::{SinkExt, StreamExt};
use nexus_server::{AppState, Config, db, invites};
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, tungstenite::Message};

pub struct TestServer {
    pub base: String,
    pub ws_url: String,
    pub state: AppState,
    pub http: reqwest::Client,
    _dir: tempfile::TempDir,
}

impl TestServer {
    pub async fn start() -> Self {
        Self::start_with(|_| {}).await
    }

    pub async fn start_with(f: impl FnOnce(&mut Config)) -> Self {
        nexus_server::install_crypto_provider();
        let dir = tempfile::tempdir().unwrap();
        let mut config = Config::for_tests(dir.path());
        f(&mut config);
        let pool = db::connect(&config.storage.database_path).await.unwrap();
        let state = AppState::new(config, pool).await.unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = nexus_server::app(state.clone()).into_make_service_with_connect_info::<SocketAddr>();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self {
            base: format!("http://{addr}"),
            ws_url: format!("ws://{addr}/gateway"),
            state,
            http: reqwest::Client::new(),
            _dir: dir,
        }
    }

    pub async fn invite(&self) -> String {
        invites::create(&self.state.db, "NEXUS", Some(1), None, None)
            .await
            .unwrap()
            .code
    }

    pub async fn raw(
        &self,
        method: Method,
        path: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut req = self.http.request(method, format!("{}{}", self.base, path));
        if let Some(t) = token {
            req = req.bearer_auth(t);
        }
        if let Some(b) = body {
            req = req.json(&b);
        }
        let res = req.send().await.unwrap();
        let status = res.status();
        let text = res.text().await.unwrap();
        let value = if text.is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&text).unwrap_or(Value::String(text))
        };
        (status, value)
    }

    pub async fn register(&self, username: &str) -> TestUser {
        let code = self.invite().await;
        let (status, body) = self
            .raw(
                Method::POST,
                "/api/auth/register",
                None,
                Some(json!({ "username": username, "password": "password123", "invite_code": code, "device_name": "test" })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "register {username}: {body}");
        TestUser::from_auth(self, &body)
    }

    pub async fn make_friends(&self, a: &TestUser, b: &TestUser) {
        let (s, body) = a.post("/api/friends/requests", json!({ "username": b.username })).await;
        assert_eq!(s, StatusCode::CREATED, "{body}");
        let id = body["request"]["id"].as_str().unwrap().to_string();
        let (s, body) = b.post(&format!("/api/friends/requests/{id}/accept"), json!({})).await;
        assert_eq!(s, StatusCode::OK, "{body}");
    }

    pub async fn dm(&self, a: &TestUser, b: &TestUser) -> String {
        self.make_friends(a, b).await;
        let (s, body) = a.post("/api/conversations/dm", json!({ "user_id": b.id })).await;
        assert!(s.is_success(), "{body}");
        body["id"].as_str().unwrap().to_string()
    }

    /// Creates `n` users that are all friends with the first one, and a group of all of them.
    pub async fn group(&self, prefix: &str, n: usize) -> (Vec<TestUser>, String) {
        let mut users = Vec::new();
        for i in 0..n {
            users.push(self.register(&format!("{prefix}{i}")).await);
        }
        for u in &users[1..] {
            self.make_friends(&users[0], u).await;
        }
        let ids: Vec<&str> = users[1..].iter().map(|u| u.id.as_str()).collect();
        let (s, body) = users[0]
            .post("/api/conversations/group", json!({ "name": prefix, "member_ids": ids }))
            .await;
        assert_eq!(s, StatusCode::CREATED, "{body}");
        let gid = body["id"].as_str().unwrap().to_string();
        (users, gid)
    }
}

pub struct TestUser {
    pub id: String,
    pub username: String,
    pub token: String,
    pub refresh: String,
    pub base: String,
    pub http: reqwest::Client,
}

impl TestUser {
    pub fn from_auth(server: &TestServer, body: &Value) -> Self {
        Self {
            id: body["user"]["id"].as_str().unwrap().to_string(),
            username: body["user"]["username"].as_str().unwrap().to_string(),
            token: body["access_token"].as_str().unwrap().to_string(),
            refresh: body["refresh_token"].as_str().unwrap().to_string(),
            base: server.base.clone(),
            http: server.http.clone(),
        }
    }

    pub async fn req(&self, method: Method, path: &str, body: Option<Value>) -> (StatusCode, Value) {
        let mut req = self
            .http
            .request(method, format!("{}{}", self.base, path))
            .bearer_auth(&self.token);
        if let Some(b) = body {
            req = req.json(&b);
        }
        let res = req.send().await.unwrap();
        let status = res.status();
        let text = res.text().await.unwrap();
        let value = if text.is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&text).unwrap_or(Value::String(text))
        };
        (status, value)
    }

    pub async fn get(&self, path: &str) -> (StatusCode, Value) {
        self.req(Method::GET, path, None).await
    }
    pub async fn post(&self, path: &str, body: Value) -> (StatusCode, Value) {
        self.req(Method::POST, path, Some(body)).await
    }
    pub async fn patch(&self, path: &str, body: Value) -> (StatusCode, Value) {
        self.req(Method::PATCH, path, Some(body)).await
    }
    pub async fn put(&self, path: &str) -> (StatusCode, Value) {
        self.req(Method::PUT, path, None).await
    }
    pub async fn delete(&self, path: &str) -> (StatusCode, Value) {
        self.req(Method::DELETE, path, None).await
    }

    pub async fn upload(&self, path: &str, file_name: &str, data: Vec<u8>) -> (StatusCode, Value) {
        let part = reqwest::multipart::Part::bytes(data).file_name(file_name.to_string());
        let form = reqwest::multipart::Form::new().part("file", part);
        let res = self
            .http
            .post(format!("{}{}", self.base, path))
            .bearer_auth(&self.token)
            .multipart(form)
            .send()
            .await
            .unwrap();
        let status = res.status();
        let text = res.text().await.unwrap();
        (status, serde_json::from_str(&text).unwrap_or(Value::String(text)))
    }
}

pub type Ws = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

pub struct Gateway {
    pub ws: Ws,
}

impl Gateway {
    /// Connects, identifies and returns the READY payload.
    pub async fn connect(server: &TestServer, token: &str) -> (Self, Value) {
        let (ws, _) = tokio_tungstenite::connect_async(&server.ws_url).await.unwrap();
        let mut gw = Self { ws };
        let hello = gw.next_any().await;
        assert_eq!(hello["t"], "HELLO");
        gw.send(json!({ "op": "IDENTIFY", "d": { "token": token } })).await;
        let ready = gw.next_event("READY").await;
        (gw, ready)
    }

    pub async fn send(&mut self, v: Value) {
        self.ws.send(Message::Text(v.to_string().into())).await.unwrap();
    }

    pub async fn next_any(&mut self) -> Value {
        loop {
            let msg = tokio::time::timeout(Duration::from_secs(5), self.ws.next())
                .await
                .expect("timed out waiting for gateway message")
                .expect("gateway closed")
                .expect("gateway error");
            match msg {
                Message::Text(t) => return serde_json::from_str(&t).unwrap(),
                Message::Close(frame) => panic!("gateway closed: {frame:?}"),
                _ => continue,
            }
        }
    }

    /// Waits for the given event, skipping others; returns its `d`.
    pub async fn next_event(&mut self, name: &str) -> Value {
        loop {
            let v = self.next_any().await;
            if v["t"] == name {
                return v["d"].clone();
            }
        }
    }

    /// Asserts the event does not arrive within `ms`.
    pub async fn assert_no_event(&mut self, name: &str, ms: u64) {
        let deadline = tokio::time::Instant::now() + Duration::from_millis(ms);
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return;
            }
            match tokio::time::timeout(remaining, self.ws.next()).await {
                Err(_) => return,
                Ok(Some(Ok(Message::Text(t)))) => {
                    let v: Value = serde_json::from_str(&t).unwrap();
                    assert_ne!(v["t"], name, "unexpected {name}: {v}");
                }
                Ok(Some(Ok(_))) => {}
                Ok(_) => return,
            }
        }
    }

    pub async fn close(mut self) {
        let _ = self.ws.close(None).await;
    }
}
