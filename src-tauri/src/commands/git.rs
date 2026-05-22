use serde::Serialize;
use std::path::Path;
use std::process::Command;

use crate::commands::{
    confine_to_repo, reject_flaggish, resolve_repo, run_git, run_git_string,
};
use crate::error::{AppError, AppResult};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
    pub staged: bool,
    pub reviewed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffResult {
    pub file_path: String,
    pub old_content: String,
    pub new_content: String,
    pub diff_text: String,
    pub is_binary: bool,
}

#[tauri::command]
pub fn git_status(repo_path: String) -> AppResult<Vec<ChangedFile>> {
    let repo = resolve_repo(&repo_path)?;

    let porcelain = run_git_string(&repo, &["status", "--porcelain=v1", "-z", "--untracked-files=all"])?;

    let mut files: Vec<ChangedFile> = parse_porcelain(&porcelain);

    // Numstat for staged + unstaged changes (additions/deletions).
    if let Ok(unstaged) = run_git_string(&repo, &["diff", "--numstat"]) {
        apply_numstat(&mut files, &unstaged, false);
    }
    if let Ok(staged) = run_git_string(&repo, &["diff", "--cached", "--numstat"]) {
        apply_numstat(&mut files, &staged, true);
    }

    Ok(files)
}

fn parse_porcelain(porcelain: &str) -> Vec<ChangedFile> {
    // Output is NUL-separated entries. For renames each entry is "XY oldpath\0newpath".
    // The simplest robust approach: split on \0 and walk with index handling.
    let mut entries: Vec<&str> = porcelain.split('\0').collect();
    // Trailing NUL produces an empty entry; drop it.
    if entries.last() == Some(&"") {
        entries.pop();
    }

    let mut files: Vec<ChangedFile> = Vec::new();
    let mut i = 0;
    while i < entries.len() {
        let entry = entries[i];
        if entry.len() < 3 {
            i += 1;
            continue;
        }
        let xy = &entry[..2];
        let path = entry[3..].to_string();
        let staged_char = xy.chars().next().unwrap_or(' ');
        let unstaged_char = xy.chars().nth(1).unwrap_or(' ');

        // Renames have an extra following entry for the old path.
        let mut old_path: Option<String> = None;
        if staged_char == 'R' || unstaged_char == 'R' {
            if i + 1 < entries.len() {
                old_path = Some(entries[i + 1].to_string());
                i += 1;
            }
        }

        // Untracked
        if xy == "??" {
            files.push(ChangedFile {
                path: path.clone(),
                old_path: None,
                status: "untracked".to_string(),
                additions: 0,
                deletions: 0,
                staged: false,
                reviewed: false,
            });
            i += 1;
            continue;
        }

        // The staged side
        if staged_char != ' ' && staged_char != '?' {
            files.push(ChangedFile {
                path: path.clone(),
                old_path: old_path.clone(),
                status: status_from_char(staged_char),
                additions: 0,
                deletions: 0,
                staged: true,
                reviewed: false,
            });
        }
        // The unstaged side
        if unstaged_char != ' ' && unstaged_char != '?' {
            files.push(ChangedFile {
                path: path.clone(),
                old_path: old_path.clone(),
                status: status_from_char(unstaged_char),
                additions: 0,
                deletions: 0,
                staged: false,
                reviewed: false,
            });
        }

        i += 1;
    }

    files
}

fn status_from_char(c: char) -> String {
    match c {
        'M' => "modified",
        'A' => "added",
        'D' => "deleted",
        'R' => "renamed",
        'C' => "modified", // treat copy as modified for MVP
        'T' => "modified",
        'U' => "modified",
        _ => "modified",
    }
    .to_string()
}

fn apply_numstat(files: &mut [ChangedFile], numstat: &str, staged: bool) {
    for line in numstat.lines() {
        let mut parts = line.split('\t');
        let adds = parts.next().unwrap_or("0");
        let dels = parts.next().unwrap_or("0");
        let path = parts.next().unwrap_or("");
        if path.is_empty() {
            continue;
        }
        let additions: u32 = adds.parse().unwrap_or(0);
        let deletions: u32 = dels.parse().unwrap_or(0);
        for f in files.iter_mut() {
            if f.path == path && f.staged == staged {
                f.additions = additions;
                f.deletions = deletions;
            }
        }
    }
}

fn looks_binary(bytes: &[u8]) -> bool {
    let sample = &bytes[..bytes.len().min(8192)];
    sample.contains(&0u8)
}

/// Compute the diff payload the DiffPane renders for a single file.
///
/// Async + `spawn_blocking` because this command does 3–4 sequential
/// `git` subprocess spawns (~5-30ms each on macOS); running them on the
/// Tauri runtime thread queued every diff fetch behind the previous one
/// during rapid file navigation. Moving to the blocking pool keeps IPC
/// responsive for the sidebar / status / terminal calls that fire
/// concurrently.
///
/// The function was accidentally dropped while pivoting the app to the
/// kanban board (the diff feature stuck around but the command lost its
/// Rust handler) and the frontend started failing with "Command
/// git_file_diff not found" on every file switch. Re-added with the
/// original behavior — the JS api wrapper in `git.api.ts` and the
/// `DIFF_CACHE` it owns are unchanged.
#[tauri::command]
pub async fn git_file_diff(
    repo_path: String,
    file_path: String,
    staged: bool,
) -> AppResult<DiffResult> {
    let repo = resolve_repo(&repo_path)?;
    // First call is sequential because the next 3 fan-outs depend on
    // `untracked`. Status itself is one small `git status --porcelain=v1
    // -- <path>`, ~5-10ms on macOS.
    let repo_for_status = repo.clone();
    let path_for_status = file_path.clone();
    let porcelain = tokio::task::spawn_blocking(move || {
        run_git_string(
            &repo_for_status,
            &["status", "--porcelain=v1", "--", &path_for_status],
        )
    })
    .await
    .map_err(|e| AppError::msg(format!("status task panicked: {e}")))??;
    let untracked = porcelain.starts_with("??");

    // Fan out the 3 remaining git calls in parallel on the blocking
    // pool. Before this they were serialised inside one spawn_blocking,
    // so the total latency was diff + read_new + read_old + is_binary
    // (~50-150ms for a medium file on cold cache). Now they overlap at
    // the cost of 3 simultaneous git subprocesses — cheap on modern
    // machines and pays off on every ⌥↓ navigation.
    let diff_handle = {
        let repo = repo.clone();
        let file_path = file_path.clone();
        tokio::task::spawn_blocking(move || -> AppResult<String> {
            let diff_args: Vec<&str> = if untracked {
                vec!["diff", "--no-index", "--", "/dev/null", &file_path]
            } else if staged {
                vec!["diff", "--cached", "--", &file_path]
            } else {
                vec!["diff", "--", &file_path]
            };
            if untracked {
                // --no-index returns exit code 1 on differences, which
                // would be misread as a failure — use the lenient runner.
                run_git_allow_nonzero(&repo, &diff_args)
            } else {
                Ok(run_git_string(&repo, &diff_args).unwrap_or_default())
            }
        })
    };
    let binary_handle = {
        let repo = repo.clone();
        let file_path = file_path.clone();
        tokio::task::spawn_blocking(move || file_is_binary(&repo, &file_path, staged, untracked))
    };
    let contents_handle = {
        let repo = repo.clone();
        let file_path = file_path.clone();
        tokio::task::spawn_blocking(move || -> AppResult<(String, String)> {
            let new_content = read_new_content(&repo, &file_path, staged, untracked)?;
            let old_content = read_old_content(&repo, &file_path, staged, untracked)?;
            Ok((old_content, new_content))
        })
    };

    let diff_text = diff_handle
        .await
        .map_err(|e| AppError::msg(format!("diff task panicked: {e}")))??;
    let is_binary = binary_handle
        .await
        .map_err(|e| AppError::msg(format!("binary-check task panicked: {e}")))??;
    let (old_content, new_content) = if is_binary {
        // We still spawned the contents task above (we couldn't know
        // is_binary yet) — drop its result. The wasted git show is
        // bounded by file size and runs on the blocking pool, so it
        // doesn't block IPC; not worth the branch to skip it.
        drop(contents_handle);
        (String::new(), String::new())
    } else {
        contents_handle
            .await
            .map_err(|e| AppError::msg(format!("contents task panicked: {e}")))??
    };

    Ok(DiffResult {
        file_path,
        old_content,
        new_content,
        diff_text,
        is_binary,
    })
}

/// Run `git` and accept exit code 1 in addition to 0. Used for
/// `git diff --no-index`, which returns 1 whenever the two inputs
/// differ — not an error in that context.
fn run_git_allow_nonzero(repo: &Path, args: &[&str]) -> AppResult<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .map_err(|e| AppError::Git(format!("failed to spawn git: {e}")))?;
    let code = output.status.code().unwrap_or(-1);
    if code != 0 && code != 1 {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(AppError::Git(if stderr.is_empty() {
            format!("git {} exited with {}", args.join(" "), output.status)
        } else {
            stderr
        }));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Heuristic: is `file_path` a binary file relative to `repo`? Reads
/// from the working tree when the file is untracked or unstaged, and
/// from the index for staged comparisons. Returns false on any IO error
/// — false-negatives just mean we'll try to render the file as text,
/// which the frontend tolerates.
fn file_is_binary(
    repo: &Path,
    file_path: &str,
    staged: bool,
    untracked: bool,
) -> AppResult<bool> {
    let path = repo.join(file_path);
    if untracked || !staged {
        if path.exists() && path.is_file() {
            if let Ok(bytes) = std::fs::read(&path) {
                return Ok(looks_binary(&bytes));
            }
        }
    }
    // Staged: peek at the indexed object.
    let object = format!(":{file_path}");
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["show", &object])
        .output();
    if let Ok(out) = output {
        if out.status.success() {
            return Ok(looks_binary(&out.stdout));
        }
    }
    Ok(false)
}

/// The "after" side of the diff: working-tree contents for unstaged /
/// untracked, indexed contents for staged.
fn read_new_content(
    repo: &Path,
    file_path: &str,
    staged: bool,
    untracked: bool,
) -> AppResult<String> {
    if untracked || !staged {
        let path = repo.join(file_path);
        if !path.exists() {
            return Ok(String::new());
        }
        return Ok(std::fs::read_to_string(&path).unwrap_or_default());
    }
    let object = format!(":{file_path}");
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["show", &object])
        .output()
        .map_err(|e| AppError::Git(e.to_string()))?;
    if !out.status.success() {
        return Ok(String::new());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// The "before" side of the diff: indexed contents for unstaged,
/// HEAD contents for staged, empty for untracked (new files have no
/// prior version).
fn read_old_content(
    repo: &Path,
    file_path: &str,
    staged: bool,
    untracked: bool,
) -> AppResult<String> {
    if untracked {
        return Ok(String::new());
    }
    let object = if staged {
        format!("HEAD:{file_path}")
    } else {
        format!(":{file_path}")
    };
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["show", &object])
        .output()
        .map_err(|e| AppError::Git(e.to_string()))?;
    if !out.status.success() {
        // Newly added: no old content.
        return Ok(String::new());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

#[tauri::command]
pub fn git_stage_file(repo_path: String, file_path: String) -> AppResult<()> {
    let repo = resolve_repo(&repo_path)?;
    run_git(&repo, &["add", "--", &file_path])?;
    Ok(())
}

/// True when the repo has any commit reachable from HEAD. False for a
/// freshly-init'd repo (unborn HEAD), which makes commands like
/// `git restore --staged` fail with "could not resolve 'HEAD'".
fn has_head(repo: &std::path::Path) -> bool {
    run_git(repo, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_ok()
}

#[tauri::command]
pub fn git_unstage_file(repo_path: String, file_path: String) -> AppResult<()> {
    let repo = resolve_repo(&repo_path)?;
    if has_head(&repo) {
        run_git(&repo, &["restore", "--staged", "--", &file_path])?;
    } else {
        // No HEAD yet → there's nothing to "restore from". The file was
        // added to the index of an empty repo; unstaging means removing
        // the index entry while leaving the working tree alone.
        run_git(
            &repo,
            &["rm", "--cached", "--force", "--", &file_path],
        )?;
    }
    Ok(())
}

#[tauri::command]
pub fn git_stage_paths(repo_path: String, file_paths: Vec<String>) -> AppResult<()> {
    if file_paths.is_empty() {
        return Ok(());
    }
    let repo = resolve_repo(&repo_path)?;
    let mut args: Vec<&str> = vec!["add", "--"];
    args.extend(file_paths.iter().map(|s| s.as_str()));
    run_git(&repo, &args)?;
    Ok(())
}

#[tauri::command]
pub fn git_unstage_paths(repo_path: String, file_paths: Vec<String>) -> AppResult<()> {
    if file_paths.is_empty() {
        return Ok(());
    }
    let repo = resolve_repo(&repo_path)?;
    let mut args: Vec<&str> = if has_head(&repo) {
        vec!["restore", "--staged", "--"]
    } else {
        // See `git_unstage_file` for the unborn-HEAD rationale.
        vec!["rm", "--cached", "--force", "--"]
    };
    args.extend(file_paths.iter().map(|s| s.as_str()));
    run_git(&repo, &args)?;
    Ok(())
}

/// Discard the working-tree changes for many files at once. Mirrors what
/// `git_discard_file` does for a single path but does it in one shot:
///   - tracked files → `git checkout HEAD -- <paths>`
///   - untracked files → physically removed from the working tree
#[tauri::command]
pub fn git_discard_paths(repo_path: String, file_paths: Vec<String>) -> AppResult<()> {
    use std::collections::HashSet;
    if file_paths.is_empty() {
        return Ok(());
    }
    let repo = resolve_repo(&repo_path)?;

    // Discover which of the requested paths are untracked. One git invocation.
    let untracked_raw = run_git_string(
        &repo,
        &["ls-files", "--others", "--exclude-standard", "-z"],
    )
    .unwrap_or_default();
    let untracked: HashSet<&str> = untracked_raw
        .split('\0')
        .filter(|s| !s.is_empty())
        .collect();

    let mut to_checkout: Vec<&str> = Vec::new();
    let mut to_delete: Vec<&str> = Vec::new();
    for p in &file_paths {
        if untracked.contains(p.as_str()) {
            to_delete.push(p.as_str());
        } else {
            to_checkout.push(p.as_str());
        }
    }

    if !to_checkout.is_empty() {
        let mut args: Vec<&str> = vec!["checkout", "HEAD", "--"];
        args.extend(to_checkout.iter().copied());
        run_git(&repo, &args)?;
    }
    for rel in to_delete {
        // Defense in depth: refuse to follow `../` escapes or absolute
        // paths even though git's own `--` separator would have caught
        // them earlier — std::fs::remove_file doesn't.
        let target = confine_to_repo(&repo, rel)?;
        if target.exists() {
            std::fs::remove_file(&target).map_err(AppError::Io)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn git_discard_file(repo_path: String, file_path: String) -> AppResult<()> {
    let repo = resolve_repo(&repo_path)?;
    // Check if untracked
    let porcelain = run_git_string(
        &repo,
        &["status", "--porcelain=v1", "--", &file_path],
    )?;
    if porcelain.starts_with("??") {
        // Delete the untracked file from the working tree. Confine first
        // so a `../foo` path doesn't reach outside the repo.
        let target = confine_to_repo(&repo, &file_path)?;
        if target.exists() {
            std::fs::remove_file(&target).map_err(AppError::Io)?;
        }
        return Ok(());
    }
    // Otherwise restore from HEAD (drops both staged and unstaged changes).
    run_git(&repo, &["checkout", "HEAD", "--", &file_path])?;
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalEditor {
    pub id: String,
    pub name: String,
}

/// Detect external editors installed on the user's machine. We probe both
/// shell CLIs (`code`, `zed`, etc.) and the macOS `/Applications` folder so
/// editors without a CLI still show up.
#[tauri::command]
pub fn detect_editors() -> AppResult<Vec<ExternalEditor>> {
    let candidates: &[(&str, &str, &[&str], &[&str])] = &[
        // (id, label, CLI commands, .app names)
        ("vscode", "VS Code", &["code"], &["Visual Studio Code"]),
        ("cursor", "Cursor", &["cursor"], &["Cursor"]),
        ("zed", "Zed", &["zed"], &["Zed"]),
        ("sublime", "Sublime Text", &["subl"], &["Sublime Text"]),
        ("webstorm", "WebStorm", &["webstorm"], &["WebStorm"]),
        ("idea", "IntelliJ IDEA", &["idea"], &["IntelliJ IDEA"]),
        ("pycharm", "PyCharm", &["pycharm"], &["PyCharm"]),
        ("phpstorm", "PhpStorm", &["phpstorm"], &["PhpStorm"]),
        ("rubymine", "RubyMine", &["mine"], &["RubyMine"]),
        ("nova", "Nova", &["nova"], &["Nova"]),
        ("xcode", "Xcode", &[], &["Xcode"]),
        ("android-studio", "Android Studio", &[], &["Android Studio"]),
    ];

    let mut out = Vec::new();
    for (id, name, cmds, apps) in candidates {
        let cli_ok = cmds.iter().any(|c| has_cli(c));
        let app_ok = apps.iter().any(|a| has_app(a));
        if cli_ok || app_ok {
            out.push(ExternalEditor {
                id: id.to_string(),
                name: name.to_string(),
            });
        }
    }
    Ok(out)
}

fn has_cli(cmd: &str) -> bool {
    std::process::Command::new("which")
        .arg(cmd)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn has_app(name: &str) -> bool {
    let candidates = [
        format!("/Applications/{name}.app"),
        format!(
            "{}/Applications/{name}.app",
            std::env::var("HOME").unwrap_or_default()
        ),
    ];
    candidates.iter().any(|p| std::path::Path::new(p).exists())
}

const EDITOR_TABLE: &[(&str, &[&str], &str)] = &[
    ("vscode", &["code"], "Visual Studio Code"),
    ("cursor", &["cursor"], "Cursor"),
    ("zed", &["zed"], "Zed"),
    ("sublime", &["subl"], "Sublime Text"),
    ("webstorm", &["webstorm"], "WebStorm"),
    ("idea", &["idea"], "IntelliJ IDEA"),
    ("pycharm", &["pycharm"], "PyCharm"),
    ("phpstorm", &["phpstorm"], "PhpStorm"),
    ("rubymine", &["mine"], "RubyMine"),
    ("nova", &["nova"], "Nova"),
    ("xcode", &[], "Xcode"),
    ("android-studio", &[], "Android Studio"),
];

#[tauri::command]
pub fn open_in_editor(
    editor_id: String,
    repo_path: String,
    file_path: String,
) -> AppResult<()> {
    let repo = resolve_repo(&repo_path)?;
    let target = if file_path.is_empty() {
        repo.clone()
    } else {
        confine_to_repo(&repo, &file_path)?
    };

    let row = EDITOR_TABLE
        .iter()
        .find(|(id, _, _)| *id == editor_id)
        .ok_or_else(|| AppError::msg(format!("Unknown editor: {editor_id}")))?;
    let (_, clis, app_name) = row;

    // Try the CLI first — opens in the user's existing window, faster.
    for cli in *clis {
        if has_cli(cli) {
            let status = std::process::Command::new(cli).arg(&target).status();
            if let Ok(s) = status {
                if s.success() {
                    return Ok(());
                }
            }
        }
    }
    // Fall back to `open -a` so editors without a CLI still work.
    if has_app(app_name) {
        let status = std::process::Command::new("open")
            .args(["-a", app_name])
            .arg(&target)
            .status()
            .map_err(|e| AppError::msg(format!("Failed to launch {app_name}: {e}")))?;
        if status.success() {
            return Ok(());
        }
    }
    Err(AppError::msg(format!(
        "Couldn't open {} — is {app_name} installed?",
        target.display()
    )))
}

#[tauri::command]
pub fn open_in_vscode(repo_path: String, file_path: String) -> AppResult<()> {
    let repo = resolve_repo(&repo_path)?;
    let full = if file_path.is_empty() {
        repo.clone()
    } else {
        confine_to_repo(&repo, &file_path)?
    };
    // Prefer `code` CLI; fall back to `open -a` on macOS.
    let attempt = Command::new("code").arg(&full).status();
    if let Ok(status) = attempt {
        if status.success() {
            return Ok(());
        }
    }
    let status = Command::new("open")
        .args(["-a", "Visual Studio Code"])
        .arg(&full)
        .status()
        .map_err(|e| AppError::msg(format!("Failed to launch VS Code: {e}")))?;
    if !status.success() {
        return Err(AppError::msg(
            "VS Code is not installed or not in PATH. Install the `code` shell command from VS Code.",
        ));
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub is_current: bool,
    pub is_remote: bool,
    pub upstream: Option<String>,
    /// `true` when this local branch had an upstream that no longer exists
    /// on the remote (someone deleted it on GitHub, `git fetch --prune`
    /// dropped the ref, but the local branch is still here). Equivalent
    /// to `git for-each-ref ... --format=%(upstream:track)` containing
    /// `[gone]`. Used by the UI to show a "gone" badge and let the user
    /// prune them in bulk.
    pub gone: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchSyncSkipped {
    pub branch: String,
    pub reason: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchSyncResult {
    pub updated: Vec<String>,
    pub up_to_date: u32,
    pub skipped: Vec<BranchSyncSkipped>,
}

#[derive(Debug)]
struct BranchSyncCandidate {
    name: String,
    upstream: String,
    track: String,
    worktree_path: String,
}

#[derive(Debug, PartialEq, Eq)]
enum BranchSyncDecision {
    FastForward,
    UpToDate,
    Skip(String),
    Ignore,
}

fn track_count(track: &str, label: &str) -> u32 {
    let Some(idx) = track.find(label) else {
        return 0;
    };
    track[idx + label.len()..]
        .trim_start()
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect::<String>()
        .parse()
        .unwrap_or(0)
}

fn classify_branch_sync(
    branch: &BranchSyncCandidate,
    current_worktree_path: &str,
) -> BranchSyncDecision {
    if branch.track.contains("[gone]") || branch.track.contains("gone") {
        return BranchSyncDecision::Skip("upstream is gone".into());
    }
    if branch.upstream.trim().is_empty() {
        return BranchSyncDecision::Ignore;
    }

    let ahead = track_count(&branch.track, "ahead");
    let behind = track_count(&branch.track, "behind");
    if ahead > 0 && behind > 0 {
        return BranchSyncDecision::Skip("diverged from upstream".into());
    }
    if behind == 0 {
        return BranchSyncDecision::UpToDate;
    }

    let worktree_path = branch.worktree_path.trim();
    if !worktree_path.is_empty() && worktree_path != current_worktree_path {
        return BranchSyncDecision::Skip(format!("checked out at {worktree_path}"));
    }
    BranchSyncDecision::FastForward
}

fn parse_branch_sync_candidates(raw: &str) -> Vec<BranchSyncCandidate> {
    raw.lines()
        .filter_map(|line| {
            let mut parts = line.splitn(4, '\x1f');
            let name = parts.next()?.trim();
            if name.is_empty() {
                return None;
            }
            Some(BranchSyncCandidate {
                name: name.to_string(),
                upstream: parts.next().unwrap_or("").trim().to_string(),
                track: parts.next().unwrap_or("").trim().to_string(),
                worktree_path: parts.next().unwrap_or("").trim().to_string(),
            })
        })
        .collect()
}

#[tauri::command]
pub async fn git_sync_branches(repo_path: String) -> AppResult<BranchSyncResult> {
    let repo = resolve_repo(&repo_path)?;
    tokio::task::spawn_blocking(move || sync_branches(&repo))
        .await
        .map_err(|e| AppError::msg(format!("sync branches task panicked: {e}")))?
}

fn sync_branches(repo: &Path) -> AppResult<BranchSyncResult> {
    run_git(repo, &["fetch", "--all", "--prune"])?;

    let current = run_git_string(repo, &["rev-parse", "--abbrev-ref", "HEAD"])
        .unwrap_or_default()
        .trim()
        .to_string();
    let current_worktree_path = repo.to_string_lossy().to_string();
    let raw = run_git_string(
        repo,
        &[
            "for-each-ref",
            "--format=%(refname:short)%x1f%(upstream:short)%x1f%(upstream:track)%x1f%(worktreepath)",
            "refs/heads/",
        ],
    )?;

    let mut result = BranchSyncResult {
        updated: Vec::new(),
        up_to_date: 0,
        skipped: Vec::new(),
    };

    for branch in parse_branch_sync_candidates(&raw) {
        match classify_branch_sync(&branch, &current_worktree_path) {
            BranchSyncDecision::FastForward => {
                let sync_result = if branch.name == current {
                    run_git(repo, &["merge", "--ff-only", &branch.upstream])
                } else {
                    let local_ref = format!("refs/heads/{}", branch.name);
                    match run_git_string(repo, &["rev-parse", "--verify", &branch.upstream]) {
                        Ok(oid) => {
                            let oid = oid.trim().to_string();
                            run_git(repo, &["update-ref", &local_ref, &oid])
                        }
                        Err(err) => Err(err),
                    }
                };
                match sync_result {
                    Ok(_) => result.updated.push(branch.name),
                    Err(err) => result.skipped.push(BranchSyncSkipped {
                        branch: branch.name,
                        reason: err.to_string(),
                    }),
                }
            }
            BranchSyncDecision::UpToDate => {
                result.up_to_date += 1;
            }
            BranchSyncDecision::Skip(reason) => {
                result.skipped.push(BranchSyncSkipped {
                    branch: branch.name,
                    reason,
                });
            }
            BranchSyncDecision::Ignore => {}
        }
    }

    Ok(result)
}

#[tauri::command]
pub fn list_branches(repo_path: String) -> AppResult<Vec<BranchInfo>> {
    let repo = resolve_repo(&repo_path)?;
    let mut out: Vec<BranchInfo> = Vec::new();

    // Local branches: `<head-marker>|<short name>|<upstream short>|<track>`
    // The track field is `[ahead 2]` / `[behind 1]` / `[gone]` etc. when
    // upstream is set; empty when no upstream.
    if let Ok(raw) = run_git_string(
        &repo,
        &[
            "for-each-ref",
            "--format=%(HEAD)|%(refname:short)|%(upstream:short)|%(upstream:track)",
            "refs/heads/",
        ],
    ) {
        for line in raw.lines() {
            let mut parts = line.splitn(4, '|');
            let head = parts.next().unwrap_or("");
            let name = parts.next().unwrap_or("").trim();
            let upstream = parts.next().unwrap_or("").trim();
            let track = parts.next().unwrap_or("").trim();
            if name.is_empty() {
                continue;
            }
            out.push(BranchInfo {
                name: name.to_string(),
                is_current: head.trim() == "*",
                is_remote: false,
                upstream: if upstream.is_empty() {
                    None
                } else {
                    Some(upstream.to_string())
                },
                gone: track.contains("[gone]") || track.contains("gone"),
            });
        }
    }

    // Remote branches — skip the symbolic HEAD pointer (e.g. `origin/HEAD -> origin/main`).
    if let Ok(raw) = run_git_string(
        &repo,
        &["for-each-ref", "--format=%(refname:short)", "refs/remotes/"],
    ) {
        for line in raw.lines() {
            let name = line.trim();
            if name.is_empty() || name.ends_with("/HEAD") {
                continue;
            }
            out.push(BranchInfo {
                name: name.to_string(),
                is_current: false,
                is_remote: true,
                upstream: None,
                gone: false,
            });
        }
    }
    Ok(out)
}

/// Delete a local branch. `force=true` maps to `git branch -D` (drops
/// unmerged commits — used for "Prune gone branches" since the local
/// branch may have unique commits that never made it upstream). Refuses
/// to delete the current branch.
#[tauri::command]
pub fn git_delete_branch(
    repo_path: String,
    name: String,
    force: Option<bool>,
) -> AppResult<()> {
    let repo = resolve_repo(&repo_path)?;
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::msg("Branch name is empty"));
    }
    reject_flaggish("Branch name", trimmed)?;
    // Don't let the caller blow away the branch they're standing on.
    let current = run_git_string(&repo, &["rev-parse", "--abbrev-ref", "HEAD"])
        .unwrap_or_default()
        .trim()
        .to_string();
    if current == trimmed {
        return Err(AppError::msg(format!(
            "Can't delete '{trimmed}' while it's the current branch — checkout a different branch first",
        )));
    }
    let flag = if force.unwrap_or(false) { "-D" } else { "-d" };
    run_git(&repo, &["branch", flag, trimmed])?;
    Ok(())
}

/// Create a new branch off `base` (or HEAD when `base` is None) and switch
/// to it. Equivalent to `git checkout -b <name> [<base>]`.
#[tauri::command]
pub fn create_branch(
    repo_path: String,
    name: String,
    base: Option<String>,
) -> AppResult<()> {
    let repo = resolve_repo(&repo_path)?;
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::msg("Branch name is empty"));
    }
    // git refuses spaces, control chars and a few other things; surface a
    // friendlier error early instead of relying on git's stderr.
    if trimmed.contains(|c: char| c.is_whitespace() || c == '~' || c == '^') {
        return Err(AppError::msg(
            "Branch name can't contain spaces or ~ / ^",
        ));
    }
    reject_flaggish("Branch name", trimmed)?;
    let base_trimmed = base.as_deref().map(str::trim).filter(|s| !s.is_empty());
    if let Some(b) = base_trimmed {
        reject_flaggish("Base branch", b)?;
    }
    let mut args: Vec<&str> = vec!["checkout", "-b", trimmed];
    if let Some(b) = base_trimmed {
        args.push(b);
    }
    run_git(&repo, &args)?;
    Ok(())
}

#[tauri::command]
pub fn checkout_branch(repo_path: String, name: String) -> AppResult<()> {
    let repo = resolve_repo(&repo_path)?;
    reject_flaggish("Branch name", &name)?;
    // If `name` is a remote tracking branch like "origin/feat-x", git's DWIM
    // will set up a local "feat-x" that tracks it automatically.
    let short = name
        .strip_prefix("origin/")
        .or_else(|| {
            name.find('/').map(|i| &name[i + 1..])
        })
        .unwrap_or(&name);
    reject_flaggish("Branch name", short)?;
    // `git checkout -- <x>` interprets <x> as a path, so we *can't* use the
    // `--` separator here — branch checkout disambiguates only without it.
    // The leading-dash guard above (and on `name`) is the argv-smuggle
    // defence. Try the short name first (DWIM for remotes); fall back to
    // the full ref.
    if run_git(&repo, &["checkout", short]).is_ok() {
        return Ok(());
    }
    run_git(&repo, &["checkout", &name])?;
    Ok(())
}

// ----- stash ---------------------------------------------------------------

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashEntry {
    /// `stash@{0}` style reference. Serialized as `ref`.
    #[serde(rename = "ref")]
    pub ref_: String,
    /// Branch the stash was created on (best-effort parse).
    pub branch: Option<String>,
    /// User-visible message (the `On {branch}: ` prefix is stripped when
    /// `branch` is set).
    pub message: String,
    /// Unix timestamp.
    pub timestamp: i64,
}

#[tauri::command]
pub async fn git_stash_push(
    repo_path: String,
    message: String,
    include_untracked: bool,
) -> AppResult<()> {
    let repo = resolve_repo(&repo_path)?;
    let trimmed = message.trim().to_string();
    if trimmed.is_empty() {
        return Err(AppError::msg("Stash message is empty"));
    }
    // Async + spawn_blocking — stashing a large/untracked-heavy working
    // tree can take seconds, and we never want git ops to stall the Tauri
    // IPC dispatcher (see `git_merge_into` for the longer rationale).
    tokio::task::spawn_blocking(move || {
        let mut args: Vec<&str> = vec!["stash", "push", "-m", &trimmed];
        if include_untracked {
            args.push("--include-untracked");
        }
        run_git(&repo, &args).map(|_| ())
    })
    .await
    .map_err(|e| AppError::msg(format!("stash push task panicked: {e}")))?
}

#[tauri::command]
pub fn git_stash_list(repo_path: String) -> AppResult<Vec<StashEntry>> {
    let repo = resolve_repo(&repo_path)?;
    // %gd = selector (stash@{0}), %ct = committer timestamp, %s = subject
    let raw = run_git_string(
        &repo,
        &["stash", "list", "--format=%gd%x1f%ct%x1f%s"],
    )
    .unwrap_or_default();
    let mut out = Vec::new();
    for line in raw.lines() {
        let mut parts = line.splitn(3, '\x1f');
        let ref_ = parts.next().unwrap_or("").to_string();
        let ts: i64 = parts.next().unwrap_or("0").parse().unwrap_or(0);
        let subject = parts.next().unwrap_or("").to_string();
        // Subject is typically "WIP on <branch>: <sha> <msg>" or
        // "On <branch>: <msg>" when -m was given.
        let (branch, message) = parse_stash_subject(&subject);
        if ref_.is_empty() {
            continue;
        }
        out.push(StashEntry {
            ref_,
            branch,
            message,
            timestamp: ts,
        });
    }
    Ok(out)
}

fn parse_stash_subject(subject: &str) -> (Option<String>, String) {
    if let Some(rest) = subject.strip_prefix("On ") {
        if let Some(colon) = rest.find(": ") {
            let branch = rest[..colon].to_string();
            let msg = rest[colon + 2..].to_string();
            return (Some(branch), msg);
        }
    }
    if let Some(rest) = subject.strip_prefix("WIP on ") {
        if let Some(colon) = rest.find(": ") {
            let branch = rest[..colon].to_string();
            let msg = rest[colon + 2..].to_string();
            return (Some(branch), msg);
        }
    }
    (None, subject.to_string())
}

/// Stash refs are formatted `stash@{N}` by git; enforce that shape so a
/// crafted value can't sneak in as a flag (`stash pop --foo`) or as
/// arbitrary text passed to git's reflog parser.
fn validate_stash_ref(stash_ref: &str) -> AppResult<()> {
    let ok = stash_ref.starts_with("stash@{")
        && stash_ref.ends_with('}')
        && stash_ref[7..stash_ref.len() - 1]
            .chars()
            .all(|c| c.is_ascii_digit());
    if !ok {
        return Err(AppError::msg(format!(
            "Invalid stash reference: {stash_ref}"
        )));
    }
    Ok(())
}

#[tauri::command]
pub async fn git_stash_pop(repo_path: String, stash_ref: String) -> AppResult<()> {
    let repo = resolve_repo(&repo_path)?;
    validate_stash_ref(&stash_ref)?;
    tokio::task::spawn_blocking(move || {
        run_git(&repo, &["stash", "pop", &stash_ref]).map(|_| ())
    })
    .await
    .map_err(|e| AppError::msg(format!("stash pop task panicked: {e}")))?
}

#[tauri::command]
pub async fn git_stash_apply(repo_path: String, stash_ref: String) -> AppResult<()> {
    let repo = resolve_repo(&repo_path)?;
    validate_stash_ref(&stash_ref)?;
    tokio::task::spawn_blocking(move || {
        run_git(&repo, &["stash", "apply", &stash_ref]).map(|_| ())
    })
    .await
    .map_err(|e| AppError::msg(format!("stash apply task panicked: {e}")))?
}

#[tauri::command]
pub async fn git_stash_drop(repo_path: String, stash_ref: String) -> AppResult<()> {
    let repo = resolve_repo(&repo_path)?;
    validate_stash_ref(&stash_ref)?;
    tokio::task::spawn_blocking(move || {
        run_git(&repo, &["stash", "drop", &stash_ref]).map(|_| ())
    })
    .await
    .map_err(|e| AppError::msg(format!("stash drop task panicked: {e}")))?
}

// ----- end stash -----------------------------------------------------------

#[tauri::command]
pub fn git_commit(repo_path: String, message: String) -> AppResult<()> {
    let repo = resolve_repo(&repo_path)?;
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err(AppError::msg("Commit message is empty"));
    }
    run_git(&repo, &["commit", "-m", trimmed])?;
    Ok(())
}

/// `git commit -am <msg>` — stages every modified/deleted tracked file
/// and commits in one shot. Used by the Approve-to-PR flow to fold the
/// agent's tracked-file edits into a single commit on the worktree
/// branch.
///
/// Deliberately does NOT `git add -A`. Sweeping untracked files in was
/// the source of "PR included random stuff that wasn't part of the
/// task" — IDE caches, .DS_Store, build outputs, scratch files the
/// agent left behind. Agents that need to introduce a new file are
/// expected to `git add <path>` it themselves (Claude Code and Codex
/// both do this when prompted to commit their own work); whatever is
/// staged at exit time is what we commit. Anything still unstaged AND
/// untracked stays in the worktree but never lands on the PR.
#[tauri::command]
pub fn git_commit_all(repo_path: String, message: String) -> AppResult<()> {
    let repo = resolve_repo(&repo_path)?;
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err(AppError::msg("Commit message is empty"));
    }
    // `-a` stages modified/deleted tracked files. `-m` is the message.
    // If there's nothing tracked to commit and nothing staged, git exits
    // non-zero — the caller (board.store#approveCard) already skips this
    // when porcelain status is empty, so we don't double-check here.
    run_git(&repo, &["commit", "-am", trimmed])?;
    Ok(())
}

/// `git push`. When `set_upstream` is true (first push on a new branch) we
/// run `git push -u origin <branch>` so future pushes work without flags.
#[tauri::command]
pub fn git_push(repo_path: String, set_upstream: Option<bool>) -> AppResult<()> {
    let repo = resolve_repo(&repo_path)?;
    if set_upstream.unwrap_or(false) {
        // Resolve the current branch so we can set its upstream to origin/<branch>.
        let branch = run_git_string(&repo, &["rev-parse", "--abbrev-ref", "HEAD"])?
            .trim()
            .to_string();
        if branch.is_empty() || branch == "HEAD" {
            return Err(AppError::msg(
                "Detached HEAD — checkout a branch before pushing",
            ));
        }
        run_git(&repo, &["push", "-u", "origin", &branch])?;
    } else {
        run_git(&repo, &["push"])?;
    }
    Ok(())
}

/// `git pull` with `--ff-only` so we never silently create a merge commit on
/// the user's behalf. If a true merge is needed the user can fall back to
/// the terminal — surfacing the conflict here would require a real conflict
/// UI we don't have yet.
#[tauri::command]
pub fn git_pull(repo_path: String) -> AppResult<()> {
    let repo = resolve_repo(&repo_path)?;
    run_git(&repo, &["pull", "--ff-only"])?;
    Ok(())
}

/// `git fetch --all --prune` — quiet refresh of remote refs.
#[tauri::command]
pub fn git_fetch(repo_path: String) -> AppResult<()> {
    let repo = resolve_repo(&repo_path)?;
    run_git(&repo, &["fetch", "--all", "--prune"])?;
    Ok(())
}

/// Resolve the repository's "default" branch (where PRs should be opened
/// against). Strategy: prefer the symbolic ref `origin/HEAD`; fall back to
/// `main`; then `master`; finally bubble an error. Used by the "Create PR"
/// flow to pick the base branch.
#[tauri::command]
pub fn git_default_branch(repo_path: String) -> AppResult<String> {
    let repo = resolve_repo(&repo_path)?;
    if let Ok(s) =
        run_git_string(&repo, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
    {
        let s = s.trim();
        if let Some(stripped) = s.strip_prefix("origin/") {
            if !stripped.is_empty() {
                return Ok(stripped.to_string());
            }
        }
        if !s.is_empty() {
            return Ok(s.to_string());
        }
    }
    for candidate in ["main", "master"] {
        if run_git(
            &repo,
            &["show-ref", "--verify", "--quiet", &format!("refs/heads/{candidate}")],
        )
        .is_ok()
        {
            return Ok(candidate.to_string());
        }
    }
    Err(AppError::msg(
        "Couldn't determine the default branch (no origin/HEAD, no main, no master)",
    ))
}

/// One side of a PR comparison: how many commits the head branch is
/// `behind` the base and how many it is `ahead`. Computed via
/// `git rev-list --left-right --count base...head`. Both numbers are
/// always non-negative — the PR-create dialog uses `behind` to warn the
/// user "your branch is N commits behind base; rebase first?".
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AheadBehind {
    pub ahead: u32,
    pub behind: u32,
}

/// `git rev-list --left-right --count <base>...<head>` — returns
/// `{ behind, ahead }` so the UI can show "X commits behind, Y ahead"
/// before opening a PR. `base` is typically `origin/main` (the PR target)
/// and `head` is the current local branch.
#[tauri::command]
pub fn git_behind_ahead(
    repo_path: String,
    base: String,
    head: String,
) -> AppResult<AheadBehind> {
    // Refuse a ref that would be parsed as a flag — e.g. a tampered
    // base of `--upload-pack=…` would smuggle options into `rev-list`.
    reject_flaggish("Base ref", &base)?;
    reject_flaggish("Head ref", &head)?;
    let repo = resolve_repo(&repo_path)?;
    // `--left-right --count A...B` returns "<behind>\t<ahead>" where
    // behind = commits in A not in B (we'd need to apply) and ahead =
    // commits in B not in A (we have locally that base doesn't).
    let raw = run_git_string(
        &repo,
        &[
            "rev-list",
            "--left-right",
            "--count",
            &format!("{base}...{head}"),
        ],
    )?;
    let trimmed = raw.trim();
    let mut parts = trimmed.split_whitespace();
    let behind: u32 = parts.next().unwrap_or("0").parse().unwrap_or(0);
    let ahead: u32 = parts.next().unwrap_or("0").parse().unwrap_or(0);
    Ok(AheadBehind { ahead, behind })
}

/// List remote-tracking branches on `origin`, sorted alphabetically with
/// the repo's default branch first. Powers the "Into" picker in the
/// Create PR dialog so the user can target any base branch
/// (main/develop/staging/...) rather than being locked to origin/HEAD.
///
/// Returns short names (e.g. `main`, `develop`) without the `origin/`
/// prefix — the dialog uses them directly as PR base arguments.
#[tauri::command]
pub fn git_remote_branches(repo_path: String) -> AppResult<Vec<String>> {
    let repo = resolve_repo(&repo_path)?;
    let raw = run_git_string(
        &repo,
        &[
            "for-each-ref",
            "--format=%(refname:short)",
            "refs/remotes/origin/",
        ],
    )?;
    let mut names: Vec<String> = raw
        .lines()
        .filter_map(|l| l.trim().strip_prefix("origin/").map(|s| s.to_string()))
        // Skip the symbolic `HEAD` pointer — it's a duplicate of whatever
        // the default branch is, and shows up as "HEAD" which is noise.
        .filter(|n| n != "HEAD")
        .collect();
    names.sort();
    // Pull the default branch to the top so it's the obvious first pick
    // in the dropdown.
    if let Ok(default) = git_default_branch(repo_path) {
        if let Some(idx) = names.iter().position(|n| *n == default) {
            let d = names.remove(idx);
            names.insert(0, d);
        }
    }
    Ok(names)
}

/// `git rebase <onto>` — replays the current branch's commits on top of
/// the given ref. Used by the "your branch is N behind" affordance in
/// the Create PR dialog. Conflict / dirty-tree errors bubble up verbatim
/// so the UI can show them.
///
/// Async + `spawn_blocking` so a long rebase (large repo, many commits,
/// hooks running) can't stall the Tauri IPC dispatcher and trigger the
/// macOS "unresponsive app" watchdog that crashes WKWebView.
#[tauri::command]
pub async fn git_rebase_onto(repo_path: String, onto: String) -> AppResult<()> {
    reject_flaggish("Rebase target", &onto)?;
    let repo = resolve_repo(&repo_path)?;
    tokio::task::spawn_blocking(move || {
        run_git(&repo, &["rebase", &onto]).map(|_| ())
    })
    .await
    .map_err(|e| AppError::msg(format!("rebase task panicked: {e}")))?
}

/// `git merge <ref> --no-edit` — fast-forward when possible, otherwise
/// creates a merge commit with the default message. Companion to
/// `git_rebase_onto` for users who prefer merge to rebase. Same async +
/// spawn_blocking rationale as `git_rebase_onto`.
#[tauri::command]
pub async fn git_merge_into(repo_path: String, from: String) -> AppResult<()> {
    reject_flaggish("Merge source", &from)?;
    let repo = resolve_repo(&repo_path)?;
    tokio::task::spawn_blocking(move || {
        run_git(&repo, &["merge", "--no-edit", &from]).map(|_| ())
    })
    .await
    .map_err(|e| AppError::msg(format!("merge task panicked: {e}")))?
}

/// Undo the last commit while keeping its changes staged (`git reset --soft
/// HEAD~1`). Matches VS Code's "Undo Last Commit" semantics — the user can
/// re-edit the message in the composer and recommit.
#[tauri::command]
pub fn git_undo_last_commit(repo_path: String) -> AppResult<()> {
    let repo = resolve_repo(&repo_path)?;
    // Safety: don't try to undo if there's no parent (initial commit). Git
    // reports a non-zero exit, but the message is cryptic — pre-flight here.
    let head_count = run_git_string(&repo, &["rev-list", "--count", "HEAD"])
        .unwrap_or_default()
        .trim()
        .parse::<u32>()
        .unwrap_or(0);
    if head_count <= 1 {
        return Err(AppError::msg(
            "Nothing to undo — this is the initial commit (or no commits yet)",
        ));
    }
    run_git(&repo, &["reset", "--soft", "HEAD~1"])?;
    Ok(())
}

/// Apply a unified-diff patch to either the git index or the working tree.
///
/// - `target = "index"` (default) → applies with `--cached`. Used by stage /
///   unstage hunk.
/// - `target = "workdir"` → applies to the working tree only. Combined with
///   `reverse = true`, this is what reverts an unstaged hunk back to the
///   index state (VS Code's "Revert block" action).
#[tauri::command]
pub fn git_apply_patch(
    repo_path: String,
    patch: String,
    reverse: bool,
    target: Option<String>,
) -> AppResult<()> {
    use std::io::Write;
    let repo = resolve_repo(&repo_path)?;
    let target = target.as_deref().unwrap_or("index");

    let mut args: Vec<&str> = vec!["apply", "--whitespace=nowarn"];
    if target != "workdir" {
        args.push("--cached");
    }
    if reverse {
        args.push("--reverse");
    }
    args.push("-");

    let mut child = std::process::Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(&args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| AppError::Git(format!("failed to spawn git apply: {e}")))?;

    {
        let stdin = child
            .stdin
            .as_mut()
            .ok_or_else(|| AppError::Git("git apply stdin unavailable".to_string()))?;
        stdin.write_all(patch.as_bytes()).map_err(AppError::Io)?;
    }

    let output = child
        .wait_with_output()
        .map_err(|e| AppError::Git(format!("git apply failed: {e}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(AppError::Git(if stderr.is_empty() {
            format!("git apply exited with {}", output.status)
        } else {
            stderr
        }));
    }
    Ok(())
}

/// Return every file in the working tree the user is likely to care about.
///
/// The main list is tracked + untracked-but-not-ignored. We also add a narrow
/// set of ignored-but-editable config files (`.env*`, `.npmrc`, etc.) so the
/// Files tab can open local configuration without exploding into
/// `node_modules/`, `dist/`, and build target trees.
#[tauri::command]
pub async fn list_repo_files(repo_path: String) -> AppResult<Vec<String>> {
    let repo = resolve_repo(&repo_path)?;
    // Async + spawn_blocking on TWO parallel tasks. This was previously
    // a plain `pub fn` that ran on the Tauri runtime thread — the two
    // sequential `git ls-files` calls (50-500ms total on big repos)
    // blocked every other IPC for that whole window, so opening the
    // sidebar's Files tab visibly froze the diff/board too. Moving each
    // call to its own spawn_blocking lets them race on the blocking
    // pool and frees the runtime for everything else.
    let cached_handle = {
        let repo = repo.clone();
        tokio::task::spawn_blocking(move || {
            git_ls_files(
                &repo,
                &[
                    "ls-files",
                    "-z",
                    "--cached",
                    "--others",
                    "--exclude-standard",
                ],
            )
        })
    };
    let ignored_handle = {
        let repo = repo.clone();
        tokio::task::spawn_blocking(move || {
            git_ls_files(
                &repo,
                &[
                    "ls-files",
                    "-z",
                    "--others",
                    "--ignored",
                    "--exclude-standard",
                ],
            )
        })
    };

    let mut out = cached_handle
        .await
        .map_err(|e| AppError::msg(format!("ls-files task panicked: {e}")))??;
    let ignored = ignored_handle
        .await
        .map_err(|e| AppError::msg(format!("ls-files (ignored) task panicked: {e}")))??;
    out.extend(
        ignored
            .into_iter()
            .filter(|path| is_editable_ignored_file(path)),
    );
    out.sort_unstable();
    out.dedup();
    Ok(out)
}

fn git_ls_files(repo: &Path, args: &[&str]) -> AppResult<Vec<String>> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .map_err(|e| AppError::Git(format!("failed to spawn git ls-files: {e}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(AppError::Git(if stderr.is_empty() {
            format!("git ls-files exited with {}", output.status)
        } else {
            stderr
        }));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect())
}

fn is_editable_ignored_file(path: &str) -> bool {
    const BLOCKED_PREFIXES: &[&str] = &[
        ".cache/",
        ".next/",
        ".nuxt/",
        ".parcel-cache/",
        ".svelte-kit/",
        ".turbo/",
        ".vite/",
        "build/",
        "coverage/",
        "dist/",
        "node_modules/",
        "out/",
        "src-tauri/target/",
        "target/",
    ];
    if BLOCKED_PREFIXES.iter().any(|prefix| path.starts_with(prefix)) {
        return false;
    }
    let name = path.rsplit('/').next().unwrap_or(path);
    name == ".env"
        || name.starts_with(".env.")
        || matches!(
            name,
            ".npmrc" | ".yarnrc" | ".pypirc" | ".netrc" | ".tool-versions"
        )
}

#[tauri::command]
pub async fn read_working_file(
    repo_path: String,
    file_path: String,
) -> AppResult<String> {
    let repo = resolve_repo(&repo_path)?;
    let full = confine_to_repo(&repo, &file_path)?;
    // Async + spawn_blocking: file IO is blocking. Same rationale as
    // git_file_diff — keeps the Tauri runtime free for parallel calls
    // (the editor often reads while the diff is also being fetched).
    tokio::task::spawn_blocking(move || {
        if !full.exists() {
            return Err(AppError::msg(format!(
                "File not found on disk: {} (resolved to {})",
                file_path,
                full.display()
            )));
        }
        let bytes = std::fs::read(&full).map_err(AppError::Io)?;
        if looks_binary(&bytes) {
            return Err(AppError::msg("Cannot edit a binary file"));
        }
        Ok(String::from_utf8_lossy(&bytes).to_string())
    })
    .await
    .map_err(|e| AppError::msg(format!("read task panicked: {e}")))?
}

/// Two-sided binary preview (typically for images). `oldDataUrl` reflects
/// what the index / HEAD has; `newDataUrl` is the working-tree copy. Either
/// may be null when the file was added or deleted. Sizes are reported in
/// bytes so the UI can show a friendly indicator.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinaryPreview {
    pub mime: String,
    pub old_data_url: Option<String>,
    pub new_data_url: Option<String>,
    pub old_size: Option<u64>,
    pub new_size: Option<u64>,
}

/// Build a base64 data URL for a binary file's two sides — used by the
/// image preview pane. Caps each side at ~8 MiB to avoid blowing the IPC
/// channel and the renderer's memory.
#[tauri::command]
pub fn git_binary_preview(
    repo_path: String,
    file_path: String,
    staged: bool,
) -> AppResult<BinaryPreview> {
    use base64::Engine as _;
    const MAX_BYTES: usize = 8 * 1024 * 1024;
    let repo = resolve_repo(&repo_path)?;
    let safe_path = confine_to_repo(&repo, &file_path)?;
    let mime = mime_from_path(&file_path);
    // Old side: what's in HEAD (unstaged diff) or in the index (staged).
    let old_spec = if staged { "HEAD" } else { ":0" };
    let old_obj = format!("{}:{}", old_spec, file_path);
    let old_bytes = run_git(&repo, &["show", &old_obj]).ok();
    let new_bytes = std::fs::read(&safe_path).ok();
    let to_data_url = |bytes: &[u8]| -> Option<String> {
        if bytes.is_empty() {
            return None;
        }
        let slice = if bytes.len() > MAX_BYTES {
            &bytes[..MAX_BYTES]
        } else {
            bytes
        };
        let b64 = base64::engine::general_purpose::STANDARD.encode(slice);
        Some(format!("data:{};base64,{}", mime, b64))
    };
    let old_data_url = old_bytes.as_deref().and_then(to_data_url);
    let new_data_url = new_bytes.as_deref().and_then(to_data_url);
    Ok(BinaryPreview {
        mime,
        old_size: old_bytes.as_ref().map(|b| b.len() as u64),
        new_size: new_bytes.as_ref().map(|b| b.len() as u64),
        old_data_url,
        new_data_url,
    })
}

fn mime_from_path(path: &str) -> String {
    let lower = path.to_ascii_lowercase();
    let ext = lower.rsplit('.').next().unwrap_or("");
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    }
    .to_string()
}

#[tauri::command]
pub fn write_working_file(
    repo_path: String,
    file_path: String,
    content: String,
) -> AppResult<()> {
    let repo = resolve_repo(&repo_path)?;
    let full = confine_to_repo(&repo, &file_path)?;
    if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent).map_err(AppError::Io)?;
    }
    std::fs::write(&full, content).map_err(AppError::Io)?;
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeEntry {
    pub path: String,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub bare: bool,
    pub detached: bool,
}

/// Append `.squint/` to `.git/info/exclude` so the worktree dir we create
/// inside the repo doesn't litter `git status`. Idempotent — we only write
/// the line if it isn't already present (so the user is free to delete
/// or move it).
fn ensure_squint_excluded(repo: &Path) -> AppResult<()> {
    let exclude = repo.join(".git").join("info").join("exclude");
    let existing = std::fs::read_to_string(&exclude).unwrap_or_default();
    let needle = ".squint/";
    if existing.lines().any(|l| l.trim() == needle) {
        return Ok(());
    }
    if let Some(parent) = exclude.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let mut next = existing;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str(needle);
    next.push('\n');
    std::fs::write(&exclude, next).map_err(AppError::Io)?;
    Ok(())
}

/// Create a worktree at `worktree_path` checked out on `branch`, based on
/// `base`. If `branch` already exists we reuse it (no `-b`); otherwise we
/// create it off `base`. Both forms reject argv that would smuggle flags.
///
/// `worktree_path` may be absolute or relative to `repo_path`; we keep the
/// caller's choice as-is so the path stored in the DB matches what `git
/// worktree list` reports.
#[tauri::command]
pub fn git_worktree_add(
    repo_path: String,
    branch: String,
    base: String,
    worktree_path: String,
) -> AppResult<String> {
    let repo = resolve_repo(&repo_path)?;
    reject_flaggish("branch", &branch)?;
    reject_flaggish("base", &base)?;
    reject_flaggish("worktree path", &worktree_path)?;

    ensure_squint_excluded(&repo)?;

    if let Some(parent) = Path::new(&worktree_path).parent() {
        if !parent.as_os_str().is_empty() {
            // Resolve against repo for relative paths so create_dir_all hits
            // the right place; absolute parents pass through unchanged.
            let abs = if Path::new(&worktree_path).is_absolute() {
                parent.to_path_buf()
            } else {
                repo.join(parent)
            };
            std::fs::create_dir_all(&abs).ok();
        }
    }

    let branch_exists = run_git(
        &repo,
        &[
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ],
    )
    .is_ok();

    if branch_exists {
        run_git(
            &repo,
            &["worktree", "add", &worktree_path, &branch],
        )?;
    } else {
        run_git(
            &repo,
            &[
                "worktree",
                "add",
                "-b",
                &branch,
                &worktree_path,
                &base,
            ],
        )?;
    }

    // Copy gitignored bootstrap files (.env, .env.*, .npmrc, etc) from
    // the main worktree into the new one. Without this, the agent's
    // worktree can't actually run the project — dev servers crash on
    // missing env vars, package installs fail without the registry
    // override, etc. Best-effort: failures don't abort the worktree
    // creation, the user can manually copy what's missing.
    let resolved_worktree = if Path::new(&worktree_path).is_absolute() {
        Path::new(&worktree_path).to_path_buf()
    } else {
        repo.join(&worktree_path)
    };
    let _ = copy_bootstrap_files(&repo, &resolved_worktree);

    Ok(worktree_path)
}

/// Copy every top-level dotfile commonly excluded by `.gitignore` from
/// `src` to `dst` so the new worktree has the env it needs to actually
/// run the project. Only top-level entries are considered — deep
/// recursive `.env`s belong to whatever sub-package owns them and the
/// agent will inherit those when it cds into the subdir.
///
/// Patterns covered: `.env`, `.env.*`, `.envrc`, `.npmrc`, `.yarnrc`,
/// `.tool-versions`. Files already present in `dst` are skipped so the
/// agent can override locally without us clobbering its edits on
/// subsequent worktree adds (unlikely but cheap to honor).
fn copy_bootstrap_files(src: &Path, dst: &Path) -> std::io::Result<()> {
    let entries = std::fs::read_dir(src)?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = match name.to_str() {
            Some(s) => s,
            None => continue,
        };
        let is_env = name_str == ".env" || name_str.starts_with(".env.");
        let is_other =
            matches!(name_str, ".envrc" | ".npmrc" | ".yarnrc" | ".tool-versions");
        if !is_env && !is_other {
            continue;
        }
        let from = entry.path();
        if !from.is_file() {
            continue;
        }
        let to = dst.join(&name);
        if to.exists() {
            continue;
        }
        let _ = std::fs::copy(&from, &to);
    }
    Ok(())
}

/// Remove a worktree by path. Uses `--force` because the agent's worktree
/// often has uncommitted/in-progress changes when the user archives a card;
/// the data still lives on the branch ref (unless `branch_name` is set,
/// see below).
///
/// Async + `spawn_blocking` because deleting a worktree with a populated
/// `node_modules` / `.next` / build artifacts can take seconds of disk
/// IO — running on the Tauri IPC thread froze the entire UI while git
/// walked the file tree. Moving it to the blocking pool keeps the rest
/// of the app responsive while cleanup runs.
///
/// `branch_name` is optional: when provided, the branch is also deleted
/// (`git branch -D`) after the worktree is gone. Used by `deleteCard` —
/// abandoning a card should leave the repo as if the card never existed.
/// The archive flow on Done cards leaves `branch_name` unset so the PR's
/// branch survives.
#[tauri::command]
pub async fn git_worktree_remove(
    repo_path: String,
    worktree_path: String,
    branch_name: Option<String>,
) -> AppResult<()> {
    reject_flaggish("worktree path", &worktree_path)?;
    if let Some(b) = branch_name.as_deref() {
        reject_flaggish("branch name", b)?;
    }
    let repo = resolve_repo(&repo_path)?;
    tokio::task::spawn_blocking(move || {
        run_git(
            &repo,
            &["worktree", "remove", "--force", &worktree_path],
        )?;
        if let Some(branch) = branch_name {
            // `-D` (force) because the branch hasn't been merged to its
            // upstream — the agent's work is being discarded.
            // Failures here are non-fatal (branch may already be gone,
            // or never existed if the agent never reached spawn). We
            // log to stderr but don't surface to the caller because the
            // user has already moved on from the card.
            if let Err(e) = run_git(&repo, &["branch", "-D", &branch]) {
                eprintln!("git_worktree_remove: branch delete failed: {e}");
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| AppError::msg(format!("worktree remove panicked: {e}")))?
}

/// Parse `git worktree list --porcelain`. Each record is a block separated
/// by a blank line: `worktree <path>`, then optional `HEAD <sha>`,
/// `branch <refname>`, `bare`, `detached`. We surface that as structured
/// data so the UI can render an "active worktrees" panel later.
#[tauri::command]
pub fn git_worktree_list(repo_path: String) -> AppResult<Vec<WorktreeEntry>> {
    let repo = resolve_repo(&repo_path)?;
    let raw = run_git_string(&repo, &["worktree", "list", "--porcelain"])?;
    let mut out: Vec<WorktreeEntry> = Vec::new();
    let mut cur: Option<WorktreeEntry> = None;
    for line in raw.lines() {
        if line.is_empty() {
            if let Some(entry) = cur.take() {
                out.push(entry);
            }
            continue;
        }
        if let Some(path) = line.strip_prefix("worktree ") {
            if let Some(entry) = cur.take() {
                out.push(entry);
            }
            cur = Some(WorktreeEntry {
                path: path.to_string(),
                head: None,
                branch: None,
                bare: false,
                detached: false,
            });
        } else if let Some(entry) = cur.as_mut() {
            if let Some(sha) = line.strip_prefix("HEAD ") {
                entry.head = Some(sha.to_string());
            } else if let Some(refname) = line.strip_prefix("branch ") {
                entry.branch = Some(
                    refname
                        .strip_prefix("refs/heads/")
                        .unwrap_or(refname)
                        .to_string(),
                );
            } else if line == "bare" {
                entry.bare = true;
            } else if line == "detached" {
                entry.detached = true;
            }
        }
    }
    if let Some(entry) = cur.take() {
        out.push(entry);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_behind_only_branch_as_fast_forwardable() {
        let branch = BranchSyncCandidate {
            name: "feature/login".into(),
            upstream: "origin/feature/login".into(),
            track: "[behind 2]".into(),
            worktree_path: String::new(),
        };

        assert_eq!(
            classify_branch_sync(&branch, "/repo"),
            BranchSyncDecision::FastForward
        );
    }

    #[test]
    fn skips_diverged_branches() {
        let branch = BranchSyncCandidate {
            name: "feature/login".into(),
            upstream: "origin/feature/login".into(),
            track: "[ahead 1, behind 2]".into(),
            worktree_path: String::new(),
        };

        assert_eq!(
            classify_branch_sync(&branch, "/repo"),
            BranchSyncDecision::Skip("diverged from upstream".into())
        );
    }

    #[test]
    fn skips_branch_checked_out_in_another_worktree() {
        let branch = BranchSyncCandidate {
            name: "main".into(),
            upstream: "origin/main".into(),
            track: "[behind 1]".into(),
            worktree_path: "/tmp/squint-main".into(),
        };

        assert_eq!(
            classify_branch_sync(&branch, "/repo"),
            BranchSyncDecision::Skip("checked out at /tmp/squint-main".into())
        );
    }

    #[test]
    fn includes_editable_ignored_files_without_build_trees() {
        assert!(is_editable_ignored_file(".env"));
        assert!(is_editable_ignored_file(".env.local"));
        assert!(is_editable_ignored_file("apps/web/.env.production"));
        assert!(is_editable_ignored_file(".npmrc"));

        assert!(!is_editable_ignored_file("node_modules/pkg/index.js"));
        assert!(!is_editable_ignored_file("dist/index.html"));
        assert!(!is_editable_ignored_file("src-tauri/target/debug/squint"));
        assert!(!is_editable_ignored_file(".DS_Store"));
    }
}
