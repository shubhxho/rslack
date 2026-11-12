#![allow(dead_code)]
use reqwest::{Client, Method, StatusCode};
use serde_json::{Value, json};
use std::net::SocketAddr;

pub struct TestServer {
    pub addr: SocketAddr,
    pub http: Client,
    _dir: tempfile::TempDir,
}

impl TestServer {
    pub async fn start() -> Self {
        Self::start_with(|_| {}).await
    }

    pub async fn start_with(f: impl FnOnce(&mut rslack::config::Config)) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = rslack::config::Config::with_data_dir(dir.path());
        f(&mut cfg);
        let (addr, _h) = rslack::start(cfg).await.unwrap();
        Self {
            addr,
            http: Client::new(),
            _dir: dir,
        }
    }

    pub fn url(&self, path: &str) -> String {
        format!("http://{}{}", self.addr, path)
    }

    pub async fn signup(&self, username: &str) -> TestUser {
        let res = self
            .http
            .post(self.url("/api/auth/signup"))
            .json(&json!({"username": username, "password": "correct horse battery", "display_name": username.to_uppercase()}))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK, "signup {username}");
        let v: Value = res.json().await.unwrap();
        TestUser {
            id: v["user"]["id"].as_i64().unwrap(),
            token: v["token"].as_str().unwrap().to_string(),
            base: format!("http://{}", self.addr),
            http: self.http.clone(),
        }
    }
}

#[derive(Clone)]
pub struct TestUser {
    pub id: i64,
    pub token: String,
    pub base: String,
    pub http: Client,
}

impl TestUser {
    pub async fn req(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut rb = self
            .http
            .request(method, format!("{}{}", self.base, path))
            .bearer_auth(&self.token);
        if let Some(b) = body {
            rb = rb.json(&b);
        }
        let res = rb.send().await.unwrap();
        let status = res.status();
        let text = res.text().await.unwrap();
        let v = serde_json::from_str(&text).unwrap_or(Value::String(text));
        (status, v)
    }

    pub async fn get(&self, path: &str) -> (StatusCode, Value) {
        self.req(Method::GET, path, None).await
    }

    pub async fn post(&self, path: &str, body: Value) -> (StatusCode, Value) {
        self.req(Method::POST, path, Some(body)).await
    }

    /// POST that must succeed; returns body.
    pub async fn ok_post(&self, path: &str, body: Value) -> Value {
        let (s, v) = self.post(path, body).await;
        assert_eq!(s, StatusCode::OK, "POST {path}: {v}");
        v
    }

    pub async fn ok_get(&self, path: &str) -> Value {
        let (s, v) = self.get(path).await;
        assert_eq!(s, StatusCode::OK, "GET {path}: {v}");
        v
    }

    pub async fn create_workspace(&self, name: &str) -> (i64, String) {
        let v = self.ok_post("/api/workspaces", json!({"name": name})).await;
        (
            v["id"].as_i64().unwrap(),
            v["invite_code"].as_str().unwrap().to_string(),
        )
    }

    pub async fn join_workspace(&self, code: &str) -> i64 {
        let v = self
            .ok_post("/api/workspaces/join", json!({"invite_code": code}))
            .await;
        v["id"].as_i64().unwrap()
    }

    pub async fn create_channel(&self, ws: i64, name: &str, private: bool) -> i64 {
        let v = self
            .ok_post(
                &format!("/api/workspaces/{ws}/channels"),
                json!({"name": name, "is_private": private}),
            )
            .await;
        v["id"].as_i64().unwrap()
    }

    pub async fn send(&self, channel: i64, body: &str) -> Value {
        self.ok_post(
            &format!("/api/channels/{channel}/messages"),
            json!({"body": body}),
        )
        .await
    }

    pub async fn channels(&self, ws: i64) -> Vec<Value> {
        self.ok_get(&format!("/api/workspaces/{ws}/channels"))
            .await
            .as_array()
            .unwrap()
            .clone()
    }

    pub async fn channel_summary(&self, ws: i64, channel: i64) -> Value {
        self.channels(ws)
            .await
            .into_iter()
            .find(|c| c["id"].as_i64() == Some(channel))
            .expect("channel in list")
    }
}

/// Two users sharing a workspace; returns (alice, bob, ws_id, general_channel_id).
pub async fn two_users(srv: &TestServer) -> (TestUser, TestUser, i64, i64) {
    let alice = srv.signup("alice").await;
    let bob = srv.signup("bob").await;
    let (ws, code) = alice.create_workspace("Acme").await;
    bob.join_workspace(&code).await;
    let general = alice.channels(ws).await[0]["id"].as_i64().unwrap();
    (alice, bob, ws, general)
}
