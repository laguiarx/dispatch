import { useEffect, useMemo, type ReactNode } from "react";
import { TopBar } from "@/components/top-bar";
import { Sidebar } from "@/components/sidebar";
import { DiffPane } from "@/components/diff-pane";
import { TabStrip } from "@/components/tab-strip";
import { BoardView } from "@/components/board/board-view";
import { ProjectSidebar } from "@/components/board/project-sidebar";
import { useBoardStore } from "@/features/board/board.store";
import { AiOutputDialog } from "@/components/ai-output-dialog";
import { PrBranchChoiceDialog } from "@/components/pr-branch-choice-dialog";
import { PrFlowDialog } from "@/components/pr-flow-dialog";
import { ReplaceOverlay } from "@/components/replace-overlay";
import { TerminalDrawer } from "@/components/terminal-drawer";
import {
  SidebarResizeHandle,
  TerminalResizeHandle,
} from "@/components/resize-handle";
import { CommandPalette } from "@/components/command-palette";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { SettingsDialog } from "@/components/settings-dialog";
import { ShortcutsDialog } from "@/components/shortcuts-dialog";
import { StashPromptDialog } from "@/components/stash-prompt-dialog";
import { OnboardingModal } from "@/components/onboarding-modal";
import { Toast } from "@/components/toast";
import { I } from "@/components/icons";
import { cn } from "@/lib/utils";
import { useRepoStore } from "@/features/repository/repository.store";
import {
  applyCustomColors,
  applyDensity,
  applyMonoFont,
  applySansFont,
  applyTheme,
  applyUiZoom,
} from "@/lib/theme";
import { isTauri } from "@/lib/tauri";
import { useKeyboardShortcuts } from "./keyboard";
import { useNativeMenu } from "./menu-events";
import {
  buildBoardCommands,
  buildCommands,
  buildFileCommands,
} from "./commands";

export function App() {
  const repository = useRepoStore((s) => s.repository);
  const reviewedCardId = useRepoStore((s) => s.reviewedCardId);
  const errorMessage = useRepoStore((s) => s.errorMessage);
  const setError = useRepoStore((s) => s.setError);
  const settings = useRepoStore((s) => s.settings);

  const loadProjects = useBoardStore((s) => s.loadProjects);
  const projects = useBoardStore((s) => s.projects);

  // confirm dialog state from store
  const confirm = useRepoStore((s) => s.confirm);
  const setConfirm = useRepoStore((s) => s.setConfirm);

  // toast queue
  const toasts = useRepoStore((s) => s.toasts);

  // search/replace/palette
  const paletteMode = useRepoStore((s) => s.paletteMode);
  const setPaletteMode = useRepoStore((s) => s.setPaletteMode);
  const repoFiles = useRepoStore((s) => s.repoFiles);
  const repoFilesLoading = useRepoStore((s) => s.repoFilesLoading);
  const fetchRepoFiles = useRepoStore((s) => s.fetchRepoFiles);

  // Index the working tree only when the user actually opens the file picker.
  useEffect(() => {
    if (paletteMode === "files") {
      fetchRepoFiles().catch(() => {
        /* error already surfaced via store */
      });
    }
  }, [paletteMode, fetchRepoFiles]);

  useKeyboardShortcuts();
  useNativeMenu();

  // (Old behaviour: auto-show the right sidebar when an AI action started.
  // The right sidebar no longer exists — AI output now opens as a centered
  // modal driven by `aiKind`, so no extra plumbing is needed.)

  useEffect(() => {
    applyTheme(settings.theme);
    applyDensity(settings.density);
    applyUiZoom(settings.uiZoom);
    applySansFont(settings.uiFont, settings.customUiFont);
    applyMonoFont(settings.codeFont, settings.customCodeFont);
    applyCustomColors(settings.customColors);
  }, [
    settings.theme,
    settings.density,
    settings.uiZoom,
    settings.uiFont,
    settings.codeFont,
    settings.customUiFont,
    settings.customCodeFont,
    settings.customColors,
  ]);

  // Show the welcome tour on first launch.
  const setOnboardingOpen = useRepoStore((s) => s.setOnboardingOpen);
  const fetchAiClis = useRepoStore((s) => s.fetchAiClis);
  const checkForUpdate = useRepoStore((s) => s.checkForUpdate);
  useEffect(() => {
    if (!settings.firstRunCompleted) {
      setOnboardingOpen(true);
    }
    // Warm the AI CLI probe in the background so opening Preferences > AI
    // (or triggering an AI action) doesn't block on a fresh subprocess
    // detection. Fire-and-forget — `fetchAiClis` no-ops on later calls.
    fetchAiClis().catch(() => {
      /* non-fatal */
    });
    if (isTauri()) {
      checkForUpdate(true).catch(() => {
        /* non-fatal */
      });
    }
    // Only on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The legacy "auto-open last repo on launch" path is gone now that the
  // board is the primary view. Repos surface as projects in the sidebar;
  // the diff workflow only re-enters via Review mode, which sets the
  // repository explicitly via `enterReviewMode`.

  // Load the project list from SQLite once at boot. The board is the
  // primary view of the app, so this needs to happen before any UI cares
  // about activeProjectId / cards.
  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  // Auto-sync with the remote whenever the window regains focus (the user
  // came back from the browser / terminal / GitHub / etc). The store
  // throttles repeated calls so alt-tabbing twice in a second doesn't
  // hammer the remote. Silent on success; toasts only when the current
  // branch's upstream becomes `gone` (PR merged + branch deleted).
  const gitAutoSync = useRepoStore((s) => s.gitAutoSync);
  useEffect(() => {
    if (!repository) return;
    const onFocus = () => {
      void gitAutoSync();
    };
    window.addEventListener("focus", onFocus);
    // Also run once on mount / when a repo first opens so the first paint
    // already reflects remote state (no wait until you alt-tab away).
    void gitAutoSync();
    return () => window.removeEventListener("focus", onFocus);
  }, [repository?.path, gitAutoSync]);

  // Build command palette items
  const files = useRepoStore((s) => s.files);
  const selectedFilePath = useRepoStore((s) => s.selectedFilePath);
  const setTheme = useRepoStore((s) => s.setTheme);
  const setSettingsOpen = useRepoStore((s) => s.setSettingsOpen);
  const selectFile = useRepoStore((s) => s.selectFile);
  const setSidebarTab = useRepoStore((s) => s.setSidebarTab);
  const toggleStage = useRepoStore((s) => s.toggleStage);
  const toggleReviewed = useRepoStore((s) => s.toggleReviewed);
  const requestDiscard = useRepoStore((s) => s.requestDiscard);
  const openProjectInVscode = useRepoStore((s) => s.openProjectInVscode);
  const refresh = useRepoStore((s) => s.refresh);
  const pingSearchFocus = useRepoStore((s) => s.pingSearchFocus);
  const setReplaceOpen = useRepoStore((s) => s.setReplaceOpen);
  const setDiffMode = useRepoStore((s) => s.setDiffMode);
  const setDiffExpansion = useRepoStore((s) => s.setDiffExpansion);
  const setAiKind = useRepoStore((s) => s.setAiKind);
  const pushToast = useRepoStore((s) => s.pushToast);
  const setShortcutsOpen = useRepoStore((s) => s.setShortcutsOpen);

  const copyErrorMessage = async () => {
    if (!errorMessage) return;
    try {
      await navigator.clipboard.writeText(errorMessage);
      pushToast("Copied error to clipboard");
    } catch {
      pushToast("Clipboard unavailable", "danger");
    }
  };

  const actionCommands = useMemo(
    () =>
      buildCommands({
        files,
        selectedFilePath,
        theme: settings.theme,
        setTheme,
        setSettingsOpen,
        selectFile,
        setSidebarTab,
        toggleStage,
        toggleReviewed,
        requestDiscard,
        refresh,
        openSearchPanel: () => {
          setSidebarTab("search");
          pingSearchFocus();
        },
        setReplaceOpen,
        setDiffMode,
        setDiffExpansion,
        setAiKind,
        openProjectInVscode,
        pushToast,
        openShortcuts: () => setShortcutsOpen(true),
        openOnboarding: () => setOnboardingOpen(true),
      }),
    [
      files,
      selectedFilePath,
      settings.theme,
      setTheme,
      setSettingsOpen,
      selectFile,
      setSidebarTab,
      toggleStage,
      toggleReviewed,
      requestDiscard,
      refresh,
      pingSearchFocus,
      setReplaceOpen,
      setDiffMode,
      setDiffExpansion,
      setAiKind,
      openProjectInVscode,
      pushToast,
      setShortcutsOpen,
      setOnboardingOpen,
    ],
  );

  const fileCommands = useMemo(() => {
    if (paletteMode !== "files") return [];
    return buildFileCommands({
      repoFiles,
      changedFiles: files,
      selectFile,
      setSidebarTab,
    });
  }, [paletteMode, repoFiles, files, selectFile, setSidebarTab]);

  // Board-mode palette has a much smaller surface than the diff palette —
  // file-staging / AI / diff-view actions don't apply when the user is
  // looking at the kanban.
  const setActiveProject = useBoardStore((s) => s.setActiveProject);
  const addProjectFromPicker = useBoardStore((s) => s.addProjectFromPicker);
  const setNewCardOpen = useBoardStore((s) => s.setNewCardOpen);
  const projectsForPalette = useBoardStore((s) => s.projects);
  const activeProjectId = useBoardStore((s) => s.activeProjectId);
  const boardCommands = useMemo(
    () =>
      buildBoardCommands({
        projects: projectsForPalette.map((p) => ({ id: p.id, name: p.name })),
        activeProjectId,
        setActiveProject,
        addProjectFromPicker,
        setNewCardOpen,
        setSettingsOpen,
        openShortcuts: () => setShortcutsOpen(true),
        setTheme,
        theme: settings.theme,
        pushToast,
      }),
    [
      projectsForPalette,
      activeProjectId,
      setActiveProject,
      addProjectFromPicker,
      setNewCardOpen,
      setSettingsOpen,
      setShortcutsOpen,
      setTheme,
      settings.theme,
      pushToast,
    ],
  );

  // The board view (no review) gets the board palette; Review mode gets
  // the legacy diff palette since the diff workflow is back in scope.
  const inBoardMode = !reviewedCardId;
  const paletteCommands =
    paletteMode === "files"
      ? fileCommands
      : inBoardMode
        ? boardCommands
        : actionCommands;

  return (
    <div
      // Outermost shell. 6px padding around the bubbles + 4px gap between
      // topbar and workspace — the inter-bubble gap matches the
      // sidebar↔main and main↔terminal gaps below so every seam in the
      // app reads as the same width.
      className="h-screen relative flex flex-col gap-1 p-1.5 bg-bg-0 overflow-hidden"
    >
      <TopBar />

      {reviewedCardId && repository ? (
        // Review mode: scope-swap to the card's worktree and show the
        // legacy diff workflow (sidebar with file list, tab strip, diff
        // pane, terminal). Banner up top to get back to the board.
        <WorkspaceShell sidebar={<Sidebar />}>
          <div
            className={cn(
              "flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden",
              "bg-[color-mix(in_oklab,var(--bg-0)_92%,transparent)]",
              "border border-bd-2 rounded-[10px]",
              "shadow-[0_12px_32px_rgba(0,0,0,0.4),0_2px_8px_rgba(0,0,0,0.25)]",
              "backdrop-blur-card backdrop-saturate-[140%]",
            )}
          >
            {/* "Back to board" lives in the unified sidebar header now. */}
            <TabStrip />
            <DiffPane />
          </div>
        </WorkspaceShell>
      ) : (
        // Default: agent-first board. Layout shape matches Review mode
        // (resizable sidebar via SidebarResizeHandle, ⌘B toggles
        // visibility) so toggling modes doesn't shift the workspace.
        <WorkspaceShell sidebar={<ProjectSidebar />}>
          <div
            className={cn(
              "flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden",
              "bg-[color-mix(in_oklab,var(--bg-0)_92%,transparent)]",
              "border border-bd-2 rounded-[10px]",
              "shadow-[0_12px_32px_rgba(0,0,0,0.4),0_2px_8px_rgba(0,0,0,0.25)]",
              "backdrop-blur-card backdrop-saturate-[140%]",
            )}
          >
            {projects.length === 0 ? (
              <div className="flex-1 grid place-items-center text-center text-[12px] text-fg-2 p-6">
                <div className="flex flex-col gap-2 max-w-[320px]">
                  <div className="text-[14px] font-medium text-fg-0">
                    No projects yet
                  </div>
                  <div>
                    Use the <span className="text-fg-1">+</span> button in
                    the Workspace sidebar to add a Git repository. Each
                    project you add becomes a kanban board scoped to that
                    repo.
                  </div>
                </div>
              </div>
            ) : (
              <BoardView />
            )}
          </div>
        </WorkspaceShell>
      )}

      {errorMessage ? (
        <div
          className={cn(
            "flex items-center gap-2 px-3 py-1.5 text-[11.5px]",
            "bg-[color-mix(in_oklab,var(--diff-del-mark)_12%,transparent)]",
            "border-t border-[color-mix(in_oklab,var(--diff-del-mark)_35%,transparent)]",
            "text-diff-del-mark",
          )}
        >
          <span className="font-mono font-semibold">Error</span>
          <span className="min-w-0 flex-1 truncate">{errorMessage}</span>
          <button
            type="button"
            title="Copy error"
            aria-label="Copy error"
            className={cn(
              "grid h-5 w-5 place-items-center rounded-[3px] bg-transparent border-0 cursor-pointer",
              "text-diff-del-mark",
              "hover:bg-white/[0.05]",
            )}
            onClick={copyErrorMessage}
          >
            {I.copy}
          </button>
          <button
            type="button"
            className={cn(
              "px-1.5 py-0.5 rounded-[3px] bg-transparent border-0 cursor-pointer",
              "text-diff-del-mark text-[10.5px] uppercase tracking-[0.04em]",
              "hover:bg-white/[0.05]",
            )}
            onClick={() => setError(null)}
          >
            dismiss
          </button>
        </div>
      ) : null}

      <ReplaceOverlay />
      <CommandPalette
        open={paletteMode !== null}
        mode={paletteMode ?? "commands"}
        onClose={() => setPaletteMode(null)}
        onSwitchMode={(m) => setPaletteMode(m)}
        commands={paletteCommands}
        loading={paletteMode === "files" && repoFilesLoading}
        minQueryLength={paletteMode === "files" ? 1 : 0}
        // Files mode only applies to the diff workflow — in board mode
        // there's no working tree to index, so the ⌘P chord is hidden.
        allowFilesMode={!inBoardMode}
      />
      <ConfirmDialog
        open={!!confirm}
        title={confirm?.title}
        body={confirm?.body}
        confirmLabel={confirm?.confirmLabel}
        danger={confirm?.danger}
        onConfirm={() => confirm?.onConfirm()}
        onCancel={() => setConfirm(null)}
      />
      <SettingsDialog />
      <ShortcutsDialog />
      <StashPromptDialog />
      <OnboardingModal />
      <AiOutputDialog />
      <PrBranchChoiceDialog />
      <PrFlowDialog />
      <Toast messages={toasts} />
    </div>
  );
}

/**
 * Workspace shell shared by Review mode (diff workflow) and Board mode.
 * Owns the sidebar + main column + terminal positioning so the two
 * top-level branches in `App` don't drift apart.
 *
 * Two terminal docks are supported, switched via
 * `settings.terminalPosition`:
 *   - "bottom": traditional drawer beneath the main pane, full width.
 *     The grid is `[sidebar | main column]` and the main column is
 *     `flex-col` with `[content | TerminalDrawer]`.
 *   - "right": the terminal becomes a side panel between the main pane
 *     and the right edge. The grid becomes
 *     `[sidebar | main column | TerminalDrawer]` and the main column is
 *     just the content (no terminal below).
 * In either mode the terminal can be hidden via the existing
 * `terminalOpen` flag (⌘`); the drawer renders `display: none` so its
 * PTY scrollback stays warm across toggles.
 */
function WorkspaceShell({
  children,
  sidebar,
}: {
  children: ReactNode;
  sidebar: ReactNode;
}) {
  const leftSidebarVisible = useRepoStore((s) => s.settings.leftSidebarVisible);
  const leftSidebarWidth = useRepoStore((s) => s.settings.leftSidebarWidth);
  const terminalOpen = useRepoStore((s) => s.terminalOpen);
  const terminalTabsLen = useRepoStore((s) => s.terminalTabs.length);
  const terminalPosition = useRepoStore((s) => s.settings.terminalPosition);
  const terminalRightWidth = useRepoStore(
    (s) => s.settings.terminalRightWidth,
  );
  const terminalShowingRight =
    terminalPosition === "right" && terminalOpen && terminalTabsLen > 0;

  // Grid columns: sidebar (optional) → main pane → terminal (only when
  // right-docked AND visible). Building the string from a flat array
  // keeps the conditional intent clear and avoids tracking grid line
  // names. `1fr` for the main pane absorbs whatever's left.
  const gridTemplateColumns = [
    leftSidebarVisible ? `${leftSidebarWidth}px` : null,
    "1fr",
    terminalShowingRight ? `${terminalRightWidth}px` : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className="flex-1 grid min-h-0 overflow-hidden gap-1 relative"
      style={{ gridTemplateColumns }}
    >
      {leftSidebarVisible ? sidebar : null}
      {/* Main column always renders its content. When terminal is
          docked at the bottom, it stacks below `children` with its
          horizontal resize handle. When docked at the right, the
          terminal is rendered as a sibling grid cell instead. */}
      <div className="flex flex-col min-w-0 min-h-0 gap-1 relative">
        {children}
        {terminalPosition === "bottom" ? (
          <>
            <TerminalDrawer />
            <TerminalResizeHandle />
          </>
        ) : null}
      </div>
      {terminalPosition === "right" ? (
        <>
          <TerminalDrawer />
          {/* Handle lives in the grid gap between main column and
              terminal — its absolute positioning anchors off the right
              edge using `terminalRightWidth`. */}
          <TerminalResizeHandle />
        </>
      ) : null}
      <SidebarResizeHandle />
    </div>
  );
}
