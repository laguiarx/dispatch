import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  filteredFiles,
  useRepoStore,
  type StatusFilter,
} from "@/features/repository/repository.store";
import { cn } from "@/lib/utils";
import { I } from "./icons";
import { FileRow } from "./file-row";
import { CommitComposer } from "./commit-composer";
import { FileTree } from "./file-tree";
import { SearchPanel } from "./search-panel";
import { ResizeHandle } from "./resize-handle";

// Top-row tab style (Changes / Files / Search). Same 24px height, radius-1
// pill, hover/active states pulled from the design system.
const TAB =
  "inline-flex items-center gap-1.5 h-6 px-2 rounded-1 text-fg-2 font-medium text-[12px]";
const TAB_HOVER = "hover:bg-bg-hover hover:text-fg-0";
const TAB_ACTIVE = "bg-bg-active text-fg-0";
// Compact mono count badge that sits next to titles. Uses an rgba bg that's
// theme-aware via a `[data-theme="light"]` override applied below in inline
// `dark:`-style fallback (we don't use Tailwind's dark variant — see the
// note in `tailwind.config.js`).
const COUNT_BADGE =
  "font-mono text-[10px] text-fg-3 bg-white/[0.04] px-1 py-px rounded-[3px] " +
  "[:root[data-theme='light']_&]:bg-black/[0.05]";

/**
 * Left workspace panel — three tabs (Changes / Files / Search). The
 * Changes tab is the busiest: filter row + status dropdown + reviewed
 * toggle + staged/unstaged groups + commit composer pinned at the bottom.
 *
 * Migrated from the `.sidebar` / `.sb-*` / `.sidebar-*` / `.filter-*` /
 * `.status-filter*` / `.review-toggle` / `.multiselect-bar*` rules.
 * Children components (FileRow, FileTree, SearchPanel, CommitComposer)
 * still own their own CSS — they'll be migrated as separate waves.
 */
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
    <aside
      className={cn(
        "relative flex flex-col min-w-0 min-h-0 overflow-hidden",
        "bg-[color-mix(in_oklab,var(--bg-1)_88%,transparent)]",
        "border border-bd-2 rounded-[10px] shadow-card",
        "backdrop-blur-card backdrop-saturate-[140%]",
      )}
    >
      <div className="flex items-center px-2 h-[34px] gap-0.5 border-b border-bd-1 shrink-0">
        <button
          className={cn(TAB, TAB_HOVER, sidebarTab === "changes" && TAB_ACTIVE)}
          onClick={() => setSidebarTab("changes")}
        >
          Changes
          <span
            className={cn(
              COUNT_BADGE,
              sidebarTab === "changes" && "text-fg-1",
            )}
          >
            {files.length}
          </span>
        </button>
        <button
          className={cn(TAB, TAB_HOVER, sidebarTab === "files" && TAB_ACTIVE)}
          onClick={() => setSidebarTab("files")}
        >
          Files
        </button>
        <button
          className={cn(TAB, TAB_HOVER, sidebarTab === "search" && TAB_ACTIVE)}
          onClick={() => setSidebarTab("search")}
        >
          Search
        </button>
      </div>

      {sidebarTab === "changes" ? (
        <>
          <div className="flex flex-col gap-2 px-2.5 pt-2.5 pb-2">
            <div className="flex items-center gap-1.5">
              <span className="font-semibold text-[13px] tracking-[-0.01em]">
                Changes
              </span>
              <span
                className={cn(
                  "font-mono text-[10.5px] text-fg-2 rounded-[3px] px-[5px] py-px",
                  "bg-white/[0.04] [:root[data-theme='light']_&]:bg-black/[0.05]",
                )}
              >
                {files.length}
              </span>
              <span className="flex-1" />
              <span
                className="inline-flex gap-1.5 font-mono text-[11px]"
                title="Total +/− across all changed files"
              >
                <span className="text-diff-add-mark">+{totals.add}</span>
                <span className="text-diff-del-mark">−{totals.del}</span>
              </span>
            </div>
            <div
              className={cn(
                "flex items-center gap-1.5 h-[26px] px-2 rounded-2 min-w-0",
                "bg-bg-2 border border-bd-1",
                "focus-within:border-accent",
              )}
            >
              <span className="grid place-items-center shrink-0 text-fg-3">
                {I.search}
              </span>
              <input
                className="flex-1 min-w-0 h-full text-[12px] bg-transparent border-0 outline-none"
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
                  className="grid place-items-center p-0.5 text-fg-3 hover:text-fg-0"
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
            <label className="flex items-center gap-[7px] text-[12px] text-fg-1 cursor-pointer py-0.5">
              <input
                type="checkbox"
                checked={onlyUnreviewed}
                onChange={(e) => setOnlyUnreviewed(e.target.checked)}
                className={cn(
                  // Custom checkbox: appearance-none + Tailwind-drawn check
                  // via an `::after` rotated-border trick (cheap angle bracket
                  // rendered as borders rather than an svg).
                  "appearance-none w-[13px] h-[13px] rounded-[3px]",
                  "border border-bd-2 bg-bg-2 grid place-items-center cursor-pointer",
                  "checked:bg-accent checked:border-accent",
                  "checked:after:content-[''] checked:after:w-[7px] checked:after:h-1",
                  "checked:after:border-l-[1.5px] checked:after:border-b-[1.5px]",
                  "checked:after:border-white checked:after:-rotate-45",
                  "checked:after:-translate-y-px",
                )}
              />
              <span>Only unreviewed</span>
              <span className="flex-1" />
              <span className="text-fg-2 font-mono">
                {reviewedCount}/{files.length} reviewed
              </span>
            </label>
          </div>

          <div
            className={cn(
              "flex-1 overflow-y-auto pt-1 pb-3 select-none",
              "[scrollbar-width:thin] [scrollbar-color:var(--bd-2)_transparent]",
              "[&::-webkit-scrollbar]:w-2",
              "[&::-webkit-scrollbar-thumb]:bg-bd-2 [&::-webkit-scrollbar-thumb]:rounded",
              "[&::-webkit-scrollbar-thumb]:border-2 [&::-webkit-scrollbar-thumb]:border-bg-1",
            )}
          >
            {stagedFiltered.length > 0 ? (
              <SidebarGroup
                label="Staged"
                count={stagedFiltered.length}
                actions={
                  <button
                    className="grid place-items-center w-5 h-5 rounded text-fg-2 transition-colors hover:bg-bg-hover hover:text-fg-0"
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
                      className="grid place-items-center w-5 h-5 rounded text-fg-2 transition-colors hover:bg-bg-hover hover:text-fg-0"
                      onClick={(e) => {
                        e.stopPropagation();
                        stageMany(unstagedFiltered.map((f) => f.path));
                      }}
                      title="Stage all (in view)"
                      type="button"
                    >
                      {I.plus}
                    </button>
                    <GroupMoreMenu
                      onDiscardAll={() =>
                        requestDiscardMany(
                          unstagedFiltered.map((f) => f.path),
                        )
                      }
                    />
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
              <div className="px-4 py-5 text-center flex flex-col gap-2 font-mono text-fg-2">
                <div>No files match.</div>
                <button
                  className="self-center text-accent text-[12px] hover:underline"
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
        <div
          className={cn(
            "flex-1 overflow-y-auto pt-1 pb-3 select-none",
            "[scrollbar-width:thin] [scrollbar-color:var(--bd-2)_transparent]",
          )}
        >
          <FileTree />
        </div>
      ) : (
        <SearchPanel />
      )}
      <ResizeHandle side="left" />
    </aside>
  );
}

/**
 * Collapsible group used for the Staged / Unstaged sections in the
 * Changes tab. Header has a chevron, label, count, and an actions cluster
 * that fades in on hover.
 */
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
    <div className="pt-1.5 pb-0.5 group">
      <div className="flex items-center gap-1 pr-2">
        <button
          className={cn(
            "flex items-center gap-1.5 px-3 py-1 flex-1 min-w-0 text-left",
            "font-mono text-[10.5px] uppercase tracking-[0.06em] text-fg-3",
            "hover:text-fg-1",
          )}
          onClick={() => setOpen(!open)}
        >
          <span
            className={cn(
              "grid place-items-center transition-transform duration-[120ms] text-fg-3",
              open ? "rotate-0" : "-rotate-90",
            )}
          >
            {I.chevron}
          </span>
          <span>{label}</span>
          <span className="text-fg-3">{count}</span>
        </button>
        {actions ? (
          <div
            // Action cluster stays hidden until the group is hovered.
            // `group-hover:` reveals it; `focus-within:` keeps it open
            // while one of the buttons has focus.
            className={cn(
              "inline-flex items-center gap-0.5 opacity-0 transition-opacity duration-100",
              "group-hover:opacity-100 focus-within:opacity-100",
            )}
          >
            {actions}
          </div>
        ) : null}
      </div>
      {open ? <div>{children}</div> : null}
    </div>
  );
}

function GroupMoreMenu({ onDiscardAll }: { onDiscardAll: () => void }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const t = e.target as Node | null;
      if (wrapRef.current && t && !wrapRef.current.contains(t)) setOpen(false);
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

  return (
    <div className="relative inline-flex" ref={wrapRef}>
      <button
        type="button"
        className={cn(
          "grid place-items-center w-5 h-5 rounded text-fg-2 transition-colors",
          "hover:bg-bg-hover hover:text-fg-0",
          open && "bg-bg-active text-fg-0",
        )}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        title="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {I.ellipsis}
      </button>
      {open ? (
        <div
          role="menu"
          className={cn(
            "absolute top-[calc(100%+4px)] right-0 z-30 min-w-[200px]",
            "bg-bg-2 border border-bd-2 rounded-3 py-1",
            "shadow-[0_12px_32px_rgba(0,0,0,0.5)]",
          )}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            role="menuitem"
            className={cn(
              "grid grid-cols-[18px_1fr] items-center gap-2 w-full px-3 py-[7px]",
              "text-left text-[12px] text-fg-1 bg-transparent border-0 cursor-pointer",
              "hover:!text-git-del",
              "hover:bg-[color-mix(in_oklab,var(--git-del)_14%,transparent)]",
              "[&:hover_.grm-icon]:!text-current",
            )}
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              onDiscardAll();
            }}
            type="button"
          >
            <span className="grm-icon grid place-items-center text-fg-3">
              {I.discard}
            </span>
            <span>Discard all (in view)</span>
          </button>
        </div>
      ) : null}
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
    <div className="relative inline-flex items-center shrink-0 h-full" ref={ref}>
      <button
        type="button"
        className={cn(
          "inline-flex items-center gap-1 h-5 min-w-5 pl-[7px] pr-1.5 rounded-1",
          "font-mono text-[10.5px] whitespace-nowrap shrink-0 border",
          isFiltered
            ? "text-accent bg-accent-soft border-[color-mix(in_oklab,var(--accent)_40%,transparent)]"
            : "text-fg-2 bg-transparent border-bd-1 hover:text-fg-0 hover:bg-bg-hover",
        )}
        onClick={() => setOpen((v) => !v)}
        title={`Status filter: ${current.label}`}
      >
        {current.dot ? (
          <span
            className="w-1.5 h-1.5 rounded-full shrink-0"
            style={{ background: current.dot }}
          />
        ) : null}
        <span className="font-medium">{current.letter}</span>
        <span
          className={cn(
            "text-[10px]",
            isFiltered
              ? "text-[color-mix(in_oklab,var(--accent)_75%,var(--fg-0))]"
              : "text-fg-3",
          )}
        >
          {currentCount}
        </span>
        <span className="inline-flex items-center ml-0.5 text-fg-3 [&_svg]:h-[9px] [&_svg]:w-[9px]">
          {I.chevron}
        </span>
      </button>
      {open ? (
        <div
          role="menu"
          className={cn(
            "absolute top-[calc(100%+6px)] right-0 z-[100] min-w-[200px]",
            "py-1 bg-bg-1 border border-bd-2 rounded-3",
            "shadow-[0_18px_50px_rgba(0,0,0,0.5),0_0_0_0.5px_rgba(255,255,255,0.04)]",
          )}
        >
          {STATUS_OPTIONS.map((opt) => {
            const c = opt.id === "all" ? counts.all : counts[opt.id] || 0;
            return (
              <button
                key={opt.id}
                role="menuitemradio"
                aria-checked={value === opt.id}
                className={cn(
                  "grid grid-cols-[14px_8px_1fr_auto] items-center gap-2 w-full",
                  "px-3 py-1.5 text-[12px] text-left bg-transparent",
                  value === opt.id ? "text-fg-0" : "text-fg-1",
                  "hover:bg-bg-hover hover:text-fg-0",
                )}
                onClick={() => {
                  onChange(opt.id);
                  setOpen(false);
                }}
                type="button"
              >
                <span className="grid place-items-center text-accent [&_svg]:h-2.5 [&_svg]:w-2.5">
                  {value === opt.id ? I.check : null}
                </span>
                {opt.dot ? (
                  <span
                    className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ background: opt.dot }}
                  />
                ) : (
                  <span className="w-1.5 h-1.5" />
                )}
                <span className="whitespace-nowrap">{opt.label}</span>
                <span className="font-mono text-fg-2 text-[10.5px]">{c}</span>
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
  // Common pill-button styling for the labelled actions.
  const btnBase =
    "inline-flex items-center gap-1 h-[22px] px-2 text-[11px] rounded-full " +
    "bg-transparent border-0 text-fg-1 whitespace-nowrap min-w-0 " +
    "hover:bg-[color-mix(in_oklab,var(--accent)_18%,transparent)] hover:text-fg-0 " +
    "[&_svg]:h-[11px] [&_svg]:w-[11px]";
  const iconBase =
    "grid place-items-center w-[22px] h-[22px] rounded-full border-0 shrink-0 " +
    "bg-transparent text-fg-1 [&_svg]:h-3 [&_svg]:w-3 " +
    "hover:bg-[color-mix(in_oklab,var(--accent)_18%,transparent)] hover:text-fg-0";
  return (
    <div
      className={cn(
        "flex items-center gap-1 shrink-0 mx-2.5 my-2 pl-2.5 pr-1.5 py-[5px]",
        "rounded-full min-w-0 text-[11.5px]",
        "bg-[color-mix(in_oklab,var(--accent-soft)_88%,var(--bg-1))]",
        "border border-[color-mix(in_oklab,var(--accent)_45%,transparent)]",
        "shadow-[0_4px_12px_rgba(0,0,0,0.25),0_0_0_0.5px_rgba(255,255,255,0.04)]",
      )}
    >
      <span
        className={cn(
          "text-accent font-semibold whitespace-nowrap pr-1.5 shrink-0",
          "border-r border-[color-mix(in_oklab,var(--accent)_30%,transparent)]",
        )}
      >
        {count}
      </span>
      {canStage ? (
        <button
          className={cn(btnBase, "overflow-hidden text-ellipsis")}
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
          className={cn(btnBase, "overflow-hidden text-ellipsis")}
          onClick={onUnstage}
          title="Unstage selected files"
          type="button"
        >
          {I.minus}
          <span>Unstage</span>
        </button>
      ) : null}
      <button
        className={btnBase}
        onClick={onMarkReviewed}
        title="Toggle reviewed (⌘⇧M)"
        type="button"
      >
        {I.review}
        <span>Reviewed</span>
      </button>
      {canDiscard ? (
        <button
          className={cn(
            iconBase,
            "hover:!text-git-del hover:!bg-[color-mix(in_oklab,var(--git-del)_18%,transparent)]",
          )}
          onClick={onDiscard}
          title="Discard selected files"
          aria-label="Discard"
          type="button"
        >
          {I.discard}
        </button>
      ) : null}
      <span className="flex-1" />
      <button
        className={cn(iconBase, "text-fg-2")}
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
