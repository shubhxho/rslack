use crate::{
    access,
    auth::AuthUser,
    error::AppResult,
    messages::{self, MSG_SELECT, MessageRow},
    state::AppState,
};
use axum::{
    Json,
    extract::{Path, Query, State},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Deserialize)]
pub struct SearchQuery {
    #[serde(default)]
    pub q: String,
}

#[derive(Serialize, sqlx::FromRow)]
struct ChannelRef {
    id: i64,
    name: String,
    is_dm: bool,
    is_private: bool,
}

/// Turn free text into a safe FTS5 query: each word quoted, prefix-matched, AND-ed.
pub fn fts_query(input: &str) -> Option<String> {
    let terms: Vec<String> = input
        .split(|c: char| !c.is_alphanumeric() && c != '_')
        .filter(|t| !t.is_empty())
        .take(8)
        .map(|t| format!("\"{t}\"*"))
        .collect();
    if terms.is_empty() {
        None
    } else {
        Some(terms.join(" "))
    }
}

/// Full-text search across channels the caller can read in a workspace.
pub async fn search(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(ws): Path<i64>,
    Query(q): Query<SearchQuery>,
) -> AppResult<Json<Value>> {
    access::require_workspace_member(&state.db, ws, user.id).await?;
    let Some(fts) = fts_query(&q.q) else {
        return Ok(Json(json!({"results": []})));
    };
    let sql = format!(
        "{MSG_SELECT}
         JOIN messages_fts f ON f.rowid = m.id
         JOIN channels c ON c.id = m.channel_id
         WHERE messages_fts MATCH ? AND c.workspace_id = ? AND m.deleted = 0
           AND (EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = ?)
                OR (c.is_private = 0 AND c.is_dm = 0))
         ORDER BY f.rank, m.id DESC LIMIT 50"
    );
    let rows = sqlx::query_as::<_, MessageRow>(&sql)
        .bind(&fts)
        .bind(ws)
        .bind(user.id)
        .fetch_all(&state.db)
        .await?;
    let msgs = messages::hydrate(&state.db, rows).await?;
    let mut results = Vec::with_capacity(msgs.len());
    for m in msgs {
        let ch = sqlx::query_as::<_, ChannelRef>(
            "SELECT id, name, is_dm, is_private FROM channels WHERE id = ?",
        )
        .bind(m.row.channel_id)
        .fetch_one(&state.db)
        .await?;
        results.push(json!({"message": m, "channel": ch}));
    }
    Ok(Json(json!({ "results": results })))
}

#[cfg(test)]
mod tests {
    use super::fts_query;

    #[test]
    fn quotes_and_prefixes_terms() {
        assert_eq!(
            fts_query("deploy plan").as_deref(),
            Some("\"deploy\"* \"plan\"*")
        );
    }

    #[test]
    fn strips_fts_syntax() {
        assert_eq!(
            fts_query("\"a\" OR NEAR(b) -c*").as_deref(),
            Some("\"a\"* \"OR\"* \"NEAR\"* \"b\"* \"c\"*")
        );
        assert_eq!(fts_query("  ** \"\" "), None);
    }

    #[test]
    fn unicode_terms() {
        assert_eq!(
            fts_query("café über").as_deref(),
            Some("\"café\"* \"über\"*")
        );
    }
}
