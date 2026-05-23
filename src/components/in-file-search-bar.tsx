import { forwardRef, useImperativeHandle, useRef } from "react";
import { cn } from "@/lib/utils";
import { I } from "./icons";
import { Button } from "@/components/ui/button";

type Props = {
  query: string;
  caseSensitive: boolean;
  regex: boolean;
  total: number;
  current: number; // 0-based; -1 when no matches
  onQueryChange: (q: string) => void;
  onToggleCase: () => void;
  onToggleRegex: () => void;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
};

export type InFileSearchBarHandle = {
  focus: () => void;
};

// Small navigation icon button used for prev/next/close. Same metrics
// across all three so they line up visually.
const ICON_BTN =
  "grid place-items-center w-[22px] h-[22px] rounded-1 text-fg-2 " +
  "bg-transparent text-[12px] hover:bg-bg-hover hover:text-fg-0 " +
  "disabled:text-fg-4 disabled:cursor-default";

// Aa / .* toggle pill. Duplicated in `search-panel.tsx` and
// `replace-overlay.tsx` with identical metrics — short enough that a
// shared util didn't earn its keep.
const FLAG_BASE =
  "inline-flex items-center justify-center min-w-6 h-[22px] px-1.5 " +
  "rounded-[4px] border border-transparent font-mono text-[11px] text-fg-3 " +
  "bg-transparent hover:text-fg-0 hover:bg-bg-3 [&_svg]:block";
const FLAG_ON =
  "!bg-accent-soft !text-accent " +
  "!border-[color-mix(in_oklab,var(--accent)_40%,transparent)]";

/**
 * Floating ⌘F search bar anchored at the top-right of the diff body.
 */
export const InFileSearchBar = forwardRef<InFileSearchBarHandle, Props>(
  function InFileSearchBar(props, ref) {
    const inputRef = useRef<HTMLInputElement | null>(null);

    useImperativeHandle(
      ref,
      () => ({
        focus() {
          inputRef.current?.focus();
          inputRef.current?.select();
        },
      }),
      [],
    );

    const label =
      props.query.length === 0
        ? "0 results"
        : props.total === 0
          ? "No results"
          : `${props.current + 1} of ${props.total}`;

    function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
      if (e.key === "Enter") {
        e.preventDefault();
        if (e.shiftKey) props.onPrev();
        else props.onNext();
      } else if (e.key === "Escape") {
        e.preventDefault();
        props.onClose();
      }
    }

    return (
      <div
        role="search"
        className={cn(
          "absolute top-2 right-[22px] z-10 flex items-center gap-1.5",
          "pl-2.5 pr-1.5 py-[5px] bg-bg-2 border border-bd-2 rounded-2",
          "shadow-[0_10px_26px_rgba(0,0,0,0.45)] text-[12px]",
        )}
      >
        <span className="grid place-items-center text-fg-3">{I.search}</span>
        <input
          ref={inputRef}
          className="w-[220px] h-6 text-[12px] text-fg-0 bg-transparent border-0 outline-none"
          type="text"
          placeholder="Find in file"
          value={props.query}
          onChange={(e) => props.onQueryChange(e.target.value)}
          onKeyDown={onKeyDown}
          autoFocus
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
        />
        <Button variant="unstyled"
          className={cn(FLAG_BASE, props.caseSensitive && FLAG_ON)}
          onClick={props.onToggleCase}
          title="Match case"
          type="button"
        >
          Aa
        </Button>
        <Button variant="unstyled"
          className={cn(FLAG_BASE, props.regex && FLAG_ON)}
          onClick={props.onToggleRegex}
          title="Regex"
          type="button"
        >
          .*
        </Button>
        <span className="font-mono text-fg-2 text-[11px] px-1.5 whitespace-nowrap min-w-[70px] text-right">
          {label}
        </span>
        <div className="inline-flex gap-0.5">
          <Button variant="unstyled"
            className={ICON_BTN}
            onClick={props.onPrev}
            title="Previous match (⇧↵)"
            type="button"
            disabled={props.total === 0}
          >
            ↑
          </Button>
          <Button variant="unstyled"
            className={ICON_BTN}
            onClick={props.onNext}
            title="Next match (↵)"
            type="button"
            disabled={props.total === 0}
          >
            ↓
          </Button>
        </div>
        <Button variant="unstyled"
          className={ICON_BTN}
          onClick={props.onClose}
          title="Close (Esc)"
          type="button"
        >
          {I.x}
        </Button>
      </div>
    );
  },
);
