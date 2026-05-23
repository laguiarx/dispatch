import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRepoStore } from "@/features/repository/repository.store";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

type Anchor = { top: number; left: number };

/**
 * Read the chevron's viewport-relative position so the portal-mounted
 * menu can sit just under the PR launcher regardless of any ancestor
 * stacking contexts / overflow / transforms.
 */
function computeAnchor(): Anchor {
  const trigger = document.querySelector<HTMLElement>(
    "[data-pr-launcher-trigger]",
  );
  if (!trigger) return { top: 60, left: 16 };
  const rect = trigger.getBoundingClientRect();
  // 320px is the card's max-width — clamp the left edge so the menu
  // doesn't extend past the right edge of the window when the launcher
  // sits near the middle of the topbar.
  return {
    top: rect.bottom + 6,
    left: Math.max(
      8,
      Math.min(rect.left, window.innerWidth - 320 - 8),
    ),
  };
}

// "Generate commit message" lives in the Changes-tab composer in the
// sidebar — it operates on the staged diff and feeds a real textarea the
// user can edit before committing, which doesn't fit a global menu.
//
// "Create Pull Request" used to live here too but moved to the main half
// of the PR launcher split-button — the chevron is what opens this menu,
// so the items here are just the read-only AI text actions.
const READ_ONLY_ACTIONS = [
  {
    kind: "summary" as const,
    label: "Summarize this diff",
    description: "What changed, and why, in plain English.",
  },
  {
    kind: "risk" as const,
    label: "Review risk",
    description: "Highlight regressions, edge cases, and footguns.",
  },
];

/**
 * AI Assist dropdown anchored to the chevron half of the PR launcher
 * split-button in the topbar. Both actions are read-only AI text passes
 * over the working-tree / branch diff — they open the centered output
 * modal rather than performing a git operation.
 */
export function GitMenu() {
  const open = useRepoStore((s) => s.gitMenuOpen);
  const setOpen = useRepoStore((s) => s.setGitMenuOpen);
  const aiKind = useRepoStore((s) => s.aiKind);
  const setAiKind = useRepoStore((s) => s.setAiKind);

  const ref = useRef<HTMLDivElement | null>(null);
  const [anchor, setAnchor] = useState<Anchor>({ top: 60, left: 16 });

  useLayoutEffect(() => {
    if (!open) return;
    setAnchor(computeAnchor());
    const onResize = () => setAnchor(computeAnchor());
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const target = e.target as Node | null;
      if (ref.current && target && !ref.current.contains(target)) {
        // The chevron trigger owns toggling — don't double-close when the
        // user clicks it to dismiss the menu.
        const trigger = document.querySelector("[data-pr-launcher-trigger]");
        if (trigger && trigger.contains(target)) return;
        setOpen(false);
      }
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
  }, [open, setOpen]);

  if (!open) return null;

  // Common card shell shared with the other portal dropdowns. Use a solid
  // surface so menus stay quiet and match the rest of the app chrome.
  const cardShell =
    "fixed z-[9999] min-w-[260px] max-w-[320px] py-1 " +
    "bg-bg-1 " +
    "border border-bd-2 rounded-3 " +
    "shadow-[0_18px_50px_rgba(0,0,0,0.5),0_0_0_0.5px_rgba(255,255,255,0.04)]";
  const sectionHead =
    "px-3.5 pt-2.5 pb-1.5 text-fg-2 text-[9.5px] uppercase tracking-[0.08em]";
  const itemBase =
    "flex flex-col gap-0.5 w-full px-3.5 py-2 text-left text-[12px] text-fg-1 " +
    "bg-transparent border-0 cursor-pointer hover:bg-bg-hover hover:text-fg-0";

  return createPortal(
    <div
      ref={ref}
      className={cardShell}
      style={{ top: anchor.top, left: anchor.left }}
    >
      <div className={sectionHead}>AI Assist</div>
      {READ_ONLY_ACTIONS.map((a) => (
        <Button variant="unstyled"
          key={a.kind}
          className={cn(
            itemBase,
            aiKind === a.kind && "!bg-accent-soft !text-accent",
          )}
          onClick={() => {
            setAiKind(aiKind === a.kind ? null : a.kind);
            setOpen(false);
          }}
          type="button"
        >
          <span className="font-medium">{a.label}</span>
          <span className="text-fg-2 text-[10.5px] leading-[1.4]">
            {a.description}
          </span>
        </Button>
      ))}
    </div>,
    document.body,
  );
}
