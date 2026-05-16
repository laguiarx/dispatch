import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BTN_GHOST, BTN_PRIMARY } from "@/lib/btn";
import { useRepoStore } from "@/features/repository/repository.store";
import { cn } from "@/lib/utils";
import { I } from "./icons";
import { Spinner } from "./spinner";

// Same shell shape as PrBranchChoiceDialog — both are portal-mounted
// popovers anchored to the topbar Git pill. Duplicating the constants here
// (instead of sharing) keeps each dialog independently editable; the rules
// are identical for now and will diverge if we ever differentiate them.
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
  "p-0.5 bg-transparent border-0 text-fg-3 cursor-pointer hover:text-fg-0 " +
  "disabled:opacity-40 disabled:cursor-not-allowed";

type Anchor = { top: number; left: number };

function computeAnchor(): Anchor {
  const trigger = document.querySelector<HTMLElement>(
    "[data-pr-create-trigger]",
  );
  if (!trigger) return { top: 60, left: 16 };
  const rect = trigger.getBoundingClientRect();
  return {
    top: rect.bottom + 6,
    // Drop straight beneath the trigger; clamp so the 420px card never
    // overflows past the right edge of the window.
    left: Math.max(
      8,
      Math.min(rect.left, window.innerWidth - 420 - 8),
    ),
  };
}

/**
 * Progress card for the `createPr` pipeline. Anchored beneath the
 * "Create PR" split-button in the topbar (same positioning logic as
 * GitMenu) instead of a centered modal — feels like an extension of the
 * button that triggered it, not a separate full-screen interrupt. Stays
 * open during running / done / error states; idle = invisible.
 *
 * Migrated from `.pr-flow-*` rules.
 */
export function PrFlowDialog() {
  const flow = useRepoStore((s) => s.prFlow);
  const reset = useRepoStore((s) => s.resetPrFlow);
  const ref = useRef<HTMLDivElement | null>(null);
  const [anchor, setAnchor] = useState<Anchor>({ top: 60, left: 16 });

  useLayoutEffect(() => {
    if (flow.state === "idle") return;
    setAnchor(computeAnchor());
    const onResize = () => setAnchor(computeAnchor());
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
    };
  }, [flow.state]);

  useEffect(() => {
    if (flow.state === "idle") return;
    // Only Escape closes — clicking outside is intentionally a no-op so
    // the user doesn't accidentally dismiss the in-flight progress card.
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && flow.state !== "running") reset();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [flow.state, reset]);

  if (flow.state === "idle") return null;

  return createPortal(
    <div
      ref={ref}
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
          onClick={reset}
          type="button"
          title="Close"
          disabled={flow.state === "running"}
        >
          {I.x}
        </button>
      </div>

      <div className="px-[18px] pt-[18px] pb-4">
        {flow.state === "running" ? (
          <div className="flex items-center gap-2.5 text-[13px] text-fg-0 [&_[data-ai-spinner]]:w-4 [&_[data-ai-spinner]]:h-4">
            <Spinner />
            <span className="[font-variant-numeric:tabular-nums]">
              {flow.message || "Working…"}
            </span>
          </div>
        ) : flow.state === "done" ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "grid place-items-center w-[22px] h-[22px] rounded-full",
                  "bg-[color-mix(in_oklab,var(--git-add)_24%,transparent)] text-git-add",
                  "[&_svg]:w-3.5 [&_svg]:h-3.5",
                )}
              >
                {I.check}
              </span>
              <span className="text-[13px] text-fg-0 font-medium">
                {flow.message}
              </span>
            </div>
            {flow.url ? (
              <a
                href={flow.url}
                target="_blank"
                rel="noreferrer"
                className={cn(
                  "block px-2.5 py-2 bg-bg-0 border border-bd-1 rounded-2",
                  "font-mono text-[11.5px] text-accent no-underline break-all",
                  "hover:border-accent select-text",
                )}
              >
                {flow.url}
              </a>
            ) : null}
            <div className="flex gap-2 justify-end">
              <button className={BTN_GHOST} onClick={reset} type="button">
                Close
              </button>
              {flow.url ? (
                <a
                  href={flow.url}
                  target="_blank"
                  rel="noreferrer"
                  className={BTN_PRIMARY}
                >
                  Open PR ↗
                </a>
              ) : null}
            </div>
          </div>
        ) : flow.state === "error" ? (
          <div className="flex flex-col gap-2.5">
            <div className="text-[13px] text-git-del font-medium">
              Couldn't create PR
            </div>
            <div
              className={cn(
                "px-2.5 py-2 bg-bg-0 border border-bd-1 rounded-2",
                "font-mono text-[11.5px] text-fg-1 whitespace-pre-wrap break-words",
                "select-text",
              )}
            >
              {flow.error}
            </div>
            <div className="flex gap-2 justify-end">
              <button className={BTN_GHOST} onClick={reset} type="button">
                Close
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
