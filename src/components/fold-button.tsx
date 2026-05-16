import { cn } from "@/lib/utils";

type Props = {
  collapsed: boolean;
  onClick: () => void;
};

/**
 * 16×16 chevron button that toggles hunk collapse state. The svg rotates
 * -90° when collapsed so the same icon reads as both "open" and "closed".
 * Migrated from the legacy `.diff-fold-btn` rule to Tailwind utilities.
 */
export function FoldButton({ collapsed, onClick }: Props) {
  return (
    <button
      type="button"
      className={cn(
        "grid h-4 w-4 place-items-center rounded-[3px] bg-transparent",
        "text-fg-3 cursor-pointer transition-colors duration-100",
        "hover:bg-bg-hover hover:text-fg-1",
        // Animate the chevron rotation. Targeting `[&_svg]` so the
        // transform applies to the inline svg without needing a wrapper.
        "[&_svg]:transition-transform [&_svg]:duration-[120ms]",
        collapsed && "[&_svg]:-rotate-90",
      )}
      onClick={onClick}
      title={collapsed ? "Expand hunk" : "Collapse hunk"}
      aria-label={collapsed ? "Expand hunk" : "Collapse hunk"}
      aria-expanded={!collapsed}
    >
      <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
        <path
          d="M2 3.5 L5 6.5 L8 3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
