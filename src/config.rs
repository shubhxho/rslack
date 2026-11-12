use clap::{ArgAction, Parser};
use std::path::PathBuf;

/// Runtime configuration. Every option can be set with a CLI flag or an env var.
#[derive(Parser, Debug, Clone)]
#[command(
    name = "rslack",
    version,
    about = "Self-hosted team chat (Slack-like) in a single Rust binary"
)]
pub struct Config {
    /// Address to bind to (use 0.0.0.0 to listen on all interfaces).
    #[arg(long, env = "RSLACK_HOST", default_value = "127.0.0.1")]
    pub host: String,

    /// TCP port to listen on.
    #[arg(short, long, env = "RSLACK_PORT", default_value_t = 8080)]
    pub port: u16,

    /// Directory holding the SQLite database and uploaded files.
    #[arg(long, env = "RSLACK_DATA_DIR", default_value = "./data")]
    pub data_dir: PathBuf,

    /// Maximum size of a single uploaded file, in megabytes.
    #[arg(long, env = "RSLACK_MAX_UPLOAD_MB", default_value_t = 10)]
    pub max_upload_mb: u64,

    /// Mark the session cookie `Secure` (enable when serving over HTTPS).
    #[arg(long, env = "RSLACK_SECURE_COOKIES", default_value_t = false, action = ArgAction::Set)]
    pub secure_cookies: bool,

    /// Allow new accounts to sign up.
    #[arg(long, env = "RSLACK_ALLOW_SIGNUP", default_value_t = true, action = ArgAction::Set)]
    pub allow_signup: bool,
}

impl Config {
    /// A config with defaults and the given data directory (handy for tests/embedding).
    pub fn with_data_dir(data_dir: impl Into<PathBuf>) -> Self {
        Self {
            host: "127.0.0.1".into(),
            port: 0,
            data_dir: data_dir.into(),
            max_upload_mb: 10,
            secure_cookies: false,
            allow_signup: true,
        }
    }

    pub fn max_upload_bytes(&self) -> u64 {
        self.max_upload_mb.saturating_mul(1024 * 1024)
    }

    pub fn uploads_dir(&self) -> PathBuf {
        self.data_dir.join("uploads")
    }
}
