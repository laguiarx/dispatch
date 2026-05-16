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

/// Summary of one open PR returned to the frontend so each branch row in
/// the branch picker can render a tiny status badge (review state +
/// failing/pending CI). One row per branch the user has open as PR HEAD.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrSummary {
    pub number: u64,
    /// Local branch this PR is opened FROM (matches `BranchInfo.name`).
    pub head_ref_name: String,
    /// PR state ("OPEN" — we filter to open PRs only, but kept on the
    /// wire so the frontend can be defensive).
    pub state: String,
    /// "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | "COMMENTED" | ""
    /// Empty when GitHub hasn't decided yet (no reviewers yet).
    pub review_decision: String,
    /// "SUCCESS" | "FAILURE" | "PENDING" | "" — best-effort rollup of the
    /// status-check entries `gh` returns (commit statuses + Actions).
    pub check_status: String,
    /// Total review comments + issue comments (rough "anything new to read?"
    /// signal — we don't distinguish read vs unread, GitHub doesn't expose
    /// that to gh CLI without notifications).
    pub comment_count: u32,
    pub url: String,
}

/// `gh pr list --state open --json …` for the current repo, mapped to a
/// flat list of `PrSummary`. Called lazily when the user opens the branch
/// picker so the rows can show "PR #42 ✓ approved" / "PR #43 ⚠ changes
/// requested" / etc. We deliberately don't poll this on a timer — the
/// branch picker is the only place that consumes it, and the user is in
/// front of the dialog when they need fresh data.
#[tauri::command]
pub async fn gh_pr_list(repo_path: String) -> AppResult<Vec<PrSummary>> {
    let repo = resolve_repo(&repo_path)?;
    let output = tokio::task::spawn_blocking(move || {
        Command::new("gh")
            .args([
                "pr",
                "list",
                "--state",
                "open",
                // 100 is the gh default cap; for any single repo this is
                // far more than the user will ever have open at once.
                "--limit",
                "100",
                "--json",
                "number,headRefName,state,reviewDecision,statusCheckRollup,comments,reviews,url",
            ])
            .current_dir(&repo)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
    })
    .await
    .map_err(|e| AppError::msg(format!("gh pr list task panicked: {e}")))?
    .map_err(|e| AppError::msg(format!("failed to spawn gh: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        // Common case: not authenticated, or repo has no GitHub remote.
        // Return an empty list rather than erroring out — the UI handles
        // "no PRs" gracefully and the user already knows their gh state
        // from elsewhere.
        if stderr.contains("not a git repository")
            || stderr.contains("no default remote")
            || stderr.contains("could not determine the GitHub")
        {
            return Ok(vec![]);
        }
        return Err(AppError::msg(if stderr.is_empty() {
            format!("gh pr list exited with {}", output.status)
        } else {
            stderr
        }));
    }

    // `gh` returns a JSON array. Parse with serde_json's `Value` so we
    // can pluck the fields we care about without modelling the whole
    // schema (which includes nested user objects, labels, etc).
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: serde_json::Value = serde_json::from_str(&stdout)
        .map_err(|e| AppError::msg(format!("gh pr list JSON parse failed: {e}")))?;
    let arr = match parsed.as_array() {
        Some(a) => a,
        None => return Ok(vec![]),
    };
    let mut out = Vec::with_capacity(arr.len());
    for entry in arr {
        let number = entry.get("number").and_then(|v| v.as_u64()).unwrap_or(0);
        let head_ref_name = entry
            .get("headRefName")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let state = entry
            .get("state")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let review_decision = entry
            .get("reviewDecision")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let url = entry
            .get("url")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        // Rollup CI status from the array gh returns. If anything failed
        // we report FAILURE; otherwise PENDING if anything's still
        // running; otherwise SUCCESS when there's at least one check.
        let check_status = entry
            .get("statusCheckRollup")
            .and_then(|v| v.as_array())
            .map(|checks| rollup_check_status(checks))
            .unwrap_or_default();
        // Comment count — sum of issue-level comments + review threads.
        // Both come back as arrays from gh.
        let issue_comments = entry
            .get("comments")
            .and_then(|v| v.as_array())
            .map(|a| a.len() as u32)
            .unwrap_or(0);
        let review_count = entry
            .get("reviews")
            .and_then(|v| v.as_array())
            .map(|a| a.len() as u32)
            .unwrap_or(0);
        out.push(PrSummary {
            number,
            head_ref_name,
            state,
            review_decision,
            check_status,
            comment_count: issue_comments + review_count,
            url,
        });
    }
    Ok(out)
}

/// Reduce gh's `statusCheckRollup` array (commit statuses + workflow runs)
/// into a single state string. Mirrors GitHub's own merge-box semantics:
/// any failure poisons the rollup; otherwise anything still running keeps
/// it pending; otherwise success.
fn rollup_check_status(checks: &[serde_json::Value]) -> String {
    if checks.is_empty() {
        return String::new();
    }
    let mut any_failure = false;
    let mut any_pending = false;
    let mut any_success = false;
    for c in checks {
        // Commit-status entries use `state`; workflow-run entries use
        // `conclusion` (when finished) and `status` (when running).
        let state = c.get("state").and_then(|v| v.as_str()).unwrap_or("");
        let conclusion = c.get("conclusion").and_then(|v| v.as_str()).unwrap_or("");
        let run_status = c.get("status").and_then(|v| v.as_str()).unwrap_or("");
        let effective = if !conclusion.is_empty() {
            conclusion
        } else if !run_status.is_empty() && run_status != "COMPLETED" {
            run_status
        } else {
            state
        };
        match effective.to_ascii_uppercase().as_str() {
            "FAILURE" | "ERROR" | "TIMED_OUT" | "CANCELLED" | "ACTION_REQUIRED" => {
                any_failure = true;
            }
            "PENDING" | "IN_PROGRESS" | "QUEUED" | "WAITING" | "REQUESTED" => {
                any_pending = true;
            }
            "SUCCESS" | "NEUTRAL" | "SKIPPED" => {
                any_success = true;
            }
            _ => {}
        }
    }
    if any_failure {
        "FAILURE".into()
    } else if any_pending {
        "PENDING".into()
    } else if any_success {
        "SUCCESS".into()
    } else {
        String::new()
    }
}
