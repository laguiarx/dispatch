import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BTN_GHOST, BTN_PRIMARY } from "@/lib/btn";
import { useRepoStore } from "@/features/repository/repository.store";
import { cn } from "@/lib/utils";
import { I } from "./icons";
import { Spinner } from "./spinner";

// Shared shell styling for portal-anchored popovers. Floating card with
// frosted glass, soft shadow, and a thin highlight-from-the-top inner
// stroke. Width bumped slightly vs the old branch-only card to fit the
// "From / Into / Status" three-row layout without crowding.
const POPOVER_SHELL =
  "fixed z-[9999] w-[min(460px,94vw)] flex flex-col overflow-hidden " +
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

// Row label for the From / Into / Status sections — small caps, fixed
// width so the controls below line up.
const ROW_LABEL =
  "shrink-0 w-12 pt-1 font-mono text-[10px] uppercase tracking-[0.08em] text-fg-3";

type Anchor = { top: number; left: number };

function computeAnchor(): Anchor {
  const trigger = document.querySelector<HTMLElement>(
    "[data-pr-create-trigger]",
  );
  if (!trigger) return { top: 60, left: 16 };
  const rect = trigger.getBoundingClientRect();
  return {
    top: rect.bottom + 6,
    left: Math.max(
      8,
      Math.min(rect.left, window.innerWidth - 460 - 8),
    ),
  };
}

/**
 * Pre-flight card for the "Create PR" pipeline. Three blocks:
 *
 *   - **From** — radio toggle between "use current branch" and "create
 *     a new branch from current"; new-branch path has an AI ✨ wand for
 *     a diff-derived name.
 *
 *   - **Into** — segmented dropdown of `origin/*` branches so the user
 *     can target main / develop / staging / etc. Persisted per repo.
 *
 *   - **Status** — live behind/ahead readout against the chosen base,
 *     with inline Rebase / Merge / Skip affordances when the head is
 *     behind. The Create-PR button is gated until the user is either
 *     up-to-date or has explicitly skipped the warning.
 *
 * Portal-mounted and anchored beneath the "Create PR" split-button in
 * the topbar so the whole interaction reads as one cascade from the
 * button rather than three disconnected dialogs.
 */
export function PrBranchChoiceDialog() {
  const open = useRepoStore((s) => s.prBranchChoiceOpen);
  const closeDialog = useRepoStore((s) => s.closePrBranchChoice);
  const createPr = useRepoStore((s) => s.createPr);
  const repository = useRepoStore((s) => s.repository);
  const generateBranchName = useRepoStore((s) => s.generateBranchName);

  const prDialog = useRepoStore((s) => s.prDialog);
  const setPrDialogBase = useRepoStore((s) => s.setPrDialogBase);
  const prDialogRebase = useRepoStore((s) => s.prDialogRebase);
  const prDialogMerge = useRepoStore((s) => s.prDialogMerge);
  const prDialogSkipBehind = useRepoStore((s) => s.prDialogSkipBehind);

  const [mode, setMode] = useState<"current" | "new">("current");
  const [newName, setNewName] = useState("");
  const [generating, setGenerating] = useState(false);
  const [basePickerOpen, setBasePickerOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const baseTriggerRef = useRef<HTMLButtonElement | null>(null);
  const basePopRef = useRef<HTMLDivElement | null>(null);

  const [anchor, setAnchor] = useState<Anchor>({ top: 60, left: 16 });

  // "Trunk" = the repo's default branch (main/master). The Rust
  // `git_remote_branches` command sorts it first, so `bases[0]` is the
  // authoritative default. We treat ONLY the default branch as trunk:
  //   - On main → hide "Current branch" (you don't PR FROM main).
  //   - On develop / release / etc → show "Current branch" so the user
  //     can legitimately PR develop → main (GitFlow release flow).
  //   - On a feature branch that's been pushed → also show "Current",
  //     because it's where the user actually wants to PR from.
  // Computed reactively because `bases` loads async after the dialog opens.
  const defaultBase = prDialog.bases[0] ?? null;
  const currentBranchIsTrunk =
    !!repository?.currentBranch &&
    !!defaultBase &&
    repository.currentBranch === defaultBase;

  // Auto-pick the right mode. Two-pass so the async bases load doesn't
  // strand the user on a now-invalid choice:
  //   1) On open: clear local state, take the best guess given current bases.
  //   2) On bases-arrive: if the user is on a trunk branch, switch to "new".
  // `userPickedMode` records explicit user intent so we never override a
  // deliberate "I really do want current" click.
  const userPickedMode = useRef(false);
  useEffect(() => {
    if (!open) {
      userPickedMode.current = false;
      return;
    }
    setNewName("");
    setBasePickerOpen(false);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    if (userPickedMode.current) return;
    setMode(currentBranchIsTrunk ? "new" : "current");
  }, [open, currentBranchIsTrunk]);
  const pickMode = (next: "current" | "new") => {
    userPickedMode.current = true;
    setMode(next);
  };

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

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const t = e.target as Node | null;
      // Base-picker has its own outside-click logic — let it handle its
      // own dismiss so a click inside it doesn't close the whole dialog.
      if (basePopRef.current && t && basePopRef.current.contains(t)) return;
      if (cardRef.current && t && !cardRef.current.contains(t)) {
        const trigger = document.querySelector("[data-pr-create-trigger]");
        if (trigger && trigger.contains(t)) return;
        closeDialog();
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (basePickerOpen) setBasePickerOpen(false);
        else closeDialog();
      }
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, basePickerOpen, closeDialog]);

  if (!open) return null;

  const currentBranch = repository?.currentBranch ?? "";
  const headBranch = mode === "new" ? newName.trim() || "(auto-named)" : currentBranch;
  const base = prDialog.base;

  // Gate Create PR on: a base is resolved, head != base, status isn't
  // mid-rebase, and the user is either up-to-date OR explicitly skipped.
  const sameBranch = !!base && headBranch === base && mode === "current";
  const stale = prDialog.behind > 0 && !prDialog.ignoreBehind;
  const canRun =
    !generating &&
    !prDialog.statusLoading &&
    !!base &&
    !sameBranch &&
    !stale;

  const onConfirm = async () => {
    if (!base) return;
    if (mode === "current") {
      void createPr({ newBranchName: null, baseBranch: base });
      return;
    }
    const typed = newName.trim();
    if (typed) {
      void createPr({ newBranchName: typed, baseBranch: base });
      return;
    }
    if (generating) return;
    setGenerating(true);
    const suggestion = await generateBranchName();
    setGenerating(false);
    if (!suggestion) return;
    setNewName(suggestion);
    void createPr({ newBranchName: suggestion, baseBranch: base });
  };

  const choiceRow = (active: boolean) =>
    cn(
      "flex items-center gap-2.5 px-3 py-2.5 rounded-2 cursor-pointer",
      "bg-bg-1 border transition-colors duration-[120ms]",
      active
        ? "border-accent bg-accent-soft"
        : "border-bd-1 hover:border-bd-2",
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

      <div className="flex flex-col gap-3 px-4 py-3.5">
        {/* FROM section */}
        <div className="flex gap-3">
          <div className={ROW_LABEL}>From</div>
          <div className="flex-1 flex flex-col gap-1.5">
            {currentBranchIsTrunk ? (
              // On a trunk branch (main/develop/...): "Current branch"
              // would be a self-PR — surface a 1-line hint instead of a
              // disabled-looking radio.
              <div className="px-3 py-2 text-[11.5px] text-fg-2 leading-[1.45]">
                You're on{" "}
                <span className="font-mono text-fg-1">{currentBranch}</span>
                . Create a new branch to open a PR from.
              </div>
            ) : (
              <label className={choiceRow(mode === "current")}>
                <input
                  type="radio"
                  name="pr-branch-mode"
                  checked={mode === "current"}
                  onChange={() => pickMode("current")}
                />
                <span className="inline-flex items-baseline gap-2 text-[12px] text-fg-0">
                  Current branch
                  <span className="font-mono text-fg-2">{currentBranch}</span>
                </span>
              </label>
            )}
            <label className={choiceRow(mode === "new")}>
              <input
                type="radio"
                name="pr-branch-mode"
                checked={mode === "new"}
                onChange={() => pickMode("new")}
              />
              <span className="inline-flex items-baseline gap-2 text-[12px] text-fg-0">
                New branch from{" "}
                <span className="font-mono text-fg-2">{currentBranch}</span>
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
                    if (e.key === "Enter" && canRun) {
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
        </div>

        {/* INTO section — base branch picker */}
        <div className="flex gap-3 items-start">
          <div className={ROW_LABEL}>Into</div>
          <div className="flex-1 relative">
            <button
              ref={baseTriggerRef}
              type="button"
              onClick={() => setBasePickerOpen((v) => !v)}
              disabled={prDialog.bases.length === 0}
              className={cn(
                "w-full flex items-center gap-2 px-3 py-2 rounded-2",
                "bg-bg-1 border border-bd-1 text-fg-0 text-[12px] cursor-pointer",
                "hover:border-bd-2 transition-colors duration-[120ms]",
                "disabled:opacity-50 disabled:cursor-not-allowed",
                basePickerOpen && "border-accent",
              )}
            >
              <span className="inline-flex text-fg-2">{I.branch}</span>
              <span className="font-mono">
                {base ?? (prDialog.statusLoading ? "loading…" : "(no remote)")}
              </span>
              <span className="flex-1" />
              <span className="text-fg-3">{I.chevron}</span>
            </button>
            {basePickerOpen ? (
              <div
                ref={basePopRef}
                className={cn(
                  "absolute z-10 top-[calc(100%+4px)] left-0 right-0",
                  "max-h-60 overflow-y-auto py-1",
                  "bg-bg-2 border border-bd-2 rounded-2",
                  "shadow-[0_12px_32px_rgba(0,0,0,0.5)]",
                  "[scrollbar-width:thin] [scrollbar-color:var(--bd-2)_transparent]",
                )}
              >
                {(() => {
                  // Filter out the current branch when the PR ships from
                  // it — you can't open a PR from a branch into itself.
                  // In "new branch" mode every base is valid (the new
                  // branch is created from current and could legitimately
                  // target current as the merge base).
                  const visible = prDialog.bases.filter(
                    (name) => mode === "new" || name !== currentBranch,
                  );
                  if (visible.length === 0) {
                    return (
                      <div className="px-3 py-2 text-[11.5px] text-fg-3 italic">
                        No other branches on origin
                        {prDialog.bases.length > 0
                          ? " — push a different branch first"
                          : ""}
                        .
                      </div>
                    );
                  }
                  return visible.map((name) => (
                    <button
                      key={name}
                      type="button"
                      onClick={() => {
                        setPrDialogBase(name);
                        setBasePickerOpen(false);
                      }}
                      className={cn(
                        "w-full flex items-center gap-2 px-3 py-1.5",
                        "text-left text-[12px] font-mono bg-transparent border-0",
                        "cursor-pointer hover:bg-bg-hover hover:text-fg-0",
                        name === base ? "text-accent" : "text-fg-1",
                      )}
                    >
                      <span className="w-3 inline-flex">
                        {name === base ? I.check : null}
                      </span>
                      {name}
                    </button>
                  ));
                })()}
              </div>
            ) : null}
          </div>
        </div>

        {/* STATUS section — behind/ahead + rebase/merge */}
        {base ? <StatusBlock
          base={base}
          loading={prDialog.statusLoading}
          behind={prDialog.behind}
          ahead={prDialog.ahead}
          ignoreBehind={prDialog.ignoreBehind}
          error={prDialog.statusError}
          sameBranch={sameBranch}
          onRebase={() => void prDialogRebase()}
          onMerge={() => void prDialogMerge()}
          onSkip={prDialogSkipBehind}
        /> : null}

        <div className="flex gap-2 justify-end mt-1">
          <button
            className={BTN_GHOST}
            onClick={closeDialog}
            type="button"
            disabled={generating || prDialog.statusLoading}
          >
            Cancel
          </button>
          <button
            className={BTN_PRIMARY}
            onClick={() => void onConfirm()}
            disabled={!canRun}
            type="button"
            title={
              sameBranch
                ? "PR can't merge a branch into itself"
                : stale
                  ? "Your branch is behind the base. Rebase, merge, or skip first."
                  : undefined
            }
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

/**
 * Behind/ahead readout + rebase/merge/skip affordance. Pulled out so the
 * main dialog body stays readable.
 *
 *   - `sameBranch=true` → degenerate state ("you're already on the base").
 *   - `behind > 0 && !ignoreBehind` → amber warning + 3 buttons.
 *   - `behind === 0` → green "Up to date" pill, ahead count for context.
 *
 * Errors from rebase/merge surface inline (red banner) so the user can
 * decide to resolve in a terminal and retry without losing the dialog.
 */
function StatusBlock({
  base,
  loading,
  behind,
  ahead,
  ignoreBehind,
  error,
  sameBranch,
  onRebase,
  onMerge,
  onSkip,
}: {
  base: string;
  loading: boolean;
  behind: number;
  ahead: number;
  ignoreBehind: boolean;
  error: string | null;
  sameBranch: boolean;
  onRebase: () => void;
  onMerge: () => void;
  onSkip: () => void;
}) {
  if (sameBranch) {
    return (
      <div className="flex gap-3 items-start">
        <div className={ROW_LABEL}>Status</div>
        <div
          className={cn(
            "flex-1 px-3 py-2 rounded-2 text-[11.5px] leading-[1.45]",
            "bg-[color-mix(in_oklab,var(--git-del)_12%,transparent)]",
            "border border-[color-mix(in_oklab,var(--git-del)_35%,transparent)]",
            "text-fg-1",
          )}
        >
          Your head and base are the same branch. Pick "New branch" above
          or change the base.
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-3 items-start">
      <div className={ROW_LABEL}>Status</div>
      <div className="flex-1 flex flex-col gap-1.5">
        {loading ? (
          <div className="flex items-center gap-2 px-3 py-2 rounded-2 bg-bg-1 border border-bd-1 text-[11.5px] text-fg-2">
            <Spinner />
            Comparing with origin/{base}…
          </div>
        ) : behind === 0 ? (
          <div
            className={cn(
              "flex items-center gap-2 px-3 py-2 rounded-2 text-[11.5px]",
              "bg-[color-mix(in_oklab,var(--git-add)_10%,transparent)]",
              "border border-[color-mix(in_oklab,var(--git-add)_30%,transparent)]",
              "text-fg-1",
            )}
          >
            <span className="text-git-add">{I.check}</span>
            Up to date with origin/{base}
            {ahead > 0 ? (
              <span className="ml-auto font-mono text-fg-2">
                ↑{ahead} commit{ahead === 1 ? "" : "s"} to push
              </span>
            ) : null}
          </div>
        ) : ignoreBehind ? (
          <div
            className={cn(
              "flex items-center gap-2 px-3 py-2 rounded-2 text-[11.5px]",
              "bg-bg-1 border border-bd-1 text-fg-1",
            )}
          >
            ⚠ Skipping — you're {behind} commit{behind === 1 ? "" : "s"} behind
            origin/{base}. PR may have conflicts.
          </div>
        ) : (
          <>
            <div
              className={cn(
                "flex items-center gap-2 px-3 py-2 rounded-2 text-[11.5px]",
                "bg-[color-mix(in_oklab,var(--git-mod)_14%,transparent)]",
                "border border-[color-mix(in_oklab,var(--git-mod)_38%,transparent)]",
                "text-fg-1",
              )}
            >
              <span className="text-git-mod">⚠</span>
              {behind} commit{behind === 1 ? "" : "s"} behind origin/{base}.
              Update first?
            </div>
            <div className="flex flex-wrap gap-1.5 justify-end">
              <button
                type="button"
                onClick={onRebase}
                className={cn(
                  "px-2.5 py-[6px] rounded-2 text-[11.5px] font-medium",
                  "bg-bg-1 border border-bd-1 text-fg-0 cursor-pointer",
                  "hover:border-accent hover:text-accent",
                )}
                title={`git rebase origin/${base}`}
              >
                Rebase onto {base}
              </button>
              <button
                type="button"
                onClick={onMerge}
                className={cn(
                  "px-2.5 py-[6px] rounded-2 text-[11.5px] font-medium",
                  "bg-bg-1 border border-bd-1 text-fg-0 cursor-pointer",
                  "hover:border-accent hover:text-accent",
                )}
                title={`git merge --no-edit origin/${base}`}
              >
                Merge {base}
              </button>
              <button
                type="button"
                onClick={onSkip}
                className={cn(
                  "px-2.5 py-[6px] rounded-2 text-[11.5px]",
                  "bg-transparent border border-bd-1 text-fg-2 cursor-pointer",
                  "hover:text-fg-0 hover:border-bd-2",
                )}
                title="Open PR anyway — resolve conflicts on GitHub"
              >
                Skip
              </button>
            </div>
          </>
        )}
        {error ? (
          <div
            className={cn(
              "px-3 py-2 rounded-2 text-[11px] font-mono leading-[1.4]",
              "bg-[color-mix(in_oklab,var(--git-del)_10%,transparent)]",
              "border border-[color-mix(in_oklab,var(--git-del)_30%,transparent)]",
              "text-fg-1 whitespace-pre-wrap break-words select-text",
            )}
          >
            {error}
          </div>
        ) : null}
      </div>
    </div>
  );
}
