use rusqlite::Connection;

use crate::error::AppResult;

const MIGRATIONS: &[&str] = &[
    // v1 — board: projects, cards, runs, run_logs
    r#"
    CREATE TABLE IF NOT EXISTS projects (
        id           TEXT PRIMARY KEY,
        repo_path    TEXT NOT NULL UNIQUE,
        name         TEXT NOT NULL,
        default_base TEXT,
        created_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cards (
        id            TEXT PRIMARY KEY,
        project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title         TEXT NOT NULL,
        description   TEXT NOT NULL DEFAULT '',
        column_id     TEXT NOT NULL,
        position      REAL NOT NULL,
        agent         TEXT NOT NULL DEFAULT 'claude',
        branch_name   TEXT,
        worktree_path TEXT,
        base_branch   TEXT,
        pr_url        TEXT,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS cards_project_col
        ON cards(project_id, column_id, position);

    CREATE TABLE IF NOT EXISTS runs (
        id         TEXT PRIMARY KEY,
        card_id    TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
        prompt     TEXT NOT NULL,
        agent      TEXT NOT NULL,
        status     TEXT NOT NULL,
        exit_code  INTEGER,
        started_at INTEGER NOT NULL,
        ended_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS runs_card ON runs(card_id, started_at);

    CREATE TABLE IF NOT EXISTS run_logs (
        id     INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        ts     INTEGER NOT NULL,
        stream TEXT NOT NULL,
        line   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS run_logs_run ON run_logs(run_id, id);
    "#,
    // v2 — priority chip on cards. Defaults to 'med' so existing rows have
    // a sensible value without a backfill loop.
    r#"
    ALTER TABLE cards ADD COLUMN priority TEXT NOT NULL DEFAULT 'med';
    "#,
    // v3 — attachments. Each row is a single file the user pinned to a
    // card. The bytes live on disk under app_data_dir; the DB only
    // remembers metadata + the absolute path so we can serve previews
    // and copy the file into the worktree at agent-spawn time.
    r#"
    CREATE TABLE IF NOT EXISTS card_attachments (
        id           TEXT PRIMARY KEY,
        card_id      TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
        filename     TEXT NOT NULL,
        mime_type    TEXT NOT NULL DEFAULT '',
        size_bytes   INTEGER NOT NULL,
        stored_path  TEXT NOT NULL,
        created_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS card_attachments_card
        ON card_attachments(card_id, created_at);
    "#,
    // v4 — pinned projects float to the top of the sidebar. NULL means
    // unpinned; storing the timestamp instead of a boolean lets us sort
    // pinned items by when they were pinned later if we want to.
    r#"
    ALTER TABLE projects ADD COLUMN pinned_at INTEGER;
    "#,
    // v5 — project scripts. Per-project named commands ("dev",
    // "test", etc) that the user can run inside a card's worktree
    // straight from the card detail modal. Position controls ordering
    // in the run dropdown.
    r#"
    CREATE TABLE IF NOT EXISTS project_scripts (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title       TEXT NOT NULL,
        command     TEXT NOT NULL,
        icon        TEXT NOT NULL DEFAULT 'play',
        position    REAL NOT NULL,
        created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS project_scripts_project
        ON project_scripts(project_id, position);
    "#,
    // v6 — manual project ordering. NULL means "not manually placed
    // yet", in which case the sidebar falls back to alphabetical. Once
    // the user drags a project, all projects get assigned a numeric
    // position so subsequent drags are deterministic.
    r#"
    ALTER TABLE projects ADD COLUMN position REAL;
    "#,
    // v7 — per-project setup script. Bash that runs on worktree
    // creation, before the agent spawns — typically `bun install` and
    // any other prerequisite the agent's worktree wouldn't otherwise
    // have. NULL means "no setup needed"; we still copy bootstrap
    // files (.env etc) regardless.
    r#"
    ALTER TABLE projects ADD COLUMN setup_script TEXT;
    "#,
    // v8 — sequential task numbers, scoped per project. The card's
    // UUID is still its primary id, but humans see "T42" everywhere:
    // branch names, PR bodies, card tiles. The window function
    // backfill assigns numbers in creation order so existing cards
    // get a stable ordering. Inserts add new ones via
    // `MAX(task_number) + 1` inside the same transaction as the row
    // insert (see board_create_card).
    r#"
    ALTER TABLE cards ADD COLUMN task_number INTEGER;
    WITH numbered AS (
        SELECT id,
               ROW_NUMBER() OVER (
                   PARTITION BY project_id ORDER BY created_at, id
               ) AS n
        FROM cards
    )
    UPDATE cards
    SET task_number = (SELECT n FROM numbered WHERE numbered.id = cards.id)
    WHERE task_number IS NULL;
    CREATE INDEX IF NOT EXISTS cards_project_tasknum
        ON cards(project_id, task_number);
    "#,
    // v9 — per-card run config. `model` is CLI-specific (sonnet /
    // opus / gpt-5-codex / …); NULL means "use the CLI's default".
    // `reasoning` matches the codex `-c model_reasoning_effort` knob
    // (low|medium|high|extra-high); NULL = default. `fast_mode` is a
    // boolean stored as INTEGER (SQLite convention) — UI hint that
    // the agent should prioritize speed over thoroughness; how that
    // maps to flags is CLI-specific and may evolve.
    r#"
    ALTER TABLE cards ADD COLUMN model TEXT;
    ALTER TABLE cards ADD COLUMN reasoning TEXT;
    ALTER TABLE cards ADD COLUMN fast_mode INTEGER NOT NULL DEFAULT 0;
    "#,
];

pub fn apply(conn: &mut Connection) -> AppResult<()> {
    let current: i64 =
        conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let mut version = current as usize;
    while version < MIGRATIONS.len() {
        let sql = MIGRATIONS[version];
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        version += 1;
        tx.pragma_update(None, "user_version", version as i64)?;
        tx.commit()?;
    }
    Ok(())
}
