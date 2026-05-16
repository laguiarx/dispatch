import { useEffect, useRef, useState } from "react";
import type { ChangedFile } from "@/features/git/git.types";
import { cn } from "@/lib/utils";
import { I, STATUS_META } from "./icons";
import { Kbd } from "./kbd";

type Props = {
  file: ChangedFile;
  selected: boolean;
  /** Same path is currently open (possibly in file-view) but not as this exact diff variant. */
  active?: boolean;
  /** Part of a multi-select group (⌘/Ctrl-click or ⇧-click). */
  multiSelected?: boolean;
  /** Receives the click event so callers can read shift/meta/ctrl modifiers. */
  onSelect: (e: React.MouseEvent) => void;
  onToggleStage: () => void;
  onToggleReviewed: () => void;
  onDiscard: () => void;
};

/**
 * Shared style fragments for the row + its trailing controls. The grid
 * (16px status · 1fr path · auto stats · auto actions) is the load-bearing
 * piece — everything else hangs off it.
 *
 * Reviewed dimming used to be `opacity: 0.55` on the whole row but that
 * composed onto the absolutely-positioned popover too. Now we dim via text
 * color on individual descendants (see `name`/`dir`/`stats` modifiers).
 */
const ROW =
  // Named group (`group/row`) so the action buttons below light up only
  // on the hovered row — NOT when the user's mouse is over the enclosing
  // Staged / Unstaged section (which itself uses `group/section`).
  "group/row grid grid-cols-[16px_minmax(0,1fr)_auto_auto] items-center gap-[7px] " +
  "h-[var(--row-h)] px-3 cursor-pointer text-[12px] border-l-2 border-l-transparent " +
  "select-none transition-[background-color,border-color] duration-100 " +
  "hover:bg-bg-hover";
const ROW_SELECTED = "bg-bg-selected !border-l-accent";
// Multi-select reuses the selected look but the accent border on the left
// is muted — only the primary selection gets the strong accent.
const ROW_MULTI =
  "!border-l-[color-mix(in_oklab,var(--accent)_55%,transparent)]";
// Same file is open elsewhere (file-view) but not as this diff variant —
// subtle marker so the user can still spot it in the changes list.
const ROW_ACTIVE = "bg-bg-hover !border-l-bd-2";

const STATUS_CELL = "font-mono text-[11px] font-semibold text-center";
const PATHWRAP = "flex flex-col min-w-0 leading-[1.15]";
// Reviewed: dim name to fg-3 + prepend "✓ " glyph via ::before. Hover /
// selected / active states pull it back up to fg-1 so it doesn't look
// outright disabled when the user is focused on it.
const NAME =
  "font-medium text-fg-0 whitespace-nowrap overflow-hidden text-ellipsis";
const NAME_REVIEWED =
  "!text-fg-3 group-hover/row:!text-fg-1 " +
  "before:content-['✓_'] before:text-git-add before:font-semibold before:mr-px";
const DIR =
  "font-mono text-[10px] text-fg-3 whitespace-nowrap overflow-hidden text-ellipsis";
const STATS = "font-mono text-[10.5px] inline-flex gap-[5px]";
// Reviewed: muted +/− deltas (still readable, but recede). Targets every
// span inside; both +/− children carry a `text-diff-*-mark` color and the
// opacity tint preserves that color while dimming it.
const STATS_REVIEWED = "[&_span]:opacity-60";

const ACTIONS = "inline-flex items-center gap-1 shrink-0";
const STAGE_BTN =
  "w-4 h-4 rounded-[3px] grid place-items-center text-[11px] leading-none " +
  "bg-transparent border border-dashed border-bd-2 text-fg-3 cursor-pointer " +
  "hover:text-fg-0 hover:border-bd-3";
// Hovering the staged variant should still feel like a button — brighten
// the border to --accent-hi and bump the soft fill so the "unstage" intent
// is obvious without changing layout / icon.
const STAGE_BTN_ON =
  "!bg-accent-soft !border-solid !border-accent !text-accent " +
  "hover:!border-accent-hi " +
  "hover:!bg-[color-mix(in_oklab,var(--accent)_24%,transparent)]";
// Square 3-dots ⋯ overflow button — always visible (consistent affordance
// across rows), stays dim until the user hovers the button itself. Same
// model as the + stage button: row-hover doesn't paint these so the eye
// has one clear hover target per affordance.
const MORE_BTN =
  "w-5 h-5 rounded-[3px] grid place-items-center bg-transparent border-0 cursor-pointer " +
  "text-fg-3 transition-[color,background-color] duration-100 " +
  "hover:!bg-bg-hover hover:!text-fg-0";
const MORE_BTN_ACTIVE = "!bg-bg-active !text-fg-0";
const MORE_BTN_REVIEWED = "!text-accent";
// Popover anchored under the ⋯ button. 220px is the sweet spot where
// "Mark reviewed" + ⌘⇧M chip still fit on one line.
const MORE_MENU =
  "absolute top-[calc(100%+4px)] right-0 z-30 min-w-[220px] " +
  "bg-bg-2 border border-bd-2 rounded-3 py-1 " +
  "shadow-[0_12px_32px_rgba(0,0,0,0.5)]";
const MORE_ITEM_BASE =
  "grid grid-cols-[18px_1fr_auto] items-center gap-2 w-full px-3 py-[7px] " +
  "text-left text-[12px] text-fg-1 bg-transparent border-0 cursor-pointer " +
  // Second cell (the label) must never wrap — truncate instead.
  "[&>span:nth-child(2)]:whitespace-nowrap [&>span:nth-child(2)]:overflow-hidden " +
  "[&>span:nth-child(2)]:text-ellipsis " +
  // Kbd chips don't need a left margin — grid gap handles spacing.
  "[&>[data-kbd]]:!ml-0 " +
  "hover:bg-bg-hover hover:text-fg-0 " +
  "[&:hover_.file-more-item-icon]:!text-current";
const MORE_ITEM_DANGER =
  "hover:!text-git-del hover:!bg-[color-mix(in_oklab,var(--git-del)_14%,transparent)]";
const MORE_ITEM_ICON = "file-more-item-icon grid place-items-center text-fg-3";

/**
 * File row layout:
 *   [status]  filename + dir   (+stats)  [+ stage]  [⋯ more]
 *
 * Previously the trailing strip had review + discard + stage all inline,
 * which was unreadable and ran off the right edge at narrow sidebar
 * widths. Now it's two affordances: a primary Stage toggle (most-used) and
 * an overflow menu for Mark reviewed / Discard.
 */
export function FileRow({
  file,
  selected,
  active,
  multiSelected,
  onSelect,
  onToggleStage,
  onToggleReviewed,
  onDiscard,
}: Props) {
  const meta = STATUS_META[file.status];
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Close the popover on outside-click / Escape.
  useEffect(() => {
    if (!menuOpen) return;
    function onDocClick(e: MouseEvent) {
      const t = e.target as Node | null;
      if (menuRef.current && t && !menuRef.current.contains(t)) {
        setMenuOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const isMulti = !selected && multiSelected;
  const isActive = !selected && !multiSelected && active;
  return (
    <div
      className={cn(
        ROW,
        (selected || isMulti) && ROW_SELECTED,
        isMulti && ROW_MULTI,
        isActive && ROW_ACTIVE,
      )}
      onMouseDown={(e) => {
        // Shift-click starts text selection on `mousedown` — long before
        // our `click` handler can call `removeAllRanges()`. That's the
        // flash the user sees. Suppress it at the source: when the
        // modifier is held, the row is acting as a range-select trigger,
        // not as a text cursor.
        if (e.shiftKey) e.preventDefault();
      }}
      onClick={onSelect}
    >
      <span
        className={STATUS_CELL}
        style={{ color: meta.color }}
        title={meta.label}
      >
        {meta.letter}
      </span>
      <span className={PATHWRAP}>
        <span
          className={cn(NAME, file.reviewed && NAME_REVIEWED)}
          title={file.path}
        >
          {file.path.split("/").pop()}
        </span>
        {file.path.includes("/") ? (
          <span className={cn(DIR, file.reviewed && "!text-fg-3")}>
            {file.path.slice(0, file.path.lastIndexOf("/"))}
          </span>
        ) : null}
      </span>
      <span className={cn(STATS, file.reviewed && STATS_REVIEWED, file.reviewed && "!text-fg-3")}>
        {file.additions > 0 ? (
          <span className="text-diff-add-mark">+{file.additions}</span>
        ) : null}
        {file.deletions > 0 ? (
          <span className="text-diff-del-mark">−{file.deletions}</span>
        ) : null}
      </span>
      <span className={ACTIONS}>
        <button
          className={cn(STAGE_BTN, file.staged && STAGE_BTN_ON)}
          title={file.staged ? "Unstage" : "Stage"}
          onClick={(e) => {
            e.stopPropagation();
            onToggleStage();
          }}
          type="button"
        >
          {file.staged ? I.check : "+"}
        </button>
        <div className="relative inline-flex" ref={menuRef}>
          <button
            className={cn(
              MORE_BTN,
              menuOpen && MORE_BTN_ACTIVE,
              file.reviewed && MORE_BTN_REVIEWED,
            )}
            title="More actions"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((o) => !o);
            }}
            type="button"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            {I.ellipsis}
          </button>
          {menuOpen ? (
            <div
              className={MORE_MENU}
              role="menu"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                role="menuitem"
                className={MORE_ITEM_BASE}
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen(false);
                  onToggleReviewed();
                }}
                type="button"
              >
                <span className={MORE_ITEM_ICON}>{I.review}</span>
                <span>
                  {file.reviewed ? "Unmark reviewed" : "Mark reviewed"}
                </span>
                <Kbd>⌘⇧M</Kbd>
              </button>
              <button
                role="menuitem"
                className={cn(MORE_ITEM_BASE, MORE_ITEM_DANGER)}
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen(false);
                  onDiscard();
                }}
                type="button"
              >
                <span className={MORE_ITEM_ICON}>{I.discard}</span>
                <span>Discard changes</span>
                <Kbd>⌘⌫</Kbd>
              </button>
            </div>
          ) : null}
        </div>
      </span>
    </div>
  );
}
