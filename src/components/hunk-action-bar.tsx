import { cn } from "@/lib/utils";
import { I, type IconName } from "./icons";

export type HunkPrimaryAction = {
  kind: "stage" | "unstage";
  label: string;
  onClick: (hunkIdx: number) => void;
};

export type HunkActions = {
  primary: HunkPrimaryAction;
  revert?: { label: string; onClick: (hunkIdx: number) => void };
};

type Props = {
  hunkIdx: number;
  actions: HunkActions;
};

const PRIMARY_ICON: Record<HunkPrimaryAction["kind"], IconName> = {
  stage: "plus",
  unstage: "minus",
};

/**
 * Cluster of action icons that fades in on hover of the parent `.diff-hunk`.
 * Lives inside the sticky hunk header. The fade-in is handled by the parent
 * (the diff body components pass a `group` class on the hunk), and we just
 * declare ourselves `opacity-0 group-hover:opacity-100`.
 *
 * Migrated from the `.hunk-actions` / `.hunk-action-icon` / `.hunk-action-primary`
 * / `.hunk-action-revert` rules.
 */
export function HunkActionBar({ hunkIdx, actions }: Props) {
  const icon =
    "grid place-items-center w-[22px] h-5 rounded-[3px] text-fg-2 " +
    "transition-colors duration-[120ms] hover:bg-bg-3 hover:text-fg-0";
  return (
    <div
      className={cn(
        "ml-auto inline-flex items-center gap-0.5 p-0.5 rounded-1",
        "bg-bg-2 border border-bd-1",
        // Fade in on hover or when a popover is mounted inside the hunk.
        // The parent hunk wrapper carries the `group` class.
        "opacity-0 transition-opacity duration-100",
        "group-hover:opacity-100 group-focus-within:opacity-100",
        "group-[:has(.hunk-popover-host)]:opacity-100",
      )}
    >
      {actions.revert ? (
        <button
          className={cn(
            icon,
            // Danger variant — accent red on hover.
            "hover:!bg-[color-mix(in_oklab,var(--diff-del-mark)_16%,transparent)] hover:!text-diff-del-mark",
          )}
          onClick={() => actions.revert!.onClick(hunkIdx)}
          title={actions.revert.label}
          type="button"
        >
          {I.undo}
        </button>
      ) : null}
      <button
        className={cn(
          icon,
          // Primary variant — accent-soft on hover.
          "hover:!bg-accent-softer hover:!text-accent-hi",
        )}
        onClick={() => actions.primary.onClick(hunkIdx)}
        title={actions.primary.label}
        type="button"
      >
        {I[PRIMARY_ICON[actions.primary.kind]]}
      </button>
    </div>
  );
}
