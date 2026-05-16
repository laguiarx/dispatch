import { useEffect, useMemo, useRef, useState } from "react";
import { TopBar } from "@/components/top-bar";
import { Sidebar } from "@/components/sidebar";
import { DiffPane } from "@/components/diff-pane";
import { TabStrip } from "@/components/tab-strip";
import { AiOutputDialog } from "@/components/ai-output-dialog";
import { PrBranchChoiceDialog } from "@/components/pr-branch-choice-dialog";
import { PrFlowDialog } from "@/components/pr-flow-dialog";
import { ReplaceOverlay } from "@/components/replace-overlay";
import { Spinner } from "@/components/spinner";
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
import { NoRepoState } from "@/components/no-repo-state";
import { cn } from "@/lib/utils";
import {
  getLastRepoPath,
  useRepoStore,
} from "@/features/repository/repository.store";
import {
  applyCustomColors,
  applyDensity,
  applyMonoFont,
  applySansFont,
  applyTheme,
} from "@/lib/theme";
import { isTauri } from "@/lib/tauri";
import { useKeyboardShortcuts } from "./keyboard";
import { useNativeMenu } from "./menu-events";
import { buildCommands, buildFileCommands } from "./commands";

export function App() {
  const repository = useRepoStore((s) => s.repository);
  const errorMessage = useRepoStore((s) => s.errorMessage);
  const setError = useRepoStore((s) => s.setError);
  const openRepositoryFromPath = useRepoStore(
    (s) => s.openRepositoryFromPath,
  );
  const openRepositoryPicker = useRepoStore((s) => s.openRepositoryPicker);
  const settings = useRepoStore((s) => s.settings);

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
    applySansFont(settings.uiFont, settings.customUiFont);
    applyMonoFont(settings.codeFont, settings.customCodeFont);
    applyCustomColors(settings.customColors);
  }, [
    settings.theme,
    settings.density,
    settings.uiFont,
    settings.codeFont,
    settings.customUiFont,
    settings.customCodeFont,
    settings.customColors,
  ]);

  // Show the welcome tour on first launch.
  const setOnboardingOpen = useRepoStore((s) => s.setOnboardingOpen);
  const fetchAiClis = useRepoStore((s) => s.fetchAiClis);
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
    // Only on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Decide synchronously whether we'll try to auto-open the last repo so
  // the very first render shows a splash (not the project picker that
  // would flash away once auto-open kicks in). `bootstrapping` flips to
  // false either after the open completes / fails, or immediately when
  // there's nothing to open.
  const [bootstrapping, setBootstrapping] = useState<boolean>(() => {
    if (!settings.autoOpenLast) return false;
    const last = getLastRepoPath();
    return Boolean(last && isTauri());
  });

  // Auto-load last repo on first run, if the preference is on.
  useEffect(() => {
    if (!settings.autoOpenLast) {
      setBootstrapping(false);
      return;
    }
    const last = getLastRepoPath();
    if (last && isTauri()) {
      openRepositoryFromPath(last)
        .catch(() => {
          /* error already in store */
        })
        .finally(() => setBootstrapping(false));
    } else {
      setBootstrapping(false);
    }
    // Only on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Recovery path for the case where `repository` drops to null AFTER
  // mount — primarily happens during dev when Vite HMR resets the
  // Zustand store mid-session (e.g. user is dogfooding the app on its
  // own repo, switches branches, source files change, HMR fires, store
  // is reborn empty). Without this, the user would land on the
  // NoRepoState picker and have to manually reopen.
  //
  // Guarded by a ref so a failing `openRepositoryFromPath` doesn't
  // ping-pong us forever — we try ONCE per "lost the repo" event, and
  // the flag is reset when the repository comes back.
  const recoveryAttempted = useRef(false);
  useEffect(() => {
    if (repository) {
      recoveryAttempted.current = false;
      return;
    }
    if (bootstrapping) return;
    if (recoveryAttempted.current) return;
    if (!settings.autoOpenLast || !isTauri()) return;
    const last = getLastRepoPath();
    if (!last) return;
    recoveryAttempted.current = true;
    setBootstrapping(true);
    openRepositoryFromPath(last)
      .catch(() => {
        /* keep the user on NoRepoState — error is in the store */
      })
      .finally(() => setBootstrapping(false));
  }, [
    repository,
    bootstrapping,
    settings.autoOpenLast,
    openRepositoryFromPath,
  ]);

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

  const paletteCommands =
    paletteMode === "files" ? fileCommands : actionCommands;

  return (
    <div
      // Outermost shell. 6px padding around the bubbles + 4px gap between
      // topbar and workspace — the inter-bubble gap matches the
      // sidebar↔main and main↔terminal gaps below so every seam in the
      // app reads as the same width.
      className="h-screen relative flex flex-col gap-1 p-1.5 bg-bg-0 overflow-hidden"
    >
      <TopBar />

      {repository ? (
        <div
          // Three-column workspace grid (left sidebar · main · optional
          // right). Width comes from the inline `gridTemplateColumns`
          // style so the sidebar can collapse to zero when hidden.
          // `relative` anchors the sidebar resize handle, which lives in
          // the inter-column gap rather than inside the sidebar bubble
          // (so the user can grab the visible space between the islands).
          className="flex-1 grid min-h-0 overflow-hidden gap-1 relative"
          style={{
            gridTemplateColumns: [
              settings.leftSidebarVisible
                ? `${settings.leftSidebarWidth}px`
                : null,
              "1fr",
            ]
              .filter(Boolean)
              .join(" "),
          }}
        >
          {settings.leftSidebarVisible ? <Sidebar /> : null}
          {/* Right column of the workspace grid: main-col on top, terminal
              drawer beneath it. Keeping them in the same flex-column means
              the terminal opening only shortens the diff pane — the
              sidebar (left column) keeps its full workspace height.
              `relative` anchors the terminal resize handle, which sits in
              the inter-row gap between main and terminal. */}
          <div className="flex flex-col min-w-0 min-h-0 gap-1 relative">
            <div
              // The "main column" floating card — same visual treatment
              // as the sidebars / terminal drawer so the three workspace
              // panes read as one consistent set of bubbles.
              className={cn(
                "flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden",
                "bg-[color-mix(in_oklab,var(--bg-0)_92%,transparent)]",
                "border border-bd-2 rounded-[10px]",
                "shadow-[0_12px_32px_rgba(0,0,0,0.4),0_2px_8px_rgba(0,0,0,0.25)]",
                "backdrop-blur-card backdrop-saturate-[140%]",
              )}
            >
              <TabStrip />
              <DiffPane />
            </div>
            <TerminalDrawer />
            <TerminalResizeHandle />
          </div>
          <SidebarResizeHandle />
          {/* Right sidebar removed — per-file actions live inline on each
              FileRow in the left sidebar, Git/AI lives in the topbar, and
              AI output opens as a centered modal (`AiOutputDialog`). */}
        </div>
      ) : bootstrapping ? (
        <div
          className="flex-1 grid place-items-center gap-3.5 grid-flow-row bg-bg-0"
          role="status"
          aria-live="polite"
        >
          <Spinner className="w-[22px] h-[22px]" />
          <span className="text-[12px] text-fg-2">Opening project…</span>
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0 }}>
          <NoRepoState onOpen={openRepositoryPicker} />
        </div>
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
          <span>{errorMessage}</span>
          <button
            className={cn(
              "ml-auto px-1.5 py-0.5 rounded-[3px] bg-transparent border-0 cursor-pointer",
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
