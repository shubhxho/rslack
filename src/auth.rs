use crate::{
    db::now_ms,
    error::{AppError, AppResult, is_unique_violation},
    state::AppState,
};
use argon2::{
    Argon2,
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString, rand_core::OsRng},
};
use axum::{
    Json,
    extract::{FromRequestParts, State},
    http::{HeaderMap, header, request::Parts},
    response::IntoResponse,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

pub const COOKIE_NAME: &str = "rslack_session";
const SESSION_TTL_MS: i64 = 30 * 24 * 3600 * 1000;

#[derive(Clone, Debug, Default, Serialize, sqlx::FromRow)]
pub struct User {
    pub id: i64,
    pub username: String,
    pub display_name: String,
    pub created_at: i64,
}

/// Extractor: the authenticated user (session cookie or `Authorization: Bearer <token>`).
pub struct AuthUser(pub User);

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, AppError> {
        let token = token_from_headers(&parts.headers).ok_or(AppError::Unauthorized)?;
        let user = user_for_token(state, &token)
            .await?
            .ok_or(AppError::Unauthorized)?;
        Ok(AuthUser(user))
    }
}

pub fn token_from_headers(headers: &HeaderMap) -> Option<String> {
    if let Some(v) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        && let Some(t) = v.strip_prefix("Bearer ")
    {
        return Some(t.trim().to_string());
    }
    for v in headers.get_all(header::COOKIE) {
        let Ok(s) = v.to_str() else { continue };
        for part in s.split(';') {
            if let Some((k, val)) = part.trim().split_once('=')
                && k == COOKIE_NAME
                && !val.is_empty()
            {
                return Some(val.to_string());
            }
        }
    }
    None
}

fn hash_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

async fn user_for_token(state: &AppState, token: &str) -> AppResult<Option<User>> {
    let user = sqlx::query_as::<_, User>(
        "SELECT u.id, u.username, u.display_name, u.created_at
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ?",
    )
    .bind(hash_token(token))
    .bind(now_ms())
    .fetch_optional(&state.db)
    .await?;
    Ok(user)
}

pub async fn hash_password(password: String) -> AppResult<String> {
    tokio::task::spawn_blocking(move || {
        let salt = SaltString::generate(&mut OsRng);
        Argon2::default()
            .hash_password(password.as_bytes(), &salt)
            .map(|h| h.to_string())
            .map_err(|e| AppError::Internal(e.to_string()))
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?
}

pub async fn verify_password(password: String, hash: String) -> bool {
    tokio::task::spawn_blocking(move || {
        PasswordHash::new(&hash)
            .map(|h| {
                Argon2::default()
                    .verify_password(password.as_bytes(), &h)
                    .is_ok()
            })
            .unwrap_or(false)
    })
    .await
    .unwrap_or(false)
}

pub fn validate_username(name: &str) -> AppResult<()> {
    let ok_len = (2..=32).contains(&name.chars().count());
    let ok_chars = name
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '_' | '-' | '.'));
    if !ok_len || !ok_chars {
        return Err(AppError::bad(
            "username must be 2-32 chars of a-z, 0-9, '_', '-' or '.'",
        ));
    }
    Ok(())
}

async fn create_session(state: &AppState, user_id: i64) -> AppResult<String> {
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let now = now_ms();
    sqlx::query(
        "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    )
    .bind(hash_token(&token))
    .bind(user_id)
    .bind(now)
    .bind(now + SESSION_TTL_MS)
    .execute(&state.db)
    .await?;
    Ok(token)
}

fn session_cookie(state: &AppState, token: &str, max_age_s: i64) -> String {
    let secure = if state.config.secure_cookies {
        "; Secure"
    } else {
        ""
    };
    format!("{COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age_s}{secure}")
}

#[derive(Deserialize)]
pub struct SignupReq {
    pub username: String,
    pub password: String,
    #[serde(default)]
    pub display_name: Option<String>,
}

pub async fn signup(
    State(state): State<AppState>,
    Json(req): Json<SignupReq>,
) -> AppResult<impl IntoResponse> {
    if !state.config.allow_signup {
        return Err(AppError::Forbidden("signups are disabled".into()));
    }
    let username = req.username.trim().to_lowercase();
    validate_username(&username)?;
    if req.password.chars().count() < 8 {
        return Err(AppError::bad("password must be at least 8 characters"));
    }
    if req.password.len() > 1024 {
        return Err(AppError::bad("password too long"));
    }
    let display_name = req
        .display_name
        .map(|d| d.trim().to_string())
        .filter(|d| !d.is_empty())
        .unwrap_or_else(|| username.clone());
    if display_name.chars().count() > 64 {
        return Err(AppError::bad("display name too long (max 64)"));
    }
    let hash = hash_password(req.password).await?;
    let now = now_ms();
    let res = sqlx::query(
        "INSERT INTO users (username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(&username)
    .bind(&display_name)
    .bind(&hash)
    .bind(now)
    .execute(&state.db)
    .await;
    let id = match res {
        Ok(r) => r.last_insert_rowid(),
        Err(e) if is_unique_violation(&e) => {
            return Err(AppError::Conflict("username already taken".into()));
        }
        Err(e) => return Err(e.into()),
    };
    let user = User {
        id,
        username,
        display_name,
        created_at: now,
    };
    let token = create_session(&state, id).await?;
    let cookie = session_cookie(&state, &token, SESSION_TTL_MS / 1000);
    Ok((
        [(header::SET_COOKIE, cookie)],
        Json(json!({ "user": user, "token": token })),
    ))
}

#[derive(Deserialize)]
pub struct LoginReq {
    pub username: String,
    pub password: String,
}

pub async fn login(
    State(state): State<AppState>,
    Json(req): Json<LoginReq>,
) -> AppResult<impl IntoResponse> {
    let username = req.username.trim().to_lowercase();
    let row: Option<(i64, String, String, i64, String)> = sqlx::query_as(
        "SELECT id, username, display_name, created_at, password_hash FROM users WHERE username = ?",
    )
    .bind(&username)
    .fetch_optional(&state.db)
    .await?;
    let Some((id, username, display_name, created_at, hash)) = row else {
        // Still spend time hashing so response timing doesn't reveal which usernames exist.
        let _ = hash_password(req.password).await;
        return Err(AppError::Unauthorized);
    };
    if !verify_password(req.password, hash).await {
        return Err(AppError::Unauthorized);
    }
    let token = create_session(&state, id).await?;
    let cookie = session_cookie(&state, &token, SESSION_TTL_MS / 1000);
    let user = User {
        id,
        username,
        display_name,
        created_at,
    };
    Ok((
        [(header::SET_COOKIE, cookie)],
        Json(json!({ "user": user, "token": token })),
    ))
}

pub async fn logout(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<impl IntoResponse> {
    if let Some(token) = token_from_headers(&headers) {
        sqlx::query("DELETE FROM sessions WHERE token_hash = ?")
            .bind(hash_token(&token))
            .execute(&state.db)
            .await?;
    }
    Ok((
        [(header::SET_COOKIE, session_cookie(&state, "", 0))],
        Json(json!({ "ok": true })),
    ))
}

pub async fn me(AuthUser(user): AuthUser) -> Json<User> {
    Json(user)
}
