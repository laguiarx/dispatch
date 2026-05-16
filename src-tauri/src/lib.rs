mod commands;
mod error;
mod menu;

/// Inherit the user's real `$PATH` from their login shell.
///
/// macOS apps launched from Finder / Spotlight / Dock get a minimal PATH
/// from launchd — usually just `/usr/bin:/bin:/usr/sbin:/sbin`. That's
/// missing every dir where the tools we care about actually live
/// (`/opt/homebrew/bin`, `/usr/local/bin`, `~/.npm-global/bin`,
/// `~/.cargo/bin`, NVM paths, etc), so `which("gh")` and friends fail.
/// In `tauri dev` the app inherits the terminal's PATH (where the user
/// has all their tools), so the integrations panel reads as fully
/// configured — masking the production bug.
///
/// Fix: at startup, spawn the user's `$SHELL` as an interactive login
/// shell, ask it to print `$PATH`, and propagate the result onto the
/// current process. After this, every later `Command::new("gh")` /
/// `which(...)` call sees the same PATH the user does in Terminal.
#[cfg(target_os = "macos")]
fn fix_macos_path_from_login_shell() {
    use std::process::Command;
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    // `-i -l -c '...'` runs the shell as an interactive login shell so it
    // sources ~/.zshrc, ~/.zprofile, ~/.bash_profile, /etc/paths.d/*, etc
    // — same path discovery the user gets when they open a Terminal tab.
    // 800ms is generous; a healthy shell startup takes <200ms.
    let out = Command::new(&shell)
        .args(["-ilc", "echo -n $PATH"])
        .env_remove("PROMPT_COMMAND") // some setups print noise on startup
        .output();
    let Ok(out) = out else { return };
    if !out.status.success() {
        return;
    }
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if path.is_empty() {
        return;
    }
    // Only overwrite if the shell-resolved PATH is richer than what we
    // already have (e.g. when launched from a terminal already, the
    // existing PATH is fine and we don't want to clobber dev-time
    // additions).
    let existing = std::env::var("PATH").unwrap_or_default();
    if path != existing && path.len() > existing.len() {
        std::env::set_var("PATH", path);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Has to happen BEFORE the Tauri builder spins up tokio + spawns any
    // commands — those inherit the process env at creation time.
    #[cfg(target_os = "macos")]
    fix_macos_path_from_login_shell();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            menu::build_app_menu(app.handle())?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            menu::on_menu_event(app, event.id().as_ref());
        })
        .invoke_handler(tauri::generate_handler![
            commands::repository::open_repository,
            commands::repository::git_current_branch,
            commands::git::git_status,
            commands::git::git_file_diff,
            commands::git::git_stage_file,
            commands::git::git_unstage_file,
            commands::git::git_stage_paths,
            commands::git::git_unstage_paths,
            commands::git::git_discard_paths,
            commands::git::git_discard_file,
            commands::git::open_in_vscode,
            commands::git::detect_editors,
            commands::git::open_in_editor,
            commands::git::read_working_file,
            commands::git::git_binary_preview,
            commands::git::write_working_file,
            commands::git::git_apply_patch,
            commands::git::git_commit,
            commands::git::git_push,
            commands::git::git_pull,
            commands::git::git_fetch,
            commands::git::git_undo_last_commit,
            commands::git::git_default_branch,
            commands::git::git_remote_branches,
            commands::git::git_behind_ahead,
            commands::git::git_rebase_onto,
            commands::git::git_merge_into,
            commands::gh::gh_detect_status,
            commands::gh::gh_pr_create,
            commands::gh::gh_pr_list,
            commands::git::list_branches,
            commands::git::git_delete_branch,
            commands::git::checkout_branch,
            commands::git::create_branch,
            commands::git::list_repo_files,
            commands::git::git_stash_push,
            commands::git::git_stash_list,
            commands::git::git_stash_pop,
            commands::git::git_stash_apply,
            commands::git::git_stash_drop,
            commands::search::search_repo,
            commands::ai::detect_ai_clis,
            commands::ai::run_ai_cli,
            commands::ai::git_diff_for_ai,
            commands::ai::git_log_for_ai,
            commands::ai::detect_integrations,
            commands::replace::replace_preview,
            commands::replace::replace_apply,
            commands::terminal::term_open,
            commands::terminal::term_write,
            commands::terminal::term_resize,
            commands::terminal::term_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
