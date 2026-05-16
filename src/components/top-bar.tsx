import { useRepoStore } from "@/features/repository/repository.store";
import { cn } from "@/lib/utils";
import { I } from "./icons";
import { IconBtn } from "./icon-btn";
import { RepoMenu } from "./repo-menu";
import { BranchMenu } from "./branch-menu";
import { EditorMenu } from "./editor-menu";
import { GitMenu } from "./git-menu";

/**
 * Common pill styling for the repo / branch / git-AI triggers along the
 * top-left and top-right. Same height, padding, radius, transition — the
 * difference is in the icons + label content. Pulled into a constant so
 * a tweak to "the pill look" is one edit.
 */
const PILL_BASE =
  "inline-flex items-center gap-1.5 h-6 px-2 rounded-2 bg-transparent " +
  "text-fg-1 text-[12px] transition-colors duration-[120ms]";
const PILL_HOVER = "hover:bg-bg-hover hover:text-fg-0";
const PILL_ACTIVE = "bg-bg-active text-fg-0";

/**
 * Floating-card application header. Houses the repo / branch pills on the
 * left, and the Git/AI pill + editor launcher + view toggles on the
 * right. The submenus (RepoMenu, BranchMenu, EditorMenu, GitMenu) live as
 * absolutely-positioned children anchored to their respective triggers.
 *
 * Migrated from the `.topbar`, `.topbar-*`, `.repo-pill`, `.branch-pill`,
 * `.git-pill`, `.editor-launcher*` rules. Menu components still own their
 * own CSS for now (Wave 5).
 */
export function TopBar() {
  const repository = useRepoStore((s) => s.repository);
  const setSettingsOpen = useRepoStore((s) => s.setSettingsOpen);
  const repoMenuOpen = useRepoStore((s) => s.repoMenuOpen);
  const setRepoMenuOpen = useRepoStore((s) => s.setRepoMenuOpen);
  const branchMenuOpen = useRepoStore((s) => s.branchMenuOpen);
  const setBranchMenuOpen = useRepoStore((s) => s.setBranchMenuOpen);
  const openProjectInVscode = useRepoStore((s) => s.openProjectInVscode);
  const editorMenuOpen = useRepoStore((s) => s.editorMenuOpen);
  const setEditorMenuOpen = useRepoStore((s) => s.setEditorMenuOpen);
  const fetchEditors = useRepoStore((s) => s.fetchEditors);
  const leftSidebarVisible = useRepoStore(
    (s) => s.settings.leftSidebarVisible,
  );
  const toggleLeftSidebar = useRepoStore((s) => s.toggleLeftSidebar);
  const terminalOpen = useRepoStore((s) => s.terminalOpen);
  const toggleTerminal = useRepoStore((s) => s.toggleTerminal);
  const gitMenuOpen = useRepoStore((s) => s.gitMenuOpen);
  const setGitMenuOpen = useRepoStore((s) => s.setGitMenuOpen);
  const aiKind = useRepoStore((s) => s.aiKind);

  return (
    <header
      data-tauri-drag-region
      className={cn(
        // Layout. `pl-[var(--traffic-lights-w)]` preserves the macOS
        // traffic-lights gap on the left.
        "relative z-40 flex items-center gap-1.5 shrink-0 h-[var(--topbar-h)]",
        "pl-[var(--traffic-lights-w)] pr-2.5 whitespace-nowrap select-none",
        // Floating-card visual — matches sidebar / main-col / terminal.
        "bg-[color-mix(in_oklab,var(--bg-1)_88%,transparent)]",
        "border border-bd-2 rounded-[10px] shadow-card",
        "backdrop-blur-card backdrop-saturate-[140%]",
      )}
    >
      <div
        data-tauri-drag-region
        className="flex items-center gap-1.5 flex-1 min-w-0"
      >
        <div className="relative">
          <button
            // RepoMenu queries this attribute to detect "click on trigger"
            // for its outside-click logic.
            data-repo-pill-trigger
            className={cn(
              PILL_BASE,
              PILL_HOVER,
              repoMenuOpen && PILL_ACTIVE,
            )}
            title="Switch project"
            onClick={() => {
              setRepoMenuOpen(!repoMenuOpen);
              if (branchMenuOpen) setBranchMenuOpen(false);
            }}
          >
            <span className="inline-flex text-fg-2">{I.folder}</span>
            <span className="font-medium">
              {repository?.name ?? "Open repository…"}
            </span>
            <span className="grid place-items-center text-fg-3">
              {I.chevron}
            </span>
          </button>
          <RepoMenu />
        </div>
        {repository ? (
          <div className="relative">
            <button
              // BranchMenu queries this attribute for its outside-click logic.
              data-branch-pill-trigger
              className={cn(
                PILL_BASE,
                PILL_HOVER,
                branchMenuOpen && PILL_ACTIVE,
              )}
              title={
                repository.remote
                  ? `Tracking ${repository.remote} — click to switch`
                  : "Switch branch"
              }
              onClick={() => {
                setBranchMenuOpen(!branchMenuOpen);
                if (repoMenuOpen) setRepoMenuOpen(false);
              }}
            >
              <span className="inline-flex text-fg-2">{I.branch}</span>
              <span className="font-mono text-fg-1">
                {repository.currentBranch || "(detached)"}
              </span>
              {repository.ahead > 0 ? (
                <span className="font-mono text-[10.5px] text-accent bg-accent-soft px-[5px] py-px rounded-[3px]">
                  ↑{repository.ahead}
                </span>
              ) : null}
              <span className="grid place-items-center text-fg-3">
                {I.chevron}
              </span>
            </button>
            <BranchMenu />
          </div>
        ) : null}
      </div>

      <div
        data-tauri-drag-region
        className="flex items-center gap-1.5"
      >
        <button
          className={cn(
            PILL_BASE,
            !repository
              ? "opacity-40 cursor-not-allowed"
              : cn(PILL_HOVER, gitMenuOpen && PILL_ACTIVE),
            // Subtle accent pulse while an AI action is running.
            aiKind && repository && "text-accent",
          )}
          data-git-menu-trigger
          onClick={() => setGitMenuOpen(!gitMenuOpen)}
          disabled={!repository}
          title="Git · AI assist (commit, PR, summary, risk)"
          type="button"
        >
          <span
            className={cn(
              "inline-flex text-fg-2",
              aiKind && repository && "text-accent",
            )}
          >
            {I.git}
          </span>
          <span className="font-medium">Git</span>
          <span className="grid place-items-center text-fg-3">
            {I.chevron}
          </span>
        </button>
        <GitMenu />
        <EditorLauncher
          disabled={!repository}
          menuOpen={editorMenuOpen}
          onOpen={() => {
            openProjectInVscode();
            fetchEditors().catch(() => {
              /* warm cache for next chevron click */
            });
          }}
          onMenuToggle={() => setEditorMenuOpen(!editorMenuOpen)}
        />
        <IconBtn
          title="Toggle left sidebar (⌘B)"
          onClick={toggleLeftSidebar}
          active={leftSidebarVisible}
        >
          {I.sidebarLeft}
        </IconBtn>
        <IconBtn
          title="Toggle terminal (⌘`)"
          onClick={toggleTerminal}
          active={terminalOpen}
        >
          {I.panelBottom}
        </IconBtn>
        {/* Keyboard-shortcuts is reachable from inside Preferences (footer
            link) and via the command palette — leaving it out keeps this
            row focused on per-repo actions. */}
        <IconBtn
          title="Preferences (⌘,)"
          onClick={() => setSettingsOpen(true)}
        >
          {I.gear}
        </IconBtn>
      </div>
    </header>
  );
}

/**
 * Split-button: main action (open project in preferred editor) + chevron
 * (pick which editor). Wrapper highlights as one cohesive pill on hover /
 * when the menu is open; a hair-line divider tells the user the two
 * halves are distinct actions.
 */
function EditorLauncher({
  disabled,
  menuOpen,
  onOpen,
  onMenuToggle,
}: {
  disabled: boolean;
  menuOpen: boolean;
  onOpen: () => void;
  onMenuToggle: () => void;
}) {
  // Whether the whole pill should look "hot" (hovered or menu open).
  const hot = !disabled && menuOpen;
  return (
    <div
      className={cn(
        "relative inline-flex items-stretch h-6 rounded-2 bg-transparent",
        "transition-colors duration-[120ms]",
        !disabled && "hover:bg-bg-hover",
        hot && "bg-bg-active",
      )}
    >
      <button
        type="button"
        className={cn(
          "grid place-items-center h-6 w-6 rounded-l-2 bg-transparent border-0",
          "text-fg-2 cursor-pointer transition-colors duration-[120ms]",
          !disabled && "group-hover:text-fg-0 hover:text-fg-0",
          hot && "text-fg-0",
          disabled && "text-fg-3 cursor-default",
        )}
        onClick={onOpen}
        disabled={disabled}
        title="Open project in your preferred editor"
      >
        {I.code}
      </button>
      <button
        type="button"
        // EditorMenu uses this attribute to anchor its portal-mounted
        // dropdown beneath this chevron (and to detect "click on the
        // trigger" for the close-on-outside-click logic).
        data-editor-launcher-trigger
        className={cn(
          "grid place-items-center h-6 w-4 rounded-r-2 bg-transparent border-0",
          "text-fg-2 cursor-pointer transition-colors duration-[120ms]",
          // Hair-line divider between halves. Stays subtle by default and
          // brightens a notch when the pill is hot.
          "shadow-[inset_1px_0_0_var(--bd-2)]",
          !disabled && "hover:shadow-[inset_1px_0_0_var(--bd-1)] hover:text-fg-0",
          hot && "text-fg-0 shadow-[inset_1px_0_0_var(--bd-1)]",
          disabled && "text-fg-3 cursor-default",
          // Inner svg is smaller than the icon font-size default.
          "[&_svg]:h-[9px] [&_svg]:w-[9px]",
        )}
        onClick={onMenuToggle}
        disabled={disabled}
        title="Choose editor"
      >
        {I.chevron}
      </button>
      <EditorMenu />
    </div>
  );
}
