import { create } from "zustand";
import type { Repository } from "./repository.types";
import type {
  BranchInfo,
  ChangedFile,
  ExternalEditor,
  StashEntry,
} from "@/features/git/git.types";
import * as gitApi from "@/features/git/git.api";
import * as repoApi from "./repository.api";
import * as searchApi from "@/features/search/search.api";
import * as aiApi from "@/features/ai/ai.api";
import type { AiCliInfo, AiResult } from "@/features/ai/ai.types";
import type {
  SearchResult,
  SearchScope,
} from "@/features/search/search.types";
import type { AiKind } from "@/features/ai/ai.types";
import type { ToastKind, ToastMessage } from "@/components/Toast";
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
  type EditorCursor,
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
  type FontPreset,
  type MonoPreset,
  type Theme,
} from "@/lib/theme";

export type StatusFilter =
  | "all"
  | ChangedFile["status"];

export type SidebarTab = "changes" | "files" | "search";

export type DiffMode = "sbs" | "inline" | "edit";

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
  gitOpLoading: "push" | "pull" | "fetch" | "undo" | null;
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
  repoFiles: string[];
  repoFilesLoading: boolean;
  branches: BranchInfo[];
  branchesLoading: boolean;
  branchMenuOpen: boolean;
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

  loading: boolean;
  errorMessage: string | null;
  confirm: ConfirmRequest | null;
  toasts: ToastMessage[];

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
  setEditorCursor: (value: EditorCursor) => void;
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
  setSettingsOpen: (open: boolean) => void;
  setShortcutsOpen: (open: boolean) => void;
  setOnboardingOpen: (open: boolean) => void;
  setRepoMenuOpen: (open: boolean) => void;
  forgetRecent: (path: string) => void;
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
  checkoutBranch: (name: string) => Promise<void>;
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
  /** `git reset --soft HEAD~1` — keeps the changes staged so the user can
   *  re-edit the message in the composer and commit again. */
  gitUndoLastCommit: () => Promise<void>;
  /** Open the "use current branch / create new branch" dialog. */
  openPrBranchChoice: () => void;
  /** Close the branch-choice dialog without starting anything. */
  closePrBranchChoice: () => void;
  /** Reset the PR-flow modal back to idle (and clear url/error). */
  resetPrFlow: () => void;
  /**
   * Run the end-to-end "Create PR" pipeline:
   *   - optionally create + checkout a new branch from current
   *   - commit any uncommitted changes (AI-generated message if textarea empty)
   *   - push (with -u when needed)
   *   - generate PR title + body via AI
   *   - call `gh pr create` against the repo's default branch
   *   - stream human-readable progress into `prFlow.message`
   *
   * `newBranchName` is supplied by the dialog when the user picks "Create
   * new branch"; pass null to use the current branch as-is.
   */
  createPr: (opts: { newBranchName: string | null }) => Promise<void>;
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

function reviewedStorageKey(repoPath: string): string {
  return `ai-code-review:reviewed:${repoPath}`;
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
 *   3. **Fall back to the first installed CLI** when the saved preference
 *      points at something that isn't on disk (e.g. user uninstalled
 *      Claude Code, or switched machines) — and persist that fallback so
 *      future runs go straight through.
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
 * Compose the prompt sent to the user's AI CLI for a given action. Kept on
 * the renderer side (vs the Rust layer) so we can iterate on wording without
 * recompiling the backend.
 */
async function buildPromptForKind(
  kind: AiKind,
  repoPath: string,
  userPrompt: string,
): Promise<string> {
  // Cap the diff at ~120kB so we don't blow the CLI's prompt budget. Most
  // real review chunks are well under this.
  const MAX_DIFF_BYTES = 120_000;
  const truncate = (s: string) =>
    s.length > MAX_DIFF_BYTES
      ? s.slice(0, MAX_DIFF_BYTES) +
        `\n\n[…truncated ${s.length - MAX_DIFF_BYTES} bytes]`
      : s;
  // Prepend the user's custom instructions when set. Goes above the
  // built-in defaults so the user can ADD on top of (or override implicitly
  // through emphasis) without rewriting the entire prompt.
  const prepend = (lines: string[]): string[] => {
    const trimmed = userPrompt.trim();
    if (!trimmed) return lines;
    return ["USER INSTRUCTIONS:", trimmed, "", ...lines];
  };

  switch (kind) {
    case "commit": {
      const diff = await aiApi.getDiffForAi(repoPath, "staged");
      return prepend([
        "Write a concise conventional-style commit message for the following diff.",
        "Output ONLY the commit message (subject + optional body), no explanation, no Markdown fences.",
        "",
        "DIFF:",
        truncate(diff),
      ]).join("\n");
    }
    case "pr": {
      const [log, diff] = await Promise.all([
        aiApi.getLogForAi(repoPath, "branch"),
        aiApi.getDiffForAi(repoPath, "branch"),
      ]);
      return prepend([
        "Draft a pull-request description in Markdown for the changes below.",
        "Use sections: ## Summary, ## Why, ## Test plan. Be specific and grounded in the diff.",
        "",
        "COMMITS:",
        log.trim() || "(no commit history available)",
        "",
        "DIFF:",
        truncate(diff),
      ]).join("\n");
    }
    case "summary": {
      const diff = await aiApi.getDiffForAi(repoPath, "working");
      return prepend([
        "Summarize the following diff in 4–8 bullet points.",
        "Focus on user-visible behavior and architectural changes; ignore noise like formatting.",
        "",
        "DIFF:",
        truncate(diff),
      ]).join("\n");
    }
    case "risk": {
      const diff = await aiApi.getDiffForAi(repoPath, "working");
      return prepend([
        "Review the following diff for bugs, regressions, and risky changes.",
        "Output a Markdown list — for each issue include the file/line and a one-sentence rationale.",
        "If nothing material stands out, say so explicitly.",
        "",
        "DIFF:",
        truncate(diff),
      ]).join("\n");
    }
  }
}


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
  repoFiles: [],
  repoFilesLoading: false,
  branches: [],
  branchesLoading: false,
  branchMenuOpen: false,
  stashes: [],
  stashesLoading: false,
  pendingStashCheckout: null,
  editors: [],
  editorMenuOpen: false,
  gitMenuOpen: false,

  loading: false,
  errorMessage: null,
  confirm: null,
  toasts: [],

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
  setEditorCursor: (editorCursor) => {
    set((s) => {
      const next = { ...s.settings, editorCursor };
      writeSettings(next);
      // Drive the CSS via a data attribute so the rule lives in index.css.
      document.documentElement.setAttribute("data-editor-cursor", editorCursor);
      return { settings: next };
    });
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
    const cliId = state.settings.preferredAiCli;
    const cli = cliId
      ? state.aiCliList.find((c) => c.id === cliId && c.available)
      : null;
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
      const raw = await aiApi.runAiCli(cli.id, prompt, repoPath);
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
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
  setOnboardingOpen: (onboardingOpen) => set({ onboardingOpen }),
  setRepoMenuOpen: (repoMenuOpen) => set({ repoMenuOpen }),
  forgetRecent: (path) => {
    set({ recentRepos: removeRecentRepo(path) });
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
    set({ loading: true, errorMessage: null });
    try {
      const [rawFiles, currentBranch] = await Promise.all([
        gitApi.getRepoStatus(repo.path),
        gitApi.getCurrentBranch(repo.path),
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
        repository: { ...repo, currentBranch },
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

  setBranchMenuOpen: (branchMenuOpen) => set({ branchMenuOpen }),

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

  cancelPendingStashCheckout: () => set({ pendingStashCheckout: null }),

  confirmStashAndCheckout: async (message, includeUntracked) => {
    const state = get();
    if (!state.repository || !state.pendingStashCheckout) return;
    const target = state.pendingStashCheckout.target;
    try {
      await gitApi.stashPush(state.repository.path, message, includeUntracked);
      get().pushToast(`Stashed: ${message}`);
      set({ pendingStashCheckout: null });
      await gitApi.checkoutBranch(state.repository.path, target);
      get().pushToast(`Switched to ${target}`);
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
      // Default to the first available CLI if the user hasn't picked one.
      const cur = state.settings.preferredAiCli;
      const validCurrent =
        cur != null && list.some((c) => c.id === cur && c.available);
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
    } catch (err) {
      set({ errorMessage: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ gitOpLoading: null });
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

  openPrBranchChoice: () => set({ prBranchChoiceOpen: true }),
  closePrBranchChoice: () => set({ prBranchChoiceOpen: false }),
  resetPrFlow: () =>
    set({
      prFlow: { state: "idle", message: "", url: null, error: null },
    }),

  createPr: async ({ newBranchName }) => {
    const startState = get();
    if (!startState.repository) return;
    if (startState.prFlow.state === "running") return;

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

      // 2) Resolve the base branch (PR target).
      setStep("Resolving default branch…");
      const baseBranch = await gitApi.defaultBranch(repoPath);

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
        const commitMessage = (
          await aiApi.runAiCli(cli.id, commitPrompt, repoPath)
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
      const prRaw = (await aiApi.runAiCli(cli.id, prPrompt, repoPath)).trim();
      if (!prRaw) {
        fail("AI returned an empty PR description.");
        return;
      }
      // Split the AI output into title (first non-empty line) + body
      // (everything after). Strips a leading `# ` if the AI gave it as
      // an H1 — gh treats title as plain text.
      const lines = prRaw.split(/\r?\n/);
      let title = "";
      let bodyStart = 0;
      for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        if (t.length === 0) continue;
        title = t.replace(/^#+\s*/, "");
        bodyStart = i + 1;
        break;
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
        body: `This permanently discards the working-tree changes for this hunk in ${filePath}. It can't be undone from Review Desk.`,
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
        body: `This permanently reverts the working-tree changes for ${count} file${count === 1 ? "" : "s"}. Untracked files will be deleted. It can't be undone from Review Desk.`,
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
        body: `This permanently removes ${file.additions + file.deletions} line changes in this file. It can't be undone from Review Desk.`,
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
