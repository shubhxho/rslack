use sqlx::SqlitePool;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Open (creating if needed) the single-file SQLite database and run migrations.
pub async fn connect(data_dir: &Path) -> anyhow::Result<SqlitePool> {
    std::fs::create_dir_all(data_dir)?;
    std::fs::create_dir_all(data_dir.join("uploads"))?;
    let opts = SqliteConnectOptions::new()
        .filename(data_dir.join("rslack.db"))
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(10));
    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(opts)
        .await?;
    sqlx::migrate!("./migrations").run(&pool).await?;
    sqlx::query("DELETE FROM sessions WHERE expires_at < ?")
        .bind(now_ms())
        .execute(&pool)
        .await?;
    Ok(pool)
}

/// Milliseconds since the Unix epoch.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
