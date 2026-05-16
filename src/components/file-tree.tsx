import { useEffect, useMemo, useState } from "react";
import { useRepoStore } from "@/features/repository/repository.store";
import {
  ancestorsOf,
  buildTree,
  flattenTree,
  type TreeNode,
} from "@/lib/tree";
import { cn } from "@/lib/utils";
import { I, STATUS_META } from "./icons";

/**
 * Shared style fragments for the Files tab tree. Each row is a 22px flex
 * line with chevron · icon · name · status-letter. The chevron and icon
 * have fixed widths so names align across rows regardless of depth.
 */
const WRAP = "text-[12px] pt-1 pb-3 select-none";
const LOADING = "font-mono text-fg-2 text-[11.5px] px-4 py-5 text-center";
const ROW =
  "flex items-center gap-[3px] h-[22px] pr-2 cursor-pointer whitespace-nowrap " +
  "transition-[background-color] duration-100 border-l-2 border-l-transparent " +
  "hover:bg-bg-hover";
const ROW_SELECTED = "!bg-bg-selected !border-l-accent";
// Group chevron — rotates from -90° (closed) to 0° (open). Same shape as
// the one in `search-panel.tsx`; kept local because there's no shared util
// for it yet.
const CHEV =
  "grid place-items-center shrink-0 w-3 text-fg-3 -rotate-90 " +
  "transition-transform duration-[120ms]";
const ICON_BASE = "grid place-items-center shrink-0 w-[14px]";
const NAME = "flex-1 min-w-0 overflow-hidden text-ellipsis text-fg-1";
const NAME_DIR = "!text-fg-0 font-medium";
const STATUS_LETTER =
  "font-mono text-[10px] font-semibold px-[5px] py-px rounded-[3px] bg-bg-2";

export function FileTree() {
  const repoFiles = useRepoStore((s) => s.repoFiles);
  const repoFilesLoading = useRepoStore((s) => s.repoFilesLoading);
  const fetchRepoFiles = useRepoStore((s) => s.fetchRepoFiles);
  // Include the repo path so the effect re-fires when the user switches
  // projects (the previous repo's `repoFiles` is reset to [] in the store,
  // but a stable `fetchRepoFiles` ref meant this effect never re-ran).
  const repoPath = useRepoStore((s) => s.repository?.path);
  const files = useRepoStore((s) => s.files);
  const selectedFilePath = useRepoStore((s) => s.selectedFilePath);
  const selectFile = useRepoStore((s) => s.selectFile);

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (!repoPath) return;
    fetchRepoFiles().catch(() => {
      /* error already surfaced */
    });
  }, [repoPath, fetchRepoFiles]);

  const tree = useMemo<TreeNode>(() => buildTree(repoFiles), [repoFiles]);

  const changedByPath = useMemo(() => {
    const m = new Map<string, (typeof files)[number]>();
    files.forEach((f) => m.set(f.path, f));
    return m;
  }, [files]);

  // Auto-expand ancestors of the selected file so the active row is visible.
  useEffect(() => {
    if (!selectedFilePath) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      ancestorsOf(selectedFilePath).forEach((p) => next.add(p));
      return next;
    });
  }, [selectedFilePath]);

  const rows = useMemo(() => flattenTree(tree, expanded), [tree, expanded]);

  function toggle(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  if (repoFilesLoading && repoFiles.length === 0) {
    return <div className={LOADING}>Indexing repository…</div>;
  }
  if (repoFiles.length === 0) {
    return <div className={LOADING}>No files found.</div>;
  }

  return (
    <div className={WRAP}>
      {rows.map((row) => {
        const isDir = row.node.kind === "dir";
        const isSelected = !isDir && row.node.path === selectedFilePath;
        const changed = changedByPath.get(row.node.path);
        const meta = changed ? STATUS_META[changed.status] : null;
        // Icon color depends on kind + open state: open dir = accent,
        // closed dir = fg-2, file = fg-3.
        const iconColor = isDir
          ? row.isOpen
            ? "text-accent"
            : "text-fg-2"
          : "text-fg-3";
        return (
          <div
            key={row.node.path}
            className={cn(ROW, isSelected && ROW_SELECTED)}
            style={{ paddingLeft: 4 + row.depth * 6 }}
            onClick={() => {
              if (isDir) toggle(row.node.path);
              else selectFile(row.node.path, null);
            }}
            title={row.node.name}
          >
            {isDir ? (
              <span className={cn(CHEV, row.isOpen && "rotate-0")}>
                {I.chevron}
              </span>
            ) : null}
            <span className={cn(ICON_BASE, iconColor)}>
              {isDir
                ? row.isOpen
                  ? I.folderOpen
                  : I.folder
                : I.fileSmall}
            </span>
            <span className={cn(NAME, isDir && NAME_DIR)}>
              {row.node.name}
            </span>
            {meta ? (
              <span
                className={STATUS_LETTER}
                style={{ color: meta.color }}
                title={meta.label}
              >
                {meta.letter}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
