import { useEffect, useMemo, useState } from "react";
import { TopBar } from "@/components/TopBar";
import { Sidebar } from "@/components/Sidebar";
import { DiffPane } from "@/components/DiffPane";
import { TabStrip } from "@/components/TabStrip";
import { AiOutputDialog } from "@/components/AiOutputDialog";
import { PrBranchChoiceDialog } from "@/components/PrBranchChoiceDialog";
import { PrFlowDialog } from "@/components/PrFlowDialog";
import { ReplaceOverlay } from "@/components/ReplaceOverlay";
import { CommandPalette } from "@/components/CommandPalette";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { SettingsDialog } from "@/components/SettingsDialog";
import { ShortcutsDialog } from "@/components/ShortcutsDialog";
import { StashPromptDialog } from "@/components/StashPromptDialog";
import { OnboardingModal } from "@/components/OnboardingModal";
import { Toast } from "@/components/Toast";
import { NoRepoState } from "@/components/NoRepoState";
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
import { useNativeMenu } from "./menuEvents";
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
    document.documentElement.setAttribute(
      "data-editor-cursor",
      settings.editorCursor,
    );
  }, [
    settings.theme,
    settings.density,
    settings.uiFont,
    settings.codeFont,
    settings.customUiFont,
    settings.customCodeFont,
    settings.customColors,
    settings.editorCursor,
  ]);

  // Show the welcome tour on first launch.
  const setOnboardingOpen = useRepoStore((s) => s.setOnboardingOpen);
  useEffect(() => {
    if (!settings.firstRunCompleted) {
      setOnboardingOpen(true);
    }
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
    <div className="app-root">
      <TopBar />

      {repository ? (
        <div
          className="workspace"
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
          <div className="main-col">
            <TabStrip />
            <DiffPane />
          </div>
          {/* Right sidebar removed — per-file actions live inline on each
              FileRow in the left sidebar, Git/AI lives in the topbar, and
              AI output opens as a centered modal (`AiOutputDialog`). */}
        </div>
      ) : bootstrapping ? (
        <div className="boot-splash" role="status" aria-live="polite">
          <span className="ai-spinner" />
          <span className="boot-splash-label dim">Opening project…</span>
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0 }}>
          <NoRepoState onOpen={openRepositoryPicker} />
        </div>
      )}

      {errorMessage ? (
        <div className="error-banner">
          <span className="mono" style={{ fontWeight: 600 }}>
            Error
          </span>
          <span>{errorMessage}</span>
          <button
            className="error-banner-dismiss"
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
