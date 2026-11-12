use crate::{
    access::{self, ChannelRow},
    auth::AuthUser,
    db::now_ms,
    error::{AppError, AppResult},
    realtime,
    state::AppState,
};
use axum::{
    Json,
    extract::{Path, Query, State},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::SqlitePool;

pub const MAX_BODY_CHARS: usize = 8000;

#[derive(Clone, Debug, Serialize, sqlx::FromRow)]
pub struct MessageRow {
    pub id: i64,
    pub channel_id: i64,
    pub user_id: i64,
    pub username: String,
    pub display_name: String,
    pub parent_id: Option<i64>,
    pub body: String,
    pub created_at: i64,
    pub edited_at: Option<i64>,
    pub deleted: bool,
    pub reply_count: i64,
    pub last_reply_at: Option<i64>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Reaction {
    pub emoji: String,
    pub count: usize,
    pub user_ids: Vec<i64>,
}

#[derive(Clone, Debug, Serialize, sqlx::FromRow)]
pub struct Attachment {
    pub id: i64,
    #[serde(skip)]
    pub message_id: Option<i64>,
    pub filename: String,
    pub content_type: String,
    pub size: i64,
    #[sqlx(skip)]
    pub url: String,
}

impl Attachment {
    pub fn with_url(mut self) -> Self {
        self.url = format!("/api/files/{}", self.id);
        self
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct Message {
    #[serde(flatten)]
    pub row: MessageRow,
    pub reactions: Vec<Reaction>,
    pub attachments: Vec<Attachment>,
}

/// Shared SELECT for messages; deleted bodies are blanked out.
pub const MSG_SELECT: &str = "
SELECT m.id, m.channel_id, m.user_id, u.username, u.display_name, m.parent_id,
       CASE WHEN m.deleted = 1 THEN '' ELSE m.body END AS body,
       m.created_at, m.edited_at, m.deleted,
       (SELECT COUNT(*) FROM messages r WHERE r.parent_id = m.id AND r.deleted = 0) AS reply_count,
       (SELECT MAX(r.created_at) FROM messages r WHERE r.parent_id = m.id AND r.deleted = 0) AS last_reply_at
FROM messages m JOIN users u ON u.id = m.user_id";

/// Attach reactions and attachments to message rows (two batched queries).
pub async fn hydrate(db: &SqlitePool, rows: Vec<MessageRow>) -> AppResult<Vec<Message>> {
    if rows.is_empty() {
        return Ok(vec![]);
    }
    let ids = serde_json::to_string(&rows.iter().map(|r| r.id).collect::<Vec<_>>())
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let reactions: Vec<(i64, String, i64)> = sqlx::query_as(
        "SELECT message_id, emoji, user_id FROM reactions
         WHERE message_id IN (SELECT value FROM json_each(?)) ORDER BY created_at, rowid",
    )
    .bind(&ids)
    .fetch_all(db)
    .await?;
    let attachments = sqlx::query_as::<_, Attachment>(
        "SELECT id, message_id, filename, content_type, size FROM attachments
         WHERE message_id IN (SELECT value FROM json_each(?)) ORDER BY id",
    )
    .bind(&ids)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let mut rs: Vec<Reaction> = Vec::new();
            for (_, emoji, uid) in reactions.iter().filter(|(m, _, _)| *m == row.id) {
                match rs.iter_mut().find(|r| &r.emoji == emoji) {
                    Some(r) => {
                        r.count += 1;
                        r.user_ids.push(*uid);
                    }
                    None => rs.push(Reaction {
                        emoji: emoji.clone(),
                        count: 1,
                        user_ids: vec![*uid],
                    }),
                }
            }
            let atts = if row.deleted {
                vec![]
            } else {
                attachments
                    .iter()
                    .filter(|a| a.message_id == Some(row.id))
                    .cloned()
                    .map(Attachment::with_url)
                    .collect()
            };
            Message {
                row,
                reactions: rs,
                attachments: atts,
            }
        })
        .collect())
}

pub async fn load(db: &SqlitePool, id: i64) -> AppResult<Message> {
    let sql = format!("{MSG_SELECT} WHERE m.id = ?");
    let row = sqlx::query_as::<_, MessageRow>(&sql)
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or(AppError::NotFound)?;
    Ok(hydrate(db, vec![row]).await?.remove(0))
}

async fn message_and_channel(
    state: &AppState,
    id: i64,
    user: i64,
) -> AppResult<(Message, ChannelRow)> {
    let msg = load(&state.db, id).await?;
    let ch = access::channel(&state.db, msg.row.channel_id).await?;
    access::require_read(&state.db, &ch, user).await?;
    Ok((msg, ch))
}

#[derive(Deserialize)]
pub struct ListQuery {
    pub before: Option<i64>,
    pub limit: Option<i64>,
}

/// Top-level messages of a channel, oldest first. Paginate with `?before=<id>`.
pub async fn list(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<i64>,
    Query(q): Query<ListQuery>,
) -> AppResult<Json<Value>> {
    let ch = access::channel(&state.db, id).await?;
    access::require_read(&state.db, &ch, user.id).await?;
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let sql = format!(
        "{MSG_SELECT} WHERE m.channel_id = ? AND m.parent_id IS NULL AND m.id < ?
           AND (m.deleted = 0 OR EXISTS (SELECT 1 FROM messages r WHERE r.parent_id = m.id AND r.deleted = 0))
         ORDER BY m.id DESC LIMIT ?"
    );
    let mut rows = sqlx::query_as::<_, MessageRow>(&sql)
        .bind(id)
        .bind(q.before.unwrap_or(i64::MAX))
        .bind(limit + 1)
        .fetch_all(&state.db)
        .await?;
    let has_more = rows.len() as i64 > limit;
    rows.truncate(limit as usize);
    rows.reverse();
    let messages = hydrate(&state.db, rows).await?;
    Ok(Json(json!({ "messages": messages, "has_more": has_more })))
}

#[derive(Deserialize)]
pub struct CreateReq {
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub parent_id: Option<i64>,
    #[serde(default)]
    pub attachment_ids: Vec<i64>,
}

pub async fn create(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(channel_id): Path<i64>,
    Json(req): Json<CreateReq>,
) -> AppResult<Json<Message>> {
    let ch = access::channel(&state.db, channel_id).await?;
    access::require_member(&state.db, &ch, user.id).await?;
    let body = req.body.trim().to_string();
    if body.is_empty() && req.attachment_ids.is_empty() {
        return Err(AppError::bad("message is empty"));
    }
    if body.chars().count() > MAX_BODY_CHARS {
        return Err(AppError::bad(format!(
            "message too long (max {MAX_BODY_CHARS} chars)"
        )));
    }
    if req.attachment_ids.len() > 10 {
        return Err(AppError::bad("at most 10 attachments per message"));
    }
    if let Some(pid) = req.parent_id {
        let parent: Option<(i64, Option<i64>, bool)> =
            sqlx::query_as("SELECT channel_id, parent_id, deleted FROM messages WHERE id = ?")
                .bind(pid)
                .fetch_optional(&state.db)
                .await?;
        match parent {
            Some((cid, None, false)) if cid == channel_id => {}
            Some((_, Some(_), _)) => return Err(AppError::bad("can't reply to a reply")),
            _ => return Err(AppError::bad("parent message not found in this channel")),
        }
    }
    let now = now_ms();
    let mut tx = state.db.begin().await?;
    let id = sqlx::query(
        "INSERT INTO messages (channel_id, user_id, parent_id, body, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(channel_id)
    .bind(user.id)
    .bind(req.parent_id)
    .bind(&body)
    .bind(now)
    .execute(&mut *tx)
    .await?
    .last_insert_rowid();
    for aid in &req.attachment_ids {
        let n = sqlx::query(
            "UPDATE attachments SET message_id = ? WHERE id = ? AND uploader_id = ? AND message_id IS NULL",
        )
        .bind(id)
        .bind(aid)
        .bind(user.id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if n != 1 {
            return Err(AppError::bad(format!("attachment {aid} is not available")));
        }
    }
    if req.parent_id.is_none() {
        sqlx::query(
            "UPDATE channel_members SET last_read_id = MAX(last_read_id, ?) WHERE channel_id = ? AND user_id = ?",
        )
        .bind(id)
        .bind(channel_id)
        .bind(user.id)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    let msg = load(&state.db, id).await?;
    realtime::broadcast_to_channel(
        &state,
        channel_id,
        &json!({"type": "message.new", "channel_id": channel_id, "message": msg}),
    )
    .await?;
    if let Some(pid) = req.parent_id {
        broadcast_updated(&state, pid).await?;
    }
    Ok(Json(msg))
}

async fn broadcast_updated(state: &AppState, id: i64) -> AppResult<()> {
    let msg = load(&state.db, id).await?;
    realtime::broadcast_to_channel(
        state,
        msg.row.channel_id,
        &json!({"type": "message.updated", "channel_id": msg.row.channel_id, "message": msg}),
    )
    .await
}

/// A thread: the parent plus all (non-deleted) replies, oldest first.
pub async fn thread(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let (parent, _) = message_and_channel(&state, id, user.id).await?;
    if parent.row.parent_id.is_some() {
        return Err(AppError::bad("not a top-level message"));
    }
    let sql = format!("{MSG_SELECT} WHERE m.parent_id = ? AND m.deleted = 0 ORDER BY m.id");
    let rows = sqlx::query_as::<_, MessageRow>(&sql)
        .bind(id)
        .fetch_all(&state.db)
        .await?;
    let replies = hydrate(&state.db, rows).await?;
    Ok(Json(json!({ "parent": parent, "replies": replies })))
}

#[derive(Deserialize)]
pub struct EditReq {
    pub body: String,
}

pub async fn edit(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<i64>,
    Json(req): Json<EditReq>,
) -> AppResult<Json<Message>> {
    let (msg, ch) = message_and_channel(&state, id, user.id).await?;
    if msg.row.user_id != user.id {
        return Err(AppError::Forbidden(
            "you can only edit your own messages".into(),
        ));
    }
    if msg.row.deleted {
        return Err(AppError::NotFound);
    }
    let body = req.body.trim();
    if body.is_empty() && msg.attachments.is_empty() {
        return Err(AppError::bad("message is empty"));
    }
    if body.chars().count() > MAX_BODY_CHARS {
        return Err(AppError::bad(format!(
            "message too long (max {MAX_BODY_CHARS} chars)"
        )));
    }
    sqlx::query("UPDATE messages SET body = ?, edited_at = ? WHERE id = ?")
        .bind(body)
        .bind(now_ms())
        .bind(id)
        .execute(&state.db)
        .await?;
    let msg = load(&state.db, id).await?;
    realtime::broadcast_to_channel(
        &state,
        ch.id,
        &json!({"type": "message.updated", "channel_id": ch.id, "message": msg}),
    )
    .await?;
    Ok(Json(msg))
}

/// Soft delete: the row stays (so threads survive) but body/attachments are hidden.
pub async fn delete(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let (msg, ch) = message_and_channel(&state, id, user.id).await?;
    if msg.row.user_id != user.id {
        return Err(AppError::Forbidden(
            "you can only delete your own messages".into(),
        ));
    }
    if msg.row.deleted {
        return Ok(Json(json!({"ok": true})));
    }
    let mut tx = state.db.begin().await?;
    sqlx::query("UPDATE messages SET deleted = 1, body = '' WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM reactions WHERE message_id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    realtime::broadcast_to_channel(
        &state,
        ch.id,
        &json!({"type": "message.deleted", "channel_id": ch.id, "message_id": id,
                "parent_id": msg.row.parent_id, "has_replies": msg.row.reply_count > 0}),
    )
    .await?;
    if let Some(pid) = msg.row.parent_id {
        broadcast_updated(&state, pid).await?;
    }
    Ok(Json(json!({"ok": true})))
}

#[derive(Deserialize)]
pub struct ReactReq {
    pub emoji: String,
}

/// Toggle the caller's reaction with `emoji` on a message.
pub async fn toggle_reaction(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<i64>,
    Json(req): Json<ReactReq>,
) -> AppResult<Json<Value>> {
    let (msg, ch) = message_and_channel(&state, id, user.id).await?;
    access::require_member(&state.db, &ch, user.id).await?;
    if msg.row.deleted {
        return Err(AppError::NotFound);
    }
    let emoji = req.emoji.trim();
    if emoji.is_empty() || emoji.chars().count() > 16 || emoji.chars().any(char::is_whitespace) {
        return Err(AppError::bad("invalid emoji"));
    }
    let removed =
        sqlx::query("DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?")
            .bind(id)
            .bind(user.id)
            .bind(emoji)
            .execute(&state.db)
            .await?
            .rows_affected();
    if removed == 0 {
        let distinct: i64 =
            sqlx::query_scalar("SELECT COUNT(DISTINCT emoji) FROM reactions WHERE message_id = ?")
                .bind(id)
                .fetch_one(&state.db)
                .await?;
        if distinct >= 50 {
            return Err(AppError::bad(
                "too many different reactions on this message",
            ));
        }
        sqlx::query(
            "INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)",
        )
        .bind(id)
        .bind(user.id)
        .bind(emoji)
        .bind(now_ms())
        .execute(&state.db)
        .await?;
    }
    let msg = load(&state.db, id).await?;
    let ev = json!({"type": "reaction.updated", "channel_id": ch.id, "message_id": id,
                    "parent_id": msg.row.parent_id, "reactions": msg.reactions});
    realtime::broadcast_to_channel(&state, ch.id, &ev).await?;
    Ok(Json(
        json!({"added": removed == 0, "reactions": msg.reactions}),
    ))
}

#[derive(Deserialize)]
pub struct ReadReq {
    pub message_id: i64,
}

pub async fn mark_read(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<i64>,
    Json(req): Json<ReadReq>,
) -> AppResult<Json<Value>> {
    let n = sqlx::query(
        "UPDATE channel_members SET last_read_id = MAX(last_read_id, ?) WHERE channel_id = ? AND user_id = ?",
    )
    .bind(req.message_id)
    .bind(id)
    .bind(user.id)
    .execute(&state.db)
    .await?
    .rows_affected();
    if n == 0 {
        return Err(AppError::NotFound);
    }
    realtime::send_to_user(
        &state,
        user.id,
        &json!({"type": "channel.read", "channel_id": id, "message_id": req.message_id}),
    );
    Ok(Json(json!({"ok": true})))
}
