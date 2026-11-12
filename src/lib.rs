//! rslack: a self-hosted, Slack-like team chat server.
//!
//! One binary serves the JSON API (`/api/*`), the realtime WebSocket (`/api/ws`)
//! and the embedded web UI. State lives in a single SQLite file plus an uploads dir.

pub mod access;
pub mod auth;
pub mod channels;
pub mod config;
pub mod db;
pub mod error;
pub mod messages;
pub mod realtime;
pub mod search;
pub mod state;
pub mod uploads;
pub mod web;
pub mod workspaces;

use axum::{
    Json, Router,
    extract::DefaultBodyLimit,
    routing::{get, patch, post},
};
use config::Config;
use realtime::Hub;
use state::AppState;
use std::{net::SocketAddr, sync::Arc};

/// Build the shared application state (opens DB, runs migrations).
pub async fn build_state(config: Config) -> anyhow::Result<AppState> {
    let db = db::connect(&config.data_dir).await?;
    Ok(AppState {
        db,
        hub: Arc::new(Hub::default()),
        config: Arc::new(config),
    })
}

/// The full HTTP router: API, WebSocket, health check and static UI.
pub fn router(state: AppState) -> Router {
    let upload_limit = state.config.max_upload_bytes() as usize + 256 * 1024;
    let api = Router::new()
        .route("/auth/signup", post(auth::signup))
        .route("/auth/login", post(auth::login))
        .route("/auth/logout", post(auth::logout))
        .route("/me", get(auth::me))
        .route(
            "/workspaces",
            get(workspaces::list).post(workspaces::create),
        )
        .route("/workspaces/join", post(workspaces::join))
        .route("/workspaces/{id}/members", get(workspaces::members))
        .route(
            "/workspaces/{id}/channels",
            get(channels::list).post(channels::create),
        )
        .route("/workspaces/{id}/channels/browse", get(channels::browse))
        .route("/workspaces/{id}/dms", post(channels::open_dm))
        .route("/workspaces/{id}/search", get(search::search))
        .route("/channels/{id}", patch(channels::update))
        .route("/channels/{id}/join", post(channels::join))
        .route("/channels/{id}/leave", post(channels::leave))
        .route(
            "/channels/{id}/members",
            get(channels::members).post(channels::add_member),
        )
        .route(
            "/channels/{id}/messages",
            get(messages::list).post(messages::create),
        )
        .route("/channels/{id}/read", post(messages::mark_read))
        .route(
            "/messages/{id}",
            patch(messages::edit).delete(messages::delete),
        )
        .route("/messages/{id}/thread", get(messages::thread))
        .route("/messages/{id}/reactions", post(messages::toggle_reaction))
        .route(
            "/uploads",
            post(uploads::upload).layer(DefaultBodyLimit::max(upload_limit)),
        )
        .route("/files/{id}", get(uploads::download))
        .route("/ws", get(realtime::ws_handler))
        .fallback(|| async {
            (
                axum::http::StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "not found"})),
            )
        });

    Router::new()
        .nest("/api", api)
        .route("/healthz", get(|| async { "ok" }))
        .fallback(web::static_handler)
        .with_state(state)
}

/// Bind and start serving in the background. Returns the bound address.
/// Useful for tests and embedding; `serve` is the blocking variant used by `main`.
pub async fn start(config: Config) -> anyhow::Result<(SocketAddr, tokio::task::JoinHandle<()>)> {
    let addr = format!("{}:{}", config.host, config.port);
    let state = build_state(config).await?;
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    let local = listener.local_addr()?;
    let app = router(state);
    let handle = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Ok((local, handle))
}

/// Run the server until Ctrl-C / SIGTERM.
pub async fn serve(config: Config) -> anyhow::Result<()> {
    let addr = format!("{}:{}", config.host, config.port);
    let data_dir = config.data_dir.clone();
    let state = build_state(config).await?;
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!(
        "rslack listening on http://{} (data dir: {})",
        listener.local_addr()?,
        data_dir.display()
    );
    axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = term => {} }
    tracing::info!("shutting down");
}
