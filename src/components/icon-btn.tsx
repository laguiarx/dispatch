import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

type Props = {
  title: string;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  children: ReactNode;
};

/**
 * 24×24 icon button used across the topbar and the sidebar headers.
 * Migrated from the legacy `.icon-btn` rule to Tailwind utilities — same
 * dimensions / colors / hover behaviour.
 *
 * `active` paints with the accent + the "active background" token so
 * toggled buttons (e.g. sidebar visibility) read as engaged. `disabled`
 * dims the icon and stops accepting clicks, but is rendered separately
 * from the native `:disabled` so we can apply the same styling whether
 * the consumer passes the prop or sets `disabled` on the button itself.
 */
export function IconBtn({ title, onClick, active, disabled, children }: Props) {
  return (
    <Button variant="unstyled"
      className={cn(
        "relative grid h-6 w-6 place-items-center rounded-1",
        "transition-colors duration-[120ms]",
        // Base + hover. Hover only when not disabled so the affordance
        // tracks reality.
        disabled
          ? "text-fg-3 cursor-default"
          : "text-fg-2 hover:bg-bg-hover hover:text-fg-0",
        // Toggled state — beats the hover paint thanks to the order here.
        active && !disabled && "bg-bg-active text-accent",
      )}
      title={title}
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
    >
      {children}
    </Button>
  );
}
