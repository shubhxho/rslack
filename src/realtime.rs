//! Realtime fan-out over WebSockets.
//!
//! The [`Hub`] maps user id -> open connections. Handlers persist first, then call
//! the `broadcast_*` helpers which look up the audience in SQLite and push JSON events.
use crate::{
    access,
    auth::AuthUser,
    error::{AppError, AppResult},
    state::AppState,
};
use axum::{
    extract::{
        State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, header},
    response::Response,
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        RwLock,
        atomic::{AtomicU64, Ordering},
    },
};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

#[derive(Default)]
pub struct Hub {
    conns: RwLock<HashMap<i64, HashMap<u64, UnboundedSender<String>>>>,
    next_id: AtomicU64,
}

impl Hub {
    /// Register a connection. Returns (conn id, receiver, whether the user just came online).
    pub fn register(&self, user: i64) -> (u64, UnboundedReceiver<String>, bool) {
        let (tx, rx) = unbounded_channel();
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut map = self.conns.write().unwrap_or_else(|e| e.into_inner());
        let entry = map.entry(user).or_default();
        let first = entry.is_empty();
        entry.insert(id, tx);
        (id, rx, first)
    }

    /// Remove a connection. Returns true if the user has no connections left.
    pub fn unregister(&self, user: i64, conn: u64) -> bool {
        let mut map = self.conns.write().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = map.get_mut(&user) {
            entry.remove(&conn);
            if entry.is_empty() {
                map.remove(&user);
                return true;
            }
        }
        false
    }

    pub fn is_online(&self, user: i64) -> bool {
        self.conns
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(&user)
            .is_some_and(|c| !c.is_empty())
    }

    pub fn send_to_conn(&self, user: i64, conn: u64, msg: &str) {
        let map = self.conns.read().unwrap_or_else(|e| e.into_inner());
        if let Some(tx) = map.get(&user).and_then(|c| c.get(&conn)) {
            let _ = tx.send(msg.to_string());
        }
    }

    pub fn send_to_users<I: IntoIterator<Item = i64>>(&self, users: I, msg: &str) {
        let map = self.conns.read().unwrap_or_else(|e| e.into_inner());
        for u in users {
            if let Some(conns) = map.get(&u) {
                for tx in conns.values() {
                    let _ = tx.send(msg.to_string());
                }
            }
        }
    }
}

/// Push an event to every member of a channel.
pub async fn broadcast_to_channel(
    state: &AppState,
    channel_id: i64,
    event: &Value,
) -> AppResult<()> {
    let users: Vec<i64> =
        sqlx::query_scalar("SELECT user_id FROM channel_members WHERE channel_id = ?")
            .bind(channel_id)
            .fetch_all(&state.db)
            .await?;
    state.hub.send_to_users(users, &event.to_string());
    Ok(())
}

/// Push an event to every member of a workspace.
pub async fn broadcast_to_workspace(state: &AppState, ws: i64, event: &Value) -> AppResult<()> {
    let users: Vec<i64> =
        sqlx::query_scalar("SELECT user_id FROM workspace_members WHERE workspace_id = ?")
            .bind(ws)
            .fetch_all(&state.db)
            .await?;
    state.hub.send_to_users(users, &event.to_string());
    Ok(())
}

pub fn send_to_user(state: &AppState, user: i64, event: &Value) {
    state.hub.send_to_users([user], &event.to_string());
}

/// Users who share at least one workspace with `user` (including `user`).
async fn peers(state: &AppState, user: i64) -> AppResult<Vec<i64>> {
    Ok(sqlx::query_scalar(
        "SELECT DISTINCT b.user_id FROM workspace_members a
         JOIN workspace_members b ON a.workspace_id = b.workspace_id
         WHERE a.user_id = ?",
    )
    .bind(user)
    .fetch_all(&state.db)
    .await?)
}

/// Reject cross-origin WebSocket handshakes (cookie auth would otherwise allow CSWSH).
fn origin_ok(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) else {
        return true; // non-browser clients
    };
    let Some(host) = headers.get(header::HOST).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let origin_host = origin
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(origin)
        .trim_end_matches('/');
    origin_host.eq_ignore_ascii_case(host)
}

pub async fn ws_handler(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<Response, AppError> {
    if !origin_ok(&headers) {
        return Err(AppError::Forbidden(
            "cross-origin websocket rejected".into(),
        ));
    }
    Ok(ws.on_upgrade(move |socket| handle_socket(state, user, socket)))
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientEvent {
    Typing {
        channel_id: i64,
        #[serde(default)]
        parent_id: Option<i64>,
    },
    Ping,
}

async fn handle_socket(state: AppState, user: crate::auth::User, socket: WebSocket) {
    let (mut sink, mut stream) = socket.split();
    let (conn_id, mut rx, came_online) = state.hub.register(user.id);

    let peer_ids = peers(&state, user.id).await.unwrap_or_default();
    let online: Vec<i64> = peer_ids
        .iter()
        .copied()
        .filter(|u| state.hub.is_online(*u))
        .collect();
    let hello = json!({ "type": "hello", "user_id": user.id, "online_user_ids": online });
    state.hub.send_to_conn(user.id, conn_id, &hello.to_string());
    if came_online {
        let ev = json!({ "type": "presence", "user_id": user.id, "online": true });
        state.hub.send_to_users(peer_ids.clone(), &ev.to_string());
    }

    let mut send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sink.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
    });

    let recv_state = state.clone();
    let recv_user = user.clone();
    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = stream.next().await {
            match msg {
                Message::Text(t) => {
                    if let Ok(ev) = serde_json::from_str::<ClientEvent>(t.as_str()) {
                        handle_client_event(&recv_state, &recv_user, conn_id, ev).await;
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    });

    tokio::select! {
        _ = &mut send_task => recv_task.abort(),
        _ = &mut recv_task => send_task.abort(),
    }

    if state.hub.unregister(user.id, conn_id) {
        let peer_ids = peers(&state, user.id).await.unwrap_or_default();
        let ev = json!({ "type": "presence", "user_id": user.id, "online": false });
        state.hub.send_to_users(peer_ids, &ev.to_string());
    }
}

async fn handle_client_event(
    state: &AppState,
    user: &crate::auth::User,
    conn_id: u64,
    ev: ClientEvent,
) {
    match ev {
        ClientEvent::Ping => {
            state
                .hub
                .send_to_conn(user.id, conn_id, &json!({"type": "pong"}).to_string());
        }
        ClientEvent::Typing {
            channel_id,
            parent_id,
        } => {
            if !access::is_channel_member(&state.db, channel_id, user.id)
                .await
                .unwrap_or(false)
            {
                return;
            }
            let users: Vec<i64> = sqlx::query_scalar(
                "SELECT user_id FROM channel_members WHERE channel_id = ? AND user_id <> ?",
            )
            .bind(channel_id)
            .bind(user.id)
            .fetch_all(&state.db)
            .await
            .unwrap_or_default();
            let ev = json!({
                "type": "typing",
                "channel_id": channel_id,
                "parent_id": parent_id,
                "user_id": user.id,
                "username": user.username,
                "display_name": user.display_name,
            });
            state.hub.send_to_users(users, &ev.to_string());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn hub_tracks_presence_per_connection() {
        let hub = Hub::default();
        let (c1, mut rx1, first) = hub.register(7);
        assert!(first);
        let (c2, _rx2, first) = hub.register(7);
        assert!(!first);
        hub.send_to_users([7], "hi");
        assert_eq!(rx1.try_recv().unwrap(), "hi");
        assert!(!hub.unregister(7, c1));
        assert!(hub.is_online(7));
        assert!(hub.unregister(7, c2));
        assert!(!hub.is_online(7));
    }

    #[test]
    fn origin_check() {
        let mut h = HeaderMap::new();
        h.insert(header::HOST, HeaderValue::from_static("chat.example.com"));
        assert!(origin_ok(&h));
        h.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://chat.example.com"),
        );
        assert!(origin_ok(&h));
        h.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://evil.example"),
        );
        assert!(!origin_ok(&h));
    }
}
