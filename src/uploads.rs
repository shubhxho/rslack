use crate::{
    access,
    auth::AuthUser,
    db::now_ms,
    error::{AppError, AppResult},
    messages::Attachment,
    state::AppState,
};
use axum::{
    Json,
    body::Body,
    extract::{Multipart, Path, State},
    http::{StatusCode, header},
    response::Response,
};
use tokio::io::AsyncWriteExt;

const INLINE_TYPES: &[&str] = &[
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "text/plain",
    "application/pdf",
];

fn sanitize_filename(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '"' | '\\' | '/'))
        .take(200)
        .collect();
    let cleaned = cleaned.trim().trim_start_matches('.').to_string();
    if cleaned.is_empty() {
        "file".into()
    } else {
        cleaned
    }
}

/// `multipart/form-data` upload with a `file` field. Returns the attachment, which
/// can then be referenced in `attachment_ids` when posting a message.
pub async fn upload(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    mut multipart: Multipart,
) -> AppResult<Json<Attachment>> {
    let limit = state.config.max_upload_bytes();
    let too_large = || {
        AppError::PayloadTooLarge(format!(
            "file exceeds {} MB limit",
            state.config.max_upload_mb
        ))
    };
    let map_err = |e: axum::extract::multipart::MultipartError| {
        if e.status() == StatusCode::PAYLOAD_TOO_LARGE {
            too_large()
        } else {
            AppError::bad(e.body_text())
        }
    };
    while let Some(mut field) = multipart.next_field().await.map_err(map_err)? {
        if field.name() != Some("file") {
            continue;
        }
        let filename = sanitize_filename(field.file_name().unwrap_or("file"));
        let content_type = field
            .content_type()
            .filter(|c| !c.is_empty() && *c != "application/octet-stream")
            .map(str::to_string)
            .unwrap_or_else(|| {
                mime_guess::from_path(&filename)
                    .first_or_octet_stream()
                    .essence_str()
                    .to_string()
            });
        let storage_name = uuid::Uuid::new_v4().simple().to_string();
        let path = state.config.uploads_dir().join(&storage_name);
        tokio::fs::create_dir_all(state.config.uploads_dir()).await?;
        let mut file = tokio::fs::File::create(&path).await?;
        let mut size: u64 = 0;
        let result: AppResult<()> = async {
            while let Some(chunk) = field.chunk().await.map_err(map_err)? {
                size += chunk.len() as u64;
                if size > limit {
                    return Err(too_large());
                }
                file.write_all(&chunk).await?;
            }
            file.flush().await?;
            Ok(())
        }
        .await;
        if let Err(e) = result {
            drop(file);
            let _ = tokio::fs::remove_file(&path).await;
            return Err(e);
        }
        let id = sqlx::query(
            "INSERT INTO attachments (message_id, uploader_id, filename, content_type, size, storage_name, created_at)
             VALUES (NULL, ?, ?, ?, ?, ?, ?)",
        )
        .bind(user.id)
        .bind(&filename)
        .bind(&content_type)
        .bind(size as i64)
        .bind(&storage_name)
        .bind(now_ms())
        .execute(&state.db)
        .await?
        .last_insert_rowid();
        return Ok(Json(
            Attachment {
                id,
                message_id: None,
                filename,
                content_type,
                size: size as i64,
                url: String::new(),
            }
            .with_url(),
        ));
    }
    Err(AppError::bad("missing 'file' field"))
}

/// Download an attachment. Allowed for the uploader, or anyone who can read the
/// channel the attachment was posted in.
pub async fn download(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Response> {
    let row: Option<(Option<i64>, i64, String, String, String)> = sqlx::query_as(
        "SELECT message_id, uploader_id, filename, content_type, storage_name FROM attachments WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?;
    let (message_id, uploader, filename, content_type, storage) = row.ok_or(AppError::NotFound)?;
    if uploader != user.id {
        let mid = message_id.ok_or(AppError::NotFound)?;
        let (channel_id, deleted): (i64, bool) =
            sqlx::query_as("SELECT channel_id, deleted FROM messages WHERE id = ?")
                .bind(mid)
                .fetch_one(&state.db)
                .await?;
        if deleted {
            return Err(AppError::NotFound);
        }
        let ch = access::channel(&state.db, channel_id).await?;
        access::require_read(&state.db, &ch, user.id).await?;
    }
    let bytes = tokio::fs::read(state.config.uploads_dir().join(&storage))
        .await
        .map_err(|_| AppError::NotFound)?;
    let inline = INLINE_TYPES.contains(&content_type.as_str());
    let disposition = format!(
        "{}; filename=\"{}\"",
        if inline { "inline" } else { "attachment" },
        filename.replace('"', "")
    );
    let ct = if inline {
        content_type
    } else {
        "application/octet-stream".to_string()
    };
    Response::builder()
        .header(header::CONTENT_TYPE, ct)
        .header(header::CONTENT_DISPOSITION, disposition)
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(
            header::CONTENT_SECURITY_POLICY,
            "sandbox; default-src 'none'",
        )
        .header(header::CACHE_CONTROL, "private, max-age=3600")
        .body(Body::from(bytes))
        .map_err(|e| AppError::Internal(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::sanitize_filename;

    #[test]
    fn strips_paths_and_dots() {
        assert_eq!(sanitize_filename("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_filename("C:\\Users\\me\\report.pdf"), "report.pdf");
        assert_eq!(sanitize_filename(".hidden"), "hidden");
        assert_eq!(sanitize_filename(""), "file");
        assert_eq!(sanitize_filename("a\"b\n.txt"), "ab.txt");
    }
}
