import { useEffect, useRef } from "react";
import { useRepoStore } from "@/features/repository/repository.store";
import { useBoardStore } from "@/features/board/board.store";

export function useKeyboardShortcuts() {
  const repository = useRepoStore((s) => s.repository);
  const selectedFilePath = useRepoStore((s) => s.selectedFilePath);
  const files = useRepoStore((s) => s.files);

  const refresh = useRepoStore((s) => s.refresh);
  const setSidebarTab = useRepoStore((s) => s.setSidebarTab);
  const pingSearchFocus = useRepoStore((s) => s.pingSearchFocus);
  const setReplaceOpen = useRepoStore((s) => s.setReplaceOpen);
  const setPaletteMode = useRepoStore((s) => s.setPaletteMode);
  const setInFileSearchOpen = useRepoStore((s) => s.setInFileSearchOpen);
  const pingInFileSearch = useRepoStore((s) => s.pingInFileSearch);
  const setAiKind = useRepoStore((s) => s.setAiKind);
  const setSettingsOpen = useRepoStore((s) => s.setSettingsOpen);
  const setRepoMenuOpen = useRepoStore((s) => s.setRepoMenuOpen);
  const selectAdjacentFile = useRepoStore((s) => s.selectAdjacentFile);
  const selectAdjacentTab = useRepoStore((s) => s.selectAdjacentTab);
  const closeTab = useRepoStore((s) => s.closeTab);
  const closeAllTabs = useRepoStore((s) => s.closeAllTabs);
  const toggleStage = useRepoStore((s) => s.toggleStage);
  const toggleReviewed = useRepoStore((s) => s.toggleReviewed);
  const requestDiscard = useRepoStore((s) => s.requestDiscard);
  const setDiffMode = useRepoStore((s) => s.setDiffMode);
  const saveEdit = useRepoStore((s) => s.saveEdit);
  const toggleLeftSidebar = useRepoStore((s) => s.toggleLeftSidebar);
  const toggleRightSidebar = useRepoStore((s) => s.toggleRightSidebar);
  const setLeftSidebarVisible = useRepoStore((s) => s.setLeftSidebarVisible);
  const toggleTerminal = useRepoStore((s) => s.toggleTerminal);
  const zoomIn = useRepoStore((s) => s.zoomIn);
  const zoomOut = useRepoStore((s) => s.zoomOut);
  const resetZoom = useRepoStore((s) => s.resetZoom);

  // Chord prefix state — survives across keydowns within a 1.5s window.
  const chordPrefixRef = useRef(false);
  const chordTimerRef = useRef<number | null>(null);

  useEffect(() => {
    function isEditable(el: EventTarget | null): boolean {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
    }

    /**
     * Show the left sidebar tab. Pops it open if it's currently collapsed —
     * otherwise the tab change would be invisible.
     */
    function focusSidebar(tab: "changes" | "files" | "search") {
      setLeftSidebarVisible(true);
      setSidebarTab(tab);
    }

    async function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      const inField = isEditable(e.target);
      // Letter keys: use `e.code` rather than `e.key`. On macOS holding ⌥
      // substitutes the displayed character (⌥B → "∫"), but `code` stays the
      // physical key ("KeyB"). Modifiers like Shift / Cmd still work fine.
      const code = e.code;

      // ⌘O → Add project (folder picker). Repurposed from the legacy
      // "Open Repository…" shortcut: in agent-first mode this drops the
      // selected folder onto the board as a new project rather than
      // opening it for diff viewing.
      if (mod && !e.shiftKey && !e.altKey && code === "KeyO") {
        if (inField) return;
        const reviewing = useRepoStore.getState().reviewedCardId !== null;
        if (reviewing) return;
        e.preventDefault();
        void useBoardStore.getState().addProjectFromPicker();
        return;
      }
      // ⌘P → file picker
      if (mod && !e.shiftKey && !e.altKey && code === "KeyP") {
        e.preventDefault();
        if (repository) setPaletteMode("files");
        return;
      }
      // ⌘⇧P → command palette
      if (mod && !e.altKey && code === "KeyP" && e.shiftKey) {
        e.preventDefault();
        setPaletteMode("commands");
        return;
      }
      // ⌘N → open the "New card" dialog in board mode. Skip when the user
      // is typing into a field (they probably want a literal "n") and skip
      // in Review mode (we have no card to add there).
      if (mod && !e.shiftKey && !e.altKey && code === "KeyN") {
        const reviewing = useRepoStore.getState().reviewedCardId !== null;
        if (inField || reviewing) return;
        const hasProjects = useBoardStore.getState().projects.length > 0;
        if (!hasProjects) return;
        e.preventDefault();
        useBoardStore.getState().setNewCardOpen(true);
        return;
      }
      // ⌘K → in board mode, alias for ⌘⇧P (open command palette). In
      // Review mode it stays as the chord prefix (e.g. ⌘K W → close all
      // tabs) since the diff workflow relies on those chords.
      if (mod && !e.shiftKey && !e.altKey && code === "KeyK") {
        if (inField) return;
        const reviewing = useRepoStore.getState().reviewedCardId !== null;
        if (!reviewing) {
          e.preventDefault();
          setPaletteMode("commands");
          return;
        }
        e.preventDefault();
        chordPrefixRef.current = true;
        if (chordTimerRef.current != null) {
          window.clearTimeout(chordTimerRef.current);
        }
        chordTimerRef.current = window.setTimeout(() => {
          chordPrefixRef.current = false;
          chordTimerRef.current = null;
        }, 1500);
        return;
      }
      // While the ⌘K chord is armed, the next keystroke resolves it.
      if (chordPrefixRef.current) {
        if (chordTimerRef.current != null) {
          window.clearTimeout(chordTimerRef.current);
          chordTimerRef.current = null;
        }
        chordPrefixRef.current = false;
        // ⌘K ⌘W or ⌘K W → close all tabs. Bail when typing in a field so
        // the chord can't hijack a literal "W" keystroke.
        if (!inField && code === "KeyW") {
          e.preventDefault();
          closeAllTabs();
          return;
        }
        // Unknown chord — fall through so the key keeps its normal binding.
      }
      // ⌘, → Preferences
      if (mod && !e.shiftKey && !e.altKey && (e.key === "," || code === "Comma")) {
        e.preventDefault();
        setSettingsOpen(true);
        return;
      }
      // ⌘+ / ⌘- / ⌘0 → global UI zoom. Catch both the shifted plus on
      // the main keyboard (`=` with Shift) and numpad plus.
      if (mod && !e.altKey && (code === "Equal" || code === "NumpadAdd")) {
        e.preventDefault();
        zoomIn();
        return;
      }
      if (mod && !e.shiftKey && !e.altKey && (code === "Minus" || code === "NumpadSubtract")) {
        e.preventDefault();
        zoomOut();
        return;
      }
      if (mod && !e.shiftKey && !e.altKey && (code === "Digit0" || code === "Numpad0")) {
        e.preventDefault();
        resetZoom();
        return;
      }
      // ⌘B → toggle left sidebar
      if (mod && !e.shiftKey && !e.altKey && code === "KeyB") {
        e.preventDefault();
        toggleLeftSidebar();
        return;
      }
      // ⌘⌥B → toggle right sidebar
      if (mod && !e.shiftKey && e.altKey && code === "KeyB") {
        e.preventDefault();
        toggleRightSidebar();
        return;
      }
      // ⌘` and ⌘J → toggle integrated terminal. `e.key === "`"` is the
      // backtick the user actually pressed; `code === "KeyJ"` covers the
      // ⌘J alternative (Cmd+J would print "∆" with some keyboard layouts,
      // so we match on the physical code).
      if (
        mod &&
        !e.shiftKey &&
        !e.altKey &&
        (e.key === "`" || code === "KeyJ")
      ) {
        e.preventDefault();
        toggleTerminal();
        return;
      }
      if (!repository) return;

      // ⌘⇧F → Search tab (and focus its input)
      if (mod && e.shiftKey && !e.altKey && code === "KeyF") {
        e.preventDefault();
        focusSidebar("search");
        pingSearchFocus();
        return;
      }
      // ⌘F → in-file search
      if (mod && !e.shiftKey && !e.altKey && code === "KeyF") {
        e.preventDefault();
        setInFileSearchOpen(true);
        pingInFileSearch();
        return;
      }
      // ⌘⇧H → Replace
      if (mod && e.shiftKey && !e.altKey && code === "KeyH") {
        e.preventDefault();
        setReplaceOpen(true);
        return;
      }
      // ⌘⇧E → Files tab
      if (mod && e.shiftKey && !e.altKey && code === "KeyE") {
        e.preventDefault();
        focusSidebar("files");
        return;
      }
      // ⌘⌥G → Changes tab
      if (mod && !e.shiftKey && e.altKey && code === "KeyG") {
        e.preventDefault();
        focusSidebar("changes");
        return;
      }
      // ⌘R → refresh
      if (mod && !e.shiftKey && !e.altKey && code === "KeyR" && !inField) {
        e.preventDefault();
        await refresh();
        return;
      }
      // ⌘E → edit file
      if (mod && !e.shiftKey && !e.altKey && code === "KeyE" && !inField) {
        e.preventDefault();
        if (selectedFilePath) setDiffMode("edit");
        return;
      }
      // ⌘S → save edit
      if (mod && !e.shiftKey && !e.altKey && code === "KeyS") {
        e.preventDefault();
        await saveEdit();
        return;
      }
      // ⌘↵ → stage / unstage
      if (mod && e.key === "Enter" && selectedFilePath) {
        e.preventDefault();
        await toggleStage(selectedFilePath);
        return;
      }
      // ⌘⇧M → toggle "Mark reviewed" on the current file
      if (mod && e.shiftKey && !e.altKey && code === "KeyM" && selectedFilePath) {
        e.preventDefault();
        toggleReviewed(selectedFilePath);
        return;
      }
      // ⌘⌫ → discard
      if (
        mod &&
        (e.key === "Backspace" || e.key === "Delete") &&
        selectedFilePath &&
        !inField
      ) {
        e.preventDefault();
        requestDiscard(selectedFilePath);
        return;
      }
      // ⌥↓ / ⌥↑ → next / previous changed file. Holding the arrow fires
      // key-repeat at the OS rate (~30Hz on macOS); navigation must keep
      // up — we want users to be able to fly through a changeset.
      if (e.altKey && !mod && e.key === "ArrowDown") {
        e.preventDefault();
        selectAdjacentFile(1);
        return;
      }
      if (e.altKey && !mod && e.key === "ArrowUp") {
        e.preventDefault();
        selectAdjacentFile(-1);
        return;
      }
      // ⌘⌥← / ⌘⌥→ → previous / next open tab
      if (mod && e.altKey && e.key === "ArrowRight") {
        e.preventDefault();
        selectAdjacentTab(1);
        return;
      }
      if (mod && e.altKey && e.key === "ArrowLeft") {
        e.preventDefault();
        selectAdjacentTab(-1);
        return;
      }
      // ⌘W → close current tab (only when we have one to close)
      if (mod && !e.shiftKey && !e.altKey && code === "KeyW") {
        const state = useRepoStore.getState();
        if (
          state.selectedFilePath != null &&
          state.openTabs.some(
            (t) =>
              t.path === state.selectedFilePath &&
              t.staged === state.selectedFileStaged,
          )
        ) {
          e.preventDefault();
          closeTab({
            path: state.selectedFilePath,
            staged: state.selectedFileStaged,
          });
          return;
        }
      }
      if (e.key === "Escape" && !inField) {
        setAiKind(null);
        setInFileSearchOpen(false);
        setRepoMenuOpen(false);
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    repository,
    selectedFilePath,
    files,
    refresh,
    setSidebarTab,
    pingSearchFocus,
    setReplaceOpen,
    setPaletteMode,
    setInFileSearchOpen,
    pingInFileSearch,
    setAiKind,
    setSettingsOpen,
    setRepoMenuOpen,
    selectAdjacentFile,
    selectAdjacentTab,
    closeTab,
    closeAllTabs,
    toggleStage,
    toggleReviewed,
    requestDiscard,
    setDiffMode,
    saveEdit,
    toggleLeftSidebar,
    toggleRightSidebar,
    setLeftSidebarVisible,
    toggleTerminal,
    zoomIn,
    zoomOut,
    resetZoom,
  ]);
}
