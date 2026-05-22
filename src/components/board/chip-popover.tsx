import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

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

type Anchor = { top: number; left: number; triggerWidth: number };

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

  // Measure the trigger every time we open so a window resize / modal
  // reflow between renders doesn't leave the menu floating in the wrong
  // place.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    setAnchor({
      top: r.bottom + 4,
      left: r.left,
      triggerWidth: r.width,
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setFilter("");
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const target = e.target as Node | null;
      const insideTrigger =
        triggerRef.current && target && triggerRef.current.contains(target);
      const insideMenu =
        menuRef.current && target && menuRef.current.contains(target);
      if (!insideTrigger && !insideMenu) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

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

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          // Sized to content so the row reads as a tight cluster of
          // chips, not a sparse split of label-vs-value.
          "h-7 inline-flex items-center gap-1.5 px-2 rounded-[5px] border text-[11.5px] font-mono",
          "transition-colors duration-100 max-w-full",
          "border-bd-2 text-fg-1 hover:bg-bg-hover hover:border-bd-1",
          open && "bg-bg-2 border-bd-1",
          disabled && "opacity-50 cursor-not-allowed hover:bg-transparent",
        )}
      >
        <span className="text-fg-2">{label}</span>
        {selected?.leading ? (
          <span className="shrink-0">{selected.leading}</span>
        ) : null}
        <span className="truncate text-fg-0">{displayLabel}</span>
        <span className="text-fg-3 text-[9px] leading-none">▾</span>
      </button>

      {open && anchor
        ? createPortal(
            <div
              ref={menuRef}
              style={{
                position: "fixed",
                top: anchor.top,
                left: anchor.left,
                minWidth: Math.max(menuMinWidth, anchor.triggerWidth),
              }}
              className={cn(
                "z-[1000] bg-bg-1 border border-bd-1 rounded-[6px]",
                "shadow-[0_12px_32px_rgba(0,0,0,0.5)] flex flex-col overflow-hidden",
              )}
            >
              {searchable ? (
                <div className="px-2 py-1.5 border-b border-bd-2">
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
                      "w-full h-6 px-1.5 text-[11.5px] text-fg-0 bg-transparent",
                      "border-0 outline-none placeholder:text-fg-3 font-mono",
                    )}
                  />
                </div>
              ) : null}
              <div className="px-1 py-1 flex flex-col gap-px max-h-[260px] overflow-y-auto">
                {filtered.length === 0 ? (
                  allowCustom && filter.trim().length > 0 ? (
                    <button
                      type="button"
                      onClick={() => {
                        onChange(filter.trim() as unknown as T);
                        setOpen(false);
                      }}
                      className={cn(
                        "px-2 py-1.5 text-[11px] text-left",
                        "text-fg-1 hover:bg-bg-hover hover:text-fg-0",
                        "rounded-[4px] font-mono",
                      )}
                    >
                      Use{" "}
                      <span className="text-accent">"{filter.trim()}"</span>{" "}
                      <span className="text-fg-3">(↵)</span>
                    </button>
                  ) : (
                    <div className="px-2 py-1.5 text-[11px] text-fg-3 italic">
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
                      <button
                        key={String(opt.value)}
                        type="button"
                        disabled={!isEnabled}
                        onClick={() => {
                          onChange(opt.value);
                          setOpen(false);
                        }}
                        className={cn(
                          "flex items-center gap-2 px-2 py-1.5 rounded-[4px] text-left",
                          "text-[11.5px] font-mono",
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
                      </button>
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
