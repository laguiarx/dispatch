use std::process::{Command, Stdio};

use crate::commands::{resolve_repo, run_git_string};
use crate::error::{AppError, AppResult};

// Test-only marker to simulate main advancing while develop is open in Squint.
/// One AI CLI we know how to drive. `available = true` when the CLI binary
/// is on PATH (detected via `which`).
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCliInfo {
    pub id: String,
    pub name: String,
    pub available: bool,
    /// Best-effort version string. Empty when the CLI isn't installed.
    pub version: String,
}

/// Probe PATH for each supported CLI and return an ordered list.
///
/// Async + `spawn_blocking` per candidate so the two `--version` invocations
/// run in parallel and don't stall the Tauri IPC thread. `claude` and
/// `codex` are Node binaries with non-trivial startup (200-500ms each), so
/// running them serially on the IPC thread was visibly slow on first open
/// of Preferences > AI.
#[tauri::command]
pub async fn detect_ai_clis() -> AppResult<Vec<AiCliInfo>> {
    let candidates: &[(&str, &str, &str)] = &[
        ("claude", "Claude Code", "--version"),
        ("codex", "Codex", "--version"),
    ];
    let handles: Vec<_> = candidates
        .iter()
        .map(|(id, name, version_arg)| {
            let id = id.to_string();
            let name = name.to_string();
            let version_arg = version_arg.to_string();
            tokio::task::spawn_blocking(move || {
                let available = which(&id);
                let version = if available {
                    Command::new(&id)
                        .arg(&version_arg)
                        .stdin(Stdio::null())
                        .stderr(Stdio::null())
                        .output()
                        .ok()
                        .and_then(|o| String::from_utf8(o.stdout).ok())
                        .map(|s| s.trim().to_string())
                        .unwrap_or_default()
                } else {
                    String::new()
                };
                AiCliInfo {
                    id,
                    name,
                    available,
                    version,
                }
            })
        })
        .collect();
    let mut out = Vec::with_capacity(handles.len());
    for h in handles {
        out.push(
            h.await
                .map_err(|e| AppError::msg(format!("cli probe panicked: {e}")))?,
        );
    }
    Ok(out)
}

/// Run an AI CLI against the repo with the given prompt and return its
/// stdout. The CLI inherits no terminal — anything written to stderr is
/// surfaced as an error if the exit code is non-zero, otherwise discarded.
///
/// **Async + spawn_blocking on purpose.** AI CLIs (claude, codex) can take
/// 10+ seconds and `Command::output()` is a synchronous blocking call. A
/// plain `pub fn` Tauri command runs on the Tauri runtime thread, so the
/// whole IPC channel would stall until the CLI returned — making the rest
/// of the app feel frozen. By marking the command `async` and offloading
/// the blocking spawn/wait to tokio's blocking thread pool, other IPC
/// calls (git status, file reads, settings writes) keep flowing while the
/// AI is thinking.
#[tauri::command]
pub async fn run_ai_cli(
    cli_id: String,
    prompt: String,
    repo_path: String,
) -> AppResult<String> {
    let repo = resolve_repo(&repo_path)?;
    let (program, args) = build_cli_invocation(&cli_id, &prompt)?;
    let program = program.to_string();
    let cli_id_for_err = cli_id.clone();

    let output = tokio::task::spawn_blocking(move || {
        let mut cmd = Command::new(program);
        cmd.current_dir(&repo)
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Strip terminal-emulator identification env vars before
        // spawning. If Squint was launched from a WARP / iTerm / VS Code
        // terminal, those programs inject env vars like `WARP_SESSION_ID`
        // and `TERM_PROGRAM=WarpTerminal` that their daemon then uses to
        // attach notifications to descendant processes. The result: every
        // AI commit-message / PR-description run made `claude` show up as
        // a tracked WARP "block", popping notifications. Clearing the
        // markers makes the subprocess look like a generic CLI run from
        // a non-emulator launcher, which is what it actually is.
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
        cmd.output()
    })
    .await
    .map_err(|e| AppError::msg(format!("ai task panicked: {e}")))?
    .map_err(|e| AppError::msg(format!("failed to spawn {cli_id_for_err}: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(AppError::msg(if stderr.is_empty() {
            format!("{cli_id} exited with {}", output.status)
        } else {
            stderr
        }));
    }
    let stdout = String::from_utf8(output.stdout)?;
    Ok(stdout)
}

fn build_cli_invocation(
    cli_id: &str,
    prompt: &str,
) -> AppResult<(&'static str, Vec<String>)> {
    match cli_id {
        "claude" => Ok(("claude", vec!["-p".into(), prompt.to_string()])),
        "codex" => Ok(("codex", vec!["exec".into(), prompt.to_string()])),
        other => Err(AppError::msg(format!("Unsupported AI CLI: {other}"))),
    }
}

/// One of the optional integrations Review Desk knows about. Reported by
/// `detect_integrations` so the onboarding modal can render a tidy checklist.
///
/// `install_command` is the actual shell command we can pipe into the
/// integrated terminal when the user clicks ▶ — distinct from the human
/// `install_hint` displayed underneath. We split the two because the
/// official Homebrew installer is a multi-line `curl | bash`, which reads
/// awkwardly as a hint but executes fine as a command.
///
/// `requires` names a different integration whose absence would make
/// `install_command` fail (e.g. `git/gh` need `brew`, `claude/codex` need
/// `npm`). The frontend uses this to disable the ▶ button with a
/// "Install <prereq> first" tooltip rather than letting the user run
/// something that's guaranteed to error in their terminal.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Integration {
    pub id: String,
    pub name: String,
    pub purpose: String,
    pub install_hint: String,
    pub install_command: String,
    pub requires: Option<String>,
    pub available: bool,
}

/// Detection result returned to the onboarding modal. All four tools
/// (git, gh, claude-code, codex) install via Homebrew now, so the only
/// prerequisite we need to surface separately is brew itself — which is
/// already its own row in `integrations`.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationsReport {
    pub integrations: Vec<Integration>,
}

#[tauri::command]
pub fn detect_integrations() -> AppResult<IntegrationsReport> {
    // Each row: (id, name, purpose, hint, command, requires)
    let rows: &[(&str, &str, &str, &str, &str, Option<&str>)] = &[
        (
            "brew",
            "Homebrew",
            "Package manager — prerequisite for installing git and gh below.",
            "Official installer from brew.sh",
            "/bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"",
            None,
        ),
        (
            "git",
            "Git",
            "Required — diff, stage, commit, branch operations.",
            "brew install git",
            "brew install git",
            Some("brew"),
        ),
        (
            "gh",
            "GitHub CLI",
            "Open PRs and pull repository metadata.",
            "brew install gh && gh auth login",
            "brew install gh",
            Some("brew"),
        ),
        (
            "claude",
            "Claude Code",
            "Powers the AI Assist actions (commit / PR / summary / risk).",
            "brew install --cask claude-code",
            "brew install --cask claude-code",
            Some("brew"),
        ),
        (
            "codex",
            "Codex CLI",
            "Alternative backend for AI Assist.",
            "brew install --cask codex",
            "brew install --cask codex",
            Some("brew"),
        ),
    ];
    let integrations = rows
        .iter()
        .map(|(id, name, purpose, hint, command, requires)| Integration {
            id: id.to_string(),
            name: name.to_string(),
            purpose: purpose.to_string(),
            install_hint: hint.to_string(),
            install_command: command.to_string(),
            requires: requires.map(|s| s.to_string()),
            available: which(id),
        })
        .collect();
    Ok(IntegrationsReport { integrations })
}

/// Best-effort `which` — checks each PATH entry for an executable file.
fn which(binary: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(binary);
        if candidate.is_file() {
            return true;
        }
    }
    false
}

/// Return a chunk of unified diff useful to feed an AI prompt.
///
/// - `staged`  → `git diff --cached`
/// - `working` → `git diff HEAD` (staged + unstaged)
/// - `branch`  → diff vs the upstream / origin/HEAD (best-effort)
#[tauri::command]
pub fn git_diff_for_ai(repo_path: String, scope: String) -> AppResult<String> {
    let repo = resolve_repo(&repo_path)?;
    match scope.as_str() {
        "staged" => {
            // If nothing is staged, fall back to the whole working diff so
            // the AI still has something to summarize.
            let staged = run_git_string(&repo, &["diff", "--cached"])?;
            if staged.trim().is_empty() {
                run_git_string(&repo, &["diff", "HEAD"])
            } else {
                Ok(staged)
            }
        }
        "working" => run_git_string(&repo, &["diff", "HEAD"]),
        "branch" => {
            // Prefer the configured upstream; otherwise diff against the
            // default branch on `origin` (origin/HEAD), and finally fall
            // back to whatever HEAD currently differs from.
            if let Ok(diff) = run_git_string(&repo, &["diff", "@{u}...HEAD"]) {
                if !diff.trim().is_empty() {
                    return Ok(diff);
                }
            }
            if let Ok(diff) =
                run_git_string(&repo, &["diff", "origin/HEAD...HEAD"])
            {
                if !diff.trim().is_empty() {
                    return Ok(diff);
                }
            }
            run_git_string(&repo, &["diff", "HEAD"])
        }
        other => Err(AppError::msg(format!("Unknown diff scope: {other}"))),
    }
}

/// Return the recent commit list scoped like `git_diff_for_ai` — used to
/// build a PR-description prompt.
#[tauri::command]
pub fn git_log_for_ai(repo_path: String, scope: String) -> AppResult<String> {
    let repo = resolve_repo(&repo_path)?;
    let range = match scope.as_str() {
        "branch" => "@{u}..HEAD",
        _ => "HEAD~10..HEAD",
    };
    let fmt = "--format=%h %s";
    // Try the requested range first; if it fails (no upstream, shallow
    // clone, etc.) fall back to "last 10 commits".
    if let Ok(log) = run_git_string(&repo, &["log", fmt, range]) {
        if !log.trim().is_empty() {
            return Ok(log);
        }
    }
    run_git_string(&repo, &["log", fmt, "HEAD~10..HEAD"])
        .or_else(|_| run_git_string(&repo, &["log", fmt]))
}
