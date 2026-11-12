mod common;

use common::{TestServer, two_users};
use reqwest::{Method, StatusCode};
use serde_json::json;

// ---------------------------------------------------------------- auth

#[tokio::test]
async fn signup_login_me_logout() {
    let srv = TestServer::start().await;
    let res = srv
        .http
        .post(srv.url("/api/auth/signup"))
        .json(&json!({"username": "Alice", "password": "hunter2hunter2"}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let cookie = res.headers()["set-cookie"].to_str().unwrap().to_string();
    assert!(cookie.starts_with("rslack_session="));
    assert!(cookie.contains("HttpOnly"));
    let v: serde_json::Value = res.json().await.unwrap();
    assert_eq!(v["user"]["username"], "alice", "usernames are lowercased");

    // Cookie auth works.
    let cookie_pair = cookie.split(';').next().unwrap();
    let me = srv
        .http
        .get(srv.url("/api/me"))
        .header("cookie", cookie_pair)
        .send()
        .await
        .unwrap();
    assert_eq!(me.status(), StatusCode::OK);

    // Duplicate username.
    let dup = srv
        .http
        .post(srv.url("/api/auth/signup"))
        .json(&json!({"username": "alice", "password": "something-else"}))
        .send()
        .await
        .unwrap();
    assert_eq!(dup.status(), StatusCode::CONFLICT);

    // Wrong password / unknown user.
    for (u, p) in [("alice", "wrong-password"), ("nobody", "hunter2hunter2")] {
        let r = srv
            .http
            .post(srv.url("/api/auth/login"))
            .json(&json!({"username": u, "password": p}))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
    }

    // Correct login gives a working bearer token; logout revokes it.
    let r = srv
        .http
        .post(srv.url("/api/auth/login"))
        .json(&json!({"username": "ALICE", "password": "hunter2hunter2"}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    let token = r.json::<serde_json::Value>().await.unwrap()["token"]
        .as_str()
        .unwrap()
        .to_string();
    let me = srv
        .http
        .get(srv.url("/api/me"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(me.status(), StatusCode::OK);
    let out = srv
        .http
        .post(srv.url("/api/auth/logout"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(out.status(), StatusCode::OK);
    let me = srv
        .http
        .get(srv.url("/api/me"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(me.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn signup_validation_and_unauthenticated_access() {
    let srv = TestServer::start().await;
    for body in [
        json!({"username": "a", "password": "longenough"}),
        json!({"username": "bad name", "password": "longenough"}),
        json!({"username": "okname", "password": "short"}),
    ] {
        let r = srv
            .http
            .post(srv.url("/api/auth/signup"))
            .json(&body)
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::BAD_REQUEST, "{body}");
    }
    let r = srv
        .http
        .get(srv.url("/api/workspaces"))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
    let r = srv
        .http
        .get(srv.url("/api/me"))
        .bearer_auth("garbage")
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn signups_can_be_disabled() {
    let srv = TestServer::start_with(|c| c.allow_signup = false).await;
    let r = srv
        .http
        .post(srv.url("/api/auth/signup"))
        .json(&json!({"username": "alice", "password": "longenough"}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn serves_web_ui_and_health() {
    let srv = TestServer::start().await;
    let r = srv.http.get(srv.url("/")).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    assert!(
        r.headers()["content-type"]
            .to_str()
            .unwrap()
            .starts_with("text/html")
    );
    assert!(r.text().await.unwrap().contains("rslack"));
    let r = srv.http.get(srv.url("/healthz")).send().await.unwrap();
    assert_eq!(r.text().await.unwrap(), "ok");
    let r = srv.http.get(srv.url("/api/nope")).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::NOT_FOUND);
}

// ---------------------------------------------------------------- workspaces & channels

#[tokio::test]
async fn workspaces_invite_and_membership() {
    let srv = TestServer::start().await;
    let alice = srv.signup("alice").await;
    let bob = srv.signup("bob").await;
    let carol = srv.signup("carol").await;
    let (ws, code) = alice.create_workspace("Acme").await;

    // Non-members can't see the workspace.
    let (s, _) = bob.get(&format!("/api/workspaces/{ws}/channels")).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    let (s, _) = bob
        .post("/api/workspaces/join", json!({"invite_code": "wrong"}))
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND);

    assert_eq!(bob.join_workspace(&code).await, ws);
    assert_eq!(
        bob.join_workspace(&code).await,
        ws,
        "joining twice is idempotent"
    );
    let list = bob.ok_get("/api/workspaces").await;
    assert_eq!(list.as_array().unwrap().len(), 1);

    // New members land in #general.
    let chans = bob.channels(ws).await;
    assert_eq!(chans.len(), 1);
    assert_eq!(chans[0]["name"], "general");

    let members = alice.ok_get(&format!("/api/workspaces/{ws}/members")).await;
    let names: Vec<_> = members
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["username"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["alice", "bob"]);
    assert!(carol.get(&format!("/api/workspaces/{ws}/members")).await.0 == StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn public_and_private_channels() {
    let srv = TestServer::start().await;
    let (alice, bob, ws, _general) = two_users(&srv).await;

    let random = alice.create_channel(ws, "Random Stuff", false).await;
    let secret = alice.create_channel(ws, "secret", true).await;

    // Names are normalized; duplicates conflict; invalid rejected.
    let chans = alice.channels(ws).await;
    assert!(chans.iter().any(|c| c["name"] == "random-stuff"));
    let (s, _) = alice
        .post(
            &format!("/api/workspaces/{ws}/channels"),
            json!({"name": "random-stuff"}),
        )
        .await;
    assert_eq!(s, StatusCode::CONFLICT);
    let (s, _) = alice
        .post(
            &format!("/api/workspaces/{ws}/channels"),
            json!({"name": "no/slashes"}),
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);

    // Bob can browse the public channel only.
    let browse = bob
        .ok_get(&format!("/api/workspaces/{ws}/channels/browse"))
        .await;
    let names: Vec<_> = browse
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["name"].as_str().unwrap().to_string())
        .collect();
    assert!(names.contains(&"random-stuff".to_string()));
    assert!(!names.contains(&"secret".to_string()));

    // Bob can read but not post in a public channel before joining.
    alice.send(random, "hello random").await;
    let (s, _) = bob.get(&format!("/api/channels/{random}/messages")).await;
    assert_eq!(s, StatusCode::OK);
    let (s, _) = bob
        .post(
            &format!("/api/channels/{random}/messages"),
            json!({"body": "hi"}),
        )
        .await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    bob.ok_post(&format!("/api/channels/{random}/join"), json!({}))
        .await;
    bob.send(random, "hi").await;
    assert_eq!(bob.channel_summary(ws, random).await["member_count"], 2);
    bob.ok_post(&format!("/api/channels/{random}/leave"), json!({}))
        .await;
    assert!(
        !bob.channels(ws)
            .await
            .iter()
            .any(|c| c["id"].as_i64() == Some(random))
    );

    // Private channel is invisible to Bob until he's added.
    for path in [
        format!("/api/channels/{secret}/messages"),
        format!("/api/channels/{secret}/members"),
    ] {
        assert_eq!(bob.get(&path).await.0, StatusCode::NOT_FOUND);
    }
    assert_eq!(
        bob.post(&format!("/api/channels/{secret}/join"), json!({}))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    alice
        .ok_post(
            &format!("/api/channels/{secret}/members"),
            json!({"username": "bob"}),
        )
        .await;
    bob.send(secret, "thanks for the invite").await;
    assert!(
        bob.channels(ws)
            .await
            .iter()
            .any(|c| c["id"].as_i64() == Some(secret))
    );

    // Topic update.
    let v = alice
        .req(
            Method::PATCH,
            &format!("/api/channels/{random}"),
            Some(json!({"topic": "anything goes"})),
        )
        .await;
    assert_eq!(v.0, StatusCode::OK);
    assert_eq!(v.1["topic"], "anything goes");
}

#[tokio::test]
async fn direct_messages() {
    let srv = TestServer::start().await;
    let (alice, bob, ws, _) = two_users(&srv).await;
    let carol = srv.signup("carol").await;

    let dm = alice
        .ok_post(
            &format!("/api/workspaces/{ws}/dms"),
            json!({"user_id": bob.id}),
        )
        .await;
    let dm_id = dm["id"].as_i64().unwrap();
    assert_eq!(dm["is_dm"], true);
    assert_eq!(dm["dm_user"]["username"], "bob");
    // Same DM from the other side.
    let dm2 = bob
        .ok_post(
            &format!("/api/workspaces/{ws}/dms"),
            json!({"user_id": alice.id}),
        )
        .await;
    assert_eq!(dm2["id"].as_i64(), Some(dm_id));
    assert_eq!(dm2["dm_user"]["username"], "alice");

    alice.send(dm_id, "psst").await;
    let s = bob.channel_summary(ws, dm_id).await;
    assert_eq!(s["unread_count"], 1);
    assert_eq!(s["mention_count"], 1, "every DM counts as a mention");

    // Outsiders can't open DMs with members or read them.
    assert_eq!(
        carol
            .get(&format!("/api/channels/{dm_id}/messages"))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        carol
            .post(
                &format!("/api/workspaces/{ws}/dms"),
                json!({"user_id": bob.id})
            )
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        bob.post(&format!("/api/channels/{dm_id}/leave"), json!({}))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
}

// ---------------------------------------------------------------- messages

#[tokio::test]
async fn post_list_edit_delete_messages() {
    let srv = TestServer::start().await;
    let (alice, bob, _ws, general) = two_users(&srv).await;

    let m1 = alice.send(general, "first **message**").await;
    let id1 = m1["id"].as_i64().unwrap();
    assert_eq!(m1["username"], "alice");
    assert_eq!(m1["display_name"], "ALICE");
    bob.send(general, "second").await;

    let list = bob
        .ok_get(&format!("/api/channels/{general}/messages"))
        .await;
    let msgs = list["messages"].as_array().unwrap();
    assert_eq!(msgs.len(), 2);
    assert_eq!(msgs[0]["body"], "first **message**");
    assert_eq!(list["has_more"], false);

    // Empty / too long.
    assert_eq!(
        alice
            .post(
                &format!("/api/channels/{general}/messages"),
                json!({"body": "   "})
            )
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    let long = "x".repeat(8001);
    assert_eq!(
        alice
            .post(
                &format!("/api/channels/{general}/messages"),
                json!({"body": long})
            )
            .await
            .0,
        StatusCode::BAD_REQUEST
    );

    // Only the author can edit/delete.
    let (s, _) = bob
        .req(
            Method::PATCH,
            &format!("/api/messages/{id1}"),
            Some(json!({"body": "hacked"})),
        )
        .await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    let (s, v) = alice
        .req(
            Method::PATCH,
            &format!("/api/messages/{id1}"),
            Some(json!({"body": "first (edited)"})),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["body"], "first (edited)");
    assert!(v["edited_at"].is_i64());

    let (s, _) = bob
        .req(Method::DELETE, &format!("/api/messages/{id1}"), None)
        .await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    let (s, _) = alice
        .req(Method::DELETE, &format!("/api/messages/{id1}"), None)
        .await;
    assert_eq!(s, StatusCode::OK);
    let list = bob
        .ok_get(&format!("/api/channels/{general}/messages"))
        .await;
    let msgs = list["messages"].as_array().unwrap();
    assert_eq!(msgs.len(), 1, "deleted message without replies disappears");
    assert_eq!(msgs[0]["body"], "second");
}

#[tokio::test]
async fn pagination() {
    let srv = TestServer::start().await;
    let (alice, _bob, _ws, general) = two_users(&srv).await;
    for i in 0..7 {
        alice.send(general, &format!("msg {i}")).await;
    }
    let page = alice
        .ok_get(&format!("/api/channels/{general}/messages?limit=3"))
        .await;
    let msgs = page["messages"].as_array().unwrap();
    assert_eq!(
        msgs.iter()
            .map(|m| m["body"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["msg 4", "msg 5", "msg 6"]
    );
    assert_eq!(page["has_more"], true);
    let before = msgs[0]["id"].as_i64().unwrap();
    let page = alice
        .ok_get(&format!(
            "/api/channels/{general}/messages?limit=10&before={before}"
        ))
        .await;
    assert_eq!(page["messages"].as_array().unwrap().len(), 4);
    assert_eq!(page["has_more"], false);
}

#[tokio::test]
async fn threads() {
    let srv = TestServer::start().await;
    let (alice, bob, _ws, general) = two_users(&srv).await;
    let parent = alice.send(general, "release v0.1?").await;
    let pid = parent["id"].as_i64().unwrap();

    let r1 = bob
        .ok_post(
            &format!("/api/channels/{general}/messages"),
            json!({"body": "ship it", "parent_id": pid}),
        )
        .await;
    alice
        .ok_post(
            &format!("/api/channels/{general}/messages"),
            json!({"body": "done", "parent_id": pid}),
        )
        .await;

    // Replies don't show at top level; parent carries reply_count.
    let list = alice
        .ok_get(&format!("/api/channels/{general}/messages"))
        .await;
    let msgs = list["messages"].as_array().unwrap();
    assert_eq!(msgs.len(), 1);
    assert_eq!(msgs[0]["reply_count"], 2);
    assert!(msgs[0]["last_reply_at"].is_i64());

    let t = bob.ok_get(&format!("/api/messages/{pid}/thread")).await;
    assert_eq!(t["parent"]["id"].as_i64(), Some(pid));
    let replies: Vec<_> = t["replies"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["body"].as_str().unwrap())
        .collect();
    assert_eq!(replies, ["ship it", "done"]);

    // No nested threads.
    let rid = r1["id"].as_i64().unwrap();
    let (s, _) = alice
        .post(
            &format!("/api/channels/{general}/messages"),
            json!({"body": "x", "parent_id": rid}),
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    let (s, _) = alice.get(&format!("/api/messages/{rid}/thread")).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);

    // Deleting a parent with replies keeps a placeholder so the thread survives.
    alice
        .req(Method::DELETE, &format!("/api/messages/{pid}"), None)
        .await;
    let list = bob
        .ok_get(&format!("/api/channels/{general}/messages"))
        .await;
    let m = &list["messages"][0];
    assert_eq!(m["deleted"], true);
    assert_eq!(m["body"], "");
    assert_eq!(m["reply_count"], 2);
}

#[tokio::test]
async fn reactions_toggle() {
    let srv = TestServer::start().await;
    let (alice, bob, _ws, general) = two_users(&srv).await;
    let m = alice.send(general, "react to me").await;
    let id = m["id"].as_i64().unwrap();
    let path = format!("/api/messages/{id}/reactions");

    let v = alice.ok_post(&path, json!({"emoji": "👍"})).await;
    assert_eq!(v["added"], true);
    let v = bob.ok_post(&path, json!({"emoji": "👍"})).await;
    assert_eq!(v["reactions"][0]["count"], 2);
    bob.ok_post(&path, json!({"emoji": "🎉"})).await;

    let list = alice
        .ok_get(&format!("/api/channels/{general}/messages"))
        .await;
    let r = &list["messages"][0]["reactions"];
    assert_eq!(r.as_array().unwrap().len(), 2);
    assert_eq!(r[0]["emoji"], "👍");
    assert_eq!(r[0]["user_ids"], json!([alice.id, bob.id]));

    // Toggle off.
    let v = alice.ok_post(&path, json!({"emoji": "👍"})).await;
    assert_eq!(v["added"], false);
    assert_eq!(v["reactions"][0]["count"], 1);

    assert_eq!(
        alice.post(&path, json!({"emoji": ""})).await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        alice.post(&path, json!({"emoji": "a b"})).await.0,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn unread_counts_and_mentions() {
    let srv = TestServer::start().await;
    let (alice, bob, ws, general) = two_users(&srv).await;
    bob.send(general, "my own message doesn't count").await;
    alice.send(general, "morning all").await;
    alice.send(general, "hey @bob can you review?").await;
    let last = alice.send(general, "thanks").await["id"].as_i64().unwrap();

    let s = bob.channel_summary(ws, general).await;
    assert_eq!(s["unread_count"], 3);
    assert_eq!(s["mention_count"], 1);
    assert_eq!(
        alice.channel_summary(ws, general).await["unread_count"],
        0,
        "sender's own posts are read"
    );

    bob.ok_post(
        &format!("/api/channels/{general}/read"),
        json!({"message_id": last}),
    )
    .await;
    let s = bob.channel_summary(ws, general).await;
    assert_eq!(s["unread_count"], 0);
    assert_eq!(s["mention_count"], 0);
    // Posting marks the channel read for the poster (like Slack).
    alice.send(general, "one more").await;
    assert_eq!(bob.channel_summary(ws, general).await["unread_count"], 1);
    let own = bob.send(general, "replying").await["id"].as_i64().unwrap();
    assert_eq!(bob.channel_summary(ws, general).await["unread_count"], 0);
    assert_eq!(
        bob.channel_summary(ws, general).await["last_read_id"].as_i64(),
        Some(own)
    );
    let last = own;
    // last_read never goes backwards.
    bob.ok_post(
        &format!("/api/channels/{general}/read"),
        json!({"message_id": 1}),
    )
    .await;
    assert_eq!(
        bob.channel_summary(ws, general).await["last_read_id"].as_i64(),
        Some(last)
    );
}

// ---------------------------------------------------------------- search

#[tokio::test]
async fn full_text_search_respects_access() {
    let srv = TestServer::start().await;
    let (alice, bob, ws, general) = two_users(&srv).await;
    let secret = alice.create_channel(ws, "secret", true).await;
    alice
        .send(general, "The deployment pipeline is green")
        .await;
    alice
        .send(secret, "deployment credentials rotate friday")
        .await;
    let gone = alice.send(general, "deployment rollback plan").await["id"]
        .as_i64()
        .unwrap();
    alice
        .req(Method::DELETE, &format!("/api/messages/{gone}"), None)
        .await;

    let path = format!("/api/workspaces/{ws}/search?q=deploy");
    let a = alice.ok_get(&path).await;
    assert_eq!(
        a["results"].as_array().unwrap().len(),
        2,
        "prefix match, both channels: {a}"
    );
    let b = bob.ok_get(&path).await;
    let res = b["results"].as_array().unwrap();
    assert_eq!(
        res.len(),
        1,
        "bob can't see the private channel or deleted messages"
    );
    assert_eq!(res[0]["channel"]["name"], "general");
    assert!(
        res[0]["message"]["body"]
            .as_str()
            .unwrap()
            .contains("pipeline")
    );

    // Multi-word AND, and FTS syntax in user input is neutralized.
    assert_eq!(
        alice
            .ok_get(&format!("/api/workspaces/{ws}/search?q=pipeline%20green"))
            .await["results"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        alice
            .ok_get(&format!("/api/workspaces/{ws}/search?q=pipeline%20purple"))
            .await["results"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    for q in ["%22", "NEAR(", "*", "a%20OR", "-x", ""] {
        let (s, _) = alice
            .get(&format!("/api/workspaces/{ws}/search?q={q}"))
            .await;
        assert_eq!(s, StatusCode::OK, "q={q}");
    }
    // Edits are re-indexed.
    let m = alice.send(general, "kiwi").await["id"].as_i64().unwrap();
    alice
        .req(
            Method::PATCH,
            &format!("/api/messages/{m}"),
            Some(json!({"body": "mango"})),
        )
        .await;
    assert_eq!(
        alice
            .ok_get(&format!("/api/workspaces/{ws}/search?q=kiwi"))
            .await["results"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    assert_eq!(
        alice
            .ok_get(&format!("/api/workspaces/{ws}/search?q=mango"))
            .await["results"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

// ---------------------------------------------------------------- uploads

#[tokio::test]
async fn file_upload_attach_download_and_limits() {
    let srv = TestServer::start_with(|c| c.max_upload_mb = 1).await;
    let (alice, bob, _ws, general) = two_users(&srv).await;
    let carol = srv.signup("carol").await;

    let upload = |user: &common::TestUser, name: &str, bytes: Vec<u8>, mime: &str| {
        let part = reqwest::multipart::Part::bytes(bytes)
            .file_name(name.to_string())
            .mime_str(mime)
            .unwrap();
        let form = reqwest::multipart::Form::new().part("file", part);
        user.http
            .post(format!("{}/api/uploads", user.base))
            .bearer_auth(&user.token)
            .multipart(form)
            .send()
    };

    let res = upload(
        &alice,
        "../../notes.txt",
        b"hello file".to_vec(),
        "text/plain",
    )
    .await
    .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let att: serde_json::Value = res.json().await.unwrap();
    assert_eq!(att["filename"], "notes.txt", "path components stripped");
    assert_eq!(att["size"], 10);
    let aid = att["id"].as_i64().unwrap();

    // Not attached yet: only the uploader can fetch it.
    assert_eq!(
        bob.get(&format!("/api/files/{aid}")).await.0,
        StatusCode::NOT_FOUND
    );
    // Someone else can't attach Alice's upload.
    let (s, _) = bob
        .post(
            &format!("/api/channels/{general}/messages"),
            json!({"body": "", "attachment_ids": [aid]}),
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);

    let m = alice
        .ok_post(
            &format!("/api/channels/{general}/messages"),
            json!({"body": "", "attachment_ids": [aid]}),
        )
        .await;
    assert_eq!(m["attachments"][0]["id"].as_i64(), Some(aid));
    let url = m["attachments"][0]["url"].as_str().unwrap().to_string();

    let res = bob
        .http
        .get(format!("{}{}", bob.base, url))
        .bearer_auth(&bob.token)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers()["x-content-type-options"], "nosniff");
    assert_eq!(res.bytes().await.unwrap().as_ref(), b"hello file");
    assert_eq!(
        carol.get(&url).await.0,
        StatusCode::NOT_FOUND,
        "non-members can't download"
    );

    // HTML is never served inline.
    let res = upload(
        &alice,
        "x.html",
        b"<script>alert(1)</script>".to_vec(),
        "text/html",
    )
    .await
    .unwrap();
    let hid = res.json::<serde_json::Value>().await.unwrap()["id"]
        .as_i64()
        .unwrap();
    let res = alice
        .http
        .get(format!("{}/api/files/{hid}", alice.base))
        .bearer_auth(&alice.token)
        .send()
        .await
        .unwrap();
    assert_eq!(res.headers()["content-type"], "application/octet-stream");
    assert!(
        res.headers()["content-disposition"]
            .to_str()
            .unwrap()
            .starts_with("attachment")
    );

    // Over the 1 MB limit.
    let res = upload(
        &alice,
        "big.bin",
        vec![0u8; 1024 * 1024 + 10],
        "application/octet-stream",
    )
    .await
    .unwrap();
    assert_eq!(res.status(), StatusCode::PAYLOAD_TOO_LARGE);
}
