/**
 * Shared button class strings. Used by every dialog/modal in the app so
 * that "the primary button look" / "the ghost button look" stays one edit
 * away. Lives in `lib/` rather than `components/` because it's pure data
 * — no React, no JSX — and the consumers compose it via `className=`.
 *
 * Migrated from the legacy `.primary-btn` / `.ghost-btn` / `.danger-btn` /
 * `.link-btn` rules in `index.css` (deleted in the final cleanup wave).
 */

export const BTN_PRIMARY =
  "inline-flex items-center gap-1.5 h-7 px-3 rounded-2 " +
  "bg-accent text-accent-fg text-[12px] font-semibold whitespace-nowrap shrink-0 " +
  "transition-[background-color] duration-[120ms] " +
  "hover:not-disabled:bg-accent-hi " +
  "disabled:opacity-40 disabled:cursor-default";

export const BTN_GHOST =
  "inline-flex items-center gap-[5px] px-[9px] py-1 rounded-2 " +
  "bg-transparent border border-bd-1 text-fg-1 text-[11.5px] whitespace-nowrap shrink-0 " +
  "hover:not-disabled:bg-bg-hover hover:not-disabled:border-bd-2 " +
  "hover:not-disabled:text-fg-0 " +
  "disabled:opacity-50 disabled:cursor-default";

export const BTN_DANGER =
  "inline-flex items-center gap-1.5 h-7 px-3 rounded-2 " +
  "bg-[#c25656] text-white text-[12px] font-semibold whitespace-nowrap shrink-0 " +
  "hover:bg-[#d36363]";

export const BTN_LINK =
  "text-accent text-[12px] self-center bg-transparent border-0 cursor-pointer " +
  "hover:underline";
