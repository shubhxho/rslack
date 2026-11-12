use crate::{
    access,
    auth::AuthUser,
    db::now_ms,
    error::{AppError, AppResult},
    realtime,
    state::AppState,
};
use axum::{
    Json,
    extract::{Path, State},
};
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Clone, Debug, Serialize, sqlx::FromRow)]
pub struct Workspace {
    pub id: i64,
    pub name: String,
    pub invite_code: String,
    pub owner_id: i64,
    pub created_at: i64,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct Member {
    pub id: i64,
    pub username: String,
    pub display_name: String,
    pub role: String,
    #[sqlx(skip)]
    pub online: bool,
}

pub async fn list(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
) -> AppResult<Json<Vec<Workspace>>> {
    let rows = sqlx::query_as::<_, Workspace>(
        "SELECT w.id, w.name, w.invite_code, w.owner_id, w.created_at
         FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id
         WHERE m.user_id = ? ORDER BY m.joined_at, w.id",
    )
    .bind(user.id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

#[derive(Deserialize)]
pub struct CreateReq {
    pub name: String,
}

pub async fn create(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Json(req): Json<CreateReq>,
) -> AppResult<Json<Workspace>> {
    let name = req.name.trim().to_string();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(AppError::bad("workspace name must be 1-80 characters"));
    }
    let invite_code = uuid::Uuid::new_v4().simple().to_string()[..12].to_string();
    let now = now_ms();
    let mut tx = state.db.begin().await?;
    let ws_id = sqlx::query(
        "INSERT INTO workspaces (name, invite_code, owner_id, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(&name)
    .bind(&invite_code)
    .bind(user.id)
    .bind(now)
    .execute(&mut *tx)
    .await?
    .last_insert_rowid();
    sqlx::query(
        "INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)",
    )
    .bind(ws_id)
    .bind(user.id)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    let ch_id = sqlx::query(
        "INSERT INTO channels (workspace_id, name, topic, is_private, is_dm, created_by, created_at)
         VALUES (?, 'general', 'Company-wide announcements and work-based matters', 0, 0, ?, ?)",
    )
    .bind(ws_id)
    .bind(user.id)
    .bind(now)
    .execute(&mut *tx)
    .await?
    .last_insert_rowid();
    sqlx::query("INSERT INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)")
        .bind(ch_id)
        .bind(user.id)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    realtime::send_to_user(&state, user.id, &json!({"type": "workspaces.changed"}));
    Ok(Json(Workspace {
        id: ws_id,
        name,
        invite_code,
        owner_id: user.id,
        created_at: now,
    }))
}

#[derive(Deserialize)]
pub struct JoinReq {
    pub invite_code: String,
}

pub async fn join(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Json(req): Json<JoinReq>,
) -> AppResult<Json<Workspace>> {
    let ws = sqlx::query_as::<_, Workspace>(
        "SELECT id, name, invite_code, owner_id, created_at FROM workspaces WHERE invite_code = ?",
    )
    .bind(req.invite_code.trim())
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;
    let now = now_ms();
    let inserted = sqlx::query(
        "INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)",
    )
    .bind(ws.id)
    .bind(user.id)
    .bind(now)
    .execute(&state.db)
    .await?
    .rows_affected();
    if inserted > 0 {
        sqlx::query(
            "INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at)
             SELECT id, ?, ? FROM channels WHERE workspace_id = ? AND name = 'general' AND is_dm = 0",
        )
        .bind(user.id)
        .bind(now)
        .bind(ws.id)
        .execute(&state.db)
        .await?;
        realtime::broadcast_to_workspace(
            &state,
            ws.id,
            &json!({"type": "workspace.member_joined", "workspace_id": ws.id, "user_id": user.id}),
        )
        .await?;
        realtime::send_to_user(&state, user.id, &json!({"type": "workspaces.changed"}));
    }
    Ok(Json(ws))
}

pub async fn members(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(ws): Path<i64>,
) -> AppResult<Json<Vec<Member>>> {
    access::require_workspace_member(&state.db, ws, user.id).await?;
    let mut rows = sqlx::query_as::<_, Member>(
        "SELECT u.id, u.username, u.display_name, m.role
         FROM workspace_members m JOIN users u ON u.id = m.user_id
         WHERE m.workspace_id = ? ORDER BY u.display_name COLLATE NOCASE",
    )
    .bind(ws)
    .fetch_all(&state.db)
    .await?;
    for m in &mut rows {
        m.online = state.hub.is_online(m.id);
    }
    Ok(Json(rows))
}
