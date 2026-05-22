//! Agent runner — spawns `claude` / `codex` headless in a worktree, streams
//! stdout/stderr to the frontend as Tauri events, and persists every line
//! into `run_logs` so a card can be reopened later and the full history
//! replayed.
//!
//! Architecture mirrors `terminal.rs`:
//!   - `Sessions = HashMap<card_id, AgentHandle>` behind a global mutex.
//!   - `agent_start` inserts a `runs` row, spawns a tokio task that owns
//!     the child, returns the `run_id` immediately.
//!   - The task reads stdout + stderr line-by-line, emits
//!     `agent://card/<id>/log` events, batches DB inserts every 50 lines
//!     or 250ms (whichever first) so we don't open a transaction per
//!     character on long runs.
//!   - On exit (clean / killed / idle-timeout), runs `git status
//!     --porcelain` in the worktree; `hadChanges = !output.is_empty()`.
//!     Emits `agent://card/<id>/exit` with `{ runId, code, hadChanges }`
//!     so the frontend can auto-move the card to Review.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;
use tokio::time::{interval, timeout, Instant};

use crate::commands::{resolve_repo, run_git_string};
use crate::db::Db;
use crate::error::{AppError, AppResult};

/// One in-flight agent. We only need the kill signal here — the spawned
/// task owns the child and does all the streaming itself.
struct AgentHandle {
    run_id: String,
    kill: mpsc::Sender<()>,
}

type Sessions = Arc<Mutex<HashMap<String, AgentHandle>>>;

fn sessions() -> Sessions {
    static HOLDER: OnceLock<Sessions> = OnceLock::new();
    HOLDER
        .get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
        .clone()
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentStartResult {
    pub run_id: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LogPayload {
    run_id: String,
    stream: &'static str,
    line: String,
    ts: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ExitPayload {
    run_id: String,
    code: Option<i32>,
    had_changes: bool,
    reason: &'static str,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub running: bool,
    pub run_id: Option<String>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Per-run knobs that come straight from the card row. `model` /
/// `reasoning` are CLI-specific opaque strings; we forward them to the
/// CLI's own flags when present, otherwise the CLI uses its default.
/// `fast_mode` is an advisory hint — for now we map it to codex's
/// `model_reasoning_effort=minimal` override (skipping any explicit
/// reasoning) and ignore it for claude (no equivalent flag).
#[derive(Default, Clone, Debug)]
struct RunConfig {
    model: Option<String>,
    reasoning: Option<String>,
    fast_mode: bool,
}

fn build_cli_invocation(
    cli_id: &str,
    prompt: &str,
    cfg: &RunConfig,
) -> AppResult<(&'static str, Vec<String>)> {
    // Same shape as commands::ai::build_cli_invocation. Kept duplicated here
    // (rather than re-exported) so agent.rs can evolve independently if we
    // later need agent-specific flags (e.g. --dangerously-skip-permissions).
    match cli_id {
        "claude" => {
            let mut args: Vec<String> = Vec::with_capacity(4);
            // `--model` accepts the shortcuts (sonnet, opus, haiku) and
            // full ids. NULL/unset means the CLI picks its default.
            if let Some(m) = cfg.model.as_deref().filter(|s| !s.is_empty()) {
                args.push("--model".into());
                args.push(m.to_string());
            }
            args.push("-p".into());
            args.push(prompt.to_string());
            Ok(("claude", args))
        }
        "codex" => {
            let mut args: Vec<String> = vec!["exec".into()];
            if let Some(m) = cfg.model.as_deref().filter(|s| !s.is_empty()) {
                args.push("--model".into());
                args.push(m.to_string());
            }
            // Reasoning effort flows through codex's `-c key=value`
            // config override knob. Fast mode wins over an explicit
            // reasoning value: the whole point is "skip the thinking".
            let effort: Option<String> = if cfg.fast_mode {
                Some("minimal".into())
            } else {
                cfg.reasoning.as_deref().filter(|s| !s.is_empty()).map(|s| s.to_string())
            };
            if let Some(e) = effort {
                args.push("-c".into());
                args.push(format!("model_reasoning_effort={e}"));
            }
            args.push(prompt.to_string());
            Ok(("codex", args))
        }
        other => Err(AppError::msg(format!("Unsupported AI CLI: {other}"))),
    }
}

/// Argv has a hard OS-level size limit (`E2BIG`); above this threshold we
/// pipe the prompt over stdin instead. Both `claude -p` and `codex exec`
/// accept the prompt arg OR stdin when no arg is given — we always pass a
/// short placeholder + stdin to keep the codepath uniform when triggered.
const STDIN_PROMPT_THRESHOLD: usize = 100_000;

/// No output for this long → assume the agent is hung on an interactive
/// prompt (which we can't answer over a null stdin) and kill it. 10 minutes
/// is generous for tool-use turns where Claude can think silently.
const IDLE_TIMEOUT_SECS: u64 = 600;

const LOG_BATCH_SIZE: usize = 50;
const LOG_FLUSH_INTERVAL_MS: u64 = 250;

#[tauri::command]
pub async fn agent_start(
    app: AppHandle,
    db: State<'_, Db>,
    card_id: String,
    prompt: String,
    agent_id: String,
    worktree_path: String,
) -> AppResult<AgentStartResult> {
    let worktree = resolve_repo(&worktree_path)?;
    // Per-card run config: NULL columns map to RunConfig defaults so a
    // card with no overrides behaves exactly like before.
    let cfg = db.with(|conn| {
        let row: (Option<String>, Option<String>, i64) = conn
            .query_row(
                "SELECT model, reasoning, fast_mode FROM cards WHERE id = ?1",
                [&card_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap_or((None, None, 0));
        Ok(RunConfig {
            model: row.0,
            reasoning: row.1,
            fast_mode: row.2 != 0,
        })
    })?;
    let (program, args) = build_cli_invocation(&agent_id, &prompt, &cfg)?;

    {
        let s = sessions();
        let map = s
            .lock()
            .map_err(|_| AppError::msg("agent sessions mutex poisoned"))?;
        if map.contains_key(&card_id) {
            return Err(AppError::msg(format!(
                "agent already running for card {card_id}"
            )));
        }
    }

    let run_id = uuid::Uuid::new_v4().to_string();
    let started_at = now_ms();
    db.with(|conn| {
        conn.execute(
            "INSERT INTO runs (id, card_id, prompt, agent, status, started_at) \
             VALUES (?1, ?2, ?3, ?4, 'running', ?5)",
            (
                &run_id,
                &card_id,
                &prompt,
                &agent_id,
                started_at,
            ),
        )?;
        Ok(())
    })?;

    let (kill_tx, kill_rx) = mpsc::channel::<()>(1);
    {
        let s = sessions();
        let mut map = s
            .lock()
            .map_err(|_| AppError::msg("agent sessions mutex poisoned"))?;
        map.insert(
            card_id.clone(),
            AgentHandle {
                run_id: run_id.clone(),
                kill: kill_tx,
            },
        );
    }

    let db_arc = db.0.clone();
    let app_for_task = app.clone();
    let run_id_for_task = run_id.clone();
    let card_id_for_task = card_id.clone();
    let worktree_for_task = worktree.clone();
    let program_owned = program.to_string();

    tokio::spawn(async move {
        let result = run_agent_task(
            app_for_task.clone(),
            db_arc.clone(),
            card_id_for_task.clone(),
            run_id_for_task.clone(),
            program_owned,
            args,
            prompt,
            worktree_for_task,
            kill_rx,
        )
        .await;

        // Always drop the session entry — even on error — so the card can be
        // retried without "already running" blocking it.
        if let Ok(mut map) = sessions().lock() {
            map.remove(&card_id_for_task);
        }

        let (code, had_changes, reason) = match result {
            Ok(outcome) => outcome,
            Err(e) => {
                // Stream the error so the user sees what went wrong in the
                // card timeline; persistence below records it too.
                let payload = LogPayload {
                    run_id: run_id_for_task.clone(),
                    stream: "stderr",
                    line: format!("squint: agent task failed: {e}"),
                    ts: now_ms(),
                };
                let _ = app_for_task
                    .emit(&format!("agent://card/{card_id_for_task}/log"), payload.clone());
                let _ = persist_logs(&db_arc, &[payload]);
                (None, false, "error")
            }
        };

        let ended_at = now_ms();
        let status = match (reason, code) {
            ("killed", _) => "aborted",
            ("idle_timeout", _) => "aborted",
            ("error", _) => "failed",
            (_, Some(0)) => "succeeded",
            (_, Some(_)) => "failed",
            (_, None) => "failed",
        };
        let _ = Db(db_arc.clone()).with(|conn| {
            conn.execute(
                "UPDATE runs SET status = ?1, exit_code = ?2, ended_at = ?3 WHERE id = ?4",
                (status, code.map(|c| c as i64), ended_at, &run_id_for_task),
            )?;
            Ok(())
        });

        let _ = app_for_task.emit(
            &format!("agent://card/{card_id_for_task}/exit"),
            ExitPayload {
                run_id: run_id_for_task,
                code,
                had_changes,
                reason,
            },
        );
    });

    Ok(AgentStartResult { run_id })
}

/// Owns the child process and the streaming/persistence loop. Returns
/// `(exit_code, had_changes, reason)` where `reason ∈ {"clean", "killed",
/// "idle_timeout"}` so the outer task can decide the final `runs.status`.
#[allow(clippy::too_many_arguments)]
async fn run_agent_task(
    app: AppHandle,
    db: Arc<Mutex<rusqlite::Connection>>,
    card_id: String,
    run_id: String,
    program: String,
    mut args: Vec<String>,
    prompt: String,
    worktree: PathBuf,
    mut kill_rx: mpsc::Receiver<()>,
) -> AppResult<(Option<i32>, bool, &'static str)> {
    let use_stdin = prompt.len() > STDIN_PROMPT_THRESHOLD;
    if use_stdin {
        // Drop the inline prompt arg; both supported CLIs read stdin when
        // no prompt is provided.
        args.retain(|a| a != &prompt);
    }

    let mut cmd = Command::new(&program);
    cmd.current_dir(&worktree)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(if use_stdin { Stdio::piped() } else { Stdio::null() });

    // Same env scrub as commands::ai::run_ai_cli — keeps WARP/iTerm/VSCode
    // notification daemons from attaching to our spawned agent process.
    for var in [
        "TERM_PROGRAM",
        "TERM_PROGRAM_VERSION",
        "TERM_SESSION_ID",
        "WARP_SESSION_ID",
        "WARP_IS_LOCAL_SHELL_SESSION",
        "WARP_USE_SSH_WRAPPER",
        "WARP_HONOR_PS1",
        "WARP_BLOCK_ID",
        "ITERM_SESSION_ID",
        "ITERM_PROFILE",
        "VSCODE_INJECTION",
        "VSCODE_IPC_HOOK_CLI",
        "VSCODE_GIT_IPC_HANDLE",
        "VSCODE_PID",
    ] {
        cmd.env_remove(var);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::msg(format!("failed to spawn {program}: {e}")))?;

    if use_stdin {
        if let Some(mut stdin) = child.stdin.take() {
            use tokio::io::AsyncWriteExt;
            stdin
                .write_all(prompt.as_bytes())
                .await
                .map_err(|e| AppError::msg(format!("write prompt to stdin: {e}")))?;
            // Closing stdin signals end-of-prompt to the CLI.
            drop(stdin);
        }
    }

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::msg("child stdout missing"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::msg("child stderr missing"))?;

    let (line_tx, mut line_rx) = mpsc::channel::<(&'static str, String, i64)>(256);

    let line_tx_out = line_tx.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            if line_tx_out
                .send(("stdout", line, now_ms()))
                .await
                .is_err()
            {
                break;
            }
        }
    });

    let line_tx_err = line_tx;
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            if line_tx_err
                .send(("stderr", line, now_ms()))
                .await
                .is_err()
            {
                break;
            }
        }
    });

    let log_event = format!("agent://card/{card_id}/log");
    let mut batch: Vec<LogPayload> = Vec::with_capacity(LOG_BATCH_SIZE);
    let mut flush_tick = interval(Duration::from_millis(LOG_FLUSH_INTERVAL_MS));
    flush_tick.tick().await; // discard immediate tick
    let mut last_activity = Instant::now();

    let (exit_code, reason): (Option<i32>, &'static str) = loop {
        tokio::select! {
            biased;
            _ = kill_rx.recv() => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                break (None, "killed");
            }
            maybe_line = line_rx.recv() => {
                match maybe_line {
                    Some((stream, line, ts)) => {
                        last_activity = Instant::now();
                        let payload = LogPayload {
                            run_id: run_id.clone(),
                            stream,
                            line,
                            ts,
                        };
                        let _ = app.emit(&log_event, payload.clone());
                        batch.push(payload);
                        if batch.len() >= LOG_BATCH_SIZE {
                            if let Err(e) = persist_logs(&db, &batch) {
                                eprintln!("agent: log batch persist failed: {e}");
                            }
                            batch.clear();
                        }
                    }
                    None => {
                        // Both stdout and stderr closed — wait for exit code.
                        let status = child.wait().await
                            .map_err(|e| AppError::msg(format!("await child: {e}")))?;
                        break (status.code(), "clean");
                    }
                }
            }
            _ = flush_tick.tick() => {
                if !batch.is_empty() {
                    if let Err(e) = persist_logs(&db, &batch) {
                        eprintln!("agent: log batch persist failed: {e}");
                    }
                    batch.clear();
                }
                if last_activity.elapsed() > Duration::from_secs(IDLE_TIMEOUT_SECS) {
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                    break (None, "idle_timeout");
                }
            }
            // Safety net: if the process exits without closing pipes (shouldn't
            // happen but Tokio sometimes splits the signal from EOF), poll
            // wait() periodically.
            wait_result = timeout(Duration::from_millis(1000), child.wait()) => {
                if let Ok(Ok(status)) = wait_result {
                    // Drain any pending lines that landed between the last
                    // recv and now.
                    while let Ok((stream, line, ts)) = line_rx.try_recv() {
                        let payload = LogPayload { run_id: run_id.clone(), stream, line, ts };
                        let _ = app.emit(&log_event, payload.clone());
                        batch.push(payload);
                    }
                    break (status.code(), "clean");
                }
            }
        }
    };

    if !batch.is_empty() {
        if let Err(e) = persist_logs(&db, &batch) {
            eprintln!("agent: final log batch persist failed: {e}");
        }
    }

    let had_changes = match run_git_string(&worktree, &["status", "--porcelain"]) {
        Ok(out) => !out.trim().is_empty(),
        Err(_) => false,
    };

    Ok((exit_code, had_changes, reason))
}

fn persist_logs(
    db: &Arc<Mutex<rusqlite::Connection>>,
    batch: &[LogPayload],
) -> AppResult<()> {
    let mut conn = db
        .lock()
        .map_err(|_| AppError::msg("db lock poisoned"))?;
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO run_logs (run_id, ts, stream, line) VALUES (?1, ?2, ?3, ?4)",
        )?;
        for entry in batch {
            stmt.execute((&entry.run_id, entry.ts, entry.stream, &entry.line))?;
        }
    }
    tx.commit()?;
    Ok(())
}

#[tauri::command]
pub async fn agent_abort(card_id: String) -> AppResult<()> {
    let kill = {
        let s = sessions();
        let map = s
            .lock()
            .map_err(|_| AppError::msg("agent sessions mutex poisoned"))?;
        map.get(&card_id).map(|h| h.kill.clone())
    };
    if let Some(kill) = kill {
        // try_send: the task is the sole receiver and the channel size is 1;
        // if it's full, a kill is already in flight.
        let _ = kill.try_send(());
    }
    Ok(())
}

#[tauri::command]
pub fn agent_status(card_id: String) -> AppResult<AgentStatus> {
    let s = sessions();
    let map = s
        .lock()
        .map_err(|_| AppError::msg("agent sessions mutex poisoned"))?;
    Ok(match map.get(&card_id) {
        Some(h) => AgentStatus {
            running: true,
            run_id: Some(h.run_id.clone()),
        },
        None => AgentStatus {
            running: false,
            run_id: None,
        },
    })
}

/// Kill every running agent. Called from the Tauri `ExitRequested` handler
/// so closing the window doesn't leave orphan `claude` / `codex` processes.
pub fn shutdown_all(app: &AppHandle) {
    let kills: Vec<mpsc::Sender<()>> = sessions()
        .lock()
        .ok()
        .map(|m| m.values().map(|h| h.kill.clone()).collect())
        .unwrap_or_default();
    for k in kills {
        let _ = k.try_send(());
    }
    // Best-effort: mark DB rows as aborted so a restart sees them as such
    // (the per-run task will also do this, but it may not get a chance to
    // run before the process exits).
    if let Some(db) = app.try_state::<Db>() {
        let now = now_ms();
        let _ = db.with(|conn| {
            conn.execute(
                "UPDATE runs SET status = 'aborted', ended_at = ?1 \
                 WHERE status = 'running'",
                [now],
            )?;
            Ok(())
        });
    }
}
