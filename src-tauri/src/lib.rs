mod commands;
mod error;
mod menu;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
            commands::gh::gh_detect_status,
            commands::gh::gh_pr_create,
            commands::git::list_branches,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
