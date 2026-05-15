use serde::Serialize;
use std::process::{Command, Stdio};

use crate::commands::{reject_flaggish, resolve_repo};
use crate::error::{AppError, AppResult};

/// Status of the user's `gh` CLI: is it installed, is it authenticated,
/// which hostnames does it know about? Surfaced to the frontend so the
/// PR-creation flow can fail early with a useful message instead of
/// running half the pipeline (branch, commit, push) and then exploding
/// on the final `gh pr create` call.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhStatus {
    pub installed: bool,
    pub authenticated: bool,
    /// Whichever host `gh auth status` reports first, e.g. `github.com`.
    /// `None` when not authenticated. Lets the UI label which account
    /// will be used to open the PR.
    pub hostname: Option<String>,
}

#[tauri::command]
pub async fn gh_detect_status() -> AppResult<GhStatus> {
    // spawn_blocking — both `gh --version` and `gh auth status` are
    // synchronous process spawns that can stall on slow machines.
    let status = tokio::task::spawn_blocking(|| {
        let version = Command::new("gh")
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output();
        let installed = matches!(&version, Ok(out) if out.status.success());
        if !installed {
            return GhStatus {
                installed: false,
                authenticated: false,
                hostname: None,
            };
        }
        let auth = Command::new("gh")
            .args(["auth", "status"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output();
        let (authenticated, hostname) = match auth {
            Ok(out) if out.status.success() => {
                // `gh auth status` writes a multi-line report to stderr.
                // The first "✓ Logged in to <host>" line tells us which
                // account is active.
                let stderr = String::from_utf8_lossy(&out.stderr).to_string();
                let host = stderr.lines().find_map(|line| {
                    let trimmed = line.trim_start_matches(['✓', ' ', '\t'].as_ref());
                    trimmed
                        .strip_prefix("Logged in to ")
                        .and_then(|rest| rest.split_whitespace().next())
                        .map(str::to_string)
                });
                (true, host)
            }
            _ => (false, None),
        };
        GhStatus {
            installed: true,
            authenticated,
            hostname,
        }
    })
    .await
    .map_err(|e| AppError::msg(format!("gh detect task panicked: {e}")))?;
    Ok(status)
}

/// Run `gh pr create --title ... --body ... --base ... [--head ...]` in
/// the given repo. Returns the PR URL on success (gh prints it to stdout
/// as the last line).
#[tauri::command]
pub async fn gh_pr_create(
    repo_path: String,
    title: String,
    body: String,
    base: String,
    head: Option<String>,
) -> AppResult<String> {
    let repo = resolve_repo(&repo_path)?;
    let title = title.trim().to_string();
    let body = body.trim().to_string();
    let base = base.trim().to_string();
    if title.is_empty() {
        return Err(AppError::msg("PR title is empty"));
    }
    if base.is_empty() {
        return Err(AppError::msg("PR base branch is empty"));
    }
    reject_flaggish("PR title", &title)?;
    reject_flaggish("PR base", &base)?;
    if let Some(ref h) = head {
        reject_flaggish("PR head", h)?;
    }

    let output = tokio::task::spawn_blocking(move || {
        let mut cmd = Command::new("gh");
        cmd.arg("pr")
            .arg("create")
            .arg("--title")
            .arg(&title)
            .arg("--body")
            .arg(&body)
            .arg("--base")
            .arg(&base);
        if let Some(h) = head {
            cmd.arg("--head").arg(h);
        }
        cmd.current_dir(&repo)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        cmd.output()
    })
    .await
    .map_err(|e| AppError::msg(format!("gh pr task panicked: {e}")))?
    .map_err(|e| AppError::msg(format!("failed to spawn gh: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(AppError::msg(if stderr.is_empty() {
            format!("gh pr create exited with {}", output.status)
        } else {
            stderr
        }));
    }
    // `gh` prints the PR URL as the last non-empty line; the rest is noise
    // ("Creating pull request for...", "https://...").
    let stdout = String::from_utf8_lossy(&output.stdout);
    let url = stdout
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| l.starts_with("https://"))
        .unwrap_or("")
        .to_string();
    if url.is_empty() {
        return Err(AppError::msg(format!(
            "gh pr create succeeded but no URL in stdout: {}",
            stdout.trim()
        )));
    }
    Ok(url)
}
