pub mod migrations;
pub mod models;

use std::path::Path;
use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};

/// Single shared connection wrapped in a Mutex. SQLite handles concurrent
/// readers fine in WAL mode, but rusqlite's `Connection` is `!Sync` — we
/// serialize access at the app layer. Throughput is fine for the board's
/// access patterns (low write rate, batched log inserts).
pub struct Db(pub Arc<Mutex<Connection>>);

impl Db {
    /// Run a closure with an exclusive lock on the connection. Errors from
    /// the closure propagate; lock poisoning is converted to an app error.
    pub fn with<T>(&self, f: impl FnOnce(&mut Connection) -> AppResult<T>) -> AppResult<T> {
        let mut guard = self
            .0
            .lock()
            .map_err(|_| AppError::Db("db lock poisoned".into()))?;
        f(&mut guard)
    }
}

pub fn open(db_path: &Path) -> AppResult<Connection> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut conn = Connection::open(db_path)?;
    // WAL avoids `database is locked` errors when log inserts overlap with
    // reads from the UI, at the cost of two sidecar files (-wal, -shm).
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    migrations::apply(&mut conn)?;
    Ok(conn)
}

/// Initialize the DB at the app's data dir and stash it in Tauri state.
/// Called once from the `setup` hook.
pub fn init(app: &AppHandle) -> AppResult<()> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Db(format!("resolve app_data_dir: {e}")))?;
    let db_path = dir.join("dispatch.db");
    let conn = open(&db_path)?;
    app.manage(Db(Arc::new(Mutex::new(conn))));
    Ok(())
}

/// Mark any runs left in `running` state as `aborted` AND push the cards
/// that owned them out of the `in_progress` column into `review`. Called
/// on startup so the DB reflects reality after a previous crash or
/// hard-quit (the child process can't survive the parent dying, so
/// anything flagged "running" at boot is by definition stale).
///
/// History note: an earlier version of this function left the cards in
/// `in_progress` and relied on a manual drag escape, on the theory that
/// "auto-promote" had previously respawned the agent. That was a bug in
/// a *separate* place — `drainQueue` only fires for cards landing in
/// `todo`, never `review`. Moving orphans to `review` is therefore safe
/// AND matches the live-exit codepath: when the agent exits for any
/// reason (success, fail, abort) during normal runtime, the card moves
/// to Review. A hard-quit is just another abort. Treating it the same
/// gets rid of the "stuck in In Progress with spinner" state the user
/// hits whenever they close the app mid-run.
///
/// Position handling: we use `MAX(position) + 1024` so the rescued card
/// lands at the end of the Review column — predictable order, no
/// renumbering of unrelated cards, same scheme `board_move_card` uses
/// when the caller doesn't pin a specific position.
pub fn reset_orphan_runs(db: &Db, now: i64) -> AppResult<()> {
    db.with(|conn| {
        // Step 1: mark any straggler runs as aborted. The single UPDATE
        // is cheap and keeps the audit trail honest. After this call
        // there are no `running` runs in the DB by definition.
        conn.execute(
            "UPDATE runs SET status = 'aborted', ended_at = ?1 \
             WHERE status = 'running'",
            [now],
        )?;

        // Step 2: rescue every card sitting in `in_progress`. Key
        // invariant: at boot time NO agent process is alive (we just
        // started — the OS killed every child of the previous process).
        // So any card the DB still thinks is in_progress is by
        // definition orphaned. An earlier version of this function
        // tried to be clever and only rescued cards whose runs were
        // `running` in the SAME boot; that filter missed cards orphaned
        // by previous sessions whose runs were already marked aborted
        // last time, leaving them permanently stuck with a spinner.
        //
        // We compute positions per-project so the rescued card lands at
        // the end of that project's Review column without re-numbering
        // anything else. Same `MAX(position) + 1024` scheme
        // `board_move_card` uses for caller-positionless moves.
        let stuck: Vec<(String, String)> = {
            let mut stmt = conn.prepare(
                "SELECT id, project_id FROM cards WHERE column_id = 'in_progress'",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        for (card_id, project_id) in stuck {
            let position: f64 = conn
                .query_row(
                    "SELECT COALESCE(MAX(position), 0) + 1024.0 FROM cards \
                     WHERE project_id = ?1 AND column_id = 'review' AND id <> ?2",
                    rusqlite::params![&project_id, &card_id],
                    |r| r.get(0),
                )
                .unwrap_or(1024.0);
            conn.execute(
                "UPDATE cards SET column_id = 'review', position = ?1, updated_at = ?2 \
                 WHERE id = ?3",
                rusqlite::params![position, now, &card_id],
            )?;
        }
        Ok(())
    })
}
