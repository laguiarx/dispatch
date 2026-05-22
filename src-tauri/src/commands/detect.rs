//! Project introspection. Given a repo path on disk, tries to figure out
//! what kind of JS/TS project it is so the setup-script dialog can
//! suggest sensible defaults (`bun install`, `cp .env.example .env`, etc).
//!
//! Heuristics only — no exec of user code. Cheap reads of well-known
//! files. The frontend can show the result to the user, who's the one
//! deciding what the setup script actually does.
//!
//! When the user wants something smarter, `project_suggest_setup_script`
//! piggybacks on the existing claude/codex CLI integration to ask the
//! model for a recommendation — same headless invocation the commit-
//! message and PR-description features already use.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::commands::resolve_repo;
use crate::error::{AppError, AppResult};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EnvStatus {
    /// Workspace path relative to repo root. Empty string = repo root.
    pub workspace: String,
    /// At least one `.env` / `.env.local` / `.env.*` (non-example) exists.
    pub has_env: bool,
    /// At least one `.env.example` / `.env.sample` template exists.
    pub has_env_example: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDetection {
    /// True when a `package.json` lives at the repo root. Other JS
    /// signals (`tsconfig.json`, `bun.lockb`) only matter as a tiebreak
    /// for the package manager pick — Node-ness is determined here.
    pub is_node: bool,
    /// "bun" | "pnpm" | "yarn" | "npm" | null. Picked from lockfile
    /// presence, with bun winning over pnpm winning over yarn winning
    /// over npm so a repo that has multiple (migration in progress)
    /// reports the most recent.
    pub package_manager: Option<String>,
    /// "turbo" | "pnpm" | "workspaces" | null. Tells the UI to look for
    /// per-package envs under `apps/*` / `packages/*`.
    pub monorepo_tool: Option<String>,
    /// Workspaces relative to repo root, e.g. `["apps/web", "apps/api"]`.
    /// Empty when the project isn't a monorepo (the env scan still
    /// reports an entry for `""` = root).
    pub workspaces: Vec<String>,
    /// One entry per scanned workspace (root + each detected workspace).
    pub env_status: Vec<EnvStatus>,
}

#[tauri::command]
pub fn project_detect(repo_path: String) -> AppResult<ProjectDetection> {
    let repo = resolve_repo(&repo_path)?;
    let is_node = repo.join("package.json").is_file();
    let package_manager = detect_pm(&repo);
    let (monorepo_tool, workspaces) = if is_node {
        detect_monorepo(&repo)
    } else {
        (None, Vec::new())
    };

    let mut env_status: Vec<EnvStatus> = Vec::with_capacity(workspaces.len() + 1);
    // Always include the root — even monorepos often keep a shared `.env`
    // for tooling (Sentry token, etc).
    env_status.push(scan_envs(&repo, ""));
    for ws in &workspaces {
        let full = repo.join(ws);
        if full.is_dir() {
            env_status.push(scan_envs(&full, ws));
        }
    }

    Ok(ProjectDetection {
        is_node,
        package_manager,
        monorepo_tool,
        workspaces,
        env_status,
    })
}

fn detect_pm(repo: &Path) -> Option<String> {
    // Order = priority. Bun is checked first because a project migrating
    // from npm → bun typically keeps the old lockfile around for a bit.
    if repo.join("bun.lockb").is_file() || repo.join("bun.lock").is_file() {
        return Some("bun".into());
    }
    if repo.join("pnpm-lock.yaml").is_file() {
        return Some("pnpm".into());
    }
    if repo.join("yarn.lock").is_file() {
        return Some("yarn".into());
    }
    if repo.join("package-lock.json").is_file() {
        return Some("npm".into());
    }
    // Fallback: `packageManager` field in package.json. Not a lockfile
    // but it's the modern convention (corepack).
    if let Ok(text) = fs::read_to_string(repo.join("package.json")) {
        if let Some(spec) = extract_package_manager_field(&text) {
            for pm in ["bun", "pnpm", "yarn", "npm"] {
                if spec.starts_with(pm) {
                    return Some(pm.into());
                }
            }
        }
    }
    None
}

fn extract_package_manager_field(json: &str) -> Option<String> {
    // We avoid pulling in a JSON parser just for this — package.json
    // `"packageManager"` is virtually always a one-line string. Cheap
    // substring match is good enough; worst case we miss it and the UI
    // still works (user types the script themselves).
    let idx = json.find("\"packageManager\"")?;
    let after = &json[idx..];
    let colon = after.find(':')?;
    let rest = after[colon + 1..].trim_start();
    let rest = rest.strip_prefix('"')?;
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

fn detect_monorepo(repo: &Path) -> (Option<String>, Vec<String>) {
    let mut tool: Option<String> = None;

    if repo.join("turbo.json").is_file() {
        tool = Some("turbo".into());
    } else if repo.join("pnpm-workspace.yaml").is_file() {
        tool = Some("pnpm".into());
    }

    // Expand workspaces. We look at:
    //   - root package.json "workspaces": []
    //   - pnpm-workspace.yaml "packages:" list
    let mut patterns: Vec<String> = Vec::new();
    if let Ok(text) = fs::read_to_string(repo.join("package.json")) {
        if let Some(list) = extract_workspaces_list(&text) {
            if tool.is_none() {
                tool = Some("workspaces".into());
            }
            patterns.extend(list);
        }
    }
    if let Ok(text) = fs::read_to_string(repo.join("pnpm-workspace.yaml")) {
        patterns.extend(parse_pnpm_workspace_yaml(&text));
    }

    // Resolve each pattern. We only support a very restricted glob — the
    // trailing `/*` form that everyone in JS-land uses. Anything fancier
    // (e.g. `packages/**`) falls back to a literal directory check.
    let mut out: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> =
        std::collections::HashSet::new();
    for p in patterns {
        let resolved = expand_pattern(repo, &p);
        for ws in resolved {
            if seen.insert(ws.clone()) {
                out.push(ws);
            }
        }
    }
    out.sort();
    (tool, out)
}

fn extract_workspaces_list(json: &str) -> Option<Vec<String>> {
    let idx = json.find("\"workspaces\"")?;
    let after = &json[idx..];
    let bracket = after.find('[')?;
    let close = after[bracket..].find(']')?;
    let inner = &after[bracket + 1..bracket + close];
    let items: Vec<String> = inner
        .split(',')
        .filter_map(|s| {
            let t = s.trim().trim_matches('"');
            if t.is_empty() {
                None
            } else {
                Some(t.to_string())
            }
        })
        .collect();
    Some(items)
}

fn parse_pnpm_workspace_yaml(text: &str) -> Vec<String> {
    // YAML is overkill — pnpm-workspace.yaml in the wild is essentially
    // `packages:\n  - 'apps/*'\n  - 'packages/*'`. Line-by-line scan
    // covers it; if a user writes anchors or multi-doc YAML we lose,
    // which is fine — they can type the setup script manually.
    let mut out = Vec::new();
    let mut in_packages = false;
    for raw in text.lines() {
        let line = raw.trim_end();
        if line.starts_with("packages:") {
            in_packages = true;
            continue;
        }
        if in_packages {
            let trimmed = line.trim_start();
            if let Some(rest) = trimmed.strip_prefix("- ") {
                let val = rest.trim().trim_matches(['"', '\'']);
                if !val.is_empty() {
                    out.push(val.to_string());
                }
            } else if !trimmed.is_empty() && !trimmed.starts_with('#') {
                // New top-level key — packages section ended.
                in_packages = false;
            }
        }
    }
    out
}

fn expand_pattern(repo: &Path, pattern: &str) -> Vec<String> {
    // `apps/*` → list direct subdirs of repo/apps that contain package.json.
    // No package.json check would let us include random non-package dirs;
    // requiring one keeps the result focused on real workspaces.
    if let Some(parent) = pattern.strip_suffix("/*") {
        let dir = repo.join(parent);
        let Ok(entries) = fs::read_dir(&dir) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            if !path.join("package.json").is_file() {
                continue;
            }
            if let Ok(rel) = path.strip_prefix(repo) {
                if let Some(s) = rel.to_str() {
                    out.push(s.replace('\\', "/"));
                }
            }
        }
        return out;
    }
    // Literal path — keep only if it's a real workspace.
    let full = repo.join(pattern);
    if full.join("package.json").is_file() {
        return vec![pattern.replace('\\', "/")];
    }
    Vec::new()
}

fn scan_envs(dir: &Path, workspace: &str) -> EnvStatus {
    let mut has_env = false;
    let mut has_env_example = false;
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => {
            return EnvStatus {
                workspace: workspace.to_string(),
                has_env: false,
                has_env_example: false,
            }
        }
    };
    for entry in entries.flatten() {
        if let Some(name) = entry.file_name().to_str() {
            // We only care about top-level dotfiles; nested `.env`s under
            // build outputs aren't relevant.
            if name == ".env"
                || name == ".env.local"
                || name == ".env.development"
                || name == ".env.production"
                || name.starts_with(".env.")
                    && !name.ends_with(".example")
                    && !name.ends_with(".sample")
            {
                has_env = true;
            }
            if name == ".env.example" || name == ".env.sample" {
                has_env_example = true;
            }
        }
    }
    // `_` to silence unused — the iterator is consumed above.
    let _ = workspace;
    EnvStatus {
        workspace: workspace.to_string(),
        has_env,
        has_env_example,
    }
}

// Suppress dead-code lint for the trailing PathBuf import if it's only used
// in tests; bringing it in unconditionally would be a chore.
#[allow(dead_code)]
fn _unused_pathbuf(_p: PathBuf) {}

// ---------------------------------------------------------------------------
// AI-powered suggestion
// ---------------------------------------------------------------------------

/// Cap individual file reads so a misconfigured monorepo (huge generated
/// package.json with all the workspaces inlined) can't blow up the prompt
/// past the model's context window. 4KB per file is plenty for the kind
/// of metadata we actually care about (dependencies, scripts, workspaces).
const SNAPSHOT_PER_FILE_BYTES: usize = 4 * 1024;

/// Ask the configured AI CLI (claude / codex) to recommend a setup
/// script. The implementation builds a small textual snapshot of the
/// project — file listings + a few key file contents — and submits it as
/// a single prompt. We deliberately reuse the same headless invocation
/// path as `run_ai_cli` rather than streaming, because:
///   - the suggestion is one-shot (no follow-ups)
///   - the output is small (a script, not prose)
///   - reusing the env-scrub keeps WARP/iTerm notifications quiet
#[tauri::command]
pub async fn project_suggest_setup_script(
    repo_path: String,
    agent_id: String,
) -> AppResult<String> {
    let repo = resolve_repo(&repo_path)?;
    let snapshot = build_snapshot(&repo);
    let prompt = build_prompt(&snapshot);

    // Reuse the existing AI CLI integration so we get the same env scrub,
    // path discovery (`fix_macos_path_from_login_shell`), and error
    // handling without duplicating that logic here.
    let raw = crate::commands::ai::run_ai_cli(
        agent_id,
        prompt,
        repo_path,
    )
    .await?;

    Ok(clean_script_output(&raw))
}

fn build_prompt(snapshot: &str) -> String {
    // Hard rules in the prompt:
    //   - Output ONLY the script (no prose, no fences) so we can drop
    //     it straight into the textarea.
    //   - Bash, idempotent, errexit (`set -euo pipefail`).
    //   - Real envs: copy from $SOURCE_REPO/<path>/.env into the
    //     worktree. Do NOT touch .env.example — those hold placeholders,
    //     not the secrets the project actually needs to run.
    //   - Stay scoped to dependency install + env bootstrap.
    format!(
        "You are recommending a bash script that runs inside a fresh git \
worktree of a project, BEFORE an autonomous coding agent starts the task. \
The goal: leave the worktree in a state where the agent can immediately \
build/test/run — same way the developer can run the project from \
$SOURCE_REPO right now.\n\
\n\
Output ONLY a bash script. No prose, no markdown fences, no narration. \
Start with `set -euo pipefail`. The script must be idempotent.\n\
\n\
The script runs with `bash -lc` from the worktree root. Available env:\n\
  $WORKTREE_PATH  absolute path of the freshly created worktree\n\
  $SOURCE_REPO    absolute path of the user's original repo (working copy \
                  with real .env files, real node_modules, etc.)\n\
\n\
Rules:\n\
  1. ENV FILES: copy the REAL `.env` (and `.env.local` if present) from \
$SOURCE_REPO into the matching paths under $WORKTREE_PATH. NEVER use \
`.env.example` as the source — those are placeholders without the actual \
secrets. If the project is a monorepo, copy each app's `.env` from \
`$SOURCE_REPO/<workspace>/.env`. Skip workspaces whose source `.env` \
doesn't exist (use `[ -f ... ] && cp` so the script doesn't error on \
projects without envs). Always pass `cp` flags that preserve perms but \
don't error on missing source.\n\
  2. DEPENDENCIES: install with the project's package manager, inferred \
from the lockfile snapshot below. Run a single install command at the \
worktree root — modern PMs handle workspaces themselves.\n\
  3. NOTHING ELSE. No migrations, no codegen, no test runs, no \
`mkdir -p` for dirs that already exist in the repo. The agent will \
handle task-specific work.\n\
\n\
Example shape for a monorepo with apps/server + apps/web on bun:\n\
  set -euo pipefail\n\
  for app in server web; do\n\
    src=\"$SOURCE_REPO/apps/$app/.env\"\n\
    [ -f \"$src\" ] && cp \"$src\" \"$WORKTREE_PATH/apps/$app/.env\"\n\
  done\n\
  bun install\n\
\n\
=== PROJECT SNAPSHOT ===\n{snapshot}\n=== END SNAPSHOT ===\n\
\n\
Output the bash script now, nothing else.\n",
    )
}

fn build_snapshot(repo: &Path) -> String {
    let mut out = String::new();
    // Top-level listing — the model uses this to spot apps/, packages/,
    // Dockerfiles, Makefiles, etc.
    out.push_str("--- top-level files ---\n");
    if let Ok(entries) = fs::read_dir(repo) {
        let mut names: Vec<String> = entries
            .flatten()
            .filter_map(|e| e.file_name().to_str().map(|s| s.to_string()))
            .filter(|n| !n.starts_with(".git") || n == ".git")
            .collect();
        names.sort();
        for n in names.iter().take(80) {
            out.push_str(n);
            out.push('\n');
        }
    }

    // Headline files. Order matters: package.json first because it's the
    // single most informative file for a Node project. Each `dump_file`
    // is a no-op when the file doesn't exist, so we don't have to know
    // whether the repo is JS, Rust, Python ahead of time.
    for relpath in [
        "package.json",
        "turbo.json",
        "pnpm-workspace.yaml",
        ".nvmrc",
        ".node-version",
        ".tool-versions",
        "Makefile",
        "justfile",
        "Cargo.toml",
        "pyproject.toml",
        "requirements.txt",
    ] {
        dump_file(&mut out, repo, relpath);
    }

    // Workspace shape. For a turbo/pnpm/workspaces monorepo, list the
    // package.json of every workspace so the model sees scripts +
    // dependencies per-app, and any .env.example presence.
    let (_, workspaces) = detect_monorepo(repo);
    for ws in workspaces.iter().take(8) {
        out.push_str(&format!("\n--- {ws}/ ---\n"));
        if let Ok(entries) = fs::read_dir(repo.join(ws)) {
            let mut names: Vec<String> = entries
                .flatten()
                .filter_map(|e| e.file_name().to_str().map(|s| s.to_string()))
                .collect();
            names.sort();
            for n in names.iter().take(40) {
                out.push_str(n);
                out.push('\n');
            }
        }
        dump_file(&mut out, repo, &format!("{ws}/package.json"));
    }

    // Lockfile names tell the model which package manager to use; we
    // include just the filenames, not contents (lockfiles are huge and
    // irrelevant beyond their existence).
    out.push_str("\n--- lockfiles present ---\n");
    for name in [
        "bun.lockb",
        "bun.lock",
        "pnpm-lock.yaml",
        "yarn.lock",
        "package-lock.json",
        "Cargo.lock",
        "uv.lock",
        "poetry.lock",
    ] {
        if repo.join(name).is_file() {
            out.push_str(name);
            out.push('\n');
        }
    }

    // Explicit list of REAL env files (not examples) present in the
    // source repo. The model needs this front-and-center so it doesn't
    // fall back to the cargo-cult pattern of copying .env.example.
    out.push_str("\n--- real env files in $SOURCE_REPO (copy these) ---\n");
    let mut env_paths: Vec<String> = Vec::new();
    collect_env_files(repo, repo, &mut env_paths, 0);
    if env_paths.is_empty() {
        out.push_str("(none found)\n");
    } else {
        env_paths.sort();
        for p in env_paths.iter().take(40) {
            out.push_str(p);
            out.push('\n');
        }
    }

    out
}

/// Walk the repo looking for real `.env*` files (not `.env.example` /
/// `.env.sample`). Bounded depth + skipped junk directories so a giant
/// monorepo doesn't blow the time budget.
fn collect_env_files(
    root: &Path,
    dir: &Path,
    out: &mut Vec<String>,
    depth: u32,
) {
    if depth > 4 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = match entry.file_name().to_str() {
            Some(n) => n.to_string(),
            None => continue,
        };
        if path.is_dir() {
            // Skip the usual heavy / irrelevant dirs.
            if matches!(
                name.as_str(),
                "node_modules"
                    | ".git"
                    | "dist"
                    | "build"
                    | ".next"
                    | ".turbo"
                    | "target"
                    | ".venv"
                    | "venv"
                    | "__pycache__"
                    | ".squint"
            ) {
                continue;
            }
            collect_env_files(root, &path, out, depth + 1);
            continue;
        }
        if !is_real_env_file(&name) {
            continue;
        }
        if let Ok(rel) = path.strip_prefix(root) {
            if let Some(s) = rel.to_str() {
                out.push(s.replace('\\', "/"));
            }
        }
    }
}

fn is_real_env_file(name: &str) -> bool {
    if name == ".env" || name == ".env.local" {
        return true;
    }
    if !name.starts_with(".env") {
        return false;
    }
    // Anything ending with .example / .sample is a template, not a real
    // env. Skip backups too.
    if name.ends_with(".example") || name.ends_with(".sample") {
        return false;
    }
    if name.ends_with(".bak") || name.ends_with("~") {
        return false;
    }
    true
}

fn dump_file(out: &mut String, repo: &Path, rel: &str) {
    let full = repo.join(rel);
    let Ok(bytes) = fs::read(&full) else {
        return;
    };
    let truncated = bytes.len() > SNAPSHOT_PER_FILE_BYTES;
    let slice = &bytes[..bytes.len().min(SNAPSHOT_PER_FILE_BYTES)];
    let text = String::from_utf8_lossy(slice);
    out.push_str(&format!("\n--- {rel} ---\n"));
    out.push_str(&text);
    if !text.ends_with('\n') {
        out.push('\n');
    }
    if truncated {
        out.push_str("…(truncated)\n");
    }
}

/// Models love wrapping code in fenced blocks even when the prompt says
/// not to. Strip the most common shapes so the user sees plain bash in
/// the textarea instead of a triple-backtick salad.
fn clean_script_output(raw: &str) -> String {
    let trimmed = raw.trim();
    // Triple-backtick fence — accept ```bash, ```sh, or plain ```.
    if let Some(stripped) = trimmed.strip_prefix("```") {
        // Drop the language tag on the first line (everything up to and
        // including the first newline).
        let after_tag = stripped
            .find('\n')
            .map(|idx| &stripped[idx + 1..])
            .unwrap_or(stripped);
        if let Some(body) = after_tag.strip_suffix("```") {
            return body.trim_end().to_string();
        }
        // Closing fence may have leading whitespace on its own line.
        let body = after_tag.trim_end();
        if let Some(body) = body.strip_suffix("```") {
            return body.trim_end().to_string();
        }
    }
    trimmed.to_string()
}

// We want to expose AppError so a failed CLI invocation propagates. The
// `?` operator on `run_ai_cli`'s AppResult covers that already; this
// reference keeps the lint quiet on the explicit import.
const _: fn() = || {
    let _: fn(String) -> AppError = AppError::msg;
};
