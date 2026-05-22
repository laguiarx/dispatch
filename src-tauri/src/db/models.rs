use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub repo_path: String,
    pub name: String,
    pub default_base: Option<String>,
    pub created_at: i64,
    pub pinned_at: Option<i64>,
    pub position: Option<f64>,
    pub setup_script: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub description: String,
    pub column_id: String,
    pub position: f64,
    pub agent: String,
    pub priority: String,
    pub branch_name: Option<String>,
    pub worktree_path: Option<String>,
    pub base_branch: Option<String>,
    pub pr_url: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    /// 1-based per-project sequence. Set on insert via MAX+1; the v8
    /// migration backfills existing rows by creation order. Optional in
    /// the type signature only so we tolerate decoding rows that some
    /// future migration created without it.
    pub task_number: Option<i64>,
    /// CLI-specific model id (`sonnet`, `gpt-5-codex`, …). NULL = use
    /// the CLI's own default. Editable until the card leaves Backlog.
    pub model: Option<String>,
    /// Reasoning effort (`low` / `medium` / `high` / `extra-high`).
    /// Currently mapped to `codex -c model_reasoning_effort=<level>`;
    /// claude doesn't expose this via CLI so it's ignored there.
    pub reasoning: Option<String>,
    /// Hint to the CLI mapping that the user wants speed over depth.
    /// Currently advisory only — interpretation depends on the agent
    /// (e.g. claude may switch to haiku, codex may force minimal
    /// reasoning). Stored as i64 because SQLite has no native bool.
    pub fast_mode: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: String,
    pub card_id: String,
    pub prompt: String,
    pub agent: String,
    pub status: String,
    pub exit_code: Option<i64>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectScript {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub command: String,
    pub icon: String,
    pub position: f64,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub card_id: String,
    pub filename: String,
    pub mime_type: String,
    pub size_bytes: i64,
    pub stored_path: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunLog {
    pub id: i64,
    pub run_id: String,
    pub ts: i64,
    pub stream: String,
    pub line: String,
}
