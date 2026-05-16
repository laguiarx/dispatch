import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useRepoStore } from "@/features/repository/repository.store";
import { isTauri } from "@/lib/tauri";

/**
 * Wire up the native macOS menu items defined in `src-tauri/src/menu.rs`.
 * The Rust side emits `menu-action` with the item id as payload; we route
 * each id to the matching store action so the menu and the keyboard
 * shortcuts converge on the same logic.
 */
export function useNativeMenu(): void {
  const store = useRepoStore.getState;

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    listen<string>("menu-action", (event) => {
      handle(event.payload, store);
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {
        /* if the listener fails, the keyboard shortcuts still work */
      });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [store]);
}

function handle(id: string, get: typeof useRepoStore.getState): void {
  const s = get();
  switch (id) {
    case "app:preferences":
      s.setSettingsOpen(true);
      return;
    case "app:check-updates":
      s.checkForUpdate().catch(() => {
        /* surfaced via toast */
      });
      return;
    case "file:open-repo":
      s.openRepositoryPicker().catch(() => {
        /* surfaced via error state */
      });
      return;
    case "file:go-to-file":
      if (s.repository) s.setPaletteMode("files");
      return;
    case "file:refresh":
      s.refresh().catch(() => {
        /* surfaced via error state */
      });
      return;
    case "file:save":
      s.saveEdit().catch(() => {
        /* surfaced via error state */
      });
      return;
    case "file:close-tab":
      if (
        s.selectedFilePath != null &&
        s.openTabs.some(
          (t) =>
            t.path === s.selectedFilePath &&
            t.staged === s.selectedFileStaged,
        )
      ) {
        s.closeTab({
          path: s.selectedFilePath,
          staged: s.selectedFileStaged,
        });
      }
      return;
    case "file:close-window":
      void import("@tauri-apps/api/webviewWindow").then((m) => {
        m.getCurrentWebviewWindow().close();
      });
      return;
    case "edit:find-in-file":
      s.setInFileSearchOpen(true);
      s.pingInFileSearch();
      return;
    case "edit:find-in-repo":
      s.setSidebarTab("search");
      s.setLeftSidebarVisible(true);
      s.pingSearchFocus();
      return;
    case "edit:replace":
      s.setReplaceOpen(true);
      return;
    case "view:tab-changes":
      s.setSidebarTab("changes");
      s.setLeftSidebarVisible(true);
      return;
    case "view:tab-files":
      s.setSidebarTab("files");
      s.setLeftSidebarVisible(true);
      return;
    case "view:toggle-left":
      s.toggleLeftSidebar();
      return;
    case "view:toggle-right":
      s.toggleRightSidebar();
      return;
    case "view:toggle-terminal":
      s.toggleTerminal();
      return;
    case "view:zoom-in":
      s.zoomIn();
      return;
    case "view:zoom-out":
      s.zoomOut();
      return;
    case "view:zoom-reset":
      s.resetZoom();
      return;
    case "view:command-palette":
      if (s.repository) s.setPaletteMode("commands");
      return;
  }
}
