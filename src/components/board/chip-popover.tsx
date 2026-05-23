import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

import { cn } from "@/lib/utils";
import { useDismissableLayer } from "@/hooks/use-dismissable-layer";

// Loosened from `string` so callers can use nullable strings (e.g.
// "Default" model meaning "let the CLI pick") or booleans (Fast / Standard
// mode toggle) without inventing sentinel strings. Equality is `===`
// inside the component which still works for all primitive shapes.
type ChipValue = string | number | boolean | null;

export type ChipOption<T extends ChipValue> = {
  value: T;
  label: string;
  /** Optional adornment shown to the left of the label (colored dot,
   * icon, etc). */
  leading?: ReactNode;
  /** Substring(s) the search input matches against in addition to
   * `label`. */
  searchTokens?: string[];
};

type Props<T extends ChipValue> = {
  label: string;
  value: T;
  options: ChipOption<T>[];
  onChange: (next: T) => void;
  /** When set, options whose `value` isn't in this list render with a
   * dimmer tone (used for unavailable agents). */
  enabledValues?: T[];
  /** Hide the search input — useful for 2-option pickers (e.g. Agent
   * cycles between Claude/Codex). */
  searchable?: boolean;
  searchPlaceholder?: string;
  disabled?: boolean;
  fullWidth?: boolean;
  /** Min width for the dropdown panel. The trigger itself sizes to
   * content. */
  menuMinWidth?: number;
  /** Allow free-text submission — typing a value and hitting Enter
   *  fires `onChange` with the typed string even when it doesn't
   *  match any option. Used for fields like Model where the list is
   *  curated but extensible (CLIs accept any model id the user has
   *  access to). The receiver must accept `string` for this to be
   *  meaningful. */
  allowCustom?: boolean;
};

type Anchor = {
  top: number;
  left: number;
  minWidth: number;
};

/**
 * Linear-style chip + popover. The trigger sizes to its content (small,
 * tight) and the dropdown renders into `document.body` via a portal so
 * the surrounding modal's `overflow-hidden` can't clip it.
 */
export function ChipPopover<T extends ChipValue>({
  label,
  value,
  options,
  onChange,
  enabledValues,
  searchable = true,
  searchPlaceholder = "Search…",
  disabled,
  fullWidth = false,
  menuMinWidth = 220,
  allowCustom = false,
}: Props<T>) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const selected = options.find((o) => o.value === value);
  // When `allowCustom` is on and the persisted value isn't in our list
  // (user typed it before), surface it on the trigger label so the chip
  // doesn't read "—" for a value that's actually set.
  const displayLabel =
    selected?.label ??
    (allowCustom && typeof value === "string" && value.length > 0
      ? value
      : "—");

  useEffect(() => {
    if (!open) return;
    setFilter("");
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  useDismissableLayer(open, setOpen, [triggerRef, menuRef]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => {
      const hay = [o.label, ...(o.searchTokens ?? [])]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [filter, options]);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;

    const viewportMargin = 8;
    const gap = 4;

    const placeMenu = () => {
      const triggerRect = triggerRef.current?.getBoundingClientRect();
      if (!triggerRect) return;

      const menuWidth = Math.max(menuMinWidth, triggerRect.width);
      const menuHeight = menuRef.current?.getBoundingClientRect().height ?? 0;
      const maxLeft = Math.max(
        viewportMargin,
        window.innerWidth - menuWidth - viewportMargin,
      );
      const left = Math.min(Math.max(triggerRect.left, viewportMargin), maxLeft);

      let top = triggerRect.bottom + gap;
      if (menuHeight > 0) {
        const belowWouldOverflow =
          top + menuHeight > window.innerHeight - viewportMargin;
        const fitsAbove =
          triggerRect.top - gap - menuHeight >= viewportMargin;

        if (belowWouldOverflow && fitsAbove) {
          top = triggerRect.top - gap - menuHeight;
        } else if (belowWouldOverflow) {
          top = Math.max(
            viewportMargin,
            window.innerHeight - menuHeight - viewportMargin,
          );
        }
      }

      setAnchor((prev) => {
        const next = { top, left, minWidth: menuWidth };
        return prev &&
          prev.top === next.top &&
          prev.left === next.left &&
          prev.minWidth === next.minWidth
          ? prev
          : next;
      });
    };

    placeMenu();
    const raf = requestAnimationFrame(placeMenu);
    window.addEventListener("resize", placeMenu);
    window.addEventListener("scroll", placeMenu, true);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", placeMenu);
      window.removeEventListener("scroll", placeMenu, true);
    };
  }, [open, menuMinWidth, searchable, filtered.length]);

  return (
    <>
      <Button variant="unstyled"
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          // Sized to content so the row reads as a tight cluster of
          // chips, not a sparse split of label-vs-value.
          "h-7 min-w-0 inline-flex items-center gap-1.5 px-2 rounded-[6px] border text-[11px] font-mono",
          "transition-colors duration-100 max-w-full",
          "border-bd-2 bg-bg-1/60 text-fg-1 hover:bg-bg-hover hover:border-bd-1",
          fullWidth && "w-full",
          open && "bg-bg-2 border-bd-1",
          disabled && "opacity-50 cursor-not-allowed hover:bg-transparent",
        )}
      >
        <span className="text-fg-2">{label}</span>
        {selected?.leading ? (
          <span className="shrink-0">{selected.leading}</span>
        ) : null}
        <span className="min-w-0 truncate text-fg-0">{displayLabel}</span>
        <span
          className={cn(
            "text-fg-3 text-[9px] leading-none",
            fullWidth && "ml-auto",
          )}
        >
          {open ? "▾" : "▸"}
        </span>
      </Button>

      {open && anchor
        ? createPortal(
            <div
              ref={menuRef}
              style={{
                position: "fixed",
                top: anchor.top,
                left: anchor.left,
                minWidth: anchor.minWidth,
              }}
              className={cn(
                "z-[1000] bg-bg-1 border border-bd-1 rounded-[7px]",
                "flex flex-col overflow-hidden p-1 outline-none",
              )}
            >
              {searchable ? (
                <div className="px-1.5 pb-1.5 mb-1 border-b border-bd-1">
                  <input
                    ref={inputRef}
                    type="text"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder={
                      allowCustom
                        ? "Type a model id, or pick…"
                        : searchPlaceholder
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        const typed = filter.trim();
                        const first = filtered[0];
                        if (first) {
                          onChange(first.value);
                          setOpen(false);
                        } else if (allowCustom && typed.length > 0) {
                          // No match, but the user explicitly opted into
                          // free-text mode — submit the typed string as
                          // the new value. Cast through unknown because
                          // T extends ChipValue and we're trusting the
                          // caller to accept `string` here.
                          onChange(typed as unknown as T);
                          setOpen(false);
                        }
                      }
                    }}
                    className={cn(
                      "w-full h-7 px-2 text-[11.5px] text-fg-0 bg-bg-0 rounded-[5px]",
                      "border border-bd-1 outline-none placeholder:text-fg-3 font-mono",
                      "focus:border-bd-2",
                    )}
                  />
                </div>
              ) : null}
              <div className="flex flex-col gap-0.5 max-h-[260px] overflow-y-auto">
                {filtered.length === 0 ? (
                  allowCustom && filter.trim().length > 0 ? (
                    <Button variant="unstyled"
                      type="button"
                      onClick={() => {
                        onChange(filter.trim() as unknown as T);
                        setOpen(false);
                      }}
                      className={cn(
                        "px-2 py-1.5 text-[11px] text-left",
                        "text-fg-1 hover:bg-bg-hover hover:text-fg-0",
                        "rounded-[5px] font-mono",
                      )}
                    >
                      Use{" "}
                      <span className="text-accent">"{filter.trim()}"</span>{" "}
                      <span className="text-fg-3">(↵)</span>
                    </Button>
                  ) : (
                    <div className="px-2 py-2 text-[11px] text-fg-3 italic">
                      No matches.
                    </div>
                  )
                ) : (
                  filtered.map((opt) => {
                    const isActive = opt.value === value;
                    const isEnabled =
                      enabledValues === undefined ||
                      enabledValues.includes(opt.value);
                    return (
                      <Button variant="unstyled"
                        key={String(opt.value)}
                        type="button"
                        disabled={!isEnabled}
                        onClick={() => {
                          onChange(opt.value);
                          setOpen(false);
                        }}
                        className={cn(
                          "h-8 flex items-center gap-2 px-2 rounded-[5px] text-left",
                          "text-[11.5px] font-mono transition-colors",
                          isEnabled
                            ? isActive
                              ? "bg-bg-2 text-fg-0"
                              : "text-fg-1 hover:bg-bg-hover hover:text-fg-0"
                            : "text-fg-3 cursor-not-allowed",
                        )}
                      >
                        {opt.leading ? (
                          <span className="shrink-0">{opt.leading}</span>
                        ) : null}
                        <span className="flex-1 min-w-0 truncate">
                          {opt.label}
                        </span>
                        {isActive ? (
                          <span className="text-fg-2 text-[12px]">✓</span>
                        ) : null}
                      </Button>
                    );
                  })
                )}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
