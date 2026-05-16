import { useRepoStore, tabKey, type FileTab } from "@/features/repository/repository.store";
import { cn, basename } from "@/lib/utils";
import { I, STATUS_META } from "./icons";

/**
 * Horizontal tab strip at the top of the diff pane. Each tab represents
 * an opened file (path + staged variant); the active one underlined in
 * accent. Migrated from `.tabstrip` / `.tab*` rules to Tailwind utilities.
 *
 * The active-underline is drawn with an `::after` pseudo-element via the
 * `after:` Tailwind variant — same visual as the legacy `.tab.is-active::after`.
 */
export function TabStrip() {
  const tabs = useRepoStore((s) => s.openTabs);
  const selectedFilePath = useRepoStore((s) => s.selectedFilePath);
  const selectedFileStaged = useRepoStore((s) => s.selectedFileStaged);
  const files = useRepoStore((s) => s.files);
  // Subscribe to the referentially-stable Set instead of the full edits
  // map — the Set's identity only changes when membership flips, so typing
  // in an already-dirty file no longer re-renders the tab strip.
  const dirtyPaths = useRepoStore((s) => s.dirtyPaths);
  const selectFile = useRepoStore((s) => s.selectFile);
  const closeTab = useRepoStore((s) => s.closeTab);

  if (tabs.length === 0) return null;

  return (
    <div
      role="tablist"
      className={cn(
        "flex items-stretch h-[30px] shrink-0 bg-bg-1",
        "border-b border-bd-1",
        // Thin horizontal scrollbar — both Firefox (`scrollbar-width`) and
        // WebKit (the arbitrary `[&::-webkit-...]` selectors).
        "overflow-x-auto overflow-y-hidden [scrollbar-width:thin]",
        "[&::-webkit-scrollbar]:h-1",
        "[&::-webkit-scrollbar-thumb]:bg-bd-2 [&::-webkit-scrollbar-thumb]:rounded-[2px]",
      )}
    >
      {tabs.map((t) => {
        const isActive =
          t.path === selectedFilePath && t.staged === selectedFileStaged;
        const changed = files.find(
          (f) => f.path === t.path && f.staged === t.staged,
        );
        const meta = changed ? STATUS_META[changed.status] : null;
        const dirty = dirtyPaths.has(t.path);
        return (
          <TabItem
            key={tabKey(t)}
            tab={t}
            active={isActive}
            statusLetter={meta?.letter ?? null}
            statusColor={meta?.color ?? null}
            stagedHint={t.staged}
            dirty={dirty}
            onActivate={() => selectFile(t.path, t.staged)}
            onClose={() => closeTab(t)}
          />
        );
      })}
    </div>
  );
}

function TabItem({
  tab,
  active,
  statusLetter,
  statusColor,
  stagedHint,
  dirty,
  onActivate,
  onClose,
}: {
  tab: FileTab;
  active: boolean;
  statusLetter: string | null;
  statusColor: string | null;
  stagedHint: boolean | null;
  dirty: boolean;
  onActivate: () => void;
  onClose: () => void;
}) {
  const name = basename(tab.path);
  const variantLabel =
    stagedHint === true ? "staged" : stagedHint === false ? "unstaged" : null;
  return (
    <div
      role="tab"
      aria-selected={active}
      className={cn(
        "group relative inline-flex items-center gap-1.5 pl-2.5 pr-2 h-[30px]",
        "min-w-[110px] max-w-[220px] text-[12px]",
        "border-r border-bd-1 cursor-pointer select-none shrink-0",
        "transition-colors duration-100",
        active
          ? "bg-bg-0 text-fg-0"
          : "bg-transparent text-fg-2 hover:bg-bg-hover hover:text-fg-1",
        // Active underline — a 2px accent bar drawn at the bottom edge,
        // -1px overlap so it sits on top of the parent's border line.
        active &&
          "after:content-[''] after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-accent",
      )}
      onClick={onActivate}
      onMouseDown={(e) => {
        // Middle-click closes (common editor convention).
        if (e.button === 1) {
          e.preventDefault();
          onClose();
        }
      }}
      title={tab.path}
    >
      {statusLetter ? (
        <span
          className="font-mono text-[10.5px] font-semibold w-3 text-center shrink-0"
          style={{ color: statusColor ?? undefined }}
        >
          {statusLetter}
        </span>
      ) : (
        <span className="font-mono text-[10.5px] font-semibold w-3 text-center shrink-0 text-fg-3">
          ·
        </span>
      )}
      <span className="overflow-hidden text-ellipsis whitespace-nowrap flex-1">
        {name}
      </span>
      {variantLabel ? (
        <span className="font-mono text-fg-2 text-[9.5px] uppercase tracking-[0.04em] px-1 py-px rounded-[3px] bg-bg-2 shrink-0">
          {variantLabel}
        </span>
      ) : null}
      <button
        type="button"
        className={cn(
          "grid place-items-center h-4 w-4 rounded-[3px] shrink-0",
          "text-fg-3 bg-transparent",
          "transition-[opacity,background-color,color] duration-100",
          // Visible only on hover / when active; full opacity otherwise.
          active ? "opacity-100" : "opacity-60 group-hover:opacity-100",
          "hover:bg-bg-3 hover:text-fg-0",
          // Close icon is 9px not the default — pulled via arbitrary
          // descendant selector.
          "[&_svg]:h-[9px] [&_svg]:w-[9px]",
        )}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        title={dirty ? "Discard edits and close" : "Close tab (⌘W)"}
        aria-label="Close tab"
      >
        {dirty ? (
          <span className="inline-block h-[7px] w-[7px] rounded-full bg-accent" />
        ) : (
          I.x
        )}
      </button>
    </div>
  );
}
