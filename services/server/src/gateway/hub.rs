//! Registry of live gateway connections. Events are serialized once and the
//! same buffer is shared by every recipient.

use std::{
    collections::HashMap,
    sync::{
        RwLock,
        atomic::{AtomicU64, Ordering},
    },
};

use axum::extract::ws::Utf8Bytes;
use serde::Serialize;
use tokio::sync::mpsc;

/// Per-connection outbound queue. A client that falls this far behind is
/// disconnected instead of letting memory grow without bound.
pub const OUTBOUND_QUEUE: usize = 256;

pub enum Outbound {
    Event(Utf8Bytes),
    /// Close the socket (logout, account disabled, slow consumer).
    Close(&'static str),
}

struct Conn {
    session_id: String,
    tx: mpsc::Sender<Outbound>,
}

#[derive(Default)]
pub struct Hub {
    users: RwLock<HashMap<String, HashMap<u64, Conn>>>,
    next_id: AtomicU64,
}

#[derive(Serialize)]
struct Envelope<'a, T: Serialize> {
    t: &'a str,
    d: &'a T,
}

pub fn encode<T: Serialize>(event: &str, data: &T) -> Utf8Bytes {
    serde_json::to_string(&Envelope { t: event, d: data })
        .unwrap_or_else(|_| String::from("{}"))
        .into()
}

impl Hub {
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns the connection id and whether this is the user's first connection.
    pub fn register(&self, user_id: &str, session_id: &str, tx: mpsc::Sender<Outbound>) -> (u64, bool) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut users = self.users.write().unwrap_or_else(|e| e.into_inner());
        let conns = users.entry(user_id.to_string()).or_default();
        let first = conns.is_empty();
        conns.insert(
            id,
            Conn {
                session_id: session_id.to_string(),
                tx,
            },
        );
        (id, first)
    }

    /// Returns true when the user has no connections left.
    pub fn unregister(&self, user_id: &str, conn_id: u64) -> bool {
        let mut users = self.users.write().unwrap_or_else(|e| e.into_inner());
        let Some(conns) = users.get_mut(user_id) else {
            return false;
        };
        if conns.remove(&conn_id).is_none() {
            return false;
        }
        if conns.is_empty() {
            users.remove(user_id);
            true
        } else {
            false
        }
    }

    pub fn is_online(&self, user_id: &str) -> bool {
        self.users
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(user_id)
            .is_some_and(|c| !c.is_empty())
    }

    pub fn online_users(&self) -> Vec<String> {
        self.users
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .keys()
            .cloned()
            .collect()
    }

    pub fn connection_count(&self) -> usize {
        self.users
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .map(HashMap::len)
            .sum()
    }

    pub fn send_raw<'a>(&self, user_ids: impl IntoIterator<Item = &'a str>, payload: &Utf8Bytes) {
        let users = self.users.read().unwrap_or_else(|e| e.into_inner());
        for uid in user_ids {
            if let Some(conns) = users.get(uid) {
                for conn in conns.values() {
                    if conn.tx.try_send(Outbound::Event(payload.clone())).is_err() {
                        // Queue full: the connection task sees the close and drops it.
                        let _ = conn.tx.try_send(Outbound::Close("slow consumer"));
                    }
                }
            }
        }
    }

    pub fn send<'a, T: Serialize>(&self, user_ids: impl IntoIterator<Item = &'a str>, event: &str, data: &T) {
        self.send_raw(user_ids, &encode(event, data));
    }

    pub fn send_one<T: Serialize>(&self, user_id: &str, event: &str, data: &T) {
        self.send([user_id], event, data);
    }

    pub fn close_session(&self, session_id: &str, reason: &'static str) {
        let users = self.users.read().unwrap_or_else(|e| e.into_inner());
        for conns in users.values() {
            for conn in conns.values().filter(|c| c.session_id == session_id) {
                let _ = conn.tx.try_send(Outbound::Close(reason));
            }
        }
    }

    pub fn close_user(&self, user_id: &str, reason: &'static str) {
        let users = self.users.read().unwrap_or_else(|e| e.into_inner());
        if let Some(conns) = users.get(user_id) {
            for conn in conns.values() {
                let _ = conn.tx.try_send(Outbound::Close(reason));
            }
        }
    }
}
