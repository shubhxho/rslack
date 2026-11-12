use crate::{config::Config, realtime::Hub};
use sqlx::SqlitePool;
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    pub db: SqlitePool,
    pub hub: Arc<Hub>,
    pub config: Arc<Config>,
}
