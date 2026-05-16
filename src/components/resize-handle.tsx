import { useRepoStore } from "@/features/repository/repository.store";
import { cn } from "@/lib/utils";

/**
 * Drag-past-this distance below the minimum width to auto-collapse the
 * sidebar. Mirrors VS Code's "if you really push, we'll hide it"
 * affordance.
 */
const COLLAPSE_THRESHOLD = 180;

/**
 * Gap between workspace bubbles in the app layout, in pixels — must match
 * the parent's `gap-1` (Tailwind 1 = 4px). The resize handles sit exactly
 * inside this strip so the user grabs the visible space *between* the
 * floating cards rather than the rounded edge of one of them.
 */
const GAP_PX = 4;

const HANDLE_BASE =
  "absolute z-20 bg-transparent rounded-full " +
  // Delayed transition: only paint the accent if the cursor lingers,
  // not on a casual flyby — keeps the gap visually quiet during normal
  // mouse travel.
  "[transition:background-color_100ms_80ms] " +
  "hover:bg-[color-mix(in_oklab,var(--accent)_40%,transparent)] " +
  "active:bg-[color-mix(in_oklab,var(--accent)_40%,transparent)] " +
  "hover:[transition-delay:0ms] active:[transition-delay:0ms]";

/**
 * Vertical drag strip that lives in the gap between the left sidebar and
 * the main pane. Positions itself absolutely in the parent grid using
 * the live sidebar width — the parent only needs `position: relative` and
 * to render this as a sibling of the sidebar / main column.
 *
 * Drag-past-min auto-collapses the sidebar (see COLLAPSE_THRESHOLD).
 */
export function SidebarResizeHandle() {
  const visible = useRepoStore((s) => s.settings.leftSidebarVisible);
  const width = useRepoStore((s) => s.settings.leftSidebarWidth);
  const setWidth = useRepoStore((s) => s.setLeftSidebarWidth);
  const setVisible = useRepoStore((s) => s.setLeftSidebarVisible);

  if (!visible) return null;

  function onMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;

    function release() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }

    function onMove(ev: MouseEvent) {
      const dx = ev.clientX - startX;
      const requested = startWidth + dx;
      if (requested < COLLAPSE_THRESHOLD) {
        setVisible(false);
        release();
        return;
      }
      setWidth(requested);
    }
    function onUp() {
      release();
    }
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  return (
    <div
      className={cn(HANDLE_BASE, "top-0 bottom-0 cursor-col-resize")}
      style={{ left: `${width}px`, width: `${GAP_PX}px` }}
      onMouseDown={onMouseDown}
      role="separator"
      aria-orientation="vertical"
    />
  );
}

/**
 * Horizontal drag strip in the gap between the main pane and the
 * terminal drawer. Lives in the parent flex column and uses
 * `bottom: terminalHeight` to sit right above the drawer.
 *
 * Only renders when the drawer is visible — otherwise the gap doesn't
 * exist and there's nothing to resize.
 */
export function TerminalResizeHandle() {
  const visible = useRepoStore(
    (s) => s.terminalOpen && s.terminalSessionAlive,
  );
  const height = useRepoStore((s) => s.terminalHeight);
  const setHeight = useRepoStore((s) => s.setTerminalHeight);

  if (!visible) return null;

  function onMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;

    function release() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }

    function onMove(ev: MouseEvent) {
      const dy = startY - ev.clientY;
      setHeight(startH + dy);
    }
    function onUp() {
      release();
    }
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  return (
    <div
      className={cn(HANDLE_BASE, "left-0 right-0 cursor-row-resize")}
      style={{ bottom: `${height}px`, height: `${GAP_PX}px` }}
      onMouseDown={onMouseDown}
      role="separator"
      aria-orientation="horizontal"
    />
  );
}
