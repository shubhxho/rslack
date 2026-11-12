mod common;

use common::{TestServer, TestUser, two_users};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::time::Duration;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Message, client::IntoClientRequest},
};

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect(srv: &TestServer, user: &TestUser) -> Ws {
    let mut req = format!("ws://{}/api/ws", srv.addr)
        .into_client_request()
        .unwrap();
    req.headers_mut().insert(
        "authorization",
        format!("Bearer {}", user.token).parse().unwrap(),
    );
    let (ws, _) = connect_async(req).await.expect("ws connect");
    ws
}

/// Read events until one matches `pred` (or time out).
async fn wait_for(ws: &mut Ws, pred: impl Fn(&Value) -> bool) -> Value {
    let fut = async {
        loop {
            match ws.next().await {
                Some(Ok(Message::Text(t))) => {
                    let v: Value = serde_json::from_str(t.as_str()).unwrap();
                    if pred(&v) {
                        return v;
                    }
                }
                Some(Ok(_)) => {}
                other => panic!("socket ended: {other:?}"),
            }
        }
    };
    tokio::time::timeout(Duration::from_secs(5), fut)
        .await
        .expect("timed out waiting for event")
}

#[tokio::test]
async fn websocket_requires_auth_and_same_origin() {
    let srv = TestServer::start().await;
    let alice = srv.signup("alice").await;
    assert!(
        connect_async(format!("ws://{}/api/ws", srv.addr))
            .await
            .is_err()
    );

    let mut req = format!("ws://{}/api/ws", srv.addr)
        .into_client_request()
        .unwrap();
    req.headers_mut().insert(
        "authorization",
        format!("Bearer {}", alice.token).parse().unwrap(),
    );
    req.headers_mut()
        .insert("origin", "https://evil.example".parse().unwrap());
    assert!(
        connect_async(req).await.is_err(),
        "cross-origin handshake rejected"
    );
}

#[tokio::test]
async fn broadcast_between_two_clients() {
    let srv = TestServer::start().await;
    let (alice, bob, ws_id, general) = two_users(&srv).await;
    let mut a = connect(&srv, &alice).await;
    let hello = wait_for(&mut a, |v| v["type"] == "hello").await;
    assert_eq!(hello["user_id"].as_i64(), Some(alice.id));

    // Presence: Alice sees Bob come online.
    let mut b = connect(&srv, &bob).await;
    wait_for(&mut b, |v| v["type"] == "hello").await;
    let bob_id = bob.id;
    let p = wait_for(&mut a, |v| {
        v["type"] == "presence" && v["user_id"].as_i64() == Some(bob_id)
    })
    .await;
    assert_eq!(p["online"], true);
    let members = alice
        .ok_get(&format!("/api/workspaces/{ws_id}/members"))
        .await;
    assert!(
        members
            .as_array()
            .unwrap()
            .iter()
            .all(|m| m["online"] == true)
    );

    // New message reaches the other client.
    let sent = alice.send(general, "hello over the wire").await;
    let ev = wait_for(&mut b, |v| v["type"] == "message.new").await;
    assert_eq!(ev["channel_id"].as_i64(), Some(general));
    assert_eq!(ev["message"]["body"], "hello over the wire");
    assert_eq!(ev["message"]["id"], sent["id"]);
    // ...and the sender's own socket (other tabs stay in sync).
    wait_for(&mut a, |v| v["type"] == "message.new").await;

    // Thread reply -> message.new with parent_id + message.updated for the parent.
    let pid = sent["id"].as_i64().unwrap();
    bob.ok_post(
        &format!("/api/channels/{general}/messages"),
        json!({"body": "reply!", "parent_id": pid}),
    )
    .await;
    let ev = wait_for(&mut a, |v| v["type"] == "message.new").await;
    assert_eq!(ev["message"]["parent_id"].as_i64(), Some(pid));
    let ev = wait_for(&mut a, |v| v["type"] == "message.updated").await;
    assert_eq!(ev["message"]["reply_count"], 1);

    // Reaction, edit, delete events.
    bob.ok_post(
        &format!("/api/messages/{pid}/reactions"),
        json!({"emoji": "🚀"}),
    )
    .await;
    let ev = wait_for(&mut a, |v| v["type"] == "reaction.updated").await;
    assert_eq!(ev["reactions"][0]["emoji"], "🚀");

    alice
        .req(
            reqwest::Method::PATCH,
            &format!("/api/messages/{pid}"),
            Some(json!({"body": "edited"})),
        )
        .await;
    let ev = wait_for(&mut b, |v| {
        v["type"] == "message.updated" && v["message"]["body"] == "edited"
    })
    .await;
    assert!(ev["message"]["edited_at"].is_i64());

    let m2 = alice.send(general, "oops").await["id"].as_i64().unwrap();
    alice
        .req(
            reqwest::Method::DELETE,
            &format!("/api/messages/{m2}"),
            None,
        )
        .await;
    let ev = wait_for(&mut b, |v| v["type"] == "message.deleted").await;
    assert_eq!(ev["message_id"].as_i64(), Some(m2));

    // Typing indicator goes to the other member only.
    b.send(Message::Text(
        json!({"type": "typing", "channel_id": general})
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    let ev = wait_for(&mut a, |v| v["type"] == "typing").await;
    assert_eq!(ev["user_id"].as_i64(), Some(bob.id));
    assert_eq!(ev["username"], "bob");

    // Ping/pong.
    a.send(Message::Text(json!({"type": "ping"}).to_string().into()))
        .await
        .unwrap();
    wait_for(&mut a, |v| v["type"] == "pong").await;

    // Presence: Bob disconnects -> offline.
    b.close(None).await.unwrap();
    drop(b);
    let p = wait_for(&mut a, |v| v["type"] == "presence" && v["online"] == false).await;
    assert_eq!(p["user_id"].as_i64(), Some(bob.id));
}

#[tokio::test]
async fn private_channel_events_stay_private() {
    let srv = TestServer::start().await;
    let (alice, bob, ws_id, general) = two_users(&srv).await;
    let secret = alice.create_channel(ws_id, "secret", true).await;
    let mut b = connect(&srv, &bob).await;
    wait_for(&mut b, |v| v["type"] == "hello").await;

    alice.send(secret, "classified").await;
    alice.send(general, "public note").await;
    // The first message.new Bob sees must be the public one.
    let ev = wait_for(&mut b, |v| v["type"] == "message.new").await;
    assert_eq!(ev["message"]["body"], "public note");

    // Typing in a channel you aren't in is ignored.
    let mut a = connect(&srv, &alice).await;
    wait_for(&mut a, |v| v["type"] == "hello").await;
    b.send(Message::Text(
        json!({"type": "typing", "channel_id": secret})
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    b.send(Message::Text(
        json!({"type": "typing", "channel_id": general})
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    let ev = wait_for(&mut a, |v| v["type"] == "typing").await;
    assert_eq!(ev["channel_id"].as_i64(), Some(general));
}
