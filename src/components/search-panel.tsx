import { useEffect, useMemo, useRef, useState } from "react";
import { useRepoStore } from "@/features/repository/repository.store";
import type {
  SearchResult,
  SearchScope,
} from "@/features/search/search.types";
import { buildTree, type TreeNode } from "@/lib/tree";
import { cn } from "@/lib/utils";
import { I } from "./icons";
import { Button } from "@/components/ui/button";

type FileGroup = { filePath: string; items: SearchResult[] };

/**
 * Shared style fragments for the search panel + its result rows. The head
 * (`HEAD`) mirrors the inline layout used by Sidebar's Changes tab so the
 * three tab heads visually align (gap, padding, border-bottom).
 *
 * Result rows: `.sb-sr-group-*` (list view) + `.sb-tree-row` (tree view).
 * Both share the same hover bg + truncate-on-overflow patterns; pulled into
 * constants so the two views stay consistent.
 */
const HEAD =
  "flex flex-col gap-2 px-2.5 pt-2.5 pb-2 border-b border-bd-1";
const INPUT_ROW =
  "flex items-center gap-1.5 h-7 px-2 rounded-2 bg-bg-2 border border-bd-2 " +
  "focus-within:border-accent";
const FLAGS_ROW =
  "flex items-center gap-1 flex-wrap gap-y-1";
const STATUS_ROW = "flex items-center gap-2 pt-1";
const FILTERS = "flex flex-col gap-1 pt-1.5";
const FILTER_ROW = "flex flex-col gap-0.5";
const FILTER_LABEL = "text-[10.5px] text-fg-3 pl-0.5";
const FILTER_INPUT =
  "h-6 px-2 text-[12px] rounded-2 bg-bg-2 border border-bd-2 text-fg-0 outline-none " +
  "placeholder:text-fg-3 focus:border-accent";
const SCOPE_BTN_BASE =
  "text-[10.5px] px-1.5 py-0.5 rounded-[3px] text-fg-2 bg-transparent " +
  "border border-transparent whitespace-nowrap shrink-0 " +
  "hover:text-fg-0 hover:bg-bg-hover";
const SCOPE_BTN_ACTIVE = "!bg-bg-active !text-fg-0 !border-bd-2";
const SCOPE_BTN_DISABLED = "opacity-40 cursor-default hover:!bg-transparent";
const STATUS_LABEL = "text-fg-2 text-[10.5px] pt-0.5";

// Mini-toggle pill (Aa / .* / details). Same shape as the one used in
// `replace-overlay.tsx` and `in-file-search-bar.tsx`; kept duplicated
// rather than promoted to a shared util — they don't already share a
// dependency, and the constants are short.
const FLAG_BASE =
  "inline-flex items-center justify-center min-w-6 h-[22px] px-1.5 " +
  "rounded-[4px] border border-transparent font-mono text-[11px] text-fg-3 " +
  "bg-transparent hover:text-fg-0 hover:bg-bg-3 [&_svg]:block";
const FLAG_ON =
  "!bg-accent-soft !text-accent " +
  "!border-[color-mix(in_oklab,var(--accent)_40%,transparent)]";

const VIEW_TOGGLE =
  "inline-flex items-center gap-px p-px bg-bg-2 border border-bd-1 rounded-[4px] shrink-0";
const VIEW_BTN_BASE =
  "grid place-items-center w-5 h-[18px] rounded-[3px] text-fg-3 bg-transparent border-0 " +
  "hover:text-fg-0";
const VIEW_BTN_ACTIVE = "!bg-bg-active !text-fg-0";

// List of result groups (one group per file).
const LIST_WRAP =
  "flex-1 overflow-y-auto [scrollbar-width:thin] [scrollbar-color:var(--bd-2)_transparent]";
const SR_GROUP = "border-b border-bd-0";
const SR_GROUP_HEAD =
  "grid grid-cols-[14px_1fr_auto] items-center gap-1.5 px-2 pr-2.5 py-[5px] w-full " +
  "text-left text-[11px] bg-transparent border-0 hover:bg-bg-hover";
const SR_GROUP_PATH =
  "font-mono text-[11px] text-fg-1 whitespace-nowrap overflow-hidden text-ellipsis " +
  "[direction:rtl] text-left";
// Compact count badge — same look as the sidebar count chips.
const SR_GROUP_COUNT =
  "font-mono text-[10px] text-fg-3 bg-white/[0.04] px-[5px] py-px rounded-[3px] " +
  "[:root[data-theme='light']_&]:bg-black/[0.05]";
const SR_GROUP_BODY = "flex flex-col";
const SR_HIT =
  "grid grid-cols-[32px_1fr] items-baseline gap-1.5 px-2.5 py-[3px] pl-4 w-full " +
  "text-left text-[11.5px] leading-[1.5] bg-transparent border-0 hover:bg-bg-hover";
const SR_LINE_NUM = "font-mono text-fg-2 text-right text-[10px] pr-1.5";
const SR_LINE_TEXT =
  "font-mono text-fg-1 overflow-hidden text-ellipsis whitespace-nowrap " +
  "[&_mark]:bg-accent-soft [&_mark]:text-fg-0 [&_mark]:px-px [&_mark]:rounded-[2px]";

// Tree-view row (folder/file with chevron + icon + name + count). Chevron
// is 12px; icon is 14px. Both stay fixed-width via their own constants
// (`CHEV` / `TREE_ICON_BASE`) so names line up across rows.
const TREE_ROW =
  "flex items-center gap-[3px] h-[22px] pr-2 w-full text-left text-[12px] whitespace-nowrap " +
  "bg-transparent border-0 hover:bg-bg-hover";
// Group chevron used by list groups + tree rows. Rotates from -90° (closed)
// to 0° (open) with a 120ms ease. Pulled here so a tweak to chevron color /
// size is one edit.
const CHEV =
  "grid place-items-center shrink-0 w-3 text-fg-3 -rotate-90 " +
  "transition-transform duration-[120ms]";
const TREE_ICON_BASE = "grid place-items-center shrink-0 w-[14px]";
const TREE_NAME =
  "flex-1 min-w-0 overflow-hidden text-ellipsis text-fg-1";
const TREE_NAME_DIR = "!text-fg-0 font-medium";

const EMPTY = "font-mono text-fg-2 text-[11.5px] px-4 py-5 text-center";

export function SearchPanel() {
  const repo = useRepoStore((s) => s.repository);
  const selectedFilePath = useRepoStore((s) => s.selectedFilePath);
  const query = useRepoStore((s) => s.searchQuery);
  const scope = useRepoStore((s) => s.searchScope);
  const caseSensitive = useRepoStore((s) => s.searchCaseSensitive);
  const regex = useRepoStore((s) => s.searchRegex);
  const include = useRepoStore((s) => s.searchInclude);
  const exclude = useRepoStore((s) => s.searchExclude);
  const filtersOpen = useRepoStore((s) => s.searchFiltersOpen);
  const results = useRepoStore((s) => s.searchResults);
  const loading = useRepoStore((s) => s.searchLoading);
  const focusNonce = useRepoStore((s) => s.searchFocusNonce);
  const searchView = useRepoStore((s) => s.settings.searchView);

  const setSearchQuery = useRepoStore((s) => s.setSearchQuery);
  const setSearchScope = useRepoStore((s) => s.setSearchScope);
  const setSearchCaseSensitive = useRepoStore((s) => s.setSearchCaseSensitive);
  const setSearchRegex = useRepoStore((s) => s.setSearchRegex);
  const setSearchInclude = useRepoStore((s) => s.setSearchInclude);
  const setSearchExclude = useRepoStore((s) => s.setSearchExclude);
  const setFiltersOpen = useRepoStore((s) => s.setSearchFiltersOpen);
  const runRepoSearch = useRepoStore((s) => s.runRepoSearch);
  const setSearchView = useRepoStore((s) => s.setSearchView);
  const selectFile = useRepoStore((s) => s.selectFile);
  const pushToast = useRepoStore((s) => s.pushToast);

  const inputRef = useRef<HTMLInputElement | null>(null);

  // Folders/files the user has collapsed. Empty = everything expanded by
  // default. New search results don't reset this — keeps the user's choices
  // sticky across debounced re-searches.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusNonce]);

  useEffect(() => {
    if (!repo) return;
    const handle = setTimeout(() => {
      runRepoSearch();
    }, 180);
    return () => clearTimeout(handle);
  }, [
    repo,
    query,
    scope,
    caseSensitive,
    regex,
    include,
    exclude,
    selectedFilePath,
    runRepoSearch,
  ]);

  const grouped: FileGroup[] = useMemo(() => groupByFile(results), [results]);

  const jump = (hit: SearchResult) => {
    selectFile(hit.filePath, null);
    pushToast(`Jumped to ${hit.filePath}:${hit.lineNumber}`);
  };

  return (
    <>
      <div className={HEAD}>
        <div className={INPUT_ROW}>
          <span className="grid place-items-center shrink-0 text-fg-3">{I.search}</span>
          <input
            ref={inputRef}
            className="flex-1 min-w-0 h-full text-[12px] bg-transparent border-0 outline-none text-fg-0 placeholder:text-fg-3"
            type="text"
            value={query}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Find in repository"
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
          />
          {query ? (
            <Button variant="unstyled"
              className="grid place-items-center p-0.5 bg-transparent border-0 text-fg-3 hover:text-fg-0"
              onClick={() => setSearchQuery("")}
              title="Clear"
            >
              {I.x}
            </Button>
          ) : null}
        </div>
        <div className={FLAGS_ROW}>
          <ScopeBtn
            current={scope}
            value="all"
            onClick={setSearchScope}
            label="All files"
          />
          <ScopeBtn
            current={scope}
            value="changed"
            onClick={setSearchScope}
            label="Changed"
          />
          <ScopeBtn
            current={scope}
            value="current"
            onClick={setSearchScope}
            label="Current"
            disabled={!selectedFilePath}
          />
          <span className="flex-1" />
          <Button variant="unstyled"
            className={cn(FLAG_BASE, caseSensitive && FLAG_ON)}
            onClick={() => setSearchCaseSensitive(!caseSensitive)}
            title="Match case"
          >
            Aa
          </Button>
          <Button variant="unstyled"
            className={cn(FLAG_BASE, regex && FLAG_ON)}
            onClick={() => setSearchRegex(!regex)}
            title="Regex"
          >
            .*
          </Button>
          <Button variant="unstyled"
            className={cn(
              FLAG_BASE,
              (filtersOpen || include || exclude) && FLAG_ON,
            )}
            onClick={() => setFiltersOpen(!filtersOpen)}
            title="Toggle search details (files to include/exclude)"
            aria-label="Toggle search details"
          >
            {I.ellipsis}
          </Button>
        </div>
        {filtersOpen ? (
          <div className={FILTERS}>
            <label className={FILTER_ROW}>
              <span className={FILTER_LABEL}>Files to include</span>
              <input
                className={FILTER_INPUT}
                type="text"
                value={include}
                onChange={(e) => setSearchInclude(e.target.value)}
                placeholder="e.g. *.ts, src/**"
                autoCapitalize="off"
                autoCorrect="off"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label className={FILTER_ROW}>
              <span className={FILTER_LABEL}>Files to exclude</span>
              <input
                className={FILTER_INPUT}
                type="text"
                value={exclude}
                onChange={(e) => setSearchExclude(e.target.value)}
                placeholder="e.g. **/node_modules, dist"
                autoCapitalize="off"
                autoCorrect="off"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          </div>
        ) : null}
        <div className={STATUS_ROW}>
          <span className={STATUS_LABEL}>
            {loading
              ? "Searching…"
              : query.trim() === ""
                ? "Type to search"
                : `${results.length} match${results.length === 1 ? "" : "es"} in ${grouped.length} file${grouped.length === 1 ? "" : "s"}`}
          </span>
          <span className="flex-1" />
          <div className={VIEW_TOGGLE}>
            <Button variant="unstyled"
              className={cn(VIEW_BTN_BASE, searchView === "list" && VIEW_BTN_ACTIVE)}
              onClick={() => setSearchView("list")}
              title="View as list"
              type="button"
            >
              {I.viewList}
            </Button>
            <Button variant="unstyled"
              className={cn(VIEW_BTN_BASE, searchView === "tree" && VIEW_BTN_ACTIVE)}
              onClick={() => setSearchView("tree")}
              title="View as tree"
              type="button"
            >
              {I.viewTree}
            </Button>
          </div>
        </div>
      </div>
      <div className={LIST_WRAP}>
        {grouped.length === 0 && query.trim() !== "" && !loading ? (
          <div className={EMPTY}>
            <div>No matches.</div>
          </div>
        ) : null}
        {searchView === "list" ? (
          <ListView
            groups={grouped}
            query={query}
            caseSensitive={caseSensitive}
            regex={regex}
            collapsed={collapsed}
            onToggle={toggle}
            onJump={jump}
          />
        ) : (
          <TreeView
            groups={grouped}
            query={query}
            caseSensitive={caseSensitive}
            regex={regex}
            collapsed={collapsed}
            onToggle={toggle}
            onJump={jump}
          />
        )}
      </div>
    </>
  );
}

// ---------- list view ----------

function ListView({
  groups,
  query,
  caseSensitive,
  regex,
  collapsed,
  onToggle,
  onJump,
}: {
  groups: FileGroup[];
  query: string;
  caseSensitive: boolean;
  regex: boolean;
  collapsed: Set<string>;
  onToggle: (path: string) => void;
  onJump: (hit: SearchResult) => void;
}) {
  return (
    <>
      {groups.map((g) => {
        const open = !collapsed.has(g.filePath);
        return (
          <div key={g.filePath} className={SR_GROUP}>
            <Button variant="unstyled"
              className={SR_GROUP_HEAD}
              onClick={() => onToggle(g.filePath)}
              title={g.filePath}
            >
              <span className={cn(CHEV, open && "rotate-0")}>
                {I.chevron}
              </span>
              <span className={SR_GROUP_PATH}>{g.filePath}</span>
              <span className={SR_GROUP_COUNT}>{g.items.length}</span>
            </Button>
            {open ? (
              <div className={SR_GROUP_BODY}>
                {g.items.map((h, i) => (
                  <HitRow
                    key={`${h.filePath}:${h.lineNumber}:${i}`}
                    hit={h}
                    query={query}
                    caseSensitive={caseSensitive}
                    regex={regex}
                    onJump={onJump}
                  />
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </>
  );
}

// ---------- tree view ----------

function TreeView({
  groups,
  query,
  caseSensitive,
  regex,
  collapsed,
  onToggle,
  onJump,
}: {
  groups: FileGroup[];
  query: string;
  caseSensitive: boolean;
  regex: boolean;
  collapsed: Set<string>;
  onToggle: (path: string) => void;
  onJump: (hit: SearchResult) => void;
}) {
  const tree = useMemo(
    () => buildTree(groups.map((g) => g.filePath)),
    [groups],
  );
  const byPath = useMemo(
    () => new Map(groups.map((g) => [g.filePath, g.items])),
    [groups],
  );
  // Aggregate match count by directory (sum of descendant file matches).
  const folderCounts = useMemo(() => {
    const counts = new Map<string, number>();
    function walk(node: TreeNode): number {
      if (node.kind === "file") return byPath.get(node.path)?.length ?? 0;
      const total =
        node.children?.reduce((acc, c) => acc + walk(c), 0) ?? 0;
      if (node.path) counts.set(node.path, total);
      return total;
    }
    walk(tree);
    return counts;
  }, [tree, byPath]);

  function renderNode(node: TreeNode, depth: number): React.ReactNode[] {
    if (node.kind === "dir") {
      const open = !collapsed.has(node.path);
      const count = folderCounts.get(node.path) ?? 0;
      const out: React.ReactNode[] = [
        <Button variant="unstyled"
          key={`dir:${node.path}`}
          className={TREE_ROW}
          style={{ paddingLeft: 4 + depth * 6 }}
          onClick={() => onToggle(node.path)}
          title={node.path}
        >
          <span className={cn(CHEV, open && "rotate-0")}>
            {I.chevron}
          </span>
          <span
            className={cn(TREE_ICON_BASE, open ? "text-accent" : "text-fg-2")}
          >
            {open ? I.folderOpen : I.folder}
          </span>
          <span className={cn(TREE_NAME, TREE_NAME_DIR)}>{node.name}</span>
          <span className={SR_GROUP_COUNT}>{count}</span>
        </Button>,
      ];
      if (open) {
        node.children?.forEach((c) => {
          out.push(...renderNode(c, depth + 1));
        });
      }
      return out;
    }

    // file
    const hits = byPath.get(node.path) ?? [];
    const open = !collapsed.has(node.path);
    const out: React.ReactNode[] = [
      <Button variant="unstyled"
        key={`file:${node.path}`}
        className={TREE_ROW}
        style={{ paddingLeft: 4 + depth * 6 }}
        onClick={() => onToggle(node.path)}
        title={node.path}
      >
        <span className={cn(CHEV, open && "rotate-0")}>
          {I.chevron}
        </span>
        <span className={cn(TREE_ICON_BASE, "text-fg-3")}>{I.fileSmall}</span>
        <span className={TREE_NAME}>{node.name}</span>
        <span className={SR_GROUP_COUNT}>{hits.length}</span>
      </Button>,
    ];
    if (open) {
      hits.forEach((h, i) => {
        out.push(
          <HitRow
            key={`hit:${node.path}:${h.lineNumber}:${i}`}
            hit={h}
            query={query}
            caseSensitive={caseSensitive}
            regex={regex}
            onJump={onJump}
            depth={depth + 1}
          />,
        );
      });
    }
    return out;
  }

  return <>{tree.children?.flatMap((c) => renderNode(c, 0))}</>;
}

// ---------- shared bits ----------

function HitRow({
  hit,
  query,
  caseSensitive,
  regex,
  onJump,
  depth,
}: {
  hit: SearchResult;
  query: string;
  caseSensitive: boolean;
  regex: boolean;
  onJump: (hit: SearchResult) => void;
  depth?: number;
}) {
  const padLeft = depth != null ? 4 + depth * 6 : undefined;
  return (
    <Button variant="unstyled"
      className={SR_HIT}
      onClick={() => onJump(hit)}
      style={padLeft != null ? { paddingLeft: padLeft } : undefined}
      title={`Line ${hit.lineNumber}`}
    >
      <span className={SR_LINE_NUM}>{hit.lineNumber}</span>
      <span className={SR_LINE_TEXT}>
        {renderHitLine(hit.lineText, query, caseSensitive, regex)}
      </span>
    </Button>
  );
}

function ScopeBtn({
  current,
  value,
  onClick,
  label,
  disabled,
}: {
  current: SearchScope;
  value: SearchScope;
  onClick: (v: SearchScope) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <Button variant="unstyled"
      type="button"
      disabled={disabled}
      onClick={() => onClick(value)}
      className={cn(
        SCOPE_BTN_BASE,
        current === value && SCOPE_BTN_ACTIVE,
        disabled && SCOPE_BTN_DISABLED,
      )}
      title={`Scope: ${label}`}
    >
      {label}
    </Button>
  );
}

function groupByFile(results: SearchResult[]): FileGroup[] {
  const map = new Map<string, SearchResult[]>();
  for (const r of results) {
    const list = map.get(r.filePath) ?? [];
    list.push(r);
    map.set(r.filePath, list);
  }
  return [...map.entries()].map(([filePath, items]) => ({ filePath, items }));
}

function renderHitLine(
  line: string,
  match: string,
  cs: boolean,
  isRegex: boolean,
) {
  if (!match) return <span>{line}</span>;
  try {
    const pattern = isRegex
      ? match
      : match.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(${pattern})`, cs ? "g" : "gi");
    const parts = line.split(re);
    return parts.map((p, i) => {
      const isMatch = i % 2 === 1;
      return isMatch ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>;
    });
  } catch {
    return <span>{line}</span>;
  }
}
