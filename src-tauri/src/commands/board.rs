//! Board CRUD — thin wrappers over rusqlite for projects, cards, runs, and
//! run logs. No business logic here; side effects (spawning agents,
//! removing worktrees) are orchestrated frontend-side via separate calls
//! to `commands::agent::*` and `commands::git::git_worktree_*`.

use rusqlite::{params, Row};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::models::{Card, Project, ProjectScript, Run, RunLog};
use crate::db::Db;
use crate::error::{AppError, AppResult};

const COLUMNS: &[&str] = &["backlog", "todo", "in_progress", "review", "done"];

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn validate_column(column_id: &str) -> AppResult<()> {
    if !COLUMNS.contains(&column_id) {
        return Err(AppError::msg(format!("unknown column id: {column_id}")));
    }
    Ok(())
}

fn validate_agent(agent: &str) -> AppResult<()> {
    if agent != "claude" && agent != "codex" {
        return Err(AppError::msg(format!("unknown agent id: {agent}")));
    }
    Ok(())
}

fn validate_priority(priority: &str) -> AppResult<()> {
    if !["low", "med", "high"].contains(&priority) {
        return Err(AppError::msg(format!("unknown priority: {priority}")));
    }
    Ok(())
}

fn project_from_row(row: &Row<'_>) -> rusqlite::Result<Project> {
    Ok(Project {
        id: row.get(0)?,
        repo_path: row.get(1)?,
        name: row.get(2)?,
        default_base: row.get(3)?,
        created_at: row.get(4)?,
        pinned_at: row.get(5)?,
        position: row.get(6)?,
        setup_script: row.get(7)?,
    })
}

const PROJECT_COLS: &str =
    "id, repo_path, name, default_base, created_at, pinned_at, position, setup_script";

/// Column list used by every SELECT * equivalent on `cards`. Order MUST
/// match `card_from_row`'s index reads — keep them in sync when adding
/// fields.
const CARD_COLS: &str =
    "id, project_id, title, description, column_id, position, agent, priority, \
     branch_name, worktree_path, base_branch, pr_url, created_at, updated_at, \
     task_number, model, reasoning, fast_mode";

fn card_from_row(row: &Row<'_>) -> rusqlite::Result<Card> {
    Ok(Card {
        id: row.get(0)?,
        project_id: row.get(1)?,
        title: row.get(2)?,
        description: row.get(3)?,
        column_id: row.get(4)?,
        position: row.get(5)?,
        agent: row.get(6)?,
        priority: row.get(7)?,
        branch_name: row.get(8)?,
        worktree_path: row.get(9)?,
        base_branch: row.get(10)?,
        pr_url: row.get(11)?,
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
        task_number: row.get(14)?,
        model: row.get(15)?,
        reasoning: row.get(16)?,
        fast_mode: row.get(17)?,
    })
}

fn run_from_row(row: &Row<'_>) -> rusqlite::Result<Run> {
    Ok(Run {
        id: row.get(0)?,
        card_id: row.get(1)?,
        prompt: row.get(2)?,
        agent: row.get(3)?,
        status: row.get(4)?,
        exit_code: row.get(5)?,
        started_at: row.get(6)?,
        ended_at: row.get(7)?,
    })
}

fn log_from_row(row: &Row<'_>) -> rusqlite::Result<RunLog> {
    Ok(RunLog {
        id: row.get(0)?,
        run_id: row.get(1)?,
        ts: row.get(2)?,
        stream: row.get(3)?,
        line: row.get(4)?,
    })
}

#[tauri::command]
pub fn board_list_projects(db: State<'_, Db>) -> AppResult<Vec<Project>> {
    db.with(|conn| {
        let sql = format!("SELECT {PROJECT_COLS} FROM projects ORDER BY name");
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map([], project_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
}

/// Idempotent — called on every repo open. Returns the existing project
/// row if the repo path is already known, otherwise inserts and returns
/// the new one. `default_base` is refreshed on every call so cached
/// "branched off main/master" data stays current as the user renames
/// branches in the repo.
#[tauri::command]
pub fn board_ensure_project(
    db: State<'_, Db>,
    repo_path: String,
    name: String,
    default_base: Option<String>,
) -> AppResult<Project> {
    db.with(|conn| {
        let now = now_ms();
        let sql = format!(
            "SELECT {PROJECT_COLS} FROM projects WHERE repo_path = ?1"
        );
        let existing: Option<Project> = conn
            .query_row(&sql, [&repo_path], project_from_row)
            .ok();

        if let Some(mut p) = existing {
            // Refresh name + default_base if they changed; preserve id.
            conn.execute(
                "UPDATE projects SET name = ?1, default_base = ?2 WHERE id = ?3",
                params![&name, &default_base, &p.id],
            )?;
            p.name = name;
            p.default_base = default_base;
            return Ok(p);
        }

        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO projects (id, repo_path, name, default_base, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![&id, &repo_path, &name, &default_base, now],
        )?;
        Ok(Project {
            id,
            repo_path,
            name,
            default_base,
            created_at: now,
            pinned_at: None,
            position: None,
            setup_script: None,
        })
    })
}

/// Reorder projects. Takes a list of project ids in the new visual
/// order and writes evenly-spaced positions so we can drop into any
/// gap later without recomputing the whole sequence.
#[tauri::command]
pub fn board_reorder_projects(
    db: State<'_, Db>,
    ids: Vec<String>,
) -> AppResult<()> {
    db.with(|conn| {
        let tx = conn.transaction()?;
        for (idx, id) in ids.iter().enumerate() {
            let pos = (idx as f64 + 1.0) * 1024.0;
            tx.execute(
                "UPDATE projects SET position = ?1 WHERE id = ?2",
                params![pos, id],
            )?;
        }
        tx.commit()?;
        Ok(())
    })
}

/// Patch a project's mutable fields. Every patchable field is `Option`-
/// wrapped so callers can target one thing at a time; `pinned` is a
/// tri-state where `Some(true)` pins, `Some(false)` unpins, `None`
/// leaves it alone. `setup_script` likewise: `Some("")` clears, `Some(_)`
/// sets, `None` ignores.
#[tauri::command]
pub fn board_update_project(
    db: State<'_, Db>,
    id: String,
    name: Option<String>,
    pinned: Option<bool>,
    setup_script: Option<String>,
) -> AppResult<Project> {
    db.with(|conn| {
        let now = now_ms();
        if let Some(n) = name.as_deref() {
            conn.execute(
                "UPDATE projects SET name = ?1 WHERE id = ?2",
                params![n, &id],
            )?;
        }
        if let Some(p) = pinned {
            let value: Option<i64> = if p { Some(now) } else { None };
            conn.execute(
                "UPDATE projects SET pinned_at = ?1 WHERE id = ?2",
                params![value, &id],
            )?;
        }
        if let Some(script) = setup_script.as_deref() {
            // Treat empty string as "clear". Trim so all-whitespace
            // scripts don't accidentally trigger a setup run.
            let trimmed = script.trim();
            let value: Option<&str> = if trimmed.is_empty() { None } else { Some(trimmed) };
            conn.execute(
                "UPDATE projects SET setup_script = ?1 WHERE id = ?2",
                params![value, &id],
            )?;
        }
        let sql = format!(
            "SELECT {PROJECT_COLS} FROM projects WHERE id = ?1"
        );
        let project = conn.query_row(&sql, [&id], project_from_row)?;
        Ok(project)
    })
}

/// All cards across every project, ordered by column then position. Used
/// for the "All projects" view in the sidebar — each row carries its
/// `project_id` so the UI can chip-tag with the project name.
#[tauri::command]
pub fn board_list_all_cards(db: State<'_, Db>) -> AppResult<Vec<Card>> {
    db.with(|conn| {
        let sql =
            format!("SELECT {CARD_COLS} FROM cards ORDER BY column_id, position");
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map([], card_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
}

/// Drop a project from the DB. Cards CASCADE off the FK and runs CASCADE
/// off cards, so this leaves the schema clean. Worktrees on disk are
/// NOT removed — the user can clean those by hand if needed (or via the
/// Archive action on individual cards before deletion).
#[tauri::command]
pub fn board_delete_project(db: State<'_, Db>, id: String) -> AppResult<()> {
    db.with(|conn| {
        conn.execute("DELETE FROM projects WHERE id = ?1", [&id])?;
        Ok(())
    })
}

#[tauri::command]
pub fn board_list_cards(
    db: State<'_, Db>,
    project_id: String,
) -> AppResult<Vec<Card>> {
    db.with(|conn| {
        let sql = format!(
            "SELECT {CARD_COLS} FROM cards WHERE project_id = ?1 \
             ORDER BY column_id, position"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map([&project_id], card_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
}

/// Insert a new card at the bottom of the Backlog column. We compute the
/// next `position` as `max(position) + 1024` so the user can drag-reorder
/// without immediate restitching; fractional indexing handles the rest.
#[tauri::command]
pub fn board_create_card(
    db: State<'_, Db>,
    project_id: String,
    title: String,
    description: String,
    agent: String,
    priority: Option<String>,
    branch_name: Option<String>,
    // Captured at creation time so the user can pick the branch the
    // agent's worktree will fork off of (main / develop / a feature
    // branch / etc.). NULL means "fall back to project.default_base at
    // spawn time" — keeps cards created before this field shipped
    // working without a migration.
    base_branch: Option<String>,
    model: Option<String>,
    reasoning: Option<String>,
    fast_mode: Option<bool>,
) -> AppResult<Card> {
    validate_agent(&agent)?;
    let priority = priority.unwrap_or_else(|| "med".to_string());
    validate_priority(&priority)?;
    let fast_mode_int: i64 = if fast_mode.unwrap_or(false) { 1 } else { 0 };
    db.with(|conn| {
        let now = now_ms();
        let id = uuid::Uuid::new_v4().to_string();
        // Atomic per-project sequence: position + task_number are both
        // derived from the same project's existing rows, so we wrap
        // both reads + the insert in a transaction. Without this two
        // concurrent IPC calls could grab the same MAX and collide.
        let tx = conn.transaction()?;
        let next_pos: f64 = tx
            .query_row(
                "SELECT COALESCE(MAX(position), 0) + 1024.0 FROM cards \
                 WHERE project_id = ?1 AND column_id = 'backlog'",
                [&project_id],
                |r| r.get(0),
            )
            .unwrap_or(1024.0);
        let task_number: i64 = tx
            .query_row(
                "SELECT COALESCE(MAX(task_number), 0) + 1 FROM cards \
                 WHERE project_id = ?1",
                [&project_id],
                |r| r.get(0),
            )
            .unwrap_or(1);
        tx.execute(
            "INSERT INTO cards (id, project_id, title, description, column_id, position, agent, priority, \
                                branch_name, worktree_path, base_branch, pr_url, created_at, updated_at, task_number, \
                                model, reasoning, fast_mode) \
             VALUES (?1, ?2, ?3, ?4, 'backlog', ?5, ?6, ?7, ?8, NULL, ?9, NULL, ?10, ?10, ?11, ?12, ?13, ?14)",
            params![
                &id, &project_id, &title, &description, next_pos, &agent, &priority, &branch_name,
                &base_branch,
                now, task_number, &model, &reasoning, fast_mode_int,
            ],
        )?;
        let sql = format!("SELECT {CARD_COLS} FROM cards WHERE id = ?1");
        let card = tx.query_row(&sql, [&id], card_from_row)?;
        tx.commit()?;
        Ok(card)
    })
}

/// Patch fields on an existing card. Every field is optional; only the
/// ones present are updated. Used by the detail drawer (title / desc /
/// agent picker) and by the agent-runner orchestration to stamp
/// `branch_name`, `worktree_path`, `base_branch`, `pr_url` after the
/// underlying git/PR operations succeed.
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CardPatch {
    pub title: Option<String>,
    pub description: Option<String>,
    pub agent: Option<String>,
    pub priority: Option<String>,
    pub branch_name: Option<String>,
    pub worktree_path: Option<String>,
    pub base_branch: Option<String>,
    pub pr_url: Option<String>,
    pub model: Option<String>,
    pub reasoning: Option<String>,
    pub fast_mode: Option<bool>,
}

#[tauri::command]
pub fn board_update_card(
    db: State<'_, Db>,
    id: String,
    patch: CardPatch,
) -> AppResult<Card> {
    if let Some(agent) = patch.agent.as_deref() {
        validate_agent(agent)?;
    }
    if let Some(priority) = patch.priority.as_deref() {
        validate_priority(priority)?;
    }
    db.with(|conn| {
        let now = now_ms();
        // Build an UPDATE that only touches provided fields. COALESCE keeps
        // the existing value when a parameter is NULL.
        // `fast_mode` is a boolean so we can't use Option<&str> + COALESCE
        // the same way — translate to nullable i64 (None = leave alone).
        let fast_mode_param: Option<i64> = patch.fast_mode.map(|b| if b { 1 } else { 0 });
        conn.execute(
            "UPDATE cards SET \
                title = COALESCE(?1, title), \
                description = COALESCE(?2, description), \
                agent = COALESCE(?3, agent), \
                priority = COALESCE(?4, priority), \
                branch_name = COALESCE(?5, branch_name), \
                worktree_path = COALESCE(?6, worktree_path), \
                base_branch = COALESCE(?7, base_branch), \
                pr_url = COALESCE(?8, pr_url), \
                model = COALESCE(?9, model), \
                reasoning = COALESCE(?10, reasoning), \
                fast_mode = COALESCE(?11, fast_mode), \
                updated_at = ?12 \
             WHERE id = ?13",
            params![
                patch.title,
                patch.description,
                patch.agent,
                patch.priority,
                patch.branch_name,
                patch.worktree_path,
                patch.base_branch,
                patch.pr_url,
                patch.model,
                patch.reasoning,
                fast_mode_param,
                now,
                &id,
            ],
        )?;
        let sql = format!("SELECT {CARD_COLS} FROM cards WHERE id = ?1");
        let card = conn.query_row(&sql, [&id], card_from_row)?;
        Ok(card)
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveCardArgs {
    pub id: String,
    pub column_id: String,
    /// Optional explicit position. When omitted, the card is appended to
    /// the end of the target column (max+1024).
    pub position: Option<f64>,
}

#[tauri::command]
pub fn board_move_card(
    db: State<'_, Db>,
    args: MoveCardArgs,
) -> AppResult<Card> {
    validate_column(&args.column_id)?;
    db.with(|conn| {
        let now = now_ms();
        let project_id: String = conn.query_row(
            "SELECT project_id FROM cards WHERE id = ?1",
            [&args.id],
            |r| r.get(0),
        )?;
        let position = match args.position {
            Some(p) => p,
            None => conn
                .query_row(
                    "SELECT COALESCE(MAX(position), 0) + 1024.0 FROM cards \
                     WHERE project_id = ?1 AND column_id = ?2 AND id <> ?3",
                    params![&project_id, &args.column_id, &args.id],
                    |r| r.get(0),
                )
                .unwrap_or(1024.0),
        };
        conn.execute(
            "UPDATE cards SET column_id = ?1, position = ?2, updated_at = ?3 \
             WHERE id = ?4",
            params![&args.column_id, position, now, &args.id],
        )?;
        // Use the shared CARD_COLS so this query keeps matching
        // `card_from_row` whenever new columns get added. Previously
        // hardcoded a 14-column list and silently broke after v8 + v9
        // migrations added task_number / model / reasoning / fast_mode:
        // every move IPC errored out and the exit handler's `.catch`
        // swallowed it — card stayed in In Progress.
        let sql = format!("SELECT {CARD_COLS} FROM cards WHERE id = ?1");
        let card = conn.query_row(&sql, [&args.id], card_from_row)?;
        Ok(card)
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteCardResult {
    pub worktree_path: Option<String>,
    pub branch_name: Option<String>,
}

/// Delete a card. Returns the worktree path + branch name (when set) so
/// the frontend can call `git_worktree_remove` to clean up on disk and
/// `git branch -D` to drop the ref — we don't do that here because the
/// worktree path may live outside the project's repo, and the IPC
/// thread should stay free for unrelated UI work while git walks the
/// file tree.
#[tauri::command]
pub fn board_delete_card(
    db: State<'_, Db>,
    id: String,
) -> AppResult<DeleteCardResult> {
    db.with(|conn| {
        let row: Option<(Option<String>, Option<String>)> = conn
            .query_row(
                "SELECT worktree_path, branch_name FROM cards WHERE id = ?1",
                [&id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .ok();
        let (worktree_path, branch_name) = row.unwrap_or((None, None));
        conn.execute("DELETE FROM cards WHERE id = ?1", [&id])?;
        Ok(DeleteCardResult {
            worktree_path,
            branch_name,
        })
    })
}

/// Clear the worktree pointer on a card. Used by the Archive action on
/// Done cards: the user has a PR open and doesn't need the local worktree
/// anymore. The card itself stays for history. Frontend should call
/// `git_worktree_remove` first; this just stamps the DB.
#[tauri::command]
pub fn board_clear_card_worktree(
    db: State<'_, Db>,
    id: String,
) -> AppResult<Card> {
    db.with(|conn| {
        let now = now_ms();
        conn.execute(
            "UPDATE cards SET worktree_path = NULL, branch_name = NULL, \
             updated_at = ?1 WHERE id = ?2",
            params![now, &id],
        )?;
        let sql = format!("SELECT {CARD_COLS} FROM cards WHERE id = ?1");
        let card = conn.query_row(&sql, [&id], card_from_row)?;
        Ok(card)
    })
}

#[tauri::command]
pub fn board_list_runs(
    db: State<'_, Db>,
    card_id: String,
) -> AppResult<Vec<Run>> {
    db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, card_id, prompt, agent, status, exit_code, started_at, ended_at \
             FROM runs WHERE card_id = ?1 ORDER BY started_at DESC",
        )?;
        let rows = stmt
            .query_map([&card_id], run_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
}

/// Stream-friendly log fetch — pass `after_id` (the last `id` you already
/// have) to get only newer rows. Used by the card detail drawer when it
/// reopens to backfill history before subscribing to live events.
#[tauri::command]
pub fn board_list_run_logs(
    db: State<'_, Db>,
    run_id: String,
    after_id: Option<i64>,
) -> AppResult<Vec<RunLog>> {
    db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, run_id, ts, stream, line FROM run_logs \
             WHERE run_id = ?1 AND id > ?2 ORDER BY id",
        )?;
        let rows = stmt
            .query_map(
                params![&run_id, after_id.unwrap_or(0)],
                log_from_row,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
}

// ---------- project scripts -----------------------------------------

fn script_from_row(row: &Row<'_>) -> rusqlite::Result<ProjectScript> {
    Ok(ProjectScript {
        id: row.get(0)?,
        project_id: row.get(1)?,
        title: row.get(2)?,
        command: row.get(3)?,
        icon: row.get(4)?,
        position: row.get(5)?,
        created_at: row.get(6)?,
    })
}

#[tauri::command]
pub fn project_script_list(
    db: State<'_, Db>,
    project_id: String,
) -> AppResult<Vec<ProjectScript>> {
    db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, project_id, title, command, icon, position, created_at \
             FROM project_scripts WHERE project_id = ?1 ORDER BY position",
        )?;
        let rows = stmt
            .query_map([&project_id], script_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
}

#[tauri::command]
pub fn project_script_create(
    db: State<'_, Db>,
    project_id: String,
    title: String,
    command: String,
    icon: Option<String>,
) -> AppResult<ProjectScript> {
    db.with(|conn| {
        let now = now_ms();
        let id = uuid::Uuid::new_v4().to_string();
        let icon = icon.unwrap_or_else(|| "play".to_string());
        let next_pos: f64 = conn
            .query_row(
                "SELECT COALESCE(MAX(position), 0) + 1024.0 FROM project_scripts \
                 WHERE project_id = ?1",
                [&project_id],
                |r| r.get(0),
            )
            .unwrap_or(1024.0);
        conn.execute(
            "INSERT INTO project_scripts \
             (id, project_id, title, command, icon, position, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![&id, &project_id, &title, &command, &icon, next_pos, now],
        )?;
        let row = conn.query_row(
            "SELECT id, project_id, title, command, icon, position, created_at \
             FROM project_scripts WHERE id = ?1",
            [&id],
            script_from_row,
        )?;
        Ok(row)
    })
}

#[tauri::command]
pub fn project_script_update(
    db: State<'_, Db>,
    id: String,
    title: Option<String>,
    command: Option<String>,
    icon: Option<String>,
) -> AppResult<ProjectScript> {
    db.with(|conn| {
        conn.execute(
            "UPDATE project_scripts SET \
                title = COALESCE(?1, title), \
                command = COALESCE(?2, command), \
                icon = COALESCE(?3, icon) \
             WHERE id = ?4",
            params![title, command, icon, &id],
        )?;
        let row = conn.query_row(
            "SELECT id, project_id, title, command, icon, position, created_at \
             FROM project_scripts WHERE id = ?1",
            [&id],
            script_from_row,
        )?;
        Ok(row)
    })
}

#[tauri::command]
pub fn project_script_delete(db: State<'_, Db>, id: String) -> AppResult<()> {
    db.with(|conn| {
        conn.execute("DELETE FROM project_scripts WHERE id = ?1", [&id])?;
        Ok(())
    })
}

