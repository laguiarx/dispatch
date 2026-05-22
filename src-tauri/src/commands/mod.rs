pub mod agent;
pub mod ai;
pub mod attachments;
pub mod board;
pub mod detect;
pub mod gh;
pub mod git;
pub mod repository;
pub mod replace;
pub mod search;
pub mod setup;
pub mod terminal;

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use crate::error::{AppError, AppResult};

/// Reject argv values that would be interpreted by the downstream tool as a
/// flag. A user-controlled value starting with `-` (e.g. a branch name like
/// `--upload-pack=…`) can smuggle options into `git`, `code`, etc. The few
/// places that legitimately need leading dashes (e.g. literal patches piped
/// via stdin) don't go through this guard.
pub(crate) fn reject_flaggish(label: &str, value: &str) -> AppResult<()> {
    if value.starts_with('-') {
        return Err(AppError::msg(format!(
            "{label} can't start with '-' (would be parsed as a flag)"
        )));
    }
    Ok(())
}

/// Canonicalize `child` against `parent` and confirm the resolved path stays
/// inside `parent`. Defends against `..` traversal and absolute-path
/// smuggling from the renderer. Symlinks pointing outside the repo are also
/// rejected — canonicalize() resolves them.
pub(crate) fn confine_to_repo(repo: &Path, rel: &str) -> AppResult<PathBuf> {
    let candidate = PathBuf::from(rel);
    // PathBuf::join discards `parent` when `rel` is absolute — reject that
    // explicitly so we don't silently widen the surface.
    if candidate.is_absolute() {
        return Err(AppError::msg(format!(
            "Path must be relative to the repository: {rel}"
        )));
    }
    let canon_repo = repo
        .canonicalize()
        .map_err(|e| AppError::msg(format!("Cannot resolve repo: {e}")))?;
    let full = canon_repo.join(&candidate);
    // The file may not exist yet (e.g. write_working_file creating a new
    // file), so canonicalize the parent — which must exist — and append the
    // final component.
    let parent = full.parent().unwrap_or(&full);
    let canon_parent = parent
        .canonicalize()
        .map_err(|e| AppError::msg(format!("Cannot resolve path: {e}")))?;
    if !canon_parent.starts_with(&canon_repo) {
        return Err(AppError::msg(format!(
            "Path escapes repository: {rel}"
        )));
    }
    Ok(if full.exists() {
        full.canonicalize()
            .unwrap_or_else(|_| canon_parent.join(candidate.file_name().unwrap_or_default()))
    } else {
        canon_parent.join(candidate.file_name().unwrap_or_default())
    })
}

/// Resolve a repo path string into a canonical `PathBuf`, ensuring it
/// exists. Canonicalization here makes subsequent `confine_to_repo` checks
/// robust against symlink trickery.
pub(crate) fn resolve_repo(path: &str) -> AppResult<PathBuf> {
    let p = PathBuf::from(path);
    if !p.exists() {
        return Err(AppError::msg(format!(
            "Path does not exist: {}",
            p.display()
        )));
    }
    p.canonicalize()
        .map_err(|e| AppError::msg(format!("Cannot resolve repo path: {e}")))
}

/// Run a `git` subcommand inside the given repo and return stdout as bytes.
/// Forces `LC_ALL=C` and `LANG=C` so stderr / parseable output stays in
/// English regardless of the user's locale — the frontend pattern-matches
/// against these messages (e.g. dirty-tree detection on checkout).
pub(crate) fn run_git(repo: &Path, args: &[&str]) -> AppResult<Vec<u8>> {
    let output: Output = Command::new("git")
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .map_err(|e| AppError::Git(format!("failed to spawn git: {e}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(AppError::Git(if stderr.is_empty() {
            format!("git {} exited with {}", args.join(" "), output.status)
        } else {
            stderr
        }));
    }
    Ok(output.stdout)
}

pub(crate) fn run_git_string(repo: &Path, args: &[&str]) -> AppResult<String> {
    let out = run_git(repo, args)?;
    Ok(String::from_utf8(out)?)
}
