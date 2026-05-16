import { useEffect } from "react";
import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/utils";

type Props = {
  onClose: () => void;
  children: ReactNode;
  style?: CSSProperties;
  /** Center the card vertically — for confirm/settings modals. */
  centered?: boolean;
};

/**
 * Full-screen scrim that hosts a modal card. `Esc` closes; clicking the
 * dim background (but not bubbled-up clicks from inside the card) also
 * closes.
 *
 * Migrated from the `.overlay-back` rule. CommandPalette still references
 * the class directly, so we left a thin compat shim in `index.css` —
 * it'll be removed once CommandPalette is migrated.
 */
export function Overlay({ onClose, children, style, centered }: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className={cn(
        "absolute inset-0 z-50 grid justify-items-center",
        // Slightly tinted scrim with a soft blur — same look as before.
        // The light theme uses a different rgba (handled via the shim
        // rule for now; see comment on `.overlay-back` in index.css).
        "bg-[rgba(2,3,5,0.55)] backdrop-blur-[4px]",
        centered ? "items-center pt-0" : "items-start pt-[70px]",
      )}
      style={style}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {children}
    </div>
  );
}
