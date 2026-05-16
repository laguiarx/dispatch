use tauri::menu::{
    AboutMetadataBuilder, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder,
};
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindow};

/// Identifier prefix for custom menu items — the frontend listens for the
/// "menu-action" event and routes by id.
const ACTION_EVENT: &str = "menu-action";

/// Build the application menu (macOS-style: App / File / Edit / View / Window
/// / Help). Custom items are flagged with stable ids that the frontend maps
/// to in-app actions.
pub fn build_app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let about = AboutMetadataBuilder::new()
        .name(Some("Squint"))
        .version(Some(env!("CARGO_PKG_VERSION")))
        .build();

    // App menu (macOS): About / Preferences / Hide / Quit
    let preferences =
        MenuItemBuilder::with_id("app:preferences", "Preferences…")
            .accelerator("CmdOrCtrl+,")
            .build(app)?;

    let app_menu = SubmenuBuilder::new(app, "Squint")
        .item(&PredefinedMenuItem::about(app, Some("About Squint"), Some(about))?)
        .separator()
        .item(&preferences)
        .separator()
        .item(&PredefinedMenuItem::services(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::hide(app, None)?)
        .item(&PredefinedMenuItem::hide_others(app, None)?)
        .item(&PredefinedMenuItem::show_all(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, None)?)
        .build()?;

    // File menu
    let open_existing =
        MenuItemBuilder::with_id("file:open-repo", "Open Repository…")
            .accelerator("CmdOrCtrl+O")
            .build(app)?;
    let go_to_file =
        MenuItemBuilder::with_id("file:go-to-file", "Go to File…")
            .accelerator("CmdOrCtrl+P")
            .build(app)?;
    let refresh =
        MenuItemBuilder::with_id("file:refresh", "Refresh Git Status")
            .accelerator("CmdOrCtrl+R")
            .build(app)?;
    let save = MenuItemBuilder::with_id("file:save", "Save")
        .accelerator("CmdOrCtrl+S")
        .build(app)?;
    let close_tab = MenuItemBuilder::with_id("file:close-tab", "Close Tab")
        .accelerator("CmdOrCtrl+W")
        .build(app)?;
    let close_window =
        MenuItemBuilder::with_id("file:close-window", "Close Window")
            .accelerator("CmdOrCtrl+Shift+W")
            .build(app)?;

    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&open_existing)
        .item(&go_to_file)
        .separator()
        .item(&refresh)
        .item(&save)
        .separator()
        .item(&close_tab)
        .item(&close_window)
        .build()?;

    // Edit menu — standard predefined items keep native shortcuts (undo /
    // redo / cut / copy / paste / select-all) working inside text fields.
    let find_in_file =
        MenuItemBuilder::with_id("edit:find-in-file", "Find in File…")
            .accelerator("CmdOrCtrl+F")
            .build(app)?;
    let find_in_repo =
        MenuItemBuilder::with_id("edit:find-in-repo", "Find in Repository…")
            .accelerator("CmdOrCtrl+Shift+F")
            .build(app)?;
    let replace =
        MenuItemBuilder::with_id("edit:replace", "Find & Replace…")
            .accelerator("CmdOrCtrl+Shift+H")
            .build(app)?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .separator()
        .item(&find_in_file)
        .item(&find_in_repo)
        .item(&replace)
        .build()?;

    // View menu
    let tab_changes =
        MenuItemBuilder::with_id("view:tab-changes", "Show Changes")
            .accelerator("CmdOrCtrl+Alt+G")
            .build(app)?;
    let tab_files =
        MenuItemBuilder::with_id("view:tab-files", "Show File Tree")
            .accelerator("CmdOrCtrl+Shift+E")
            .build(app)?;
    let toggle_left =
        MenuItemBuilder::with_id("view:toggle-left", "Toggle Left Sidebar")
            .accelerator("CmdOrCtrl+B")
            .build(app)?;
    let toggle_right =
        MenuItemBuilder::with_id("view:toggle-right", "Toggle Right Sidebar")
            .accelerator("CmdOrCtrl+Alt+B")
            .build(app)?;
    let toggle_terminal =
        MenuItemBuilder::with_id("view:toggle-terminal", "Toggle Terminal")
            .accelerator("CmdOrCtrl+`")
            .build(app)?;
    let zoom_in = MenuItemBuilder::with_id("view:zoom-in", "Zoom In")
        .accelerator("CmdOrCtrl+=")
        .build(app)?;
    let zoom_out = MenuItemBuilder::with_id("view:zoom-out", "Zoom Out")
        .accelerator("CmdOrCtrl+-")
        .build(app)?;
    let zoom_reset = MenuItemBuilder::with_id("view:zoom-reset", "Actual Size")
        .accelerator("CmdOrCtrl+0")
        .build(app)?;
    let cmd_palette =
        MenuItemBuilder::with_id("view:command-palette", "Command Palette…")
            .accelerator("CmdOrCtrl+Shift+P")
            .build(app)?;

    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&tab_changes)
        .item(&tab_files)
        .separator()
        .item(&toggle_left)
        .item(&toggle_right)
        .item(&toggle_terminal)
        .separator()
        .item(&zoom_in)
        .item(&zoom_out)
        .item(&zoom_reset)
        .separator()
        .item(&cmd_palette)
        .build()?;

    // Window menu — standard predefined items (Minimize / Zoom / Fullscreen).
    let window_menu = SubmenuBuilder::new(app, "Window")
        .item(&PredefinedMenuItem::minimize(app, None)?)
        .item(&PredefinedMenuItem::maximize(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::fullscreen(app, None)?)
        .build()?;

    let menu = MenuBuilder::new(app)
        .item(&app_menu)
        .item(&file_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .item(&window_menu)
        .build()?;

    app.set_menu(menu)?;
    Ok(())
}

/// Forward menu clicks to the frontend by emitting "menu-action" with the
/// item id as payload. Frontend (`menu-events.ts`) maps id → action.
pub fn on_menu_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    if let Some(window) = app.get_webview_window("main") {
        emit_to_window(&window, id);
    } else {
        let _ = app.emit(ACTION_EVENT, id.to_string());
    }
}

fn emit_to_window<R: Runtime>(window: &WebviewWindow<R>, id: &str) {
    let _ = window.emit(ACTION_EVENT, id.to_string());
}
