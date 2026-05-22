//! Card attachments — file uploads pinned to a card.
//!
//! Bytes live on disk under `app_data_dir/attachments/<card_id>/<uuid>-<filename>`
//! so the DB stays slim (we'd otherwise blob megabytes of PNGs into
//! SQLite, which kills query perf and bloats backups). The DB row keeps
//! filename, mime, size and the absolute stored path; the agent runner
//! copies the file into the card's worktree before each run so the
//! agent can read it via its normal file tools.

use std::path::PathBuf;

use rusqlite::{params, Row};
use tauri::{AppHandle, Manager, State};

use crate::db::models::Attachment;
use crate::db::Db;
use crate::error::{AppError, AppResult};

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn attachment_from_row(row: &Row<'_>) -> rusqlite::Result<Attachment> {
    Ok(Attachment {
        id: row.get(0)?,
        card_id: row.get(1)?,
        filename: row.get(2)?,
        mime_type: row.get(3)?,
        size_bytes: row.get(4)?,
        stored_path: row.get(5)?,
        created_at: row.get(6)?,
    })
}

fn attachments_dir(app: &AppHandle, card_id: &str) -> AppResult<PathBuf> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::msg(format!("resolve app_data_dir: {e}")))?;
    let dir = base.join("attachments").join(card_id);
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Strip directory components and the trailing slash that some browsers
/// include in `File.name`. Defends against `../../etc/passwd` smuggling.
fn safe_basename(name: &str) -> String {
    let trimmed = name.trim();
    let last = trimmed
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(trimmed)
        .trim();
    if last.is_empty() || last == "." || last == ".." {
        "attachment".to_string()
    } else {
        last.to_string()
    }
}

#[tauri::command]
pub fn attachment_save(
    app: AppHandle,
    db: State<'_, Db>,
    card_id: String,
    filename: String,
    mime_type: String,
    bytes: Vec<u8>,
) -> AppResult<Attachment> {
    if bytes.is_empty() {
        return Err(AppError::msg("attachment is empty"));
    }
    let safe = safe_basename(&filename);
    let id = uuid::Uuid::new_v4().to_string();
    let dir = attachments_dir(&app, &card_id)?;
    // Prefix the disk filename with the row id so two attachments with
    // the same display name don't collide on disk.
    let on_disk = dir.join(format!("{}-{}", &id[..8], &safe));
    std::fs::write(&on_disk, &bytes)?;
    let stored_path = on_disk.to_string_lossy().to_string();
    let size_bytes = bytes.len() as i64;
    let now = now_ms();

    db.with(|conn| {
        conn.execute(
            "INSERT INTO card_attachments \
             (id, card_id, filename, mime_type, size_bytes, stored_path, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![&id, &card_id, &safe, &mime_type, size_bytes, &stored_path, now],
        )?;
        Ok(())
    })?;

    Ok(Attachment {
        id,
        card_id,
        filename: safe,
        mime_type,
        size_bytes,
        stored_path,
        created_at: now,
    })
}

#[tauri::command]
pub fn attachment_list(
    db: State<'_, Db>,
    card_id: String,
) -> AppResult<Vec<Attachment>> {
    db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, card_id, filename, mime_type, size_bytes, stored_path, created_at \
             FROM card_attachments WHERE card_id = ?1 ORDER BY created_at",
        )?;
        let rows = stmt
            .query_map([&card_id], attachment_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
}

#[tauri::command]
pub fn attachment_delete(db: State<'_, Db>, id: String) -> AppResult<()> {
    let stored: Option<String> = db.with(|conn| {
        let path: Option<String> = conn
            .query_row(
                "SELECT stored_path FROM card_attachments WHERE id = ?1",
                [&id],
                |r| r.get(0),
            )
            .ok();
        conn.execute("DELETE FROM card_attachments WHERE id = ?1", [&id])?;
        Ok(path)
    })?;
    if let Some(p) = stored {
        // Best-effort — if the file's already gone the row deletion still
        // sticks.
        let _ = std::fs::remove_file(&p);
    }
    Ok(())
}

/// Read the raw bytes of a stored attachment. Used by the frontend to
/// render previews (images render via a Blob URL built from this).
#[tauri::command]
pub fn attachment_read_bytes(
    db: State<'_, Db>,
    id: String,
) -> AppResult<Vec<u8>> {
    let stored: String = db.with(|conn| {
        let path: String = conn.query_row(
            "SELECT stored_path FROM card_attachments WHERE id = ?1",
            [&id],
            |r| r.get(0),
        )?;
        Ok(path)
    })?;
    let bytes = std::fs::read(&stored)?;
    Ok(bytes)
}

/// Resolve the on-disk paths for every attachment belonging to a card.
fn list_paths_for_card(
    db: &Db,
    card_id: &str,
) -> AppResult<Vec<(String, String)>> {
    db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT filename, stored_path FROM card_attachments \
             WHERE card_id = ?1 ORDER BY created_at",
        )?;
        let rows = stmt
            .query_map([card_id], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
}

/// Copy every attachment of `card_id` into `<worktree>/.squint/attachments/`
/// so the agent can read them via its normal file-reading tools. Returns
/// the list of filenames copied (relative names — the agent only needs to
/// know what to reference, the directory is documented in the prompt).
///
/// We deliberately re-copy on every run instead of symlinking: if the
/// user deletes the attachment before re-running, we don't want a stale
/// file in the worktree pointing at the original. Re-copy keeps the
/// worktree synced with the DB state.
#[tauri::command]
pub fn attachment_stage_for_run(
    db: State<'_, Db>,
    card_id: String,
    worktree_path: String,
) -> AppResult<Vec<String>> {
    let pairs = list_paths_for_card(&db, &card_id)?;
    if pairs.is_empty() {
        return Ok(Vec::new());
    }
    let dest_dir = PathBuf::from(&worktree_path)
        .join(".squint")
        .join("attachments");
    // Clear existing staged files so deleted attachments don't linger.
    if dest_dir.exists() {
        let _ = std::fs::remove_dir_all(&dest_dir);
    }
    std::fs::create_dir_all(&dest_dir)?;
    let mut names = Vec::with_capacity(pairs.len());
    for (filename, stored_path) in pairs {
        let safe = safe_basename(&filename);
        let dest = dest_dir.join(&safe);
        std::fs::copy(&stored_path, &dest)?;
        names.push(safe);
    }
    Ok(names)
}
