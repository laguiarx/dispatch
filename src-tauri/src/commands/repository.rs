use serde::Serialize;
use std::path::Path;
use std::process::Command;

use crate::commands::{resolve_repo, run_git_string};
use crate::error::{AppError, AppResult};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Repository {
    pub path: String,
    pub name: String,
    pub current_branch: String,
    pub ahead: u32,
    pub behind: u32,
    pub remote: Option<String>,
    pub last_commit: Option<String>,
}

#[tauri::command]
pub fn open_repository(path: String) -> AppResult<Repository> {
    let repo_path = resolve_repo(&path)?;
    let inside = run_git_string(&repo_path, &["rev-parse", "--is-inside-work-tree"])
        .map_err(|_| AppError::NotARepo(path.clone()))?;
    if inside.trim() != "true" {
        return Err(AppError::NotARepo(path));
    }
    let top = run_git_string(&repo_path, &["rev-parse", "--show-toplevel"])?
        .trim()
        .to_string();
    let top_path = std::path::PathBuf::from(&top);

    let name = top_path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| top.clone());

    let current_branch = current_branch_impl(&top_path)?;
    let (ahead, behind, remote) = ahead_behind(&top_path);
    let last_commit = last_commit_summary(&top_path);

    Ok(Repository {
        path: top,
        name,
        current_branch,
        ahead,
        behind,
        remote,
        last_commit,
    })
}

fn current_branch_impl(repo: &Path) -> AppResult<String> {
    // `symbolic-ref --short HEAD` reads `.git/HEAD` directly and works even
    // on freshly-initialised repos without any commits — unlike `rev-parse
    // --abbrev-ref HEAD`, which complains about an "ambiguous argument 'HEAD'"
    // until at least one commit exists.
    if let Ok(s) = run_git_string(repo, &["symbolic-ref", "--short", "HEAD"]) {
        let trimmed = s.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }
    // Detached HEAD: fall back to the short SHA.
    if let Ok(s) = run_git_string(repo, &["rev-parse", "--short", "HEAD"]) {
        let trimmed = s.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }
    // Truly headless (corrupt or impossible state) — return empty.
    Ok(String::new())
}

fn ahead_behind(repo: &Path) -> (u32, u32, Option<String>) {
    let remote = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args([
            "for-each-ref",
            "--format=%(upstream:short)",
            "refs/heads/",
        ])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| {
            let head_branch = current_branch_impl(repo).ok()?;
            s.lines()
                .find(|l| !l.is_empty())
                .map(|s| s.to_string())
                .or_else(|| {
                    // Try rev-parse to confirm upstream of HEAD
                    let out = Command::new("git")
                        .arg("-C")
                        .arg(repo)
                        .args([
                            "rev-parse",
                            "--abbrev-ref",
                            &format!("{head_branch}@{{u}}"),
                        ])
                        .output()
                        .ok()?;
                    if out.status.success() {
                        Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
                    } else {
                        None
                    }
                })
        });

    let counts = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["rev-list", "--left-right", "--count", "@{u}...HEAD"])
        .output()
        .ok();

    let (behind, ahead) = match counts {
        Some(out) if out.status.success() => {
            let s = String::from_utf8_lossy(&out.stdout);
            let mut it = s.split_whitespace();
            let b: u32 = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
            let a: u32 = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
            (b, a)
        }
        _ => (0, 0),
    };
    (ahead, behind, remote)
}

fn last_commit_summary(repo: &Path) -> Option<String> {
    let out = run_git_string(repo, &["log", "-1", "--pretty=%h · %s (%cr)"]).ok()?;
    let trimmed = out.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}
