import { create } from "zustand";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import type { Repository } from "./repository.types";
import type {
  BranchInfo,
  ChangedFile,
  ExternalEditor,
  StashEntry,
} from "@/features/git/git.types";
import * as gitApi from "@/features/git/git.api";
import type { PrSummary } from "@/features/git/git.api";
import * as repoApi from "./repository.api";
import * as searchApi from "@/features/search/search.api";
import * as aiApi from "@/features/ai/ai.api";
import type { AiCliInfo, AiResult } from "@/features/ai/ai.types";
import type {
  SearchResult,
  SearchScope,
} from "@/features/search/search.types";
import type { AiKind } from "@/features/ai/ai.types";
import type { ToastKind, ToastMessage } from "@/components/toast";
import {
  pushRecentRepo,
  readLastRepoPath,
  readRecentRepos,
  readSettings,
  removeRecentRepo,
  writeLastRepoPath,
  writeSettings,
  type Density,
  type DiffExpansion,
  type RecentRepo,
  type SearchView,
  type Settings,
} from "@/lib/paths";
import {
  applyCustomColors,
  applyDensity,
  applyMonoFont,
  applySansFont,
  applyTheme,
  applyUiZoom,
  normalizeUiZoom,
  UI_ZOOM_STEP,
  type FontPreset,
  type MonoPreset,
  type Theme,
} from "@/lib/theme";
import { isTauri } from "@/lib/tauri";

export type StatusFilter =
  | "all"
  | ChangedFile["status"];

export type SidebarTab = "changes" | "files" | "search";

export type DiffMode = "sbs" | "inline" | "edit";

export type UpdaterStatus =
  | "idle"
  | "checking"
  | "unavailable"
  | "available"
  | "downloading"
  | "ready"
  | "error";

export type UpdateInfo = {
  version: string;
  currentVersion: string;
  body?: string;
};

let pendingUpdate: Update | null = null;

/**
 * One open tab in the diff pane. `staged` mirrors `selectedFileStaged` —
 * each unique (path, staged) is a separate tab so the user can keep e.g.
 * the unstaged and staged views of the same file open side-by-side.
 */
export type FileTab = {
  path: string;
  staged: boolean | null;
};

export function tabKey(t: FileTab): string {
  return `${t.path}#${t.staged === null ? "f" : t.staged ? "s" : "u"}`;
}

export type ConfirmRequest = {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
};

export function filteredFiles(
  files: ChangedFile[],
  filterText: string,
  statusFilter: StatusFilter,
  onlyUnreviewed: boolean,
): ChangedFile[] {
  const q = filterText.trim().toLowerCase();
  return files.filter((f) => {
    if (q && !f.path.toLowerCase().includes(q)) return false;
    if (statusFilter !== "all" && f.status !== statusFilter) return false;
    if (onlyUnreviewed && f.reviewed) return false;
    return true;
  });
}

type State = {
  repository: Repository | null;
  files: ChangedFile[];
  selectedFilePath: string | null;
  /**
   * Distinguishes which version of the selected file the user is viewing.
   * The same path can appear in both `Staged` and `Unstaged` sections —
   * keeping just the path on the selection would make either click resolve
   * to the same `find()` result. `null` is used when the selected file isn't
   * a changed file (opened from the tree / palette).
   */
  selectedFileStaged: boolean | null;
  /**
   * Files the user has opened, in order. The active tab is whichever entry
   * matches (selectedFilePath, selectedFileStaged). Tabs persist across
   * navigation so the user can hop between files without losing context.
   */
  openTabs: FileTab[];
  reviewedPaths: Set<string>;
  /**
   * Paths the user picked with ⌘/Ctrl-click or ⇧-click in the Changes
   * sidebar. Drives the batch action bar (stage / unstage / mark reviewed /
   * discard several at once). Multi-select is in addition to the primary
   * `selectedFilePath` selection, which is what drives the diff pane.
   */
  multiSelection: Set<string>;
  /**
   * The "anchor" file for shift-click range selection — usually the file
   * the user single-clicked most recently. `null` after a clear or repo
   * close.
   */
  multiSelectAnchor: { path: string; staged: boolean | null } | null;

  filterText: string;
  statusFilter: StatusFilter;
  onlyUnreviewed: boolean;
  sidebarTab: SidebarTab;

  diffMode: DiffMode;
  edits: Record<string, string>;
  savedEdits: Record<string, string>;
  /**
   * Paths whose `edits[path]` differs from `savedEdits[path]`. Kept as a
   * referentially-stable Set so cheap subscribers (TabStrip, RightPanel)
   * can ask "is this file dirty?" without re-rendering on every keystroke.
   */
  dirtyPaths: Set<string>;

  // Repo-wide search (left sidebar "Search" tab). Persisted in-memory so the
  // user can switch sidebar tabs without losing their query.
  searchQuery: string;
  searchScope: SearchScope;
  searchCaseSensitive: boolean;
  searchRegex: boolean;
  /** Comma-separated VS Code-style globs restricting which files are searched. */
  searchInclude: string;
  /** Comma-separated VS Code-style globs excluding files from the search. */
  searchExclude: string;
  /** Whether the include/exclude inputs are revealed in the search panel. */
  searchFiltersOpen: boolean;
  searchResults: SearchResult[];
  searchLoading: boolean;
  /** Bumped on ⌘⇧F to refocus the existing input. */
  searchFocusNonce: number;

  replaceOpen: boolean;
  paletteMode: "files" | "commands" | null;
  inFileSearchOpen: boolean;
  inFileSearchNonce: number;
  aiKind: AiKind | null;
  aiCliList: AiCliInfo[];
  aiCliLoading: boolean;
  aiOutput: AiResult | null;
  aiLoading: boolean;
  aiError: string | null;
  /**
   * Inline commit composer in the left-sidebar Changes tab. The textarea
   * binds to `commitDraft`; the magic-wand button populates it via AI; the
   * Commit button calls `commitDraftRun()`. `commitDraftLoading` covers
   * both phases (AI generation + git commit) so the UI can disable controls
   * during either.
   */
  commitDraft: string;
  commitDraftLoading: boolean;
  /**
   * Which standalone Git op is in flight, if any. Used by the commit
   * composer's chevron button to render a spinner + by the dropdown menu
   * to mark which row is currently running. `null` when idle.
   */
  gitOpLoading: "push" | "pull" | "fetch" | "sync" | "undo" | null;
  /**
   * State of the multi-step "Create PR" pipeline. `idle` until the user
   * fires it; cycles through the named steps with the current human-readable
   * label streamed into `prFlowMessage`; lands on `done` (with `prFlowUrl`
   * populated) or `error`.
   */
  prFlow: {
    state: "idle" | "running" | "done" | "error";
    message: string;
    url: string | null;
    error: string | null;
  };
  /** Open the "Branch choice" dialog before running `createPr`. */
  prBranchChoiceOpen: boolean;
  /**
   * Live state for the Create PR dialog. Separated from `prFlow` because
   * it lives BEFORE the pipeline kicks off — driving the dialog body's
   * "Into" picker, the behind/ahead readout, and the rebase/merge
   * affordance. Reset to defaults every time the dialog opens.
   */
  prDialog: {
    /** Remote branches available as PR base (sorted, default branch first). */
    bases: string[];
    /** Currently selected base. Null while we boot the dialog state. */
    base: string | null;
    /** `git rev-list --count base...head` — populated by loadPrDialogStatus. */
    behind: number;
    ahead: number;
    /** True while behindAhead / remoteBranches RPCs are in flight. */
    statusLoading: boolean;
    /** User clicked "Skip" on the behind-warning; unblocks Create PR. */
    ignoreBehind: boolean;
    /** Last sync error surfaced inline (rebase/merge conflict, etc). */
    statusError: string | null;
  };
  repoFiles: string[];
  repoFilesLoading: boolean;
  branches: BranchInfo[];
  branchesLoading: boolean;
  branchMenuOpen: boolean;
  /**
   * Open PRs in this repo keyed by HEAD branch name. Populated lazily
   * when the branch picker opens — the branch menu joins this against
   * `branches` to render a small "PR #42 ✓ approved" badge on each row.
   * Empty when gh isn't available or there's no remote.
   */
  branchPrs: Record<string, PrSummary>;
  branchPrsLoading: boolean;
  stashes: StashEntry[];
  stashesLoading: boolean;
  /**
   * When set, `checkoutBranch` failed because the working tree is dirty and
   * we're asking the user to stash before switching. `target` is the branch
   * the user originally tried to reach.
   */
  pendingStashCheckout: { target: string; suggestedMessage: string } | null;
  editors: ExternalEditor[];
  editorMenuOpen: boolean;
  /** Global Git/AI dropdown in the topbar (commit / PR / summary / risk). */
  gitMenuOpen: boolean;

  /**
   * Integrated terminal drawer at the bottom of the workspace. Toggled with
   * `Ctrl+\`` and a remembered height between sessions. v1 ships a single
   * PTY per window — the actual session id is owned by `TerminalDrawer.tsx`,
   * the store only tracks UI visibility/size so that closing the drawer
   * preserves drawer height across re-opens.
   */
  /**
   * Whether the terminal drawer is currently VISIBLE. Decoupled from
   * `terminalSessionAlive` so the user can hide the drawer (X button)
   * without losing the running shell — opening it again resumes the same
   * scrollback / running process.
   */
  terminalOpen: boolean;
  /**
   * Whether the PTY session backing the terminal is alive. Becomes true the
   * first time the drawer is opened (or a command is queued from
   * onboarding); cleared only when the user explicitly kills it via the
   * trash button in the drawer header, when the repo changes, or when the
   * shell itself exits. Hiding the drawer does NOT set this to false.
   */
  terminalSessionAlive: boolean;
  terminalHeight: number;
  /**
   * Command queued for the integrated terminal — picked up by `TerminalDrawer`
   * once its PTY session is ready, written verbatim (with a trailing `\n`),
   * then cleared. Used by the onboarding modal's ▶ install buttons so a
   * single click both opens the drawer and types the command for the user.
   */
  pendingTerminalCommand: string | null;

  loading: boolean;
  errorMessage: string | null;
  confirm: ConfirmRequest | null;
  toasts: ToastMessage[];
  updaterStatus: UpdaterStatus;
  updateInfo: UpdateInfo | null;
  updateProgress: number | null;
  updateError: string | null;

  recentRepos: RecentRepo[];
  settings: Settings;
  settingsOpen: boolean;
  shortcutsOpen: boolean;
  onboardingOpen: boolean;
  repoMenuOpen: boolean;

  // actions
  setTheme: (theme: Theme) => void;
  setDensity: (density: Density) => void;
  setAutoOpenLast: (value: boolean) => void;
  setDiffExpansion: (value: DiffExpansion) => void;
  setSearchView: (value: SearchView) => void;
  setUiZoom: (value: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
  setUiFont: (value: FontPreset, custom?: string) => void;
  setCodeFont: (value: MonoPreset, custom?: string) => void;
  setCustomColor: (key: string, value: string | null) => void;
  resetCustomColors: () => void;
  /** Update the system/instruction prompt for a given AI action. */
  setAiSystemPrompt: (
    kind: "commit" | "pr" | "summary" | "risk" | "branch",
    value: string,
  ) => void;
  /**
   * Generate a branch name suggestion from staged/working changes. Returns
   * the trimmed string from the CLI, or null on error. Used inline by the
   * branch-create input — does NOT pollute the AI panel state.
   */
  generateBranchName: () => Promise<string | null>;
  setLeftSidebarVisible: (v: boolean) => void;
  setRightSidebarVisible: (v: boolean) => void;
  setLeftSidebarWidth: (px: number) => void;
  setRightSidebarWidth: (px: number) => void;
  toggleLeftSidebar: () => void;
  toggleRightSidebar: () => void;
  /**
   * Show/hide the integrated terminal drawer. Hiding does NOT kill the PTY
   * — re-opening resumes the same session. To actually destroy the
   * session call `killTerminalSession`.
   */
  setTerminalOpen: (open: boolean) => void;
  /** Flip the terminal drawer's visibility (used by `⌘\`` / `⌘J`). */
  toggleTerminal: () => void;
  /**
   * Kill the PTY session, dispose xterm, and hide the drawer. Wired to the
   * trash icon in the drawer header — the X next to it only HIDES.
   */
  killTerminalSession: () => void;
  /** Persist the drawer's height after a user resize. */
  setTerminalHeight: (px: number) => void;
  /**
   * Open the integrated terminal (if not already open) and queue `cmd` to be
   * typed + run as soon as the PTY is ready. The TerminalDrawer reads
   * `pendingTerminalCommand` from the store and calls
   * `clearPendingTerminalCommand` once it has injected it.
   */
  runInTerminal: (cmd: string) => void;
  clearPendingTerminalCommand: () => void;
  setSettingsOpen: (open: boolean) => void;
  setShortcutsOpen: (open: boolean) => void;
  setOnboardingOpen: (open: boolean) => void;
  setRepoMenuOpen: (open: boolean) => void;
  forgetRecent: (path: string) => void;
  checkForUpdate: (silent?: boolean) => Promise<void>;
  installUpdate: () => Promise<void>;
  openRepositoryFromPath: (path: string) => Promise<void>;
  openRepositoryPicker: () => Promise<void>;
  closeRepository: () => void;
  refresh: () => Promise<void>;

  /**
   * Select a file. When `staged` is omitted, the store picks a sensible default:
   *   - if both the staged and unstaged versions exist, the unstaged one wins
   *     (matches `git diff` default behavior)
   *   - otherwise whichever exists, or `null` for non-changed files
   */
  /**
   * Select a file for the main pane.
   * - `staged === undefined` → auto-detect (used by the Changes sidebar when
   *   the path appears only once).
   * - `staged === boolean` → pick that exact variant from the changed list.
   * - `staged === null` → force file-view (Files tab, Search jump, ⌘P): the
   *   editor shows the working-tree contents even when the file is modified.
   */
  selectFile: (path: string | null, staged?: boolean | null) => void;
  selectAdjacentFile: (direction: 1 | -1) => void;
  /** Close an open tab. If it was the active tab, switch to a neighbor. */
  closeTab: (tab: FileTab) => void;
  /** Close every open tab. */
  closeAllTabs: () => void;
  /** Cycle to the previous/next open tab. */
  selectAdjacentTab: (direction: 1 | -1) => void;

  setFilterText: (value: string) => void;
  setStatusFilter: (value: StatusFilter) => void;
  setOnlyUnreviewed: (value: boolean) => void;
  setSidebarTab: (value: SidebarTab) => void;

  setDiffMode: (mode: DiffMode) => void;
  setEdit: (path: string, value: string) => void;
  loadEditBuffer: (path: string, content: string) => void;
  saveEdit: () => Promise<void>;
  cancelEdit: () => void;

  setSearchQuery: (q: string) => void;
  setSearchScope: (s: SearchScope) => void;
  setSearchCaseSensitive: (v: boolean) => void;
  setSearchRegex: (v: boolean) => void;
  setSearchInclude: (v: string) => void;
  setSearchExclude: (v: string) => void;
  setSearchFiltersOpen: (v: boolean) => void;
  runRepoSearch: () => Promise<void>;
  pingSearchFocus: () => void;

  setReplaceOpen: (open: boolean) => void;
  setPaletteMode: (mode: "files" | "commands" | null) => void;
  fetchRepoFiles: () => Promise<void>;
  fetchBranches: () => Promise<void>;
  setBranchMenuOpen: (open: boolean) => void;
  /**
   * Pull the open-PR snapshot from `gh pr list` so the branch picker can
   * render review/CI badges per row. Silent on failure (no toast — the
   * branch picker is still useful without PR info; gh might just not be
   * authenticated or the repo might lack a GitHub remote).
   */
  fetchBranchPrs: () => Promise<void>;
  checkoutBranch: (name: string) => Promise<void>;
  /** `git branch -d <name>` (or `-D` if force). Refuses to delete the
   *  current branch — UI guards against picking it. */
  deleteBranch: (name: string, opts?: { force?: boolean }) => Promise<void>;
  /** Confirm-then-delete all local branches whose upstream has been
   *  removed on the remote (gone). Bulk equivalent of the per-row
   *  delete; uses `-D` because gone branches may have unpushed commits. */
  requestPruneGoneBranches: () => void;
  /** Create a new branch (optionally based on `base`) and switch to it. */
  createBranch: (name: string, base?: string) => Promise<void>;
  /** Refresh the stash list (also called after push/pop/apply/drop). */
  fetchStashes: () => Promise<void>;
  /** Cancel the pending "stash before switching" prompt. */
  cancelPendingStashCheckout: () => void;
  /**
   * Stash the working tree with the user-provided message, then retry the
   * checkout that originally failed. Used by the StashPromptDialog.
   */
  confirmStashAndCheckout: (
    message: string,
    includeUntracked: boolean,
  ) => Promise<void>;
  popStash: (stashRef: string) => Promise<void>;
  applyStash: (stashRef: string) => Promise<void>;
  dropStash: (stashRef: string) => Promise<void>;
  /** Open a confirm dialog before dropping a stash. UI entry point. */
  requestDropStash: (stashRef: string, label: string) => void;
  setInFileSearchOpen: (open: boolean) => void;
  pingInFileSearch: () => void;
  setAiKind: (kind: AiKind | null) => void;
  /** Lazily detect installed AI CLIs (claude / codex) — runs once. */
  fetchAiClis: () => Promise<void>;
  setPreferredAiCli: (id: string | null) => void;
  /** Build the prompt for `kind`, invoke the preferred CLI, store the result. */
  runAi: (kind: AiKind) => Promise<void>;
  /** Clear the current AI output and reset error state. */
  clearAiOutput: () => void;
  /** Update the inline commit composer textarea. */
  setCommitDraft: (value: string) => void;
  /** Populate `commitDraft` by running the AI on the current staged diff. */
  generateCommitDraft: () => Promise<void>;
  /** `git commit -m commitDraft`, then clear the textarea + refresh. */
  commitDraftRun: () => Promise<void>;
  /** Run `commitDraftRun` then `git push` in the same flow. */
  commitDraftAndPush: () => Promise<void>;
  /** `git push` (or `git push -u origin <branch>` on a brand-new branch). */
  gitPush: () => Promise<void>;
  /** `git pull --ff-only`. */
  gitPull: () => Promise<void>;
  /** `git fetch --all --prune`. */
  gitFetchRemote: () => Promise<void>;
  /**
   * Fetch/prune remotes, then fast-forward every local branch that can be
   * advanced safely without checking it out.
   */
  gitSyncBranches: () => Promise<void>;
  /** Background-friendly fetch fired on window focus. Silent on success,
   *  refreshes the branch list + working tree, and toasts (once) when the
   *  current branch's upstream becomes `gone` (PR merged + branch deleted
   *  on the remote). Throttled — repeated calls within `AUTO_SYNC_MS` are
   *  no-ops so alt-tabbing doesn't hammer the remote. */
  gitAutoSync: () => Promise<void>;
  /** `git reset --soft HEAD~1` — keeps the changes staged so the user can
   *  re-edit the message in the composer and commit again. */
  gitUndoLastCommit: () => Promise<void>;
  /** Open the "use current branch / create new branch" dialog. */
  openPrBranchChoice: () => void;
  /** Close the branch-choice dialog without starting anything. */
  closePrBranchChoice: () => void;
  /** Set the PR base picked by the user (the branch the PR will merge into). */
  setPrDialogBase: (base: string) => void;
  /**
   * Recompute behind/ahead between the head branch and the chosen base
   * (`prDialog.base`). Called when the dialog opens and after each
   * rebase/merge so the warning banner stays in sync.
   */
  refreshPrDialogStatus: () => Promise<void>;
  /** `git rebase origin/<base>` from inside the Create PR dialog. */
  prDialogRebase: () => Promise<void>;
  /** `git merge --no-edit origin/<base>` from inside the Create PR dialog. */
  prDialogMerge: () => Promise<void>;
  /** Dismiss the "behind" warning so the Create PR button unlocks. */
  prDialogSkipBehind: () => void;
  /** Reset the PR-flow modal back to idle (and clear url/error). */
  resetPrFlow: () => void;
  /**
   * Run the end-to-end "Create PR" pipeline:
   *   - optionally create + checkout a new branch from current
   *   - commit any uncommitted changes (AI-generated message if textarea empty)
   *   - push (with -u when needed)
   *   - generate PR title + body via AI
   *   - call `gh pr create` against the chosen `baseBranch`
   *   - stream human-readable progress into `prFlow.message`
   *
   * `newBranchName` is supplied by the dialog when the user picks "Create
   * new branch"; pass null to use the current branch as-is. `baseBranch`
   * is the user-chosen PR target (defaults to the dialog's resolved base).
   */
  createPr: (opts: {
    newBranchName: string | null;
    baseBranch: string;
  }) => Promise<void>;
  /** Flip the onboarding flag (used by the first-run modal). */
  setFirstRunCompleted: (v: boolean) => void;

  toggleReviewed: (path: string) => void;
  /**
   * Toggle the reviewed flag for several paths at once. If any of them are
   * currently unreviewed, marks all reviewed; if all are already reviewed,
   * unmarks all. Mirrors how a "Mark selected" batch button should feel.
   */
  toggleReviewedMany: (paths: string[]) => void;
  /** Replace `multiSelection` with `paths` and update the anchor. */
  setMultiSelection: (
    paths: Iterable<string>,
    anchor: { path: string; staged: boolean | null } | null,
  ) => void;
  /** Flip one path's membership in `multiSelection` (⌘/Ctrl-click). */
  toggleMultiSelection: (
    path: string,
    anchor: { path: string; staged: boolean | null } | null,
  ) => void;
  clearMultiSelection: () => void;
  toggleStage: (path: string) => Promise<void>;
  stageMany: (paths: string[]) => Promise<void>;
  unstageMany: (paths: string[]) => Promise<void>;
  applyHunkPatch: (patch: string, reverse: boolean, label: string) => Promise<void>;
  applyHunkPatchAndCommit: (
    patch: string,
    reverse: boolean,
    message: string,
    label: string,
  ) => Promise<void>;
  /** Generate a commit-message draft from one hunk patch only. */
  generateHunkCommitDraft: (
    patch: string,
    signal?: AbortSignal,
  ) => Promise<string>;
  /**
   * Discards a working-tree hunk (`git apply -R` on the working tree). Always
   * routes through a confirm modal — it's destructive.
   */
  requestRevertHunk: (
    patch: string,
    hunkIdx: number,
    filePath: string,
  ) => void;
  requestDiscard: (path: string) => void;
  requestDiscardMany: (paths: string[]) => void;
  openInVscode: (path: string) => Promise<void>;
  openProjectInVscode: () => Promise<void>;
  fetchEditors: () => Promise<void>;
  setEditorMenuOpen: (open: boolean) => void;
  setGitMenuOpen: (open: boolean) => void;
  setPreferredEditor: (id: string | null) => void;
  openProjectInEditor: (editorId: string) => Promise<void>;

  setConfirm: (req: ConfirmRequest | null) => void;
  pushToast: (text: string, kind?: ToastKind) => void;
  setError: (message: string | null) => void;
};

/** Persisted height of the integrated terminal drawer (px). */
const TERMINAL_HEIGHT_KEY = "squint:terminal-height";
function readTerminalHeight(): number {
  try {
    const raw = localStorage.getItem(TERMINAL_HEIGHT_KEY);
    if (!raw) return 260;
    const n = Number(raw);
    if (!Number.isFinite(n)) return 260;
    return Math.max(120, Math.min(800, Math.round(n)));
  } catch {
    return 260;
  }
}
function writeTerminalHeight(px: number): void {
  try {
    localStorage.setItem(TERMINAL_HEIGHT_KEY, String(px));
  } catch {
    /* ignore */
  }
}

function reviewedStorageKey(repoPath: string): string {
  return `squint:reviewed:${repoPath}`;
}

function loadReviewed(repoPath: string): Set<string> {
  try {
    const raw = localStorage.getItem(reviewedStorageKey(repoPath));
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function saveReviewed(repoPath: string, set: Set<string>): void {
  try {
    localStorage.setItem(
      reviewedStorageKey(repoPath),
      JSON.stringify([...set]),
    );
  } catch {
    /* ignore */
  }
}

let toastCounter = 0;
// Monotonic id for in-flight `runAi` calls — see `runAi` for the rationale.
let aiRequestCounter = 0;

/**
 * Drop the in-memory edit buffer and saved-snapshot for the given paths.
 * Used after destructive operations (discard, stash pop) so the next "Edit"
 * re-reads the file from disk instead of showing pre-revert content.
 */
function clearEditBuffers(
  set: (
    fn: (s: State) => Partial<State>,
  ) => void,
  paths: string[],
): void {
  if (paths.length === 0) return;
  const drop = new Set(paths);
  set((s) => {
    const nextEdits = { ...s.edits };
    const nextSaved = { ...s.savedEdits };
    let touchedDirty = false;
    const nextDirty = new Set(s.dirtyPaths);
    for (const p of drop) {
      delete nextEdits[p];
      delete nextSaved[p];
      if (nextDirty.delete(p)) touchedDirty = true;
    }
    return {
      edits: nextEdits,
      savedEdits: nextSaved,
      dirtyPaths: touchedDirty ? nextDirty : s.dirtyPaths,
    };
  });
}

/**
 * Resolve which AI CLI to use for a given run. Three responsibilities:
 *
 *   1. **Lazy-detect** the installed CLIs the first time anything needs the
 *      list — used to live only behind `setAiKind`, so the commit composer
 *      (which doesn't touch `setAiKind`) would fire on an empty list and
 *      report "No AI CLI detected" even with Codex installed.
 *   2. **Prefer the user's pick** when it's still available.
 *   3. **Fall back to the first installed CLI in backend priority order**
 *      when the saved preference points at something that isn't on disk
 *      (e.g. user uninstalled Codex, or switched machines) — and persist
 *      that fallback so future runs go straight through.
 *
 * Returns `null` only when no CLI is installed at all.
 */
async function resolveAvailableCli(
  get: () => State,
  set: (partial: Partial<State>) => void,
): Promise<AiCliInfo | null> {
  let list = get().aiCliList;
  if (list.length === 0) {
    try {
      list = await aiApi.detectAiClis();
      set({ aiCliList: list });
    } catch {
      // Fall through; the empty-list check below will surface the error.
    }
  }
  const preferred = get().settings.preferredAiCli;
  let cli = preferred
    ? list.find((c) => c.id === preferred && c.available) ?? null
    : null;
  if (!cli) {
    const fallback = list.find((c) => c.available) ?? null;
    if (fallback) {
      // Persist so the user doesn't see this fallback path again next run.
      get().setPreferredAiCli(fallback.id);
      cli = fallback;
    }
  }
  return cli;
}

/**
 * Both Claude Code and Codex sometimes wrap their response in a fenced
 * code block — typically ```markdown ... ``` for PR descriptions — even
 * when the prompt asks for plain text. When that happens the literal
 * fence line becomes the first non-empty line of the output, which the
 * PR-title parser then takes as the title (producing PRs literally named
 * ` ```markdown `).
 *
 * This strips a *full-output* outer fence (open on line 1, close on the
 * last non-empty line) and returns the inner content. If the output
 * isn't fence-wrapped, returns it unchanged. Inner code blocks in the
 * body are preserved — we only peel one layer.
 */
function stripOuterCodeFence(raw: string): string {
  const lines = raw.split(/\r?\n/);
  if (lines.length < 2) return raw;
  const opener = lines[0].trim();
  if (!/^```[a-zA-Z0-9_+-]*$/.test(opener)) return raw;
  let lastIdx = lines.length - 1;
  while (lastIdx > 0 && lines[lastIdx].trim() === "") lastIdx--;
  if (lastIdx <= 0 || lines[lastIdx].trim() !== "```") return raw;
  return lines.slice(1, lastIdx).join("\n");
}

/**
 * Wrap a git operation that requires a clean working tree (rebase, merge,
 * etc) so it can run even when the user has uncommitted changes. Pattern:
 *
 *   1. Inspect the working tree. If clean, just run the operation and
 *      return — no stash plumbing needed.
 *   2. Otherwise `git stash push -u` with an autogenerated message.
 *   3. Run the wrapped operation.
 *   4. `git stash pop` to re-apply. On conflict, the stash stays put and
 *      we throw an annotated error so the caller can surface "operation
 *      succeeded but your changes are in stash@{0}".
 *
 * The whole thing is reentrant-safe: nothing here mutates the store
 * directly — the caller controls UI loading/error state.
 */
async function runWithAutoStash<T>(
  get: () => State,
  repoPath: string,
  op: () => Promise<T>,
): Promise<T> {
  // Cheap check: any modified/staged/untracked entries in the working
  // tree? `getRepoStatus` already returns the parsed porcelain list.
  const files = await gitApi.getRepoStatus(repoPath);
  if (files.length === 0) {
    return op();
  }
  const ts = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
  const message = `squint auto-stash ${ts}`;
  await gitApi.stashPush(repoPath, message, true);
  try {
    const result = await op();
    // Re-apply on top of the now-updated branch. Pop fails on conflict
    // but leaves the stash intact, so we don't lose anything.
    try {
      await gitApi.stashPop(repoPath, "stash@{0}");
    } catch (popErr) {
      const msg = popErr instanceof Error ? popErr.message : String(popErr);
      get().pushToast(
        `Couldn't re-apply your changes — kept as '${message}' in stash. ${msg}`,
        "danger",
      );
    }
    return result;
  } catch (opErr) {
    // The operation itself failed (e.g. rebase conflict). Restore the
    // user's working tree to where it was before we touched anything —
    // otherwise they'd see "stash made, operation failed, working tree
    // mysteriously empty" which is the worst of both worlds.
    try {
      await gitApi.stashPop(repoPath, "stash@{0}");
    } catch {
      // If even the rollback pop fails (rare — would require state
      // changes between the stash and the failed op), leave the stash
      // alone. The user can pop manually.
      const msg = opErr instanceof Error ? opErr.message : String(opErr);
      get().pushToast(
        `${msg}. Your changes are kept as '${message}' in stash — pop manually after resolving.`,
        "danger",
      );
    }
    throw opErr;
  }
}

const MAX_AI_DIFF_BYTES = 120_000;

function truncateAiDiff(s: string): string {
  return s.length > MAX_AI_DIFF_BYTES
    ? s.slice(0, MAX_AI_DIFF_BYTES) +
        `\n\n[…truncated ${s.length - MAX_AI_DIFF_BYTES} bytes]`
    : s;
}

function prependUserPrompt(userPrompt: string, lines: string[]): string[] {
  const trimmed = userPrompt.trim();
  if (!trimmed) return lines;
  return ["USER INSTRUCTIONS:", trimmed, "", ...lines];
}

function buildCommitPromptFromDiff(diff: string, userPrompt: string): string {
  return prependUserPrompt(userPrompt, [
    "Write a concise conventional-style commit message for the following diff.",
    "Output ONLY the commit message (subject + optional body), no explanation, no Markdown fences.",
    "",
    "DIFF:",
    truncateAiDiff(diff),
  ]).join("\n");
}

/**
 * Compose the prompt sent to the user's AI CLI for a given action. Kept on
 * the renderer side (vs the Rust layer) so we can iterate on wording without
 * recompiling the backend.
 */
async function buildPromptForKind(
  kind: AiKind,
  repoPath: string,
  userPrompt: string,
): Promise<string> {
  switch (kind) {
    case "commit": {
      const diff = await aiApi.getDiffForAi(repoPath, "staged");
      return buildCommitPromptFromDiff(diff, userPrompt);
    }
    case "pr": {
      const [log, diff] = await Promise.all([
        aiApi.getLogForAi(repoPath, "branch"),
        aiApi.getDiffForAi(repoPath, "branch"),
      ]);
      return prependUserPrompt(userPrompt, [
        "Draft a pull-request TITLE and DESCRIPTION for the changes below.",
        "",
        "Output format (STRICT — no ``` fences around the whole output):",
        "  Line 1: a single-line PR title — imperative sentence describing the",
        "          change, under 72 chars, no leading '#', no quotes, no",
        "          prefixes like 'Summary:' or 'PR:' or 'Title:'.",
        "  Line 2: blank.",
        "  Line 3+: PR body in Markdown with sections: ## Summary, ## Why, ## Test plan.",
        "",
        "Bad TITLES — these are section names, NEVER emit them as the title:",
        "  'Summary', '## Summary', 'Description', 'Changes', 'Overview', 'Why'.",
        "Good TITLES (examples):",
        "  'Add base-branch picker to Create PR dialog'",
        "  'Fix hover state bleeding across file rows'",
        "  'Auto-sync remote on window focus'",
        "",
        "COMMITS:",
        log.trim() || "(no commit history available)",
        "",
        "DIFF:",
        truncateAiDiff(diff),
      ]).join("\n");
    }
    case "summary": {
      const diff = await aiApi.getDiffForAi(repoPath, "working");
      return prependUserPrompt(userPrompt, [
        "Summarize the following diff in 4–8 bullet points.",
        "Focus on user-visible behavior and architectural changes; ignore noise like formatting.",
        "",
        "DIFF:",
        truncateAiDiff(diff),
      ]).join("\n");
    }
    case "risk": {
      const diff = await aiApi.getDiffForAi(repoPath, "working");
      return prependUserPrompt(userPrompt, [
        "Review the following diff for bugs, regressions, and risky changes.",
        "Output a Markdown list — for each issue include the file/line and a one-sentence rationale.",
        "If nothing material stands out, say so explicitly.",
        "",
        "DIFF:",
        truncateAiDiff(diff),
      ]).join("\n");
    }
  }
}


// ----- background auto-sync state -------------------------------------------
// Kept at module scope (not in the store) because these are purely ephemeral
// concerns — they reset on app reload and never need to participate in
// re-renders. `AUTO_SYNC_MS` is the throttle window; alt-tabbing twice in
// quick succession should NOT trigger two `git fetch` calls.
const AUTO_SYNC_MS = 30_000;
let lastAutoSyncAt = 0;
// Branches we've already told the user about since boot, so the "your
// branch was deleted on remote" toast doesn't repeat on every focus.
const notifiedGoneBranches = new Set<string>();

export const useRepoStore = create<State>((set, get) => ({
  repository: null,
  files: [],
  selectedFilePath: null,
  selectedFileStaged: null,
  openTabs: [],
  reviewedPaths: new Set(),
  multiSelection: new Set(),
  multiSelectAnchor: null,

  filterText: "",
  statusFilter: "all",
  onlyUnreviewed: false,
  sidebarTab: "changes",

  diffMode: "sbs",
  edits: {},
  savedEdits: {},
  dirtyPaths: new Set(),

  searchQuery: "",
  searchScope: "all",
  searchCaseSensitive: false,
  searchRegex: false,
  searchInclude: "",
  searchExclude: "",
  searchFiltersOpen: false,
  searchResults: [],
  searchLoading: false,
  searchFocusNonce: 0,

  replaceOpen: false,
  paletteMode: null,
  inFileSearchOpen: false,
  inFileSearchNonce: 0,
  aiKind: null,
  aiCliList: [],
  aiCliLoading: false,
  aiOutput: null,
  aiLoading: false,
  aiError: null,
  commitDraft: "",
  commitDraftLoading: false,
  gitOpLoading: null,
  prFlow: { state: "idle", message: "", url: null, error: null },
  prBranchChoiceOpen: false,
  prDialog: {
    bases: [],
    base: null,
    behind: 0,
    ahead: 0,
    statusLoading: false,
    ignoreBehind: false,
    statusError: null,
  },
  repoFiles: [],
  repoFilesLoading: false,
  branches: [],
  branchesLoading: false,
  branchMenuOpen: false,
  branchPrs: {},
  branchPrsLoading: false,
  stashes: [],
  stashesLoading: false,
  pendingStashCheckout: null,
  editors: [],
  editorMenuOpen: false,
  gitMenuOpen: false,

  terminalOpen: false,
  terminalSessionAlive: false,
  terminalHeight: readTerminalHeight(),
  pendingTerminalCommand: null,

  loading: false,
  errorMessage: null,
  confirm: null,
  toasts: [],
  updaterStatus: "idle",
  updateInfo: null,
  updateProgress: null,
  updateError: null,

  recentRepos: readRecentRepos(),
  settings: readSettings(),
  settingsOpen: false,
  shortcutsOpen: false,
  onboardingOpen: false,
  repoMenuOpen: false,

  setTheme: (theme) => {
    set((s) => {
      const next = { ...s.settings, theme };
      writeSettings(next);
      applyTheme(theme);
      return { settings: next };
    });
  },
  setDensity: (density) => {
    set((s) => {
      const next = { ...s.settings, density };
      writeSettings(next);
      applyDensity(density);
      return { settings: next };
    });
  },
  setAutoOpenLast: (autoOpenLast) => {
    set((s) => {
      const next = { ...s.settings, autoOpenLast };
      writeSettings(next);
      return { settings: next };
    });
  },
  setDiffExpansion: (diffExpansion) => {
    set((s) => {
      const next = { ...s.settings, diffExpansion };
      writeSettings(next);
      return { settings: next };
    });
  },
  setSearchView: (searchView) => {
    set((s) => {
      const next = { ...s.settings, searchView };
      writeSettings(next);
      return { settings: next };
    });
  },
  setUiZoom: (uiZoom) => {
    set((s) => {
      const nextZoom = normalizeUiZoom(uiZoom);
      const next = { ...s.settings, uiZoom: nextZoom };
      writeSettings(next);
      applyUiZoom(nextZoom);
      return { settings: next };
    });
  },
  zoomIn: () => {
    const current = get().settings.uiZoom;
    get().setUiZoom(current + UI_ZOOM_STEP);
  },
  zoomOut: () => {
    const current = get().settings.uiZoom;
    get().setUiZoom(current - UI_ZOOM_STEP);
  },
  resetZoom: () => {
    get().setUiZoom(1);
  },
  setUiFont: (uiFont, custom) => {
    set((s) => {
      const customUiFont = custom ?? s.settings.customUiFont;
      const next = { ...s.settings, uiFont, customUiFont };
      writeSettings(next);
      applySansFont(uiFont, customUiFont);
      return { settings: next };
    });
  },
  setCodeFont: (codeFont, custom) => {
    set((s) => {
      const customCodeFont = custom ?? s.settings.customCodeFont;
      const next = { ...s.settings, codeFont, customCodeFont };
      writeSettings(next);
      applyMonoFont(codeFont, customCodeFont);
      return { settings: next };
    });
  },
  setCustomColor: (key, value) => {
    set((s) => {
      const nextColors = { ...s.settings.customColors };
      if (value == null || value === "") delete nextColors[key];
      else nextColors[key] = value;
      const next = { ...s.settings, customColors: nextColors };
      writeSettings(next);
      applyCustomColors(nextColors);
      return { settings: next };
    });
  },
  resetCustomColors: () => {
    set((s) => {
      const next = { ...s.settings, customColors: {} };
      writeSettings(next);
      applyCustomColors({});
      return { settings: next };
    });
  },
  setAiSystemPrompt: (kind, value) => {
    set((s) => {
      const next = {
        ...s.settings,
        aiSystemPrompts: { ...s.settings.aiSystemPrompts, [kind]: value },
      };
      writeSettings(next);
      return { settings: next };
    });
  },
  generateBranchName: async () => {
    const state = get();
    if (!state.repository) return null;
    // Same lazy-detect + fallback the commit composer and the modal use.
    // Used to do its own `aiCliList.find()` and barf "No AI CLI detected"
    // when the user had never opened the GitMenu yet (which is what used
    // to trigger detection) or had a stale preference pointing at an
    // uninstalled CLI.
    const cli = await resolveAvailableCli(get, set);
    if (!cli) {
      state.pushToast(
        "No AI CLI detected. Set one in Preferences → AI.",
        "danger",
      );
      return null;
    }
    try {
      const repoPath = state.repository.path;
      const diff = await aiApi.getDiffForAi(repoPath, "working");
      const userPrompt = state.settings.aiSystemPrompts.branch.trim();
      const prompt = [
        userPrompt,
        userPrompt ? "" : null,
        "Suggest a single short Git branch name for the changes below.",
        "Use kebab-case with a conventional prefix like feat/, fix/, refactor/, chore/.",
        "Output ONLY the branch name on a single line — no quotes, no Markdown, no explanation.",
        "",
        "DIFF:",
        diff.slice(0, 60_000),
      ]
        .filter((x): x is string => x !== null)
        .join("\n");
      const raw = stripOuterCodeFence(
        (await aiApi.runAiCli(cli.id, prompt, repoPath)).trim(),
      );
      // Trust but verify: strip surrounding whitespace, drop trailing
      // punctuation, take the first line.
      const first = raw.trim().split("\n")[0] ?? "";
      const cleaned = first
        .replace(/^["'`]+|["'`]+$/g, "")
        .replace(/[\s.,;]+$/g, "")
        .trim();
      if (!cleaned) {
        state.pushToast("AI returned an empty branch name", "danger");
        return null;
      }
      return cleaned;
    } catch (err) {
      state.pushToast(
        err instanceof Error ? err.message : String(err),
        "danger",
      );
      return null;
    }
  },
  setLeftSidebarVisible: (leftSidebarVisible) => {
    set((s) => {
      const next = { ...s.settings, leftSidebarVisible };
      writeSettings(next);
      return { settings: next };
    });
  },
  setRightSidebarVisible: (rightSidebarVisible) => {
    set((s) => {
      const next = { ...s.settings, rightSidebarVisible };
      writeSettings(next);
      return { settings: next };
    });
  },
  setLeftSidebarWidth: (px) => {
    const w = Math.max(240, Math.min(600, Math.round(px)));
    set((s) => {
      if (s.settings.leftSidebarWidth === w) return s;
      const next = { ...s.settings, leftSidebarWidth: w };
      writeSettings(next);
      return { settings: next };
    });
  },
  setRightSidebarWidth: (px) => {
    const w = Math.max(240, Math.min(600, Math.round(px)));
    set((s) => {
      if (s.settings.rightSidebarWidth === w) return s;
      const next = { ...s.settings, rightSidebarWidth: w };
      writeSettings(next);
      return { settings: next };
    });
  },
  toggleLeftSidebar: () =>
    set((s) => {
      const next = {
        ...s.settings,
        leftSidebarVisible: !s.settings.leftSidebarVisible,
      };
      writeSettings(next);
      return { settings: next };
    }),
  toggleRightSidebar: () =>
    set((s) => {
      const next = {
        ...s.settings,
        rightSidebarVisible: !s.settings.rightSidebarVisible,
      };
      writeSettings(next);
      return { settings: next };
    }),
  setTerminalOpen: (terminalOpen) =>
    set((s) => ({
      terminalOpen,
      // Opening the drawer guarantees a live session; closing leaves
      // whatever session was running intact (hidden but alive).
      terminalSessionAlive: terminalOpen ? true : s.terminalSessionAlive,
    })),
  toggleTerminal: () =>
    set((s) => {
      const next = !s.terminalOpen;
      return {
        terminalOpen: next,
        terminalSessionAlive: next ? true : s.terminalSessionAlive,
      };
    }),
  killTerminalSession: () =>
    set({
      terminalOpen: false,
      terminalSessionAlive: false,
      pendingTerminalCommand: null,
    }),
  setTerminalHeight: (px) => {
    // Clamp so the drawer can't eat the entire main pane or collapse below
    // a usable shell height (4-5 lines).
    const h = Math.max(120, Math.min(800, Math.round(px)));
    set((s) => {
      if (s.terminalHeight === h) return s;
      writeTerminalHeight(h);
      return { terminalHeight: h };
    });
  },
  runInTerminal: (cmd) =>
    set({
      terminalOpen: true,
      terminalSessionAlive: true,
      pendingTerminalCommand: cmd,
    }),
  clearPendingTerminalCommand: () => set({ pendingTerminalCommand: null }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
  setOnboardingOpen: (onboardingOpen) => set({ onboardingOpen }),
  setRepoMenuOpen: (repoMenuOpen) => set({ repoMenuOpen }),
  forgetRecent: (path) => {
    set({ recentRepos: removeRecentRepo(path) });
  },
  checkForUpdate: async (silent = false) => {
    if (!isTauri()) {
      if (!silent) {
        get().pushToast("Updates are available in the packaged app.");
      }
      return;
    }
    const state = get();
    if (
      state.updaterStatus === "checking" ||
      state.updaterStatus === "downloading"
    ) {
      return;
    }
    set({
      updaterStatus: "checking",
      updateError: null,
      updateProgress: null,
    });
    try {
      const update = await check();
      pendingUpdate = update;
      if (!update) {
        set({
          updaterStatus: "unavailable",
          updateInfo: null,
          updateProgress: null,
        });
        if (!silent) get().pushToast("Squint is up to date");
        return;
      }
      set({
        updaterStatus: "available",
        updateInfo: {
          version: update.version,
          currentVersion: update.currentVersion,
          body: update.body,
        },
        updateProgress: null,
      });
      get().pushToast(`Update ${update.version} available`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      pendingUpdate = null;
      set({
        updaterStatus: silent ? "idle" : "error",
        updateError: message,
        updateProgress: null,
      });
      if (!silent) {
        get().pushToast(`Update check failed: ${message}`, "danger");
      }
    }
  },
  installUpdate: async () => {
    if (!isTauri()) return;
    if (get().updaterStatus === "downloading") return;

    let update = pendingUpdate;
    if (!update) {
      await get().checkForUpdate();
      update = pendingUpdate;
    }
    if (!update) return;

    let downloaded = 0;
    let total: number | null = null;
    set({ updaterStatus: "downloading", updateError: null, updateProgress: 0 });
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? null;
          downloaded = 0;
          set({ updateProgress: total ? 0 : null });
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          if (total && total > 0) {
            set({ updateProgress: Math.min(1, downloaded / total) });
          }
        } else if (event.event === "Finished") {
          set({ updateProgress: 1 });
        }
      });
      set({ updaterStatus: "ready", updateProgress: 1 });
      get().pushToast("Update installed. Relaunching...");
      await relaunch();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ updaterStatus: "error", updateError: message });
      get().pushToast(`Update failed: ${message}`, "danger");
    }
  },

  setError: (errorMessage) => set({ errorMessage }),

  setConfirm: (confirm) => set({ confirm }),

  pushToast: (text, kind = "info") => {
    const id = `${++toastCounter}:${Math.random().toString(36).slice(2, 8)}`;
    set((s) => ({ toasts: [...s.toasts, { id, text, kind }] }));
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, 2400);
  },

  openRepositoryFromPath: async (path) => {
    set({ loading: true, errorMessage: null });
    try {
      const repository = await repoApi.openRepository(path);
      writeLastRepoPath(repository.path);
      const recentRepos = pushRecentRepo({
        path: repository.path,
        name: repository.name,
        branch: repository.currentBranch,
      });
      const reviewedPaths = loadReviewed(repository.path);
      const decorate = (files: ChangedFile[]) =>
        files.map((f) => ({ ...f, reviewed: reviewedPaths.has(f.path) }));
      const files = decorate(await gitApi.getRepoStatus(repository.path));
      set({
        repository,
        files,
        reviewedPaths,
        recentRepos,
        repoMenuOpen: false,
        selectedFilePath: files[0]?.path ?? null,
        selectedFileStaged: files[0]?.staged ?? null,
        openTabs: files[0]
          ? [{ path: files[0].path, staged: files[0].staged }]
          : [],
        multiSelection: new Set(),
        multiSelectAnchor: null,
        loading: false,
        edits: {},
        savedEdits: {},
        repoFiles: [],
        repoFilesLoading: false,
        branches: [],
        branchesLoading: false,
        branchMenuOpen: false,
        stashes: [],
        stashesLoading: false,
        pendingStashCheckout: null,
      });
      // File index is built lazily — only when the user opens the ⌘P palette.
    } catch (err) {
      // On failure (e.g. folder deleted), drop the stale entry from recents.
      const recentRepos = removeRecentRepo(path);
      set({
        loading: false,
        recentRepos,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  },

  openRepositoryPicker: async () => {
    try {
      const selected = await repoApi.pickRepositoryFolder();
      if (!selected) return;
      await get().openRepositoryFromPath(selected);
    } catch (err) {
      set({ errorMessage: err instanceof Error ? err.message : String(err) });
    }
  },

  closeRepository: () => {
    writeLastRepoPath(null);
    set({
      repository: null,
      files: [],
      selectedFilePath: null,
      selectedFileStaged: null,
      openTabs: [],
      reviewedPaths: new Set(),
      multiSelection: new Set(),
      multiSelectAnchor: null,
      filterText: "",
      statusFilter: "all",
      onlyUnreviewed: false,
      sidebarTab: "changes",
      diffMode: "sbs",
      edits: {},
      savedEdits: {},
      searchQuery: "",
      searchScope: "all",
      searchCaseSensitive: false,
      searchRegex: false,
      searchInclude: "",
      searchExclude: "",
      searchFiltersOpen: false,
      searchResults: [],
      searchLoading: false,
      replaceOpen: false,
      paletteMode: null,
      aiKind: null,
      aiOutput: null,
      aiLoading: false,
      aiError: null,
      repoFiles: [],
      repoFilesLoading: false,
      branches: [],
      branchesLoading: false,
      branchMenuOpen: false,
      stashes: [],
      stashesLoading: false,
      pendingStashCheckout: null,
      errorMessage: null,
    });
  },

  refresh: async () => {
    const repo = get().repository;
    if (!repo) return;
    // The working tree may have changed (commit / pull / stash / external
    // edit) so the per-file diff cache is now stale. Cheaper to drop it
    // wholesale than to track per-key invalidation — the cache repopulates
    // as the user navigates.
    gitApi.clearDiffCache();
    set({ loading: true, errorMessage: null });
    try {
      const [rawFiles, repository] = await Promise.all([
        gitApi.getRepoStatus(repo.path),
        repoApi.openRepository(repo.path),
      ]);
      const reviewedPaths = get().reviewedPaths;
      const files = rawFiles.map((f) => ({
        ...f,
        reviewed: reviewedPaths.has(f.path),
      }));
      const selectedPath = get().selectedFilePath;
      const selectedStaged = get().selectedFileStaged;
      // `selectedFileStaged === null` means the user is viewing a file that
      // isn't a changed entry (opened via the file tree / ⌘P). It's still a
      // valid working-tree path — keep showing it instead of jumping to the
      // first changed file.
      const isUnchangedSelection = selectedPath != null && selectedStaged === null;
      const stillExists = files.some(
        (f) => f.path === selectedPath && f.staged === selectedStaged,
      );
      const preserve = stillExists || isUnchangedSelection;
      const nextSelectedPath = preserve
        ? selectedPath
        : (files[0]?.path ?? null);
      const nextSelectedStaged = preserve
        ? selectedStaged
        : (files[0]?.staged ?? null);
      // Keep tabs in sync: prune tabs whose (path, staged) no longer exists
      // in `files` AND whose staged isn't `null` (file-view tabs survive
      // because they don't need a changed entry). If selection moved to a
      // new file that isn't tabbed yet, append it so the active tab is
      // always findable in the strip.
      const prevTabs = get().openTabs;
      let nextTabs = prevTabs.filter(
        (t) =>
          t.staged === null ||
          files.some((f) => f.path === t.path && f.staged === t.staged),
      );
      if (
        nextSelectedPath != null &&
        !nextTabs.some(
          (t) =>
            t.path === nextSelectedPath && t.staged === nextSelectedStaged,
        )
      ) {
        nextTabs = [
          ...nextTabs,
          { path: nextSelectedPath, staged: nextSelectedStaged },
        ];
      }
      set({
        files,
        loading: false,
        repository,
        selectedFilePath: nextSelectedPath,
        selectedFileStaged: nextSelectedStaged,
        openTabs: nextTabs,
      });
    } catch (err) {
      set({
        loading: false,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  },

  selectFile: (path, staged) =>
    set((s) => {
      if (path === null) {
        return { selectedFilePath: null, selectedFileStaged: null };
      }
      // Resolve the staged variant the user actually wants.
      let resolvedStaged: boolean | null;
      if (staged === null) {
        resolvedStaged = null;
      } else if (staged !== undefined) {
        resolvedStaged = staged;
      } else {
        // Auto-detect: prefer the unstaged version when both exist (matches
        // `git diff` defaults). Falls back to staged, then to null when the
        // file isn't a changed entry at all (file tree / ⌘P picker).
        const matches = s.files.filter((f) => f.path === path);
        const unstaged = matches.find((f) => !f.staged);
        const stagedMatch = matches.find((f) => f.staged);
        const picked = unstaged ?? stagedMatch;
        resolvedStaged = picked ? picked.staged : null;
      }
      const tab: FileTab = { path, staged: resolvedStaged };
      const exists = s.openTabs.some(
        (t) => t.path === tab.path && t.staged === tab.staged,
      );
      return {
        selectedFilePath: path,
        selectedFileStaged: resolvedStaged,
        openTabs: exists ? s.openTabs : [...s.openTabs, tab],
      };
    }),

  closeTab: (tab) =>
    set((s) => {
      const idx = s.openTabs.findIndex(
        (t) => t.path === tab.path && t.staged === tab.staged,
      );
      if (idx < 0) return {};
      const nextTabs = [...s.openTabs.slice(0, idx), ...s.openTabs.slice(idx + 1)];
      const wasActive =
        s.selectedFilePath === tab.path && s.selectedFileStaged === tab.staged;
      if (!wasActive) {
        return { openTabs: nextTabs };
      }
      const neighbor = nextTabs[idx] ?? nextTabs[idx - 1] ?? null;
      return {
        openTabs: nextTabs,
        selectedFilePath: neighbor?.path ?? null,
        selectedFileStaged: neighbor?.staged ?? null,
      };
    }),

  closeAllTabs: () =>
    set((s) => {
      // Only clear the active selection if it actually corresponded to one
      // of the tabs we're closing — preserves a file opened via Files tree
      // or ⌘P (which becomes an "active" tab transparently).
      const wasInTab = s.openTabs.some(
        (t) =>
          t.path === s.selectedFilePath && t.staged === s.selectedFileStaged,
      );
      return {
        openTabs: [],
        selectedFilePath: wasInTab ? null : s.selectedFilePath,
        selectedFileStaged: wasInTab ? null : s.selectedFileStaged,
      };
    }),

  selectAdjacentTab: (direction) => {
    const state = get();
    if (state.openTabs.length === 0) return;
    const idx = state.openTabs.findIndex(
      (t) =>
        t.path === state.selectedFilePath &&
        t.staged === state.selectedFileStaged,
    );
    const nextIdx =
      idx < 0
        ? 0
        : (idx + direction + state.openTabs.length) % state.openTabs.length;
    const next = state.openTabs[nextIdx];
    set({
      selectedFilePath: next.path,
      selectedFileStaged: next.staged,
    });
  },

  selectAdjacentFile: (direction) => {
    const state = get();
    if (!state.repository) return;
    const visible = filteredFiles(
      state.files,
      state.filterText,
      state.statusFilter,
      state.onlyUnreviewed,
    );
    if (visible.length === 0) return;
    const idx = visible.findIndex(
      (f) =>
        f.path === state.selectedFilePath &&
        f.staged === state.selectedFileStaged,
    );
    const nextIdx =
      idx < 0
        ? 0
        : (idx + direction + visible.length) % visible.length;
    const next = visible[nextIdx];
    set({ selectedFilePath: next.path, selectedFileStaged: next.staged });

    // Prefetch the file the user is most likely to navigate to next so
    // it's already in cache by the time they hit ⌥↓ / ⌥↑ again. The cost
    // is one extra background `git diff` that runs in parallel on the
    // Rust blocking pool (doesn't block the foreground fetch).
    const repoPath = state.repository.path;
    const peek = visible[(nextIdx + direction + visible.length) % visible.length];
    if (peek && (peek.path !== next.path || peek.staged !== next.staged)) {
      gitApi.prefetchFileDiff(repoPath, peek.path, peek.staged);
    }
  },

  setFilterText: (filterText) => set({ filterText }),
  setStatusFilter: (statusFilter) => set({ statusFilter }),
  setOnlyUnreviewed: (onlyUnreviewed) => set({ onlyUnreviewed }),
  setSidebarTab: (sidebarTab) => set({ sidebarTab }),

  setDiffMode: (diffMode) => set({ diffMode }),

  setEdit: (path, value) =>
    set((s) => {
      const nextEdits = { ...s.edits, [path]: value };
      const saved = s.savedEdits[path];
      const nowDirty = saved !== value;
      const wasDirty = s.dirtyPaths.has(path);
      // Only allocate a new Set when membership actually flips — typing in
      // a single dirty file (the hot path) reuses the same Set reference, so
      // subscribers like TabStrip don't re-render per keystroke.
      const nextDirty =
        nowDirty === wasDirty
          ? s.dirtyPaths
          : (() => {
              const next = new Set(s.dirtyPaths);
              if (nowDirty) next.add(path);
              else next.delete(path);
              return next;
            })();
      return { edits: nextEdits, dirtyPaths: nextDirty };
    }),

  /**
   * Prime the edit buffer with content read from disk. Both `edits` and
   * `savedEdits` get the same value so the file is *not* immediately
   * considered dirty just because we loaded it.
   */
  loadEditBuffer: (path, content) =>
    set((s) => {
      const nextDirty = s.dirtyPaths.has(path)
        ? (() => {
            const next = new Set(s.dirtyPaths);
            next.delete(path);
            return next;
          })()
        : s.dirtyPaths;
      return {
        edits: { ...s.edits, [path]: content },
        savedEdits: { ...s.savedEdits, [path]: content },
        dirtyPaths: nextDirty,
      };
    }),

  saveEdit: async () => {
    const state = get();
    if (!state.repository || !state.selectedFilePath) return;
    const path = state.selectedFilePath;
    const content = state.edits[path];
    if (content == null) return;
    // Skip writing when the buffer matches what we last loaded/saved — avoids
    // touching the file's mtime and the spurious refresh that comes with it.
    const saved = state.savedEdits[path];
    if (saved != null && saved === content) return;
    try {
      await gitApi.writeWorkingFile(state.repository.path, path, content);
      set((s) => {
        const nextDirty = s.dirtyPaths.has(path)
          ? (() => {
              const next = new Set(s.dirtyPaths);
              next.delete(path);
              return next;
            })()
          : s.dirtyPaths;
        return {
          savedEdits: { ...s.savedEdits, [path]: content },
          dirtyPaths: nextDirty,
        };
      });
      get().pushToast(`Saved ${path}`);
      await get().refresh();
    } catch (err) {
      set({ errorMessage: err instanceof Error ? err.message : String(err) });
    }
  },

  cancelEdit: () => {
    const state = get();
    const path = state.selectedFilePath;
    if (!path) return;
    set((s) => {
      const nextEdits = { ...s.edits };
      delete nextEdits[path];
      const nextDirty = s.dirtyPaths.has(path)
        ? (() => {
            const next = new Set(s.dirtyPaths);
            next.delete(path);
            return next;
          })()
        : s.dirtyPaths;
      return { edits: nextEdits, diffMode: "sbs", dirtyPaths: nextDirty };
    });
  },

  setSearchQuery: (searchQuery) => set({ searchQuery }),
  setSearchScope: (searchScope) => set({ searchScope }),
  setSearchCaseSensitive: (searchCaseSensitive) =>
    set({ searchCaseSensitive }),
  setSearchRegex: (searchRegex) => set({ searchRegex }),
  setSearchInclude: (searchInclude) => set({ searchInclude }),
  setSearchExclude: (searchExclude) => set({ searchExclude }),
  setSearchFiltersOpen: (searchFiltersOpen) => set({ searchFiltersOpen }),
  pingSearchFocus: () =>
    set((s) => ({ searchFocusNonce: s.searchFocusNonce + 1 })),
  runRepoSearch: async () => {
    const state = get();
    if (!state.repository) return;
    const q = state.searchQuery.trim();
    if (!q) {
      set({ searchResults: [], searchLoading: false });
      return;
    }
    set({ searchLoading: true });
    try {
      const paths =
        state.searchScope === "changed"
          ? state.files.map((f) => f.path)
          : state.searchScope === "current" && state.selectedFilePath
            ? [state.selectedFilePath]
            : undefined;
      const results = await searchApi.searchRepo({
        repoPath: state.repository.path,
        query: q,
        scope: state.searchScope,
        caseSensitive: state.searchCaseSensitive,
        regex: state.searchRegex,
        paths,
        include: state.searchInclude.trim() || undefined,
        exclude: state.searchExclude.trim() || undefined,
      });
      // Discard if the user has typed something else in the meantime.
      if (get().searchQuery.trim() === q) {
        set({ searchResults: results, searchLoading: false });
      }
    } catch (err) {
      set({
        searchLoading: false,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  },
  setReplaceOpen: (replaceOpen) => set({ replaceOpen }),
  setPaletteMode: (paletteMode) => set({ paletteMode }),

  fetchRepoFiles: async () => {
    const state = get();
    if (!state.repository) return;
    if (state.repoFiles.length > 0 || state.repoFilesLoading) return;
    set({ repoFilesLoading: true });
    try {
      const repoFiles = await gitApi.listRepoFiles(state.repository.path);
      set({ repoFiles, repoFilesLoading: false });
    } catch (err) {
      set({
        repoFilesLoading: false,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  },

  fetchBranches: async () => {
    const state = get();
    if (!state.repository) return;
    set({ branchesLoading: true });
    try {
      const branches = await gitApi.listBranches(state.repository.path);
      set({ branches, branchesLoading: false });
    } catch (err) {
      set({
        branchesLoading: false,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  },

  fetchBranchPrs: async () => {
    const state = get();
    if (!state.repository) return;
    if (state.branchPrsLoading) return;
    set({ branchPrsLoading: true });
    try {
      const list = await gitApi.ghPrList(state.repository.path);
      // Map by HEAD branch name so the branch menu can look up each row
      // in O(1) — one branch can have at most one open PR.
      const byBranch: Record<string, PrSummary> = {};
      for (const pr of list) {
        if (pr.headRefName) byBranch[pr.headRefName] = pr;
      }
      set({ branchPrs: byBranch, branchPrsLoading: false });
    } catch {
      // Silent on failure — gh might not be installed / authenticated /
      // the repo might not have a GitHub remote. The branch picker still
      // works fine without PR badges, and the user has the Preferences
      // → AI / onboarding screens to fix gh setup if they want to.
      set({ branchPrsLoading: false });
    }
  },

  setBranchMenuOpen: (branchMenuOpen) => {
    set({ branchMenuOpen });
    // Refresh PR badges every time the picker opens (cheap — one
    // `gh pr list` call) so the user sees up-to-date review/CI state
    // without us paying for background polling.
    if (branchMenuOpen) {
      get().fetchBranchPrs().catch(() => {
        /* fetchBranchPrs already swallows errors */
      });
    }
  },

  checkoutBranch: async (name) => {
    const state = get();
    if (!state.repository) return;
    try {
      await gitApi.checkoutBranch(state.repository.path, name);
      get().pushToast(`Switched to ${name}`);
      set({ branchMenuOpen: false });
      await get().refresh();
      get().fetchStashes().catch(() => {
        /* non-fatal */
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Detect git's "your local changes would be overwritten" family of
      // errors and offer to stash. Match a couple of phrasings to be safe.
      const isDirty =
        /would be overwritten/i.test(msg) ||
        /please commit your changes or stash them/i.test(msg);
      if (isDirty) {
        const fromBranch = state.repository.currentBranch || "current branch";
        const ts = new Date().toISOString().slice(0, 16).replace("T", " ");
        const suggested = `wip on ${fromBranch} → ${name} (${ts})`;
        set({
          pendingStashCheckout: {
            target: name,
            suggestedMessage: suggested,
          },
          branchMenuOpen: false,
        });
        return;
      }
      set({ errorMessage: msg });
    }
  },

  createBranch: async (name, base) => {
    const state = get();
    if (!state.repository) return;
    try {
      await gitApi.createBranch(state.repository.path, name, base);
      get().pushToast(`Created and switched to ${name}`);
      set({ branchMenuOpen: false });
      await get().refresh();
    } catch (err) {
      set({ errorMessage: err instanceof Error ? err.message : String(err) });
    }
  },

  deleteBranch: async (name, opts) => {
    const state = get();
    if (!state.repository) return;
    try {
      await gitApi.deleteBranch(state.repository.path, name, opts?.force);
      get().pushToast(`Deleted ${name}`);
      await get().fetchBranches();
    } catch (err) {
      set({ errorMessage: err instanceof Error ? err.message : String(err) });
    }
  },

  requestPruneGoneBranches: () => {
    const state = get();
    if (!state.repository) return;
    const gone = state.branches.filter((b) => !b.isRemote && b.gone);
    if (gone.length === 0) {
      state.pushToast("No gone branches to prune");
      return;
    }
    const names = gone.map((b) => b.name);
    const preview =
      names.length <= 5
        ? names.join(", ")
        : `${names.slice(0, 5).join(", ")} … (+${names.length - 5} more)`;
    set({
      confirm: {
        title: `Prune ${names.length} gone branch${names.length === 1 ? "" : "es"}?`,
        body: `Local branches whose remote was deleted: ${preview}. This runs \`git branch -D\` on each — unpushed commits in those branches will be lost. The reflog still has them for ~30 days.`,
        confirmLabel: `Delete ${names.length}`,
        danger: true,
        onConfirm: async () => {
          set({ confirm: null });
          const errors: string[] = [];
          for (const n of names) {
            try {
              await gitApi.deleteBranch(
                state.repository!.path,
                n,
                /* force */ true,
              );
            } catch (err) {
              errors.push(`${n}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          await get().fetchBranches();
          if (errors.length > 0) {
            set({ errorMessage: errors.join("\n") });
          } else {
            get().pushToast(
              `Pruned ${names.length} branch${names.length === 1 ? "" : "es"}`,
            );
          }
        },
      },
    });
  },

  cancelPendingStashCheckout: () => set({ pendingStashCheckout: null }),

  confirmStashAndCheckout: async (message, includeUntracked) => {
    const state = get();
    if (!state.repository || !state.pendingStashCheckout) return;
    const repoPath = state.repository.path;
    const target = state.pendingStashCheckout.target;
    try {
      // Stash → checkout → pop. The goal is "the user keeps working on
      // the same uncommitted change, just on a different branch". Without
      // the pop step the changes would just sit in the stash list and
      // the user would have to remember to apply them manually — which
      // defeats the whole "carry my work-in-progress with me" intent.
      await gitApi.stashPush(repoPath, message, includeUntracked);
      set({ pendingStashCheckout: null });
      await gitApi.checkoutBranch(repoPath, target);
      // Try to re-apply onto the target branch. `git stash pop` is
      // forgiving when the change applies cleanly and bails (without
      // dropping the stash) when there's a conflict — perfect for our
      // "best effort, surface the error" UX.
      try {
        await gitApi.stashPop(repoPath, "stash@{0}");
        get().pushToast(`Switched to ${target} — changes brought over`);
      } catch (popErr) {
        // Pop failed (usually: conflict with target branch's version
        // of the same file). The checkout succeeded and the stash is
        // still safely parked, so the user can resolve manually.
        const msg = popErr instanceof Error ? popErr.message : String(popErr);
        get().pushToast(
          `Switched to ${target}, but couldn't apply stash automatically — kept as stash@{0}. ${msg}`,
          "danger",
        );
      }
      await get().refresh();
      get().fetchStashes().catch(() => {
        /* non-fatal */
      });
    } catch (err) {
      set({
        pendingStashCheckout: null,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  },

  fetchStashes: async () => {
    const state = get();
    if (!state.repository) {
      set({ stashes: [] });
      return;
    }
    set({ stashesLoading: true });
    try {
      const stashes = await gitApi.stashList(state.repository.path);
      set({ stashes, stashesLoading: false });
    } catch {
      set({ stashesLoading: false });
    }
  },

  popStash: async (stashRef) => {
    const state = get();
    if (!state.repository) return;
    try {
      await gitApi.stashPop(state.repository.path, stashRef);
      get().pushToast(`Popped ${stashRef}`);
      await get().refresh();
      await get().fetchStashes();
    } catch (err) {
      set({ errorMessage: err instanceof Error ? err.message : String(err) });
    }
  },

  applyStash: async (stashRef) => {
    const state = get();
    if (!state.repository) return;
    try {
      await gitApi.stashApply(state.repository.path, stashRef);
      get().pushToast(`Applied ${stashRef}`);
      await get().refresh();
    } catch (err) {
      set({ errorMessage: err instanceof Error ? err.message : String(err) });
    }
  },

  dropStash: async (stashRef) => {
    const state = get();
    if (!state.repository) return;
    try {
      await gitApi.stashDrop(state.repository.path, stashRef);
      get().pushToast(`Dropped ${stashRef}`);
      await get().fetchStashes();
    } catch (err) {
      set({ errorMessage: err instanceof Error ? err.message : String(err) });
    }
  },

  requestDropStash: (stashRef, label) => {
    set({
      confirm: {
        title: `Drop ${stashRef}?`,
        body: `This permanently deletes the stash "${label}". It can't be undone.`,
        confirmLabel: "Drop stash",
        danger: true,
        onConfirm: async () => {
          set({ confirm: null });
          await get().dropStash(stashRef);
        },
      },
    });
  },

  setInFileSearchOpen: (inFileSearchOpen) => set({ inFileSearchOpen }),
  pingInFileSearch: () =>
    set((s) => ({ inFileSearchNonce: s.inFileSearchNonce + 1 })),
  setAiKind: (aiKind) => {
    // Compare BEFORE calling set — otherwise the comparison is always false
    // and stale output never gets cleared when switching kinds.
    const prev = get().aiKind;
    if (prev !== aiKind) {
      // Set `aiLoading: true` up front when activating so the modal renders
      // a spinner from the first paint — otherwise it briefly shows an
      // empty body until `runAi`'s useEffect fires and flips the flag,
      // which read as "frozen / crashed" to the user.
      set({
        aiKind,
        aiOutput: null,
        aiError: null,
        aiLoading: aiKind != null,
      });
    } else {
      set({ aiKind });
    }
    if (aiKind) {
      get().fetchAiClis().catch(() => {
        /* non-fatal */
      });
    }
  },

  fetchAiClis: async () => {
    const state = get();
    if (state.aiCliList.length > 0 || state.aiCliLoading) return;
    set({ aiCliLoading: true });
    try {
      const list = await aiApi.detectAiClis();
      set({ aiCliList: list, aiCliLoading: false });
      // Prefer Codex for new installs and migrate the old "first detected"
      // default once. After that, explicit user choices persist normally.
      const settings = get().settings;
      const cur = settings.preferredAiCli;
      const validCurrent =
        cur != null && list.some((c) => c.id === cur && c.available);
      const codex = list.find((c) => c.id === "codex" && c.available);
      if (!settings.aiCliDefaultMigratedToCodex && codex) {
        const next = {
          ...settings,
          preferredAiCli: codex.id,
          aiCliDefaultMigratedToCodex: true,
        };
        writeSettings(next);
        set({ settings: next });
        return;
      }
      if (!validCurrent) {
        const firstAvail = list.find((c) => c.available);
        if (firstAvail) get().setPreferredAiCli(firstAvail.id);
      }
    } catch {
      set({ aiCliLoading: false });
    }
  },

  setPreferredAiCli: (id) => {
    set((s) => {
      const next = { ...s.settings, preferredAiCli: id };
      writeSettings(next);
      return { settings: next };
    });
  },

  runAi: async (kind) => {
    const state = get();
    if (!state.repository) return;
    const cli = await resolveAvailableCli(get, set);
    if (!cli) {
      set({
        aiOutput: null,
        aiLoading: false,
        aiError:
          "No AI CLI detected. Install Claude Code (`brew install claude`) or Codex CLI, then pick one in Preferences → AI.",
      });
      return;
    }
    // Bump a monotonic request id so a slow-returning previous call can't
    // overwrite the result of a more recent runAi (e.g. user switches from
    // "commit" to "risk" before the first one comes back).
    aiRequestCounter += 1;
    const myId = aiRequestCounter;
    set({ aiLoading: true, aiError: null, aiOutput: null });
    try {
      const repoPath = state.repository.path;
      const userPrompt = state.settings.aiSystemPrompts[kind] ?? "";
      const prompt = await buildPromptForKind(kind, repoPath, userPrompt);
      const text = await aiApi.runAiCli(cli.id, prompt, repoPath);
      if (myId !== aiRequestCounter) return; // a newer request superseded us
      set({
        aiLoading: false,
        aiOutput: { cliId: cli.id, cliName: cli.name, text: text.trim() },
      });
    } catch (err) {
      if (myId !== aiRequestCounter) return;
      set({
        aiLoading: false,
        aiError: err instanceof Error ? err.message : String(err),
      });
    }
  },

  clearAiOutput: () => set({ aiOutput: null, aiError: null }),

  setCommitDraft: (value) => set({ commitDraft: value }),

  /**
   * Run the AI once to produce a commit message from the staged diff and
   * drop the result into `commitDraft`. The user can edit the result before
   * actually committing — this is intentionally separate from the modal
   * `runAi("commit")` flow because the textarea is the canonical UI now.
   */
  generateCommitDraft: async () => {
    const state = get();
    if (!state.repository || state.commitDraftLoading) return;
    const cli = await resolveAvailableCli(get, set);
    if (!cli) {
      set({
        errorMessage:
          "No AI CLI detected. Install Claude Code or Codex CLI and pick one in Preferences → AI.",
      });
      return;
    }
    set({ commitDraftLoading: true });
    try {
      const repoPath = state.repository.path;
      const userPrompt = state.settings.aiSystemPrompts.commit ?? "";
      const prompt = await buildPromptForKind("commit", repoPath, userPrompt);
      const text = await aiApi.runAiCli(cli.id, prompt, repoPath);
      set({ commitDraft: text.trim(), commitDraftLoading: false });
    } catch (err) {
      set({
        commitDraftLoading: false,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  },

  generateHunkCommitDraft: async (patch, signal) => {
    const state = get();
    if (!state.repository) return "";
    const throwIfAborted = () => {
      if (signal?.aborted) {
        throw new DOMException("Cancelled", "AbortError");
      }
    };
    throwIfAborted();
    const cli = await resolveAvailableCli(get, set);
    if (!cli) {
      const message =
        "No AI CLI detected. Install Claude Code or Codex CLI and pick one in Preferences → AI.";
      set({ errorMessage: message });
      throw new Error(message);
    }
    try {
      const userPrompt = state.settings.aiSystemPrompts.commit ?? "";
      const prompt = buildCommitPromptFromDiff(patch, userPrompt);
      const text = await aiApi.runAiCli(cli.id, prompt, state.repository.path);
      throwIfAborted();
      return stripOuterCodeFence(text.trim()).trim();
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        set({ errorMessage: err instanceof Error ? err.message : String(err) });
      }
      throw err;
    }
  },

  /**
   * Commit staged changes using the current `commitDraft`. Empty drafts are
   * rejected up front so the git plumbing never sees a blank message.
   */
  commitDraftRun: async () => {
    const state = get();
    if (!state.repository || state.commitDraftLoading) return;
    const message = state.commitDraft.trim();
    if (!message) {
      set({ errorMessage: "Commit message is empty" });
      return;
    }
    set({ commitDraftLoading: true });
    try {
      await gitApi.commit(state.repository.path, message);
      set({ commitDraft: "", commitDraftLoading: false });
      get().pushToast(`Committed: ${message.split("\n")[0]}`);
      await get().refresh();
    } catch (err) {
      set({
        commitDraftLoading: false,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  },

  /**
   * Combined `commit + push` action. We do the commit first; on success we
   * push. If the branch has no upstream yet (`origin/<branch>` doesn't
   * exist), retry once with `-u` to set it. Errors at either step bubble
   * to the global error banner so the user knows which half failed.
   */
  commitDraftAndPush: async () => {
    const state = get();
    if (!state.repository || state.commitDraftLoading) return;
    const message = state.commitDraft.trim();
    if (!message) {
      set({ errorMessage: "Commit message is empty" });
      return;
    }
    set({ commitDraftLoading: true });
    const repoPath = state.repository.path;
    try {
      await gitApi.commit(repoPath, message);
      set({ commitDraft: "" });
      try {
        await gitApi.push(repoPath);
      } catch (pushErr) {
        // Detect the classic "no upstream branch" case and retry with -u.
        const m = pushErr instanceof Error ? pushErr.message : String(pushErr);
        if (/no upstream branch|--set-upstream/i.test(m)) {
          await gitApi.push(repoPath, true);
        } else {
          throw pushErr;
        }
      }
      set({ commitDraftLoading: false });
      get().pushToast(`Committed & pushed: ${message.split("\n")[0]}`);
      await get().refresh();
    } catch (err) {
      set({
        commitDraftLoading: false,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  },

  gitPush: async () => {
    const state = get();
    if (!state.repository || state.gitOpLoading != null) return;
    set({ gitOpLoading: "push" });
    try {
      try {
        await gitApi.push(state.repository.path);
      } catch (pushErr) {
        const m = pushErr instanceof Error ? pushErr.message : String(pushErr);
        if (/no upstream branch|--set-upstream/i.test(m)) {
          await gitApi.push(state.repository.path, true);
        } else {
          throw pushErr;
        }
      }
      get().pushToast("Pushed");
      await get().refresh();
    } catch (err) {
      set({ errorMessage: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ gitOpLoading: null });
    }
  },

  gitPull: async () => {
    const state = get();
    if (!state.repository || state.gitOpLoading != null) return;
    set({ gitOpLoading: "pull" });
    try {
      await gitApi.pull(state.repository.path);
      get().pushToast("Pulled");
      await get().refresh();
    } catch (err) {
      set({ errorMessage: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ gitOpLoading: null });
    }
  },

  gitFetchRemote: async () => {
    const state = get();
    if (!state.repository || state.gitOpLoading != null) return;
    set({ gitOpLoading: "fetch" });
    try {
      await gitApi.fetchRemote(state.repository.path);
      get().pushToast("Fetched");
      await get().refresh();
      await get().fetchBranches();
    } catch (err) {
      set({ errorMessage: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ gitOpLoading: null });
    }
  },

  gitSyncBranches: async () => {
    const state = get();
    if (!state.repository || state.gitOpLoading != null) return;
    set({ gitOpLoading: "sync" });
    try {
      const result = await gitApi.syncBranches(state.repository.path);
      await get().refresh();
      await get().fetchBranches();

      const updated = result.updated.length;
      const skipped = result.skipped.length;
      const unchanged = result.upToDate;
      const summary = [
        updated === 1 ? "Synced 1 branch" : `Synced ${updated} branches`,
        unchanged > 0 ? `${unchanged} unchanged` : null,
        skipped > 0 ? `${skipped} skipped` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      get().pushToast(summary || "No branches to sync");

      if (skipped > 0) {
        set({
          errorMessage: result.skipped
            .map((s) => `${s.branch}: ${s.reason}`)
            .join("\n"),
        });
      }
    } catch (err) {
      set({ errorMessage: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ gitOpLoading: null });
    }
  },

  gitAutoSync: async () => {
    const state = get();
    if (!state.repository) return;
    // Don't compete with an in-flight user-initiated op — the foreground
    // action will refresh on its own.
    if (state.gitOpLoading != null) return;
    const now = Date.now();
    if (now - lastAutoSyncAt < AUTO_SYNC_MS) return;
    lastAutoSyncAt = now;
    try {
      await gitApi.fetchRemote(state.repository.path);
      // Order matters: refresh the working tree first (cheap, no network)
      // then re-list branches so the "gone" badge reflects fresh upstream
      // tracking info from the fetch we just did.
      await get().refresh();
      await get().fetchBranches();
      // If the user's current branch had its upstream deleted on the
      // remote (almost always: the PR was merged + branch deleted on
      // GitHub), surface that exactly once per branch-per-session.
      const cur = get().repository?.currentBranch;
      if (!cur) return;
      const info = get().branches.find(
        (b) => b.name === cur && !b.isRemote,
      );
      if (info?.gone && !notifiedGoneBranches.has(cur)) {
        notifiedGoneBranches.add(cur);
        get().pushToast(
          `'${cur}' was deleted on remote — likely merged. Switch branches when ready.`,
        );
      }
    } catch {
      // Silent on failure — this is a best-effort background sync. If the
      // network is down or the remote auth expired, the user will see the
      // error the next time they explicitly fetch / push / pull.
    }
  },

  gitUndoLastCommit: async () => {
    const state = get();
    if (!state.repository || state.gitOpLoading != null) return;
    set({ gitOpLoading: "undo" });
    try {
      await gitApi.undoLastCommit(state.repository.path);
      get().pushToast("Undid last commit (changes kept staged)");
      await get().refresh();
    } catch (err) {
      set({ errorMessage: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ gitOpLoading: null });
    }
  },

  openPrBranchChoice: () => {
    const state = get();
    if (!state.repository) return;
    const repoPath = state.repository.path;
    // Show the dialog immediately with a "loading" baseline so the user
    // never sees an empty card. Bases / behind-ahead come in async.
    set({
      prBranchChoiceOpen: true,
      prDialog: {
        bases: [],
        base: null,
        behind: 0,
        ahead: 0,
        statusLoading: true,
        ignoreBehind: false,
        statusError: null,
      },
    });
    (async () => {
      try {
        // List of remote branches comes first because we need it to pick
        // the dropdown default (last-used > origin/HEAD > first remote).
        const [bases, fallback] = await Promise.all([
          gitApi.remoteBranches(repoPath),
          gitApi.defaultBranch(repoPath).catch(() => null),
        ]);
        const remembered = get().settings.lastPrBaseByRepo[repoPath];
        const base =
          (remembered && bases.includes(remembered) ? remembered : null) ??
          (fallback && bases.includes(fallback) ? fallback : null) ??
          bases[0] ??
          null;
        set((s) => ({
          prDialog: { ...s.prDialog, bases, base },
        }));
        // Now compute behind/ahead against whichever base we landed on.
        if (base) await get().refreshPrDialogStatus();
        else set((s) => ({ prDialog: { ...s.prDialog, statusLoading: false } }));
      } catch (err) {
        set((s) => ({
          prDialog: {
            ...s.prDialog,
            statusLoading: false,
            statusError: err instanceof Error ? err.message : String(err),
          },
        }));
      }
    })();
  },
  closePrBranchChoice: () => set({ prBranchChoiceOpen: false }),

  setPrDialogBase: (base) => {
    set((s) => ({
      prDialog: { ...s.prDialog, base, ignoreBehind: false, statusError: null },
    }));
    void get().refreshPrDialogStatus();
  },

  refreshPrDialogStatus: async () => {
    const state = get();
    const repoPath = state.repository?.path;
    const base = state.prDialog.base;
    const head = state.repository?.currentBranch;
    if (!repoPath || !base || !head) {
      set((s) => ({ prDialog: { ...s.prDialog, statusLoading: false } }));
      return;
    }
    set((s) => ({ prDialog: { ...s.prDialog, statusLoading: true } }));
    try {
      // Compare against the REMOTE ref so we see the same commits the PR
      // tool will. Comparing against the local copy of base lies when
      // `origin/main` has commits the user hasn't pulled yet.
      const { behind, ahead } = await gitApi.behindAhead(
        repoPath,
        `origin/${base}`,
        head,
      );
      set((s) => ({
        prDialog: { ...s.prDialog, behind, ahead, statusLoading: false },
      }));
    } catch (err) {
      set((s) => ({
        prDialog: {
          ...s.prDialog,
          statusLoading: false,
          statusError: err instanceof Error ? err.message : String(err),
        },
      }));
    }
  },

  prDialogRebase: async () => {
    const state = get();
    const repoPath = state.repository?.path;
    const base = state.prDialog.base;
    if (!repoPath || !base) return;
    set((s) => ({
      prDialog: { ...s.prDialog, statusLoading: true, statusError: null },
    }));
    try {
      await runWithAutoStash(get, repoPath, () =>
        gitApi.rebaseOnto(repoPath, `origin/${base}`),
      );
      get().pushToast(`Rebased onto origin/${base}`);
      await get().refresh();
      await get().refreshPrDialogStatus();
    } catch (err) {
      set((s) => ({
        prDialog: {
          ...s.prDialog,
          statusLoading: false,
          statusError: err instanceof Error ? err.message : String(err),
        },
      }));
    }
  },

  prDialogMerge: async () => {
    const state = get();
    const repoPath = state.repository?.path;
    const base = state.prDialog.base;
    if (!repoPath || !base) return;
    set((s) => ({
      prDialog: { ...s.prDialog, statusLoading: true, statusError: null },
    }));
    try {
      await runWithAutoStash(get, repoPath, () =>
        gitApi.mergeInto(repoPath, `origin/${base}`),
      );
      get().pushToast(`Merged origin/${base} into current branch`);
      await get().refresh();
      await get().refreshPrDialogStatus();
    } catch (err) {
      set((s) => ({
        prDialog: {
          ...s.prDialog,
          statusLoading: false,
          statusError: err instanceof Error ? err.message : String(err),
        },
      }));
    }
  },

  prDialogSkipBehind: () =>
    set((s) => ({ prDialog: { ...s.prDialog, ignoreBehind: true } })),

  resetPrFlow: () =>
    set({
      prFlow: { state: "idle", message: "", url: null, error: null },
    }),

  createPr: async ({ newBranchName, baseBranch }) => {
    const startState = get();
    if (!startState.repository) return;
    if (startState.prFlow.state === "running") return;
    // Remember the chosen base for this repo so the dialog defaults to it
    // next time — solo dev → main, GitFlow repo → develop, etc.
    const repoPathForPersist = startState.repository.path;
    set((s) => ({
      settings: {
        ...s.settings,
        lastPrBaseByRepo: {
          ...s.settings.lastPrBaseByRepo,
          [repoPathForPersist]: baseBranch,
        },
      },
    }));
    writeSettings(get().settings);

    const repoPath = startState.repository.path;
    const setStep = (message: string) =>
      set((s) => ({
        prFlow: { ...s.prFlow, state: "running", message },
      }));
    const fail = (error: string) =>
      set({
        prFlow: { state: "error", message: "", url: null, error },
      });

    set({
      prBranchChoiceOpen: false,
      prFlow: { state: "running", message: "Checking gh CLI…", url: null, error: null },
    });

    try {
      // 1) gh installed + authenticated? Fail early — no point in pushing
      //    a branch we can't open a PR from.
      const gh = await gitApi.ghDetectStatus();
      if (!gh.installed) {
        fail("`gh` CLI not found. Install with `brew install gh`, then run `gh auth login`.");
        return;
      }
      if (!gh.authenticated) {
        fail("`gh` is installed but not authenticated. Run `gh auth login` in a terminal.");
        return;
      }

      // 2) Pre-flight: refuse to even try when head == base. `gh pr create`
      //    errors out late ("head branch 'main' is the same as base branch
      //    'main'") and by then we've already done useless work. Base
      //    comes from the dialog now — no more "Resolving default branch…"
      //    step because the user already picked one explicitly.
      const currentBranch = get().repository?.currentBranch ?? "";
      const headBranch = newBranchName?.trim() || currentBranch;
      if (headBranch === baseBranch) {
        fail(
          `Can't open a PR from '${headBranch}' into itself. Pick "Create new branch" or change the base in the dialog.`,
        );
        return;
      }

      // 3) Optionally create + checkout a new branch.
      if (newBranchName) {
        setStep(`Creating branch ${newBranchName}…`);
        await gitApi.createBranch(repoPath, newBranchName);
        await get().refresh();
      }

      // 4) Commit any pending changes. Stage everything first so the AI
      //    sees the full picture, then commit. Skip if working tree clean
      //    AND there are unpushed commits to PR — gh will still find them.
      const filesAfterMaybeBranch = get().files;
      const hasChanges = filesAfterMaybeBranch.length > 0;
      if (hasChanges) {
        const unstaged = filesAfterMaybeBranch
          .filter((f) => !f.staged)
          .map((f) => f.path);
        if (unstaged.length > 0) {
          setStep("Staging changes…");
          await gitApi.stagePaths(repoPath, unstaged);
        }

        setStep("Drafting commit message with AI…");
        const cli = await resolveAvailableCli(get, set);
        if (!cli) {
          fail("No AI CLI detected. Install Claude Code or Codex CLI and pick one in Preferences → AI.");
          return;
        }
        const commitUserPrompt = get().settings.aiSystemPrompts.commit ?? "";
        const commitPrompt = await buildPromptForKind(
          "commit",
          repoPath,
          commitUserPrompt,
        );
        const commitMessage = stripOuterCodeFence(
          (await aiApi.runAiCli(cli.id, commitPrompt, repoPath)).trim(),
        ).trim();
        if (!commitMessage) {
          fail("AI returned an empty commit message — refusing to commit.");
          return;
        }

        setStep("Committing…");
        await gitApi.commit(repoPath, commitMessage);
        await get().refresh();
      }

      // 5) Push (with -u when there's no upstream yet — typical for a
      //    freshly created branch).
      setStep("Pushing to remote…");
      try {
        await gitApi.push(repoPath);
      } catch (pushErr) {
        const m = pushErr instanceof Error ? pushErr.message : String(pushErr);
        if (/no upstream branch|--set-upstream/i.test(m)) {
          await gitApi.push(repoPath, true);
        } else {
          throw pushErr;
        }
      }

      // 6) Draft PR title + body via AI (separate from commit message —
      //    the PR description summarizes the whole branch, not one commit).
      setStep("Drafting PR description with AI…");
      const cli = await resolveAvailableCli(get, set);
      if (!cli) {
        fail("AI CLI vanished mid-flow — check Preferences → AI.");
        return;
      }
      const prUserPrompt = get().settings.aiSystemPrompts.pr ?? "";
      const prPrompt = await buildPromptForKind("pr", repoPath, prUserPrompt);
      const prRaw = stripOuterCodeFence(
        (await aiApi.runAiCli(cli.id, prPrompt, repoPath)).trim(),
      ).trim();
      if (!prRaw) {
        fail("AI returned an empty PR description.");
        return;
      }
      // Split the AI output into title (first usable line) + body. The
      // prompt asks for "title on line 1, blank, then ## Summary / ## Why
      // / ## Test plan", but models still sometimes lead with a bare
      // section heading like "## Summary". When that happens the
      // historical parser would strip the `#` and ship a PR titled
      // "Summary" — useless. Skip past anything that's obviously a
      // section heading and find the first real sentence.
      const SECTION_HEADERS = new Set([
        "summary",
        "description",
        "changes",
        "overview",
        "why",
        "what",
        "test plan",
        "test-plan",
        "testing",
        "details",
        "context",
        "background",
        "motivation",
      ]);
      const isSectionHeading = (s: string): boolean => {
        // Strip markdown heading markers AND any leading/trailing
        // punctuation so "## Summary:" → "summary" before the check.
        const stripped = s
          .replace(/^#+\s*/, "")
          .replace(/[:.\s]+$/g, "")
          .trim()
          .toLowerCase();
        return SECTION_HEADERS.has(stripped);
      };
      const lines = prRaw.split(/\r?\n/);
      let title = "";
      let bodyStart = 0;
      for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        if (t.length === 0) continue;
        if (isSectionHeading(t)) continue;
        title = t.replace(/^#+\s*/, "");
        bodyStart = i + 1;
        break;
      }
      // gh enforces title length but cuts off mid-word silently — clamp
      // ourselves with an ellipsis so the user sees the truncation.
      if (title.length > 100) {
        title = title.slice(0, 97).trimEnd() + "…";
      }
      const body = lines.slice(bodyStart).join("\n").trim();
      if (!title) {
        fail("Couldn't parse a PR title from the AI output.");
        return;
      }

      // 7) Finally — create the PR. gh resolves the head branch from the
      //    current checkout when --head is omitted.
      setStep(`Opening PR against ${baseBranch}…`);
      const url = await gitApi.ghPrCreate({
        repoPath,
        title,
        body,
        base: baseBranch,
      });

      set({
        prFlow: {
          state: "done",
          message: `Created PR · ${title}`,
          url,
          error: null,
        },
      });
      get().pushToast(`Opened PR: ${title}`);
      await get().refresh();
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  },

  setFirstRunCompleted: (v) => {
    set((s) => {
      const next = { ...s.settings, firstRunCompleted: v };
      writeSettings(next);
      return { settings: next };
    });
  },

  toggleReviewed: (path) => {
    const repo = get().repository;
    if (!repo) return;
    const next = new Set(get().reviewedPaths);
    let nowReviewed: boolean;
    if (next.has(path)) {
      next.delete(path);
      nowReviewed = false;
    } else {
      next.add(path);
      nowReviewed = true;
    }
    saveReviewed(repo.path, next);
    set((s) => ({
      reviewedPaths: next,
      files: s.files.map((f) =>
        f.path === path ? { ...f, reviewed: nowReviewed } : f,
      ),
    }));
  },

  toggleReviewedMany: (paths) => {
    const repo = get().repository;
    if (!repo || paths.length === 0) return;
    const current = get().reviewedPaths;
    // If everything in the selection is already reviewed, treat the action
    // as "unmark all"; otherwise mark all reviewed (covers the common case
    // of selecting a mixed set + wanting to check them off).
    const allReviewed = paths.every((p) => current.has(p));
    const next = new Set(current);
    for (const p of paths) {
      if (allReviewed) next.delete(p);
      else next.add(p);
    }
    saveReviewed(repo.path, next);
    const target = !allReviewed;
    const targetSet = new Set(paths);
    set((s) => ({
      reviewedPaths: next,
      files: s.files.map((f) =>
        targetSet.has(f.path) ? { ...f, reviewed: target } : f,
      ),
    }));
  },

  setMultiSelection: (paths, anchor) =>
    set({
      multiSelection: new Set(paths),
      multiSelectAnchor: anchor,
    }),

  toggleMultiSelection: (path, anchor) =>
    set((s) => {
      const next = new Set(s.multiSelection);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return { multiSelection: next, multiSelectAnchor: anchor };
    }),

  clearMultiSelection: () =>
    set({ multiSelection: new Set(), multiSelectAnchor: null }),

  toggleStage: async (path) => {
    const state = get();
    if (!state.repository) return;
    const file = state.files.find((f) => f.path === path);
    if (!file) return;
    try {
      if (file.staged) {
        await gitApi.unstageFile(state.repository.path, path);
        get().pushToast(`Unstaged ${path}`);
      } else {
        await gitApi.stageFile(state.repository.path, path);
        get().pushToast(`Staged ${path}`);
      }
      await get().refresh();
    } catch (err) {
      set({ errorMessage: err instanceof Error ? err.message : String(err) });
    }
  },

  stageMany: async (paths) => {
    const state = get();
    if (!state.repository || paths.length === 0) return;
    try {
      await gitApi.stagePaths(state.repository.path, paths);
      get().pushToast(
        `Staged ${paths.length} file${paths.length === 1 ? "" : "s"}`,
      );
      await get().refresh();
    } catch (err) {
      set({ errorMessage: err instanceof Error ? err.message : String(err) });
    }
  },

  unstageMany: async (paths) => {
    const state = get();
    if (!state.repository || paths.length === 0) return;
    try {
      await gitApi.unstagePaths(state.repository.path, paths);
      get().pushToast(
        `Unstaged ${paths.length} file${paths.length === 1 ? "" : "s"}`,
      );
      await get().refresh();
    } catch (err) {
      set({ errorMessage: err instanceof Error ? err.message : String(err) });
    }
  },

  applyHunkPatch: async (patch, reverse, label) => {
    const state = get();
    if (!state.repository) return;
    try {
      await gitApi.applyPatch(state.repository.path, patch, reverse);
      get().pushToast(label);
      await get().refresh();
    } catch (err) {
      set({ errorMessage: err instanceof Error ? err.message : String(err) });
    }
  },

  requestRevertHunk: (patch, hunkIdx, filePath) => {
    const state = get();
    if (!state.repository) return;
    set({
      confirm: {
        title: `Revert hunk #${hunkIdx + 1}?`,
        body: `This permanently discards the working-tree changes for this hunk in ${filePath}. It can't be undone from Squint.`,
        confirmLabel: "Revert",
        danger: true,
        onConfirm: async () => {
          const repo = get().repository;
          if (!repo) return;
          try {
            await gitApi.applyPatch(repo.path, patch, true, "workdir");
            get().pushToast(`Reverted hunk #${hunkIdx + 1}`, "danger");
            set({ confirm: null });
            await get().refresh();
          } catch (err) {
            set({
              errorMessage:
                err instanceof Error ? err.message : String(err),
              confirm: null,
            });
          }
        },
      },
    });
  },

  applyHunkPatchAndCommit: async (patch, reverse, message, label) => {
    const state = get();
    if (!state.repository) return;
    const trimmed = message.trim();
    if (!trimmed) {
      set({ errorMessage: "Commit message is empty" });
      return;
    }
    try {
      await gitApi.applyPatch(state.repository.path, patch, reverse);
      await gitApi.commit(state.repository.path, trimmed);
      get().pushToast(label);
      await get().refresh();
    } catch (err) {
      set({ errorMessage: err instanceof Error ? err.message : String(err) });
    }
  },

  requestDiscardMany: (paths) => {
    const state = get();
    if (!state.repository || paths.length === 0) return;
    const count = paths.length;
    set({
      confirm: {
        title: `Discard ${count} file${count === 1 ? "" : "s"}?`,
        body: `This permanently reverts the working-tree changes for ${count} file${count === 1 ? "" : "s"}. Untracked files will be deleted. It can't be undone from Squint.`,
        confirmLabel: "Discard all",
        danger: true,
        onConfirm: async () => {
          const repo = get().repository;
          if (!repo) return;
          try {
            await gitApi.discardPaths(repo.path, paths);
            get().pushToast(
              `Discarded ${count} file${count === 1 ? "" : "s"}`,
              "danger",
            );
            // Clear any stale in-memory edit buffers for these paths — the
            // file on disk has changed, so the next "Edit" should re-read.
            clearEditBuffers(set, paths);
            set({ confirm: null });
            await get().refresh();
          } catch (err) {
            set({
              errorMessage: err instanceof Error ? err.message : String(err),
              confirm: null,
            });
          }
        },
      },
    });
  },

  requestDiscard: (path) => {
    const state = get();
    if (!state.repository) return;
    const file = state.files.find((f) => f.path === path);
    if (!file) return;
    set({
      confirm: {
        title: `Discard changes to ${path}?`,
        body: `This permanently removes ${file.additions + file.deletions} line changes in this file. It can't be undone from Squint.`,
        confirmLabel: "Discard changes",
        danger: true,
        onConfirm: async () => {
          const repo = get().repository;
          if (!repo) return;
          try {
            await gitApi.discardFile(repo.path, path);
            get().pushToast(`Discarded ${path}`, "danger");
            clearEditBuffers(set, [path]);
            set({ confirm: null });
            await get().refresh();
          } catch (err) {
            set({
              errorMessage:
                err instanceof Error ? err.message : String(err),
              confirm: null,
            });
          }
        },
      },
    });
  },

  openInVscode: async (path) => {
    const state = get();
    if (!state.repository) return;
    try {
      await gitApi.openInVscode(state.repository.path, path);
      get().pushToast(`Opening ${path} in VS Code…`);
    } catch (err) {
      set({ errorMessage: err instanceof Error ? err.message : String(err) });
    }
  },

  openProjectInVscode: async () => {
    const state = get();
    if (!state.repository) return;
    // Prefer the user-selected editor when set; otherwise fall back to the
    // first detected (preferredEditor is hydrated lazily on the first
    // fetchEditors call).
    const editorId =
      state.settings.preferredEditor ?? state.editors[0]?.id ?? "vscode";
    return get().openProjectInEditor(editorId);
  },

  fetchEditors: async () => {
    const state = get();
    if (state.editors.length > 0) return;
    try {
      const editors = await gitApi.detectEditors();
      set({ editors });
      // Hydrate the preferred editor if the user hasn't picked one yet.
      if (
        !state.settings.preferredEditor &&
        editors.length > 0
      ) {
        get().setPreferredEditor(editors[0].id);
      }
    } catch {
      /* non-fatal — button just won't show options */
    }
  },

  setEditorMenuOpen: (editorMenuOpen) => set({ editorMenuOpen }),
  setGitMenuOpen: (gitMenuOpen) => set({ gitMenuOpen }),

  setPreferredEditor: (id) => {
    set((s) => {
      const next = { ...s.settings, preferredEditor: id };
      writeSettings(next);
      return { settings: next };
    });
  },

  openProjectInEditor: async (editorId) => {
    const state = get();
    if (!state.repository) return;
    try {
      await gitApi.openInEditor(editorId, state.repository.path, "");
      const editor = state.editors.find((e) => e.id === editorId);
      get().pushToast(
        `Opening ${state.repository.name} in ${editor?.name ?? editorId}…`,
      );
    } catch (err) {
      set({ errorMessage: err instanceof Error ? err.message : String(err) });
    }
  },
}));

export function getLastRepoPath(): string | null {
  return readLastRepoPath();
}
