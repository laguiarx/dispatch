import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactElement } from "react";
import { Button } from "@/components/ui/button";

import { cn } from "@/lib/utils";
import { useDismissableLayer } from "@/hooks/use-dismissable-layer";
import { I } from "@/components/icons";

/**
 * Curated icon set for project actions. The DB stores just the id string
 * ("play", "bug", …) — `iconNodeFor` resolves it back to the SVG, with a
 * graceful fallback to `play` when a future migration introduces an id
 * this build doesn't know about.
 *
 * Keep the set tight (~10): a longer list is harder to scan, and we'd
 * rather the user pick a meaningful icon than have a perfect match.
 */
export type ActionIconId =
  | "play"
  | "bug"
  | "check"
  | "code"
  | "refresh"
  | "gear"
  | "search"
  | "branch"
  | "terminal"
  | "database"
  | "sparkles"
  | "discard";

const ACTION_ICONS: { id: ActionIconId; label: string }[] = [
  { id: "play", label: "Run" },
  { id: "bug", label: "Debug" },
  { id: "check", label: "Test" },
  { id: "code", label: "Build" },
  { id: "refresh", label: "Restart" },
  { id: "gear", label: "Config" },
  { id: "search", label: "Search" },
  { id: "branch", label: "Git" },
  { id: "terminal", label: "Shell" },
  { id: "database", label: "Database" },
  { id: "sparkles", label: "Format" },
  { id: "discard", label: "Clean" },
];

/** Resolve an icon id (possibly unknown / legacy) to an SVG node. */
export function iconNodeFor(id: string | null | undefined): ReactElement {
  if (id && id in I) {
    return (I as Record<string, ReactElement>)[id];
  }
  return I.play;
}

type PickerProps = {
  value: string;
  onChange: (id: ActionIconId) => void;
  /** Optional tooltip override. Defaults to "Choose icon". */
  title?: string;
};

/**
 * 36×36 trigger button with the current icon, opens a small grid popover
 * on click. Click outside / Esc closes. Used in `ScriptForm` where it
 * replaces the static play icon and lets the user pick from
 * `ACTION_ICONS`.
 */
export function ActionIconPicker({ value, onChange, title }: PickerProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(
    null,
  );

  useDismissableLayer(open, setOpen, [triggerRef, popRef]);

  useEffect(() => {
    if (!open) return;
    if (triggerRef.current) {
      const r = triggerRef.current.getBoundingClientRect();
      setAnchor({ top: r.bottom + 4, left: r.left });
    }
  }, [open]);

  return (
    <>
      <Button variant="unstyled"
        ref={triggerRef}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        title={title ?? "Choose icon"}
        className={cn(
          "w-9 h-9 grid place-items-center rounded-[6px] shrink-0",
          "bg-bg-1 border text-fg-2 cursor-pointer",
          "[&_svg]:w-3.5 [&_svg]:h-3.5",
          "hover:bg-bg-hover hover:text-fg-0",
          open
            ? "border-bd-1 bg-bg-hover text-fg-0"
            : "border-bd-2 hover:border-bd-1",
        )}
      >
        {iconNodeFor(value)}
      </Button>
      {open && anchor
        ? createPortal(
            <div
              ref={popRef}
              style={{
                position: "fixed",
                top: anchor.top,
                left: anchor.left,
              }}
              className={cn(
                "z-[1000] p-2 rounded-[8px]",
                "bg-bg-1 border border-bd-1",
                "shadow-[0_12px_32px_rgba(0,0,0,0.5)]",
                "grid grid-cols-6 gap-1",
              )}
            >
              {ACTION_ICONS.map((icon) => {
                const active = icon.id === value;
                return (
                  <Button variant="unstyled"
                    key={icon.id}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onChange(icon.id);
                      setOpen(false);
                    }}
                    title={icon.label}
                    className={cn(
                      "w-9 h-9 grid place-items-center rounded-[5px]",
                      "border text-fg-2",
                      "[&_svg]:w-3.5 [&_svg]:h-3.5",
                      active
                        ? "!bg-accent !bg-none text-accent-fg border-transparent"
                        : "bg-bg-2 border-bd-2 hover:bg-bg-hover hover:text-fg-0 hover:border-bd-1",
                    )}
                  >
                    {iconNodeFor(icon.id)}
                  </Button>
                );
              })}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
