import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { BTN_GHOST } from "@/lib/btn";
import { useRepoStore } from "@/features/repository/repository.store";
import {
  getFileDiff,
  peekCachedFileDiff,
  readWorkingFile,
} from "@/features/git/git.api";
import type { ChangedFile, DiffResult, Hunk } from "@/features/git/git.types";
import {
  parseUnifiedDiff,
  syntheticAddedHunk,
  syntheticDeletedHunk,
} from "@/lib/parse-diff";
import { buildPatch } from "@/lib/patch";
import { buildSections } from "@/lib/sections";
import {
  buildLineHighlights,
  buildSearchRegex,
  findInSections,
  findInValue,
  valueLineHighlights,
  type LineHighlightMap,
} from "@/lib/find-in-diff";
import { cn, detectLanguage } from "@/lib/utils";
import { I, STATUS_META } from "./icons";
import { Spinner } from "./spinner";
import { Kbd } from "./kbd";
import { DiffSideBySide } from "./diff-side-by-side";
import { DiffInline } from "./diff-inline";
import { DiffEditor, type DiffEditorHandle } from "./diff-editor";
import {
  InFileSearchBar,
  type InFileSearchBarHandle,
} from "./in-file-search-bar";
import { HunkStagePopover } from "./hunk-stage-popover";
import { BinaryPreviewPane } from "./binary-preview-pane";

const EMPTY_HIGHLIGHTS: LineHighlightMap = new Map();

// ----- shared style fragments ------------------------------------------------
// Pulled out so the same look is one edit. None of these are component
// boundaries on their own — they're just reused class strings.

const DIFFPANE_ROOT =
  "flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden bg-bg-0";

const DIFF_HEADER =
  "h-9 flex items-center gap-2.5 px-3 border-b border-bd-1 shrink-0 bg-bg-1";

const DIFF_BODY_WRAP = "relative flex flex-col flex-1 min-h-0";
const DIFF_BODY =
  // `select-text` opts back in to text selection — the body sets
  // `user-select: none` globally so menus / tabs / sidebar items don't
  // accidentally highlight, but the code in the editor obviously should.
  "flex-1 overflow-auto bg-bg-0 select-text " +
  "[scrollbar-width:thin] [scrollbar-color:var(--bd-2)_transparent] " +
  "[&::-webkit-scrollbar]:w-2.5 [&::-webkit-scrollbar]:h-2.5 " +
  "[&::-webkit-scrollbar-thumb]:bg-bd-2 [&::-webkit-scrollbar-thumb]:rounded-[5px] " +
  "[&::-webkit-scrollbar-thumb]:border-2 [&::-webkit-scrollbar-thumb]:border-bg-0";

const DIFF_FOOTER =
  "h-6 flex items-center gap-2 px-3.5 border-t border-bd-1 text-[10.5px] " +
  "bg-bg-1 text-fg-2 font-mono shrink-0";

const DIFF_EMPTY = "h-full grid place-content-center text-center gap-2 p-10";

// Loading / empty / binary-file placeholder card used for the centered
// "Reading file…" / "Binary file" / "This file is empty" states inside
// the diff body. Same shape across all three so the layout doesn't reflow
// when state flips.
const FILE_LOADING =
  "grid place-items-center h-full gap-3 grid-flow-row p-10 text-center text-[12px] text-fg-3";
const FL_TITLE = "text-[14px] text-fg-1 font-medium";
const FL_SUB = "text-[12px] text-fg-2";

// Tiny "Re-read from disk" action in the diff footer. Subtle hover tint
// rather than a full ghost button — fits next to the LF / UTF-8 chips.
const FOOTER_ACTION =
  "font-mono text-[10.5px] text-fg-3 px-1.5 py-px rounded-[3px] " +
  "bg-transparent border-0 cursor-pointer " +
  "hover:text-accent hover:bg-accent-soft";

// Segmented control (sbs/inline/edit + full/hunks toggles). Icon-only here.
const SEG_GROUP =
  "inline-flex bg-bg-2 border border-bd-1 rounded-2 p-0.5 gap-0.5";
const SEG_BTN_BASE =
  "grid place-items-center w-[26px] h-[22px] rounded text-fg-2 " +
  "hover:text-fg-0 [&_svg]:h-[13px] [&_svg]:w-[13px]";
const SEG_BTN_ACTIVE =
  "bg-bg-4 text-fg-0 shadow-[0_1px_0_rgba(0,0,0,0.3)] " +
  "[:root[data-theme='light']_&]:bg-bg-0 " +
  "[:root[data-theme='light']_&]:shadow-[0_1px_2px_rgba(0,0,0,0.06)]";

export function DiffPane() {
  const repo = useRepoStore((s) => s.repository);
  const selectedFilePath = useRepoStore((s) => s.selectedFilePath);
  const selectedFileStaged = useRepoStore((s) => s.selectedFileStaged);
  const files = useRepoStore((s) => s.files);
  const diffMode = useRepoStore((s) => s.diffMode);
  const setDiffMode = useRepoStore((s) => s.setDiffMode);
  const setDiffExpansion = useRepoStore((s) => s.setDiffExpansion);
  const setError = useRepoStore((s) => s.setError);
  // Per-path subscription: only re-render this pane when the *current*
  // file's buffer changes, not when any other open file's edits change.
  const editValue = useRepoStore((s) =>
    selectedFilePath ? s.edits[selectedFilePath] : undefined,
  );
  const savedValue = useRepoStore((s) =>
    selectedFilePath ? s.savedEdits[selectedFilePath] : undefined,
  );
  const setEdit = useRepoStore((s) => s.setEdit);
  const loadEditBuffer = useRepoStore((s) => s.loadEditBuffer);
  const applyHunkPatch = useRepoStore((s) => s.applyHunkPatch);
  const applyHunkPatchAndCommit = useRepoStore(
    (s) => s.applyHunkPatchAndCommit,
  );
  const generateHunkCommitDraft = useRepoStore(
    (s) => s.generateHunkCommitDraft,
  );
  const requestRevertHunk = useRepoStore((s) => s.requestRevertHunk);
  const diffExpansion = useRepoStore((s) => s.settings.diffExpansion);

  const inFileSearchOpen = useRepoStore((s) => s.inFileSearchOpen);
  const setInFileSearchOpen = useRepoStore((s) => s.setInFileSearchOpen);
  const inFileSearchNonce = useRepoStore((s) => s.inFileSearchNonce);

  // Memoize the file lookup so subsequent renders return the SAME reference
  // when the underlying entry hasn't changed. Without this, every render
  // recomputes `files.find(...)` and produces a fresh object identity, which
  // cascades into our `hunks` / `sections` useMemos invalidating — meaning
  // we'd re-parse the diff and re-build sections on every keystroke or
  // unrelated store update.
  const file = useMemo(
    () =>
      files.find(
        (f) => f.path === selectedFilePath && f.staged === selectedFileStaged,
      ) ?? null,
    [files, selectedFilePath, selectedFileStaged],
  );
  /** A path was chosen (likely via the tree or ⌘P) but it isn't a changed file. */
  const isUnchangedView = selectedFilePath != null && file == null;

  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [loading, setLoading] = useState(false);

  // In-file search state (local — only the open flag is shared with the store).
  const [searchQuery, setSearchQuery] = useState("");
  const [searchCS, setSearchCS] = useState(false);
  const [searchRegex, setSearchRegex] = useState(false);
  const [searchIdx, setSearchIdx] = useState(0);

  // Per-hunk staging popover state — null when closed.
  const [pendingHunk, setPendingHunk] = useState<{
    hunkIdx: number;
    busy: boolean;
  } | null>(null);
  // When the working-file read fails with "Cannot edit a binary file" we
  // remember the path here and render an inline empty state in FilePane
  // instead of surfacing the error to the global banner — opening a binary
  // file isn't an error, it's just not editable.
  const [binaryPath, setBinaryPath] = useState<string | null>(null);
  // Hunks the user has collapsed via the header chevron.
  const [collapsedHunks, setCollapsedHunks] = useState<Set<number>>(
    () => new Set(),
  );
  // Stable identity → lets `DiffSideBySide` / `DiffInline` stay memoized
  // across DiffPane re-renders that didn't touch the diff content.
  const toggleHunkCollapsed = useCallback((hi: number) => {
    setCollapsedHunks((prev) => {
      const next = new Set(prev);
      if (next.has(hi)) next.delete(hi);
      else next.add(hi);
      return next;
    });
  }, []);

  const searchBarRef = useRef<InFileSearchBarHandle | null>(null);
  const editorRef = useRef<DiffEditorHandle | null>(null);
  const diffBodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!repo || !file) {
      setDiff(null);
      return;
    }
    let cancelled = false;
    const path = file.path;
    const staged = file.staged;
    // Synchronous cache peek so holding ⌥↓ doesn't flash the "Loading…"
    // skeleton on every step when the next file is already warm from
    // `selectAdjacentFile`'s prefetch window. The cache lives in the
    // git.api module so it survives unmounts of this pane.
    const cached = peekCachedFileDiff(repo.path, path, staged);
    if (cached) {
      setDiff(cached);
      setLoading(false);
      return;
    }
    setLoading(true);
    getFileDiff(repo.path, path, staged)
      .then((d) => {
        if (!cancelled) setDiff(d);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `file` itself is a fresh `.find(...)` reference on every render —
    // depending on it would re-fetch the diff on unrelated re-renders.
    // The path + staged tuple is what actually changes.
  }, [repo, file?.path, file?.staged, setError]);

  // Editor buffer for changed files in `edit` mode, or any file in unchanged
  // view. We prime both `edits` and `savedEdits` so the freshly-loaded file
  // isn't immediately considered dirty.
  useEffect(() => {
    if (!repo || !selectedFilePath) return;
    if (!isUnchangedView && diffMode !== "edit") return;
    // New path — clear any previous binary marker so we don't stick the
    // empty state on an unrelated file.
    if (binaryPath != null && binaryPath !== selectedFilePath) {
      setBinaryPath(null);
    }
    // Already classified this path as binary — skip the re-read so we
    // don't loop on the same error every render of this effect.
    if (binaryPath === selectedFilePath) return;
    if (editValue != null) return;
    let cancelled = false;
    readWorkingFile(repo.path, selectedFilePath)
      .then((content) => {
        if (!cancelled) loadEditBuffer(selectedFilePath, content);
      })
      .catch((err) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        // "Cannot edit a binary file" is expected for keystores, images,
        // archives, etc. — don't blare a global error, just mark the path
        // so FilePane can render a friendly inline state.
        if (msg.toLowerCase().includes("binary")) {
          setBinaryPath(selectedFilePath);
        } else {
          setError(msg);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    repo,
    selectedFilePath,
    isUnchangedView,
    diffMode,
    editValue,
    loadEditBuffer,
    setError,
    binaryPath,
  ]);

  // useDeferredValue: when the user holds ⌥↓ at 30Hz, `diff` flips
  // every ~33ms. Computing hunks/sections + rendering the SbsCell tree
  // for a 2000-line file takes 100ms+, which would block the next file
  // switch's React reconciliation. By deferring `diff` here, React is
  // free to abandon an in-progress diff-body render the moment a new
  // file is selected — only the latest one actually commits to the
  // DOM. The selected row in the sidebar still updates on the urgent
  // pass, so the focus indicator tracks the user's keys without lag.
  const deferredDiff = useDeferredValue(diff);
  const hunks: Hunk[] = useMemo(() => {
    if (!deferredDiff || !file) return [];
    const parsed = parseUnifiedDiff(deferredDiff.diffText);
    if (parsed.length > 0) return parsed;
    if (file.status === "added" || file.status === "untracked") {
      if (deferredDiff.newContent)
        return [syntheticAddedHunk(deferredDiff.newContent)];
    }
    if (file.status === "deleted") {
      if (deferredDiff.oldContent)
        return [syntheticDeletedHunk(deferredDiff.oldContent)];
    }
    return [];
  }, [deferredDiff, file]);

  const sections = useMemo(() => {
    if (!file || !deferredDiff) return [];
    return buildSections(
      hunks,
      deferredDiff.oldContent,
      deferredDiff.newContent,
      diffExpansion,
      file.status,
    );
  }, [hunks, deferredDiff, diffExpansion, file]);

  // Reset state when switching files / modes. Guarded so we don't emit
  // useless renders (`setCollapsedHunks(new Set())` on a path that already
  // had no collapsed hunks would otherwise trigger a re-render at 30Hz
  // when the user holds ⌥↓).
  useEffect(() => {
    setSearchIdx((idx) => (idx === 0 ? idx : 0));
    setPendingHunk((prev) => (prev === null ? prev : null));
    setCollapsedHunks((prev) => (prev.size === 0 ? prev : new Set()));
  }, [selectedFilePath, diffMode]);

  useEffect(() => {
    if (inFileSearchOpen) {
      requestAnimationFrame(() => searchBarRef.current?.focus());
    }
  }, [inFileSearchOpen, inFileSearchNonce]);

  const { lineHighlights, matchCount, editorRange } = useMemo(() => {
    if (!inFileSearchOpen || !searchQuery) {
      return {
        lineHighlights: EMPTY_HIGHLIGHTS,
        matchCount: 0,
        editorRange: null as [number, number] | null,
      };
    }
    const re = buildSearchRegex(searchQuery, searchCS, searchRegex);
    if (!re) {
      return {
        lineHighlights: EMPTY_HIGHLIGHTS,
        matchCount: 0,
        editorRange: null,
      };
    }
    if (diffMode === "edit" && file && editValue != null) {
      const matches = findInValue(editValue, re);
      const cur = matches[searchIdx] ?? null;
      return {
        lineHighlights: valueLineHighlights(editValue, matches, searchIdx),
        matchCount: matches.length,
        editorRange: cur ? ([cur.start, cur.end] as [number, number]) : null,
      };
    }
    const matches = findInSections(sections, re);
    return {
      lineHighlights: buildLineHighlights(matches, searchIdx),
      matchCount: matches.length,
      editorRange: null,
    };
  }, [
    inFileSearchOpen,
    searchQuery,
    searchCS,
    searchRegex,
    diffMode,
    file,
    editValue,
    sections,
    searchIdx,
  ]);

  useEffect(() => {
    if (searchIdx >= matchCount) {
      setSearchIdx(matchCount === 0 ? 0 : matchCount - 1);
    }
  }, [matchCount, searchIdx]);

  useEffect(() => {
    if (!inFileSearchOpen || matchCount === 0) return;
    if (diffMode === "edit") return;
    const root = diffBodyRef.current;
    if (!root) return;
    const el = root.querySelector("[data-hl-current]");
    if (el && typeof (el as HTMLElement).scrollIntoView === "function") {
      (el as HTMLElement).scrollIntoView({
        block: "center",
        inline: "nearest",
      });
    }
  }, [searchIdx, matchCount, diffMode, inFileSearchOpen, lineHighlights]);

  useEffect(() => {
    if (diffMode !== "edit" || !editorRange || !editorRef.current) return;
    // Pass `focus: false` — the user is typing in the search bar; we just
    // want the matched line scrolled into view, not focus stolen.
    editorRef.current.selectRange(editorRange[0], editorRange[1], false);
  }, [diffMode, editorRange]);

  function nextMatch() {
    if (matchCount === 0) return;
    setSearchIdx((i) => (i + 1) % matchCount);
  }
  function prevMatch() {
    if (matchCount === 0) return;
    setSearchIdx((i) => (i - 1 + matchCount) % matchCount);
  }

  // ---------------------------------------------------------------------
  // Memoized hunk action handlers + popover. MUST stay above the early
  // returns below — moving them after `if (!file) return …` would change
  // the hook count between renders (file null → file present) and trip
  // React's Rules of Hooks. The internal guards make them safe when
  // `file` is null.
  // ---------------------------------------------------------------------
  const hunkActionEnabled =
    !!file &&
    diffMode !== "edit" &&
    !diff?.isBinary &&
    file.status === "modified" &&
    hunks.length > 0;
  const reverseStage = file?.staged ?? false;

  const hunkActions = useMemo(() => {
    if (!hunkActionEnabled || !file) return null;
    return {
      primary: {
        kind: (reverseStage ? "unstage" : "stage") as "stage" | "unstage",
        label: reverseStage ? "Unstage hunk" : "Stage hunk",
        onClick: (hunkIdx: number) => {
          setPendingHunk((prev) =>
            prev && prev.hunkIdx === hunkIdx
              ? null
              : { hunkIdx, busy: false },
          );
        },
      },
      // Revert only makes sense for working-tree hunks (unstaged file).
      // For staged hunks the equivalent action is "unstage" which is
      // already covered by the primary button.
      revert: !reverseStage
        ? {
            label: "Revert hunk (discard from working tree)",
            onClick: (hunkIdx: number) => {
              const target = hunks[hunkIdx];
              if (!target) return;
              const patch = buildPatch(
                file.path,
                [target],
                file.oldPath ?? undefined,
              );
              requestRevertHunk(patch, hunkIdx, file.path);
            },
          }
        : undefined,
    };
  }, [
    hunkActionEnabled,
    reverseStage,
    hunks,
    file,
    requestRevertHunk,
  ]);

  const popoverNode = useMemo(() => {
    if (!hunkActionEnabled || !pendingHunk || !file) return null;
    return (
      <HunkStagePopover
        hunkIdx={pendingHunk.hunkIdx}
        filePath={file.path}
        busy={pendingHunk.busy}
        reverse={reverseStage}
        onCancel={() => setPendingHunk(null)}
        onStageOnly={async () => {
          const target = hunks[pendingHunk.hunkIdx];
          if (!target) return;
          const patch = buildPatch(
            file.path,
            [target],
            file.oldPath ?? undefined,
          );
          setPendingHunk({ ...pendingHunk, busy: true });
          await applyHunkPatch(
            patch,
            reverseStage,
            reverseStage
              ? `Unstaged hunk #${pendingHunk.hunkIdx + 1}`
              : `Staged hunk #${pendingHunk.hunkIdx + 1}`,
          );
          setPendingHunk(null);
        }}
        onStageAndCommit={async (message) => {
          const target = hunks[pendingHunk.hunkIdx];
          if (!target) return;
          const patch = buildPatch(
            file.path,
            [target],
            file.oldPath ?? undefined,
          );
          setPendingHunk({ ...pendingHunk, busy: true });
          await applyHunkPatchAndCommit(
            patch,
            reverseStage,
            message,
            reverseStage
              ? `Unstaged & committed`
              : `Staged & committed`,
          );
          setPendingHunk(null);
        }}
        onGenerate={async (signal) => {
          const target = hunks[pendingHunk.hunkIdx];
          if (!target) return "";
          const patch = buildPatch(
            file.path,
            [target],
            file.oldPath ?? undefined,
          );
          return generateHunkCommitDraft(patch, signal);
        }}
      />
    );
  }, [
    hunkActionEnabled,
    pendingHunk,
    file,
    reverseStage,
    hunks,
    applyHunkPatch,
    applyHunkPatchAndCommit,
    generateHunkCommitDraft,
  ]);

  if (!repo) return null;
  if (isUnchangedView && selectedFilePath) {
    // Look up a changed entry for this path — prefer unstaged (working-tree
    // diff) since the editor is showing working-tree contents.
    const matchingChanged =
      files.find((f) => f.path === selectedFilePath && !f.staged) ??
      files.find((f) => f.path === selectedFilePath) ??
      null;
    return (
      <FilePane
        repoPath={repo.path}
        filePath={selectedFilePath}
        editValue={editValue ?? ""}
        savedValue={savedValue ?? null}
        onChange={(v) => setEdit(selectedFilePath, v)}
        changedEntry={matchingChanged}
        isBinary={binaryPath === selectedFilePath}
      />
    );
  }
  if (!file) {
    return (
      <main className={DIFFPANE_ROOT}>
        <div className={DIFF_EMPTY}>
          <div className="grid place-items-center w-12 h-12 mx-auto mb-2 border border-dashed border-bd-2 rounded-3 text-fg-3 [&_svg]:h-[18px] [&_svg]:w-[18px]">
            {I.folder}
          </div>
          <div className="text-[14px] font-medium">
            {files.length === 0
              ? "No changes — working tree is clean"
              : "Pick a file to start reviewing"}
          </div>
          <div className="font-mono text-fg-2 text-[12px]">
            Press <Kbd>⌥↓</Kbd> to jump to the next changed file, or{" "}
            <Kbd>⌘P</Kbd> for commands.
          </div>
        </div>
      </main>
    );
  }

  const lang = detectLanguage(file.path);
  const meta = STATUS_META[file.status];
  const dir = file.path.includes("/")
    ? file.path.slice(0, file.path.lastIndexOf("/"))
    : "";
  const name = file.path.split("/").pop() ?? file.path;
  const fileEditValue = editValue ?? "";
  const fileSavedValue = savedValue ?? null;
  const dirty =
    diffMode === "edit" &&
    editValue != null &&
    fileEditValue !== fileSavedValue;

  // `hunkActionEnabled`, `reverseStage`, `hunkActions`, `popoverNode` are
  // declared above (before the early returns) to keep the hook call count
  // stable. They're memoized there using the same dependency set.

  return (
    <main className={DIFFPANE_ROOT}>
      <div className={DIFF_HEADER}>
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <span
            className={cn(
              "inline-grid place-items-center w-[18px] h-[18px] rounded-[3px]",
              "border text-[10px] font-semibold opacity-95 font-mono",
            )}
            style={{ color: meta.color }}
          >
            {meta.letter}
          </span>
          <span
            className={cn(
              "font-mono font-medium text-[13px] whitespace-nowrap",
              "overflow-hidden text-ellipsis min-w-0",
              // Make the filename itself fg-0, leave the .dim path prefix at fg-2.
              "[&_span:not(.dim)]:text-fg-0",
            )}
          >
            {dir ? <span className="text-fg-2">{dir}/</span> : null}
            <span>{name}</span>
          </span>
          <span className="inline-flex gap-1.5 text-[11.5px] font-mono">
            <span className="text-diff-add-mark">+{file.additions}</span>
            <span className="text-diff-del-mark">−{file.deletions}</span>
          </span>
          {diffMode === "edit" && dirty ? (
            <span className="inline-flex items-center gap-1 font-mono text-[10.5px] px-1.5 py-0.5 rounded-[3px] bg-accent-softer text-accent-hi">
              ● unsaved
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5">
          <div className={SEG_GROUP}>
            <button
              type="button"
              className={cn(SEG_BTN_BASE, diffMode === "sbs" && SEG_BTN_ACTIVE)}
              onClick={() => setDiffMode("sbs")}
              title="Side-by-side"
              aria-label="Side-by-side"
            >
              {I.splitView}
            </button>
            <button
              type="button"
              className={cn(SEG_BTN_BASE, diffMode === "inline" && SEG_BTN_ACTIVE)}
              onClick={() => setDiffMode("inline")}
              title="Inline"
              aria-label="Inline"
            >
              {I.inlineView}
            </button>
            <button
              type="button"
              className={cn(SEG_BTN_BASE, diffMode === "edit" && SEG_BTN_ACTIVE)}
              onClick={() => setDiffMode("edit")}
              title="Edit"
              aria-label="Edit"
            >
              {I.edit}
            </button>
          </div>
          {/* Diff expansion mode — full file vs hunks only. Used to live
              only in Preferences; surfacing it inline lets the user bail
              out of full-file rendering on a huge file with one click,
              which is the single biggest perf knob the user has.
              Previous/next-file (↑/↓) buttons were removed from here —
              ⌥↑ / ⌥↓ already cover that and the icons added noise. */}
          <div className={SEG_GROUP}>
            <button
              type="button"
              className={cn(
                SEG_BTN_BASE,
                diffExpansion === "full" && SEG_BTN_ACTIVE,
              )}
              onClick={() => setDiffExpansion("full")}
              title="Show the whole file with continuous line numbers"
              aria-label="Full file"
            >
              {I.fileFull}
            </button>
            <button
              type="button"
              className={cn(
                SEG_BTN_BASE,
                diffExpansion === "hunks" && SEG_BTN_ACTIVE,
              )}
              onClick={() => setDiffExpansion("hunks")}
              title="Show only the changed regions"
              aria-label="Hunks only"
            >
              {I.fileHunks}
            </button>
          </div>
        </div>
      </div>
      <div className={DIFF_BODY_WRAP}>
        {inFileSearchOpen ? (
          <InFileSearchBar
            ref={searchBarRef}
            query={searchQuery}
            caseSensitive={searchCS}
            regex={searchRegex}
            total={matchCount}
            current={matchCount === 0 ? -1 : searchIdx}
            onQueryChange={(q) => {
              setSearchQuery(q);
              setSearchIdx(0);
            }}
            onToggleCase={() => setSearchCS((v) => !v)}
            onToggleRegex={() => setSearchRegex((v) => !v)}
            onNext={nextMatch}
            onPrev={prevMatch}
            onClose={() => setInFileSearchOpen(false)}
          />
        ) : null}
        <div className={DIFF_BODY} ref={diffBodyRef}>
          {loading && !diff ? (
            <div className={DIFF_EMPTY}>
              <div className="font-mono text-fg-2 text-[12px]">
                Loading diff…
              </div>
            </div>
          ) : diff?.isBinary ? (
            <BinaryPreviewPane
              repoPath={repo.path}
              filePath={file.path}
              staged={file.staged}
              status={file.status}
            />
          ) : diffMode === "sbs" ? (
            <DiffSideBySide
              sections={sections}
              lang={lang}
              status={file.status}
              lineHighlights={lineHighlights}
              hunkActions={hunkActions}
              popoverHunkIdx={pendingHunk?.hunkIdx ?? null}
              popoverNode={popoverNode}
              collapsedHunks={collapsedHunks}
              onToggleHunk={toggleHunkCollapsed}
            />
          ) : diffMode === "inline" ? (
            <DiffInline
              sections={sections}
              lang={lang}
              lineHighlights={lineHighlights}
              hunkActions={hunkActions}
              popoverHunkIdx={pendingHunk?.hunkIdx ?? null}
              popoverNode={popoverNode}
              collapsedHunks={collapsedHunks}
              onToggleHunk={toggleHunkCollapsed}
            />
          ) : (
            <DiffEditor
              ref={editorRef}
              value={fileEditValue}
              onChange={(v) => setEdit(file.path, v)}
              lang={lang}
              lineHighlights={lineHighlights}
            />
          )}
        </div>
      </div>
      <div className={DIFF_FOOTER}>
        <span>{lang.toUpperCase()}</span>
        <span>·</span>
        <span>UTF-8</span>
        <span>·</span>
        <span>LF</span>
        <span>·</span>
        <span>
          {hunks.length} hunk{hunks.length === 1 ? "" : "s"}
        </span>
        <span className="flex-1" />
        <span>
          {diffMode === "edit"
            ? dirty
              ? "Editing · unsaved changes"
              : "Editing · no changes"
            : diffExpansion === "full"
              ? "Full file"
              : "Hunks only"}
        </span>
      </div>
    </main>
  );
}

/**
 * Render path for files the user picked from the file tree / Search / ⌘P.
 * Shows the working-tree contents as a single editor pane. When the file is
 * also a changed entry, we still show the full file (not a diff) but paint a
 * subtle gutter stripe on lines that differ from HEAD/index.
 */
function FilePane({
  repoPath,
  filePath,
  editValue,
  savedValue,
  onChange,
  changedEntry,
  isBinary,
}: {
  repoPath: string;
  filePath: string;
  editValue: string;
  savedValue: string | null;
  onChange: (v: string) => void;
  changedEntry: ChangedFile | null;
  isBinary: boolean;
}) {
  const lang = detectLanguage(filePath);
  const dir = filePath.includes("/")
    ? filePath.slice(0, filePath.lastIndexOf("/"))
    : "";
  const name = filePath.split("/").pop() ?? filePath;
  const dirty = savedValue != null && editValue !== savedValue;
  const editorRef = useRef<DiffEditorHandle | null>(null);
  const setError = useRepoStore((s) => s.setError);
  const meta = changedEntry ? STATUS_META[changedEntry.status] : null;

  // In-file search (⌘F). Lives in the FilePane so it works when the user
  // opens a file from the Files tree / Search jump / ⌘P palette.
  const inFileSearchOpen = useRepoStore((s) => s.inFileSearchOpen);
  const setInFileSearchOpen = useRepoStore((s) => s.setInFileSearchOpen);
  const inFileSearchNonce = useRepoStore((s) => s.inFileSearchNonce);
  const searchBarRef = useRef<InFileSearchBarHandle | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchCS, setSearchCS] = useState(false);
  const [searchRegex, setSearchRegex] = useState(false);
  const [searchIdx, setSearchIdx] = useState(0);

  useEffect(() => {
    if (inFileSearchOpen) {
      requestAnimationFrame(() => searchBarRef.current?.focus());
    }
  }, [inFileSearchOpen, inFileSearchNonce]);

  // Reset search index when the user types something new.
  useEffect(() => {
    setSearchIdx(0);
  }, [searchQuery, searchCS, searchRegex]);

  const { lineHighlights, matchCount, editorRange } = useMemo(() => {
    if (!inFileSearchOpen || !searchQuery) {
      return {
        lineHighlights: EMPTY_HIGHLIGHTS,
        matchCount: 0,
        editorRange: null as [number, number] | null,
      };
    }
    const re = buildSearchRegex(searchQuery, searchCS, searchRegex);
    if (!re) {
      return {
        lineHighlights: EMPTY_HIGHLIGHTS,
        matchCount: 0,
        editorRange: null,
      };
    }
    const matches = findInValue(editValue, re);
    const cur = matches[searchIdx] ?? null;
    return {
      lineHighlights: valueLineHighlights(editValue, matches, searchIdx),
      matchCount: matches.length,
      editorRange: cur ? ([cur.start, cur.end] as [number, number]) : null,
    };
  }, [
    inFileSearchOpen,
    searchQuery,
    searchCS,
    searchRegex,
    editValue,
    searchIdx,
  ]);

  useEffect(() => {
    if (!editorRange || !editorRef.current) return;
    // Same as the diff-edit branch above: don't pull focus away from the
    // search input while the user is typing.
    editorRef.current.selectRange(editorRange[0], editorRange[1], false);
  }, [editorRange]);

  function nextMatch() {
    if (matchCount === 0) return;
    setSearchIdx((i) => (i + 1) % matchCount);
  }
  function prevMatch() {
    if (matchCount === 0) return;
    setSearchIdx((i) => (i - 1 + matchCount) % matchCount);
  }

  // Compute changed line numbers (in the working-tree file) for gutter marks.
  const [changedLines, setChangedLines] = useState<Set<number>>(
    () => new Set(),
  );
  useEffect(() => {
    if (!changedEntry) {
      setChangedLines(new Set());
      return;
    }
    let cancelled = false;
    getFileDiff(repoPath, changedEntry.path, changedEntry.staged)
      .then((diff) => {
        if (cancelled) return;
        const hunks = parseUnifiedDiff(diff.diffText);
        const marks = new Set<number>();
        for (const h of hunks) {
          for (const l of h.lines) {
            if (l.t === "add" && l.n_new != null) marks.add(l.n_new);
          }
        }
        setChangedLines(marks);
      })
      .catch((err) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [repoPath, changedEntry, setError]);

  return (
    <main className={DIFFPANE_ROOT}>
      <div className={DIFF_HEADER}>
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <span
            className={cn(
              "inline-grid place-items-center w-[18px] h-[18px] rounded-[3px]",
              "border text-[10px] font-semibold opacity-95 font-mono",
            )}
            style={{ color: meta?.color ?? "var(--fg-3)" }}
            title={meta?.label ?? "Unchanged"}
          >
            {meta?.letter ?? "·"}
          </span>
          <span
            className={cn(
              "font-mono font-medium text-[13px] whitespace-nowrap",
              "overflow-hidden text-ellipsis min-w-0",
              "[&_span:not(.dim)]:text-fg-0",
            )}
          >
            {dir ? <span className="text-fg-2">{dir}/</span> : null}
            <span>{name}</span>
          </span>
          <span
            className={cn(
              "inline-flex items-center gap-1.5 px-[7px] py-[2px] rounded-full bg-transparent",
              "font-mono text-[10.5px]",
              "border border-[color-mix(in_oklab,var(--pill-color,var(--fg-1))_40%,transparent)]",
            )}
            style={
              {
                color: meta ? meta.color : "var(--fg-2)",
                "--pill-color": meta?.color ?? "var(--fg-1)",
              } as React.CSSProperties
            }
          >
            <span
              className="inline-block w-[5px] h-[5px] rounded-full"
              style={{ background: meta?.color ?? "var(--fg-3)" }}
            />
            {meta?.label ?? "Unchanged"}
          </span>
          {dirty ? (
            <span className="inline-flex items-center gap-1 font-mono text-[10.5px] px-1.5 py-0.5 rounded-[3px] bg-accent-softer text-accent-hi">
              ● unsaved
            </span>
          ) : null}
        </div>
      </div>
      <div className={DIFF_BODY_WRAP}>
        {inFileSearchOpen ? (
          <InFileSearchBar
            ref={searchBarRef}
            query={searchQuery}
            caseSensitive={searchCS}
            regex={searchRegex}
            total={matchCount}
            current={matchCount === 0 ? -1 : searchIdx}
            onQueryChange={setSearchQuery}
            onToggleCase={() => setSearchCS((v) => !v)}
            onToggleRegex={() => setSearchRegex((v) => !v)}
            onNext={nextMatch}
            onPrev={prevMatch}
            onClose={() => setInFileSearchOpen(false)}
          />
        ) : null}
        <div className={DIFF_BODY}>
          {isBinary ? (
            // Binary file (keystore, image, archive, …) — the read failed
            // with "Cannot edit a binary file" but that's expected, not an
            // error worth blaring. Show a calm inline state instead.
            <div className={FILE_LOADING}>
              <span className={FL_TITLE}>Binary file</span>
              <span className={FL_SUB}>
                <code className="font-mono">{filePath}</code> isn't text — it
                can't be opened in the editor.
              </span>
            </div>
          ) : savedValue === null ? (
            <div className={cn(FILE_LOADING, "[&_[data-ai-spinner]]:w-[18px] [&_[data-ai-spinner]]:h-[18px]")}>
              <Spinner />
              <span>Reading {filePath}…</span>
            </div>
          ) : savedValue === "" && editValue === "" ? (
            // Empty file — surface this explicitly. Lets the user tell
            // "broken render" apart from "really empty file on disk", and
            // gives them a one-click way to force a re-read in case the
            // buffer was loaded as "" while the file actually has content.
            <div className={FILE_LOADING}>
              <span className={FL_TITLE}>This file is empty</span>
              <span className={FL_SUB}>
                Disk reports 0 bytes for{" "}
                <code className="font-mono">{filePath}</code>.
              </span>
              <button
                type="button"
                className={BTN_GHOST}
                onClick={() => {
                  readWorkingFile(repoPath, filePath)
                    .then((content) =>
                      useRepoStore
                        .getState()
                        .loadEditBuffer(filePath, content),
                    )
                    .catch((err) =>
                      setError(
                        err instanceof Error ? err.message : String(err),
                      ),
                    );
                }}
              >
                Re-read from disk
              </button>
            </div>
          ) : (
            <DiffEditor
              ref={editorRef}
              value={editValue}
              onChange={onChange}
              lang={lang}
              changedLines={changedLines}
              lineHighlights={lineHighlights}
            />
          )}
        </div>
      </div>
      <div className={DIFF_FOOTER}>
        <span>{lang.toUpperCase()}</span>
        <span>·</span>
        <span>UTF-8</span>
        <span>·</span>
        <span>LF</span>
        <span className="flex-1" />
        {isBinary ? null : (
          <>
            <button
              type="button"
              className={FOOTER_ACTION}
              title="Discard the in-memory buffer and re-read this file from disk"
              onClick={() => {
                readWorkingFile(repoPath, filePath)
                  .then((content) =>
                    useRepoStore
                      .getState()
                      .loadEditBuffer(filePath, content),
                  )
                  .catch((err) =>
                    setError(
                      err instanceof Error ? err.message : String(err),
                    ),
                  );
              }}
            >
              Re-read from disk
            </button>
            <span>·</span>
          </>
        )}
        <span>
          {isBinary
            ? "Binary file · read-only"
            : dirty
              ? "Editing · unsaved changes"
              : changedEntry
                ? "Editing file · gutter marks show modified lines"
                : "Editing unchanged file"}
        </span>
      </div>
    </main>
  );
}
