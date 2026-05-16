import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRepoStore } from "@/features/repository/repository.store";
import { cn } from "@/lib/utils";

type Anchor = { top: number; right: number };

/**
 * Read the trigger's viewport-relative position so the portal-mounted menu
 * can sit just under the topbar button regardless of any ancestor stacking
 * contexts / overflow / transforms. Mirrors `EditorMenu`'s anchor logic.
 */
function computeAnchor(): Anchor {
  const trigger = document.querySelector<HTMLElement>("[data-git-menu-trigger]");
  if (!trigger) return { top: 60, right: 16 };
  const rect = trigger.getBoundingClientRect();
  return {
    top: rect.bottom + 6,
    right: Math.max(8, window.innerWidth - rect.right),
  };
}

// "Generate commit message" lives in the Changes-tab composer in the
// sidebar now — it operates on the staged diff and feeds a real textarea
// the user can edit before committing, which doesn't fit a global menu.
//
// Items here are split in two:
//   - `pr-create`: a real action (branch → commit → push → gh pr create),
//     handled specially in the click callback.
//   - `summary` / `risk`: read-only AI text actions that open the modal.
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
 * Global Git/AI dropdown shown in the topbar. The four actions all act on
 * the WHOLE working tree (or whole branch for PR), not on the currently
 * selected file — they're inherently repo-scoped, so they live up here
 * rather than in the per-file right panel.
 */
export function GitMenu() {
  const open = useRepoStore((s) => s.gitMenuOpen);
  const setOpen = useRepoStore((s) => s.setGitMenuOpen);
  const aiKind = useRepoStore((s) => s.aiKind);
  const setAiKind = useRepoStore((s) => s.setAiKind);
  const openPrBranchChoice = useRepoStore((s) => s.openPrBranchChoice);

  const ref = useRef<HTMLDivElement | null>(null);
  const [anchor, setAnchor] = useState<Anchor>({ top: 60, right: 16 });

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
        // The trigger button itself owns toggling — don't double-close
        // when the user clicks it to dismiss the menu.
        const trigger = document.querySelector("[data-git-menu-trigger]");
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

  // Common card shell shared with the other portal dropdowns (EditorMenu,
  // PrFlow/PrBranchChoice). Frosted glass at higher opacity than the
  // popovers so menu contents read crisply even over busy backgrounds.
  const cardShell =
    "fixed z-[9999] min-w-[260px] max-w-[320px] py-1 " +
    "bg-[color-mix(in_oklab,var(--bg-1)_92%,transparent)] " +
    "border border-bd-2 rounded-3 " +
    "shadow-[0_18px_50px_rgba(0,0,0,0.5),0_0_0_0.5px_rgba(255,255,255,0.04)] " +
    "backdrop-blur-card backdrop-saturate-[140%]";
  const sectionHead =
    "px-3.5 pt-2.5 pb-1.5 text-fg-2 text-[9.5px] uppercase tracking-[0.08em]";
  const itemBase =
    "flex flex-col gap-0.5 w-full px-3.5 py-2 text-left text-[12px] text-fg-1 " +
    "bg-transparent border-0 cursor-pointer hover:bg-bg-hover hover:text-fg-0";

  return createPortal(
    <div
      ref={ref}
      className={cardShell}
      style={{ top: anchor.top, right: anchor.right }}
    >
      <div className={sectionHead}>Git · Actions</div>
      {/* Real action: stages → commits → pushes → opens the PR via gh. */}
      <button
        key="pr-create"
        // Primary item gets the accent applied to its label (the row
        // background stays transparent until hover, same as other items).
        className={cn(itemBase, "[&_.git-menu-label]:text-accent")}
        onClick={() => {
          openPrBranchChoice();
          setOpen(false);
        }}
        type="button"
      >
        <span className="git-menu-label font-medium">Create Pull Request</span>
        <span className="text-fg-2 text-[10.5px] leading-[1.4]">
          Branch · commit · push · open PR on GitHub.
        </span>
      </button>

      <div className="h-px mx-0 my-1 bg-bd-0" />
      <div className={sectionHead}>AI Assist</div>
      {READ_ONLY_ACTIONS.map((a) => (
        <button
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
        </button>
      ))}
    </div>,
    document.body,
  );
}
