import { useEffect } from "react";
import { createPortal } from "react-dom";
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
 * Portalled to `document.body` so the scrim always covers the whole
 * window — otherwise dialogs rendered inside a constrained subtree (e.g.
 * NewCardDialog inside BoardView) leave the sidebar interactive behind
 * them.
 */
export function Overlay({ onClose, children, style, centered }: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      className={cn(
        "fixed inset-0 z-50 grid justify-items-center",
        "bg-[rgba(2,3,5,0.55)] backdrop-blur-[4px]",
        centered ? "items-center pt-0" : "items-start pt-[70px]",
      )}
      style={style}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
