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

  return createPortal(
    <div
      className="git-menu"
      ref={ref}
      style={{ top: anchor.top, right: anchor.right }}
    >
      <div className="git-menu-head dim">Git · Actions</div>
      {/* Real action: stages → commits → pushes → opens the PR via gh. */}
      <button
        key="pr-create"
        className="git-menu-item is-primary"
        onClick={() => {
          openPrBranchChoice();
          setOpen(false);
        }}
        type="button"
      >
        <span className="git-menu-item-label">Create Pull Request</span>
        <span className="git-menu-item-desc dim">
          Branch · commit · push · open PR on GitHub.
        </span>
      </button>

      <div className="git-menu-sep" />
      <div className="git-menu-head dim">AI Assist</div>
      {READ_ONLY_ACTIONS.map((a) => (
        <button
          key={a.kind}
          className={cn("git-menu-item", aiKind === a.kind && "is-active")}
          onClick={() => {
            setAiKind(aiKind === a.kind ? null : a.kind);
            setOpen(false);
          }}
          type="button"
        >
          <span className="git-menu-item-label">{a.label}</span>
          <span className="git-menu-item-desc dim">{a.description}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}
