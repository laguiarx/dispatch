import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BTN_GHOST, BTN_PRIMARY } from "@/lib/btn";
import { useRepoStore } from "@/features/repository/repository.store";
import { cn } from "@/lib/utils";
import { I } from "./icons";
import { Spinner } from "./spinner";

// Shared shell styling for portal-anchored popovers (both PrBranchChoice
// and PrFlow use the same look). Floating card with frosted glass, soft
// shadow, and a thin highlight-from-the-top inner stroke.
const POPOVER_SHELL =
  "fixed z-[9999] w-[min(420px,92vw)] flex flex-col overflow-hidden " +
  "bg-[color-mix(in_oklab,var(--bg-1)_96%,transparent)] " +
  "border border-bd-2 rounded-3 " +
  "shadow-[0_18px_50px_rgba(0,0,0,0.5),0_0_0_0.5px_rgba(255,255,255,0.04)] " +
  "backdrop-blur-card backdrop-saturate-[140%]";
const POPOVER_HEAD =
  "flex items-center gap-2 px-3.5 py-3 border-b border-bd-0 bg-bg-2";
const POPOVER_EYEBROW =
  "font-mono text-fg-2 text-[10px] uppercase tracking-[0.08em]";
const POPOVER_CLOSE =
  "p-0.5 bg-transparent border-0 text-fg-3 cursor-pointer hover:text-fg-0";

type Anchor = { top: number; left: number };

function computeAnchor(): Anchor {
  const trigger = document.querySelector<HTMLElement>(
    "[data-pr-create-trigger]",
  );
  if (!trigger) return { top: 60, left: 16 };
  const rect = trigger.getBoundingClientRect();
  return {
    top: rect.bottom + 6,
    // Align the card's left edge with the trigger; clamp so the 420px
    // card never sticks out past the right edge of the window.
    left: Math.max(
      8,
      Math.min(rect.left, window.innerWidth - 420 - 8),
    ),
  };
}

/**
 * Branch-choice card shown before `createPr` fires. Portal-mounted and
 * anchored beneath the "Create PR" split-button in the topbar — same
 * pattern as `GitMenu` and `PrFlowDialog`, so the whole "Create PR"
 * interaction feels like one conversation cascading out of the button
 * instead of three unrelated full-screen modals.
 */
export function PrBranchChoiceDialog() {
  const open = useRepoStore((s) => s.prBranchChoiceOpen);
  const closeDialog = useRepoStore((s) => s.closePrBranchChoice);
  const createPr = useRepoStore((s) => s.createPr);
  const repository = useRepoStore((s) => s.repository);
  const generateBranchName = useRepoStore((s) => s.generateBranchName);

  const [mode, setMode] = useState<"current" | "new">("current");
  const [newName, setNewName] = useState("");
  const [generating, setGenerating] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);

  const [anchor, setAnchor] = useState<Anchor>({ top: 60, left: 16 });

  // Reset state on each open.
  useEffect(() => {
    if (!open) return;
    setMode("current");
    setNewName("");
  }, [open]);

  // Anchor to the Git pill + keep in sync on resize/scroll.
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
    if (open && mode === "new") {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open, mode]);

  // Escape closes; click outside (but not on the Git trigger) closes too.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const t = e.target as Node | null;
      if (cardRef.current && t && !cardRef.current.contains(t)) {
        const trigger = document.querySelector("[data-pr-create-trigger]");
        if (trigger && trigger.contains(t)) return;
        closeDialog();
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeDialog();
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, closeDialog]);

  if (!open) return null;

  // `mode === "new"` no longer requires a typed name — leave the input
  // empty and we'll AI-generate one transparently when "Create PR" is
  // clicked. The input still works as a manual override / for the wand
  // pre-fill button.
  const canRun = mode === "current" || mode === "new";

  const onConfirm = async () => {
    // Current-branch path: nothing to resolve, fire and forget.
    if (mode === "current") {
      void createPr({ newBranchName: null });
      return;
    }
    // New-branch path: if the user typed a name, use it; otherwise
    // generate one in the background before kicking off createPr so the
    // pipeline starts with a real branch name in hand. `generating`
    // gates the Create-PR button so re-clicks during the AI call are
    // no-ops.
    const typed = newName.trim();
    if (typed) {
      void createPr({ newBranchName: typed });
      return;
    }
    if (generating) return;
    setGenerating(true);
    const suggestion = await generateBranchName();
    setGenerating(false);
    if (!suggestion) {
      // `generateBranchName` already pushes a toast on failure (no CLI,
      // empty diff, etc.) — bail without closing the dialog so the user
      // can either type a name or switch back to "Use current branch".
      return;
    }
    // Reflect the generated name in the input so the user sees what
    // they're about to commit-and-PR with, even briefly before the
    // dialog closes.
    setNewName(suggestion);
    void createPr({ newBranchName: suggestion });
  };

  // Each radio-choice row: subtle border + accent when selected.
  const choiceRow = (active: boolean) =>
    cn(
      "flex items-center gap-2.5 px-3 py-2.5 rounded-2 cursor-pointer",
      "bg-bg-1 border transition-colors duration-[120ms]",
      active
        ? "border-accent bg-accent-soft"
        : "border-bd-1 hover:border-bd-2",
      // Radio uses the accent color natively (Tailwind compiles
      // `accent-accent` to `accent-color: var(--accent)`).
      "[&_input[type='radio']]:accent-accent",
    );

  return createPortal(
    <div
      ref={cardRef}
      className={POPOVER_SHELL}
      style={{ top: anchor.top, left: anchor.left }}
      role="dialog"
      aria-label="Create Pull Request"
    >
      <div className={POPOVER_HEAD}>
        <span className={POPOVER_EYEBROW}>Git · Create PR</span>
        <span className="flex-1" />
        <button
          className={POPOVER_CLOSE}
          onClick={closeDialog}
          type="button"
          title="Close"
        >
          {I.x}
        </button>
      </div>

      <div className="flex flex-col gap-2.5 px-4 py-3.5">
        <div className="text-[12px] text-fg-2 leading-[1.5]">
          Currently on{" "}
          <span className="font-mono">
            {repository?.currentBranch ?? "(no branch)"}
          </span>
          . What branch should the PR come from?
        </div>

        <div className="flex flex-col gap-1.5 my-1">
          <label className={choiceRow(mode === "current")}>
            <input
              type="radio"
              name="pr-branch-mode"
              checked={mode === "current"}
              onChange={() => setMode("current")}
            />
            <span className="inline-flex items-baseline gap-2 text-[12px] text-fg-0">
              Use current branch
              <span className="font-mono text-fg-2">
                {repository?.currentBranch ?? ""}
              </span>
            </span>
          </label>
          <label className={choiceRow(mode === "new")}>
            <input
              type="radio"
              name="pr-branch-mode"
              checked={mode === "new"}
              onChange={() => setMode("new")}
            />
            <span className="inline-flex items-baseline gap-2 text-[12px] text-fg-0">
              Create new branch from{" "}
              <span className="font-mono text-fg-2">
                {repository?.currentBranch ?? ""}
              </span>
            </span>
          </label>
          {mode === "new" ? (
            <div className="flex gap-1.5 mt-1">
              <input
                ref={inputRef}
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canRun && !generating) {
                    e.preventDefault();
                    void onConfirm();
                  }
                }}
                placeholder="leave blank to auto-name from the diff"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                className={cn(
                  "flex-1 px-2.5 py-[7px] bg-bg-0 border border-bd-1 rounded-2",
                  "text-fg-0 text-[12px] font-mono outline-none",
                  "transition-colors duration-[120ms] focus:border-accent",
                )}
              />
              <button
                type="button"
                title="Suggest a branch name from the current diff"
                onClick={async () => {
                  if (generating) return;
                  setGenerating(true);
                  const suggestion = await generateBranchName();
                  setGenerating(false);
                  if (suggestion) {
                    setNewName(suggestion);
                    requestAnimationFrame(() => inputRef.current?.focus());
                  }
                }}
                disabled={generating}
                className={cn(
                  "grid place-items-center w-8 h-8 rounded-2",
                  "bg-bg-1 border border-bd-1 text-fg-2 cursor-pointer",
                  "hover:not-disabled:text-accent hover:not-disabled:border-accent",
                  "disabled:opacity-[0.45] disabled:cursor-not-allowed",
                )}
              >
                {generating ? <Spinner /> : I.sparkles}
              </button>
            </div>
          ) : null}
        </div>

        <div className="flex gap-2 justify-end mt-1">
          <button
            className={BTN_GHOST}
            onClick={closeDialog}
            type="button"
            disabled={generating}
          >
            Cancel
          </button>
          <button
            className={BTN_PRIMARY}
            onClick={() => void onConfirm()}
            disabled={!canRun || generating}
            type="button"
          >
            {generating ? (
              <>
                <Spinner />
                <span>Naming branch…</span>
              </>
            ) : (
              "Create PR"
            )}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
