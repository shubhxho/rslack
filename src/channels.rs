use crate::{
    access::{self, ChannelRow},
    auth::AuthUser,
    db::now_ms,
    error::{AppError, AppResult, is_unique_violation},
    realtime,
    state::AppState,
};
use axum::{
    Json,
    extract::{Path, State},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Debug, Default, Serialize, sqlx::FromRow)]
pub struct UserBrief {
    pub id: i64,
    pub username: String,
    pub display_name: String,
    #[sqlx(skip)]
    pub online: bool,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ChannelSummary {
    pub id: i64,
    pub workspace_id: i64,
    pub name: String,
    pub topic: String,
    pub is_private: bool,
    pub is_dm: bool,
    pub created_by: i64,
    pub created_at: i64,
    pub last_read_id: i64,
    pub unread_count: i64,
    pub mention_count: i64,
    pub member_count: i64,
    #[sqlx(skip)]
    pub dm_user: Option<UserBrief>,
}

const SUMMARY_SQL: &str = "
SELECT c.id, c.workspace_id, c.name, c.topic, c.is_private, c.is_dm, c.created_by, c.created_at,
       cm.last_read_id,
       (SELECT COUNT(*) FROM messages m
         WHERE m.channel_id = c.id AND m.parent_id IS NULL AND m.deleted = 0
           AND m.id > cm.last_read_id AND m.user_id <> ?1) AS unread_count,
       (SELECT COUNT(*) FROM messages m
         WHERE m.channel_id = c.id AND m.parent_id IS NULL AND m.deleted = 0
           AND m.id > cm.last_read_id AND m.user_id <> ?1
           AND (c.is_dm = 1 OR instr(lower(m.body), '@' || ?2) > 0)) AS mention_count,
       (SELECT COUNT(*) FROM channel_members x WHERE x.channel_id = c.id) AS member_count
FROM channels c JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = ?1";

async fn dm_partner(state: &AppState, channel_id: i64, me: i64) -> AppResult<Option<UserBrief>> {
    let mut u = sqlx::query_as::<_, UserBrief>(
        "SELECT u.id, u.username, u.display_name FROM channel_members cm
         JOIN users u ON u.id = cm.user_id
         WHERE cm.channel_id = ? ORDER BY (cm.user_id = ?) LIMIT 1",
    )
    .bind(channel_id)
    .bind(me)
    .fetch_optional(&state.db)
    .await?;
    if let Some(u) = u.as_mut() {
        u.online = state.hub.is_online(u.id);
    }
    Ok(u)
}

async fn summary(
    state: &AppState,
    channel_id: i64,
    user: &crate::auth::User,
) -> AppResult<ChannelSummary> {
    let sql = format!("{SUMMARY_SQL} WHERE c.id = ?3");
    let mut s = sqlx::query_as::<_, ChannelSummary>(&sql)
        .bind(user.id)
        .bind(&user.username)
        .bind(channel_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or(AppError::NotFound)?;
    if s.is_dm {
        s.dm_user = dm_partner(state, s.id, user.id).await?;
    }
    Ok(s)
}

/// Channels (and DMs) the caller belongs to in a workspace, with unread/mention counts.
pub async fn list(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(ws): Path<i64>,
) -> AppResult<Json<Vec<ChannelSummary>>> {
    access::require_workspace_member(&state.db, ws, user.id).await?;
    let sql = format!("{SUMMARY_SQL} WHERE c.workspace_id = ?3 ORDER BY c.is_dm, c.name");
    let mut rows = sqlx::query_as::<_, ChannelSummary>(&sql)
        .bind(user.id)
        .bind(&user.username)
        .bind(ws)
        .fetch_all(&state.db)
        .await?;
    for r in &mut rows {
        if r.is_dm {
            r.dm_user = dm_partner(&state, r.id, user.id).await?;
        }
    }
    Ok(Json(rows))
}

#[derive(Serialize, sqlx::FromRow)]
pub struct BrowseRow {
    pub id: i64,
    pub name: String,
    pub topic: String,
    pub member_count: i64,
    pub joined: bool,
}

/// Public channels in the workspace (joined or not).
pub async fn browse(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(ws): Path<i64>,
) -> AppResult<Json<Vec<BrowseRow>>> {
    access::require_workspace_member(&state.db, ws, user.id).await?;
    let rows = sqlx::query_as::<_, BrowseRow>(
        "SELECT c.id, c.name, c.topic,
                (SELECT COUNT(*) FROM channel_members x WHERE x.channel_id = c.id) AS member_count,
                EXISTS(SELECT 1 FROM channel_members x WHERE x.channel_id = c.id AND x.user_id = ?) AS joined
         FROM channels c WHERE c.workspace_id = ? AND c.is_private = 0 AND c.is_dm = 0
         ORDER BY c.name",
    )
    .bind(user.id)
    .bind(ws)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

pub fn normalize_channel_name(raw: &str) -> AppResult<String> {
    let name: String = raw
        .trim()
        .trim_start_matches('#')
        .to_lowercase()
        .chars()
        .map(|c| if c.is_whitespace() { '-' } else { c })
        .collect();
    let ok = (1..=80).contains(&name.chars().count())
        && name
            .chars()
            .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
        && !name.starts_with("dm-");
    if !ok {
        return Err(AppError::bad(
            "channel name must be 1-80 chars: letters, numbers, '-' or '_' (and not start with 'dm-')",
        ));
    }
    Ok(name)
}

#[derive(Deserialize)]
pub struct CreateReq {
    pub name: String,
    #[serde(default)]
    pub topic: String,
    #[serde(default)]
    pub is_private: bool,
}

pub async fn create(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(ws): Path<i64>,
    Json(req): Json<CreateReq>,
) -> AppResult<Json<ChannelSummary>> {
    access::require_workspace_member(&state.db, ws, user.id).await?;
    let name = normalize_channel_name(&req.name)?;
    let topic = req.topic.trim().to_string();
    if topic.chars().count() > 250 {
        return Err(AppError::bad("topic too long (max 250)"));
    }
    let now = now_ms();
    let mut tx = state.db.begin().await?;
    let res = sqlx::query(
        "INSERT INTO channels (workspace_id, name, topic, is_private, is_dm, created_by, created_at)
         VALUES (?, ?, ?, ?, 0, ?, ?)",
    )
    .bind(ws)
    .bind(&name)
    .bind(&topic)
    .bind(req.is_private)
    .bind(user.id)
    .bind(now)
    .execute(&mut *tx)
    .await;
    let id = match res {
        Ok(r) => r.last_insert_rowid(),
        Err(e) if is_unique_violation(&e) => {
            return Err(AppError::Conflict(format!("#{name} already exists")));
        }
        Err(e) => return Err(e.into()),
    };
    sqlx::query("INSERT INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)")
        .bind(id)
        .bind(user.id)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    realtime::send_to_user(
        &state,
        user.id,
        &json!({"type": "channels.changed", "workspace_id": ws}),
    );
    Ok(Json(summary(&state, id, &user).await?))
}

#[derive(Deserialize)]
pub struct UpdateReq {
    pub topic: String,
}

pub async fn update(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<i64>,
    Json(req): Json<UpdateReq>,
) -> AppResult<Json<ChannelSummary>> {
    let ch = access::channel(&state.db, id).await?;
    access::require_member(&state.db, &ch, user.id).await?;
    let topic = req.topic.trim();
    if topic.chars().count() > 250 {
        return Err(AppError::bad("topic too long (max 250)"));
    }
    sqlx::query("UPDATE channels SET topic = ? WHERE id = ?")
        .bind(topic)
        .bind(id)
        .execute(&state.db)
        .await?;
    realtime::broadcast_to_channel(
        &state,
        id,
        &json!({"type": "channel.updated", "channel_id": id, "topic": topic}),
    )
    .await?;
    Ok(Json(summary(&state, id, &user).await?))
}

pub async fn join(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<ChannelSummary>> {
    let ch = access::channel(&state.db, id).await?;
    if ch.is_private || ch.is_dm {
        // Private channels are invite-only; don't reveal they exist.
        if !access::is_channel_member(&state.db, id, user.id).await? {
            return Err(AppError::NotFound);
        }
    }
    access::require_workspace_member(&state.db, ch.workspace_id, user.id).await?;
    let added = sqlx::query(
        "INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)",
    )
    .bind(id)
    .bind(user.id)
    .bind(now_ms())
    .execute(&state.db)
    .await?
    .rows_affected();
    if added > 0 {
        announce_membership(&state, &ch, user.id, true).await?;
    }
    Ok(Json(summary(&state, id, &user).await?))
}

pub async fn leave(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let ch = access::channel(&state.db, id).await?;
    access::require_read(&state.db, &ch, user.id).await?;
    if ch.is_dm {
        return Err(AppError::bad("you can't leave a direct message"));
    }
    let removed = sqlx::query("DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?")
        .bind(id)
        .bind(user.id)
        .execute(&state.db)
        .await?
        .rows_affected();
    if removed > 0 {
        announce_membership(&state, &ch, user.id, false).await?;
    }
    Ok(Json(json!({"ok": true})))
}

async fn announce_membership(
    state: &AppState,
    ch: &ChannelRow,
    user_id: i64,
    joined: bool,
) -> AppResult<()> {
    realtime::broadcast_to_channel(
        state,
        ch.id,
        &json!({"type": "channel.members_changed", "channel_id": ch.id, "user_id": user_id, "joined": joined}),
    )
    .await?;
    realtime::send_to_user(
        state,
        user_id,
        &json!({"type": "channels.changed", "workspace_id": ch.workspace_id}),
    );
    Ok(())
}

pub async fn members(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Vec<UserBrief>>> {
    let ch = access::channel(&state.db, id).await?;
    access::require_read(&state.db, &ch, user.id).await?;
    let mut rows = sqlx::query_as::<_, UserBrief>(
        "SELECT u.id, u.username, u.display_name FROM channel_members cm
         JOIN users u ON u.id = cm.user_id WHERE cm.channel_id = ?
         ORDER BY u.display_name COLLATE NOCASE",
    )
    .bind(id)
    .fetch_all(&state.db)
    .await?;
    for r in &mut rows {
        r.online = state.hub.is_online(r.id);
    }
    Ok(Json(rows))
}

#[derive(Deserialize)]
pub struct AddMemberReq {
    #[serde(default)]
    pub user_id: Option<i64>,
    #[serde(default)]
    pub username: Option<String>,
}

async fn resolve_user(state: &AppState, req: &AddMemberReq) -> AppResult<i64> {
    if let Some(id) = req.user_id {
        return Ok(id);
    }
    let name = req
        .username
        .as_deref()
        .map(|s| s.trim().trim_start_matches('@').to_lowercase())
        .ok_or_else(|| AppError::bad("user_id or username required"))?;
    sqlx::query_scalar("SELECT id FROM users WHERE username = ?")
        .bind(name)
        .fetch_optional(&state.db)
        .await?
        .ok_or(AppError::NotFound)
}

/// Add a workspace member to a channel (the way into private channels).
pub async fn add_member(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<i64>,
    Json(req): Json<AddMemberReq>,
) -> AppResult<Json<Value>> {
    let ch = access::channel(&state.db, id).await?;
    access::require_member(&state.db, &ch, user.id).await?;
    if ch.is_dm {
        return Err(AppError::bad("can't add people to a direct message"));
    }
    let target = resolve_user(&state, &req).await?;
    if !access::is_workspace_member(&state.db, ch.workspace_id, target).await? {
        return Err(AppError::bad("that user is not in this workspace"));
    }
    let added = sqlx::query(
        "INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)",
    )
    .bind(id)
    .bind(target)
    .bind(now_ms())
    .execute(&state.db)
    .await?
    .rows_affected();
    if added > 0 {
        announce_membership(&state, &ch, target, true).await?;
    }
    Ok(Json(json!({"ok": true, "added": added > 0})))
}

#[derive(Deserialize)]
pub struct DmReq {
    pub user_id: i64,
}

/// Get or create the DM channel between the caller and another workspace member.
pub async fn open_dm(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(ws): Path<i64>,
    Json(req): Json<DmReq>,
) -> AppResult<Json<ChannelSummary>> {
    access::require_workspace_member(&state.db, ws, user.id).await?;
    if !access::is_workspace_member(&state.db, ws, req.user_id).await? {
        return Err(AppError::NotFound);
    }
    let (a, b) = (user.id.min(req.user_id), user.id.max(req.user_id));
    let name = format!("dm-{a}-{b}");
    let existing: Option<i64> = sqlx::query_scalar(
        "SELECT id FROM channels WHERE workspace_id = ? AND name = ? AND is_dm = 1",
    )
    .bind(ws)
    .bind(&name)
    .fetch_optional(&state.db)
    .await?;
    let id = match existing {
        Some(id) => id,
        None => {
            let now = now_ms();
            let res = sqlx::query(
                "INSERT INTO channels (workspace_id, name, topic, is_private, is_dm, created_by, created_at)
                 VALUES (?, ?, '', 1, 1, ?, ?)",
            )
            .bind(ws)
            .bind(&name)
            .bind(user.id)
            .bind(now)
            .execute(&state.db)
            .await;
            let id = match res {
                Ok(r) => r.last_insert_rowid(),
                // Lost a race with the other participant: use theirs.
                Err(e) if is_unique_violation(&e) => {
                    sqlx::query_scalar(
                        "SELECT id FROM channels WHERE workspace_id = ? AND name = ?",
                    )
                    .bind(ws)
                    .bind(&name)
                    .fetch_one(&state.db)
                    .await?
                }
                Err(e) => return Err(e.into()),
            };
            // Idempotent, so safe even if the other side created the channel concurrently.
            for uid in [a, b] {
                sqlx::query(
                    "INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)",
                )
                .bind(id)
                .bind(uid)
                .bind(now)
                .execute(&state.db)
                .await?;
            }
            id
        }
    };
    for uid in [a, b] {
        realtime::send_to_user(
            &state,
            uid,
            &json!({"type": "channels.changed", "workspace_id": ws}),
        );
    }
    Ok(Json(summary(&state, id, &user).await?))
}

#[cfg(test)]
mod tests {
    use super::normalize_channel_name;

    #[test]
    fn normalizes() {
        assert_eq!(
            normalize_channel_name("#Design Team").unwrap(),
            "design-team"
        );
        assert_eq!(normalize_channel_name("ops_2026").unwrap(), "ops_2026");
    }

    #[test]
    fn rejects_bad_names() {
        for n in ["", "a/b", "dm-1-2", "<script>", &"x".repeat(81)] {
            assert!(normalize_channel_name(n).is_err(), "{n}");
        }
    }
}
