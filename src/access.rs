//! Membership / permission helpers shared by the handlers.
use crate::error::{AppError, AppResult};
use serde::Serialize;
use sqlx::SqlitePool;

#[derive(Clone, Debug, Serialize, sqlx::FromRow)]
pub struct ChannelRow {
    pub id: i64,
    pub workspace_id: i64,
    pub name: String,
    pub topic: String,
    pub is_private: bool,
    pub is_dm: bool,
    pub created_by: i64,
    pub created_at: i64,
}

pub async fn channel(db: &SqlitePool, id: i64) -> AppResult<ChannelRow> {
    sqlx::query_as::<_, ChannelRow>(
        "SELECT id, workspace_id, name, topic, is_private, is_dm, created_by, created_at
         FROM channels WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(db)
    .await?
    .ok_or(AppError::NotFound)
}

pub async fn is_workspace_member(db: &SqlitePool, ws: i64, user: i64) -> AppResult<bool> {
    let n: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM workspace_members WHERE workspace_id = ? AND user_id = ?",
    )
    .bind(ws)
    .bind(user)
    .fetch_one(db)
    .await?;
    Ok(n > 0)
}

pub async fn require_workspace_member(db: &SqlitePool, ws: i64, user: i64) -> AppResult<()> {
    if is_workspace_member(db, ws, user).await? {
        Ok(())
    } else {
        Err(AppError::NotFound)
    }
}

pub async fn is_channel_member(db: &SqlitePool, ch: i64, user: i64) -> AppResult<bool> {
    let n: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM channel_members WHERE channel_id = ? AND user_id = ?",
    )
    .bind(ch)
    .bind(user)
    .fetch_one(db)
    .await?;
    Ok(n > 0)
}

/// Read access: private channels and DMs need membership (404 otherwise, so their
/// existence isn't leaked); public channels are readable by any workspace member.
pub async fn require_read(db: &SqlitePool, ch: &ChannelRow, user: i64) -> AppResult<()> {
    if ch.is_private || ch.is_dm {
        if is_channel_member(db, ch.id, user).await? {
            return Ok(());
        }
        return Err(AppError::NotFound);
    }
    require_workspace_member(db, ch.workspace_id, user).await
}

/// Write access (post, react, ...) needs channel membership.
pub async fn require_member(db: &SqlitePool, ch: &ChannelRow, user: i64) -> AppResult<()> {
    require_read(db, ch, user).await?;
    if is_channel_member(db, ch.id, user).await? {
        Ok(())
    } else {
        Err(AppError::Forbidden("join the channel first".into()))
    }
}
