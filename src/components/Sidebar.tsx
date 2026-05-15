import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  filteredFiles,
  useRepoStore,
  type StatusFilter,
} from "@/features/repository/repository.store";
import { cn } from "@/lib/utils";
import { I } from "./Icons";
import { FileRow } from "./FileRow";
import { CommitComposer } from "./CommitComposer";
import { FileTree } from "./FileTree";
import { SearchPanel } from "./SearchPanel";
import { ResizeHandle } from "./ResizeHandle";

export function Sidebar() {
  const files = useRepoStore((s) => s.files);
  const reviewedPaths = useRepoStore((s) => s.reviewedPaths);
  const filterText = useRepoStore((s) => s.filterText);
  const statusFilter = useRepoStore((s) => s.statusFilter);
  const onlyUnreviewed = useRepoStore((s) => s.onlyUnreviewed);
  const selectedFilePath = useRepoStore((s) => s.selectedFilePath);
  const selectedFileStaged = useRepoStore((s) => s.selectedFileStaged);
  const sidebarTab = useRepoStore((s) => s.sidebarTab);
  const setFilterText = useRepoStore((s) => s.setFilterText);
  const setStatusFilter = useRepoStore((s) => s.setStatusFilter);
  const setOnlyUnreviewed = useRepoStore((s) => s.setOnlyUnreviewed);
  const setSidebarTab = useRepoStore((s) => s.setSidebarTab);
  const selectFile = useRepoStore((s) => s.selectFile);
  const toggleStage = useRepoStore((s) => s.toggleStage);
  const toggleReviewed = useRepoStore((s) => s.toggleReviewed);
  const requestDiscard = useRepoStore((s) => s.requestDiscard);
  const stageMany = useRepoStore((s) => s.stageMany);
  const unstageMany = useRepoStore((s) => s.unstageMany);
  const requestDiscardMany = useRepoStore((s) => s.requestDiscardMany);
  const multiSelection = useRepoStore((s) => s.multiSelection);
  const multiSelectAnchor = useRepoStore((s) => s.multiSelectAnchor);
  const setMultiSelection = useRepoStore((s) => s.setMultiSelection);
  const toggleMultiSelection = useRepoStore((s) => s.toggleMultiSelection);
  const clearMultiSelection = useRepoStore((s) => s.clearMultiSelection);
  const toggleReviewedMany = useRepoStore((s) => s.toggleReviewedMany);

  const decorated = useMemo(
    () => files.map((f) => ({ ...f, reviewed: reviewedPaths.has(f.path) })),
    [files, reviewedPaths],
  );

  const counts = useMemo(() => {
    const c = {
      all: decorated.length,
      modified: 0,
      added: 0,
      deleted: 0,
      renamed: 0,
      untracked: 0,
    } as Record<string, number>;
    decorated.forEach((f) => {
      c[f.status] = (c[f.status] || 0) + 1;
    });
    return c;
  }, [decorated]);

  const filtered = useMemo(
    () => filteredFiles(decorated, filterText, statusFilter, onlyUnreviewed),
    [decorated, filterText, statusFilter, onlyUnreviewed],
  );

  const totals = useMemo(() => {
    let a = 0;
    let d = 0;
    decorated.forEach((f) => {
      a += f.additions;
      d += f.deletions;
    });
    return { add: a, del: d };
  }, [decorated]);

  const stagedFiltered = filtered.filter((f) => f.staged);
  const unstagedFiltered = filtered.filter((f) => !f.staged);
  const reviewedCount = decorated.filter((f) => f.reviewed).length;

  // Combined ordered list for ⇧-click range selection. Staged group first
  // (matches the on-screen order).
  const flatVisible = useMemo(
    () => [...stagedFiltered, ...unstagedFiltered],
    [stagedFiltered, unstagedFiltered],
  );

  const handleFileClick = (
    e: React.MouseEvent,
    path: string,
    staged: boolean,
  ) => {
    if (e.shiftKey) {
      // Shift-click triggers the browser's native text-selection extend —
      // even with `user-select: none` on the row, any existing selection
      // from outside the sidebar can latch on. Clear it so the only thing
      // ⇧-click does is range-select rows.
      window.getSelection()?.removeAllRanges();
    }
    if (e.shiftKey && multiSelectAnchor) {
      // Range select from anchor → clicked file, using the visible order.
      const startIdx = flatVisible.findIndex(
        (f) =>
          f.path === multiSelectAnchor.path &&
          f.staged === multiSelectAnchor.staged,
      );
      const endIdx = flatVisible.findIndex(
        (f) => f.path === path && f.staged === staged,
      );
      if (startIdx >= 0 && endIdx >= 0) {
        const [lo, hi] =
          startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
        const paths = flatVisible.slice(lo, hi + 1).map((f) => f.path);
        setMultiSelection(paths, multiSelectAnchor);
        selectFile(path, staged);
        return;
      }
    }
    if (e.metaKey || e.ctrlKey) {
      // Toggle this file in the multi-selection (additive). The anchor
      // moves to the most-recently toggled item so a follow-up ⇧-click
      // anchors here.
      toggleMultiSelection(path, { path, staged });
      selectFile(path, staged);
      return;
    }
    // Plain click — drop any prior multi-selection but remember this row
    // as the anchor so a follow-up ⇧-click ranges from here.
    selectFile(path, staged);
    setMultiSelection([], { path, staged });
  };

  return (
    <aside className="sidebar">
      <div className="sb-tabs">
        <button
          className={cn("sb-tab", sidebarTab === "changes" && "is-active")}
          onClick={() => setSidebarTab("changes")}
        >
          Changes
          <span className="sb-tab-count">{files.length}</span>
        </button>
        <button
          className={cn("sb-tab", sidebarTab === "files" && "is-active")}
          onClick={() => setSidebarTab("files")}
        >
          Files
        </button>
        <button
          className={cn("sb-tab", sidebarTab === "search" && "is-active")}
          onClick={() => setSidebarTab("search")}
        >
          Search
        </button>
      </div>

      {sidebarTab === "changes" ? (
        <>
          <div className="sidebar-head">
            <div className="sidebar-title-row">
              <span className="sidebar-title">Changes</span>
              <span className="sidebar-count">{files.length}</span>
              <div className="flex-spacer" />
              <span
                className="diffstat"
                title="Total +/− across all changed files"
              >
                <span className="diffstat-add">+{totals.add}</span>
                <span className="diffstat-del">−{totals.del}</span>
              </span>
            </div>
            <div className="filter-row">
              <span className="filter-icon">{I.search}</span>
              <input
                className="filter-input"
                type="text"
                placeholder="Filter files…"
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
                autoCapitalize="off"
                autoCorrect="off"
                autoComplete="off"
                spellCheck={false}
              />
              {filterText ? (
                <button
                  className="filter-clear"
                  onClick={() => setFilterText("")}
                  title="Clear"
                >
                  {I.x}
                </button>
              ) : null}
              <StatusFilterDropdown
                value={statusFilter}
                onChange={setStatusFilter}
                counts={counts}
              />
            </div>
            <label className="review-toggle">
              <input
                type="checkbox"
                checked={onlyUnreviewed}
                onChange={(e) => setOnlyUnreviewed(e.target.checked)}
              />
              <span>Only unreviewed</span>
              <span className="flex-spacer" />
              <span className="dim mono">
                {reviewedCount}/{files.length} reviewed
              </span>
            </label>
          </div>

          <div className="sidebar-list">
            {stagedFiltered.length > 0 ? (
              <SidebarGroup
                label="Staged"
                count={stagedFiltered.length}
                actions={
                  <button
                    className="sb-group-action"
                    onClick={(e) => {
                      e.stopPropagation();
                      unstageMany(stagedFiltered.map((f) => f.path));
                    }}
                    title="Unstage all (in view)"
                    type="button"
                  >
                    {I.minus}
                  </button>
                }
              >
                {stagedFiltered.map((f) => (
                  <FileRow
                    key={`${f.path}#staged`}
                    file={f}
                    selected={
                      f.path === selectedFilePath &&
                      selectedFileStaged === true
                    }
                    active={f.path === selectedFilePath}
                    multiSelected={multiSelection.has(f.path)}
                    onSelect={(e) => handleFileClick(e, f.path, true)}
                    onToggleStage={() => toggleStage(f.path)}
                    onToggleReviewed={() => toggleReviewed(f.path)}
                    onDiscard={() => requestDiscard(f.path)}
                  />
                ))}
              </SidebarGroup>
            ) : null}
            {unstagedFiltered.length > 0 ? (
              <SidebarGroup
                label="Unstaged"
                count={unstagedFiltered.length}
                actions={
                  <>
                    <button
                      className="sb-group-action sb-group-action-danger"
                      onClick={(e) => {
                        e.stopPropagation();
                        requestDiscardMany(
                          unstagedFiltered.map((f) => f.path),
                        );
                      }}
                      title="Discard all (in view) — reverts the working tree"
                      type="button"
                    >
                      {I.undo}
                    </button>
                    <button
                      className="sb-group-action"
                      onClick={(e) => {
                        e.stopPropagation();
                        stageMany(unstagedFiltered.map((f) => f.path));
                      }}
                      title="Stage all (in view)"
                      type="button"
                    >
                      {I.plus}
                    </button>
                  </>
                }
              >
                {unstagedFiltered.map((f) => (
                  <FileRow
                    key={`${f.path}#unstaged`}
                    file={f}
                    selected={
                      f.path === selectedFilePath &&
                      selectedFileStaged === false
                    }
                    active={f.path === selectedFilePath}
                    multiSelected={multiSelection.has(f.path)}
                    onSelect={(e) => handleFileClick(e, f.path, false)}
                    onToggleStage={() => toggleStage(f.path)}
                    onToggleReviewed={() => toggleReviewed(f.path)}
                    onDiscard={() => requestDiscard(f.path)}
                  />
                ))}
              </SidebarGroup>
            ) : null}
            {filtered.length === 0 ? (
              <div className="sidebar-empty mono dim">
                <div>No files match.</div>
                <button
                  className="link-btn"
                  onClick={() => {
                    setFilterText("");
                    setStatusFilter("all");
                    setOnlyUnreviewed(false);
                  }}
                >
                  Clear filters
                </button>
              </div>
            ) : null}
          </div>
          {/* Multi-select bar sits between the file list and the commit
              composer — that puts the bulk actions inside the changes area
              without overlapping the composer's textarea / Commit button. */}
          {multiSelection.size > 0 ? (
            <MultiSelectBar
              count={multiSelection.size}
              onStage={() => {
                const targets = unstagedFiltered
                  .filter((f) => multiSelection.has(f.path))
                  .map((f) => f.path);
                if (targets.length > 0) stageMany(targets);
              }}
              onUnstage={() => {
                const targets = stagedFiltered
                  .filter((f) => multiSelection.has(f.path))
                  .map((f) => f.path);
                if (targets.length > 0) unstageMany(targets);
              }}
              onMarkReviewed={() => {
                toggleReviewedMany([...multiSelection]);
              }}
              onDiscard={() => {
                const targets = unstagedFiltered
                  .filter((f) => multiSelection.has(f.path))
                  .map((f) => f.path);
                if (targets.length > 0) requestDiscardMany(targets);
              }}
              onClear={clearMultiSelection}
              canStage={unstagedFiltered.some((f) =>
                multiSelection.has(f.path),
              )}
              canUnstage={stagedFiltered.some((f) =>
                multiSelection.has(f.path),
              )}
              canDiscard={unstagedFiltered.some((f) =>
                multiSelection.has(f.path),
              )}
            />
          ) : null}
          {/* Pinned bottom: commit composer (textarea + AI wand + commit). */}
          <CommitComposer />
        </>
      ) : sidebarTab === "files" ? (
        <div className="sidebar-list">
          <FileTree />
        </div>
      ) : (
        <SearchPanel />
      )}
      <ResizeHandle side="left" />
    </aside>
  );
}

function SidebarGroup({
  label,
  count,
  children,
  actions,
}: {
  label: string;
  count: number;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="sb-group">
      <div className="sb-group-head-row">
        <button className="sb-group-head" onClick={() => setOpen(!open)}>
          <span className={cn("sb-group-chev", open && "is-open")}>
            {I.chevron}
          </span>
          <span className="sb-group-label">{label}</span>
          <span className="sb-group-count">{count}</span>
        </button>
        {actions ? <div className="sb-group-actions">{actions}</div> : null}
      </div>
      {open ? <div className="sb-group-body">{children}</div> : null}
    </div>
  );
}

type StatusOption = {
  id: StatusFilter;
  label: string;
  letter: string;
  dot?: string;
};

const STATUS_OPTIONS: StatusOption[] = [
  { id: "all", label: "All files", letter: "All" },
  { id: "modified", label: "Modified", letter: "M", dot: "var(--git-mod)" },
  { id: "added", label: "Added", letter: "A", dot: "var(--git-add)" },
  { id: "deleted", label: "Deleted", letter: "D", dot: "var(--git-del)" },
  { id: "renamed", label: "Renamed", letter: "R", dot: "var(--git-ren)" },
  { id: "untracked", label: "Untracked", letter: "U", dot: "var(--git-unt)" },
];

function StatusFilterDropdown({
  value,
  onChange,
  counts,
}: {
  value: StatusFilter;
  onChange: (v: StatusFilter) => void;
  counts: Record<string, number>;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const target = e.target as Node | null;
      if (ref.current && target && !ref.current.contains(target)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = STATUS_OPTIONS.find((o) => o.id === value) ?? STATUS_OPTIONS[0];
  const currentCount =
    current.id === "all" ? counts.all : counts[current.id] || 0;
  const isFiltered = value !== "all";

  return (
    <div className="status-filter" ref={ref}>
      <button
        type="button"
        className={cn("status-filter-btn", isFiltered && "is-on")}
        onClick={() => setOpen((v) => !v)}
        title={`Status filter: ${current.label}`}
      >
        {current.dot ? (
          <span
            className="status-filter-dot"
            style={{ background: current.dot }}
          />
        ) : null}
        <span className="status-filter-label">{current.letter}</span>
        <span className="status-filter-count mono">{currentCount}</span>
        <span className="status-filter-chev">{I.chevron}</span>
      </button>
      {open ? (
        <div className="status-filter-menu" role="menu">
          {STATUS_OPTIONS.map((opt) => {
            const c = opt.id === "all" ? counts.all : counts[opt.id] || 0;
            return (
              <button
                key={opt.id}
                role="menuitemradio"
                aria-checked={value === opt.id}
                className={cn(
                  "status-filter-item",
                  value === opt.id && "is-active",
                )}
                onClick={() => {
                  onChange(opt.id);
                  setOpen(false);
                }}
                type="button"
              >
                <span className="status-filter-mark">
                  {value === opt.id ? I.check : null}
                </span>
                {opt.dot ? (
                  <span
                    className="status-filter-dot"
                    style={{ background: opt.dot }}
                  />
                ) : (
                  <span className="status-filter-dot-empty" />
                )}
                <span className="status-filter-item-label">{opt.label}</span>
                <span className="status-filter-item-count mono dim">{c}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Single-row pill that shows up when the user multi-selects files.
 * Layout: `[N] [+ Stage] [- Unstage] [✓] [⌫]   [✕]`
 *
 * Stage/Unstage keep their text labels because they're the headline
 * actions, and only one of them shows at a time (depending on which side
 * of the staged/unstaged divide the selection lives on). Reviewed and
 * Discard are icon-only with tooltips so the bar stays single-row at
 * narrow sidebar widths (was wrapping into an ugly 2-row pill before).
 */
function MultiSelectBar({
  count,
  onStage,
  onUnstage,
  onMarkReviewed,
  onDiscard,
  onClear,
  canStage,
  canUnstage,
  canDiscard,
}: {
  count: number;
  onStage: () => void;
  onUnstage: () => void;
  onMarkReviewed: () => void;
  onDiscard: () => void;
  onClear: () => void;
  canStage: boolean;
  canUnstage: boolean;
  canDiscard: boolean;
}) {
  return (
    <div className="multiselect-bar">
      <span className="multiselect-bar-count">{count}</span>
      {canStage ? (
        <button
          className="multiselect-bar-btn multiselect-bar-btn-primary"
          onClick={onStage}
          title="Stage selected files"
          type="button"
        >
          {I.plus}
          <span>Stage</span>
        </button>
      ) : null}
      {canUnstage ? (
        <button
          className="multiselect-bar-btn multiselect-bar-btn-primary"
          onClick={onUnstage}
          title="Unstage selected files"
          type="button"
        >
          {I.minus}
          <span>Unstage</span>
        </button>
      ) : null}
      <button
        className="multiselect-bar-btn"
        onClick={onMarkReviewed}
        title="Toggle reviewed (⌘⇧M)"
        type="button"
      >
        {I.review}
        <span>Reviewed</span>
      </button>
      {canDiscard ? (
        <button
          className="multiselect-bar-icon is-danger"
          onClick={onDiscard}
          title="Discard selected files"
          aria-label="Discard"
          type="button"
        >
          {I.discard}
        </button>
      ) : null}
      <span className="flex-spacer" />
      <button
        className="multiselect-bar-icon multiselect-bar-clear"
        onClick={onClear}
        title="Clear selection"
        aria-label="Clear selection"
        type="button"
      >
        {I.x}
      </button>
    </div>
  );
}

// Re-export the StatusFilter type so consumers in lib/store stay decoupled.
export type { StatusFilter };
