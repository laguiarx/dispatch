import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { useRepoStore } from "@/features/repository/repository.store";
import type { AiKind } from "@/features/ai/ai.types";
import { cn } from "@/lib/utils";
import { Overlay } from "./overlay";
import { I } from "./icons";
import { Spinner } from "./spinner";

const TABS: { id: AiKind; label: string }[] = [
  { id: "commit", label: "Commit" },
  { id: "pr", label: "PR" },
  { id: "summary", label: "Summary" },
  { id: "risk", label: "Risk" },
];

/**
 * Centralized modal that streams AI Assist output (commit message / PR
 * description / summary / risk). Replaces the inline AiOutputSection that
 * used to live in the right sidebar — now that the trigger lives globally
 * in the topbar's `GitMenu`, the output is global too. Opens automatically
 * when `aiKind` is set; closing the modal clears `aiKind`.
 *
 * Migrated from the `.ai-output-dialog*` / `.ai-loading` / `.ai-error*` /
 * `.ai-actions-row` / `.ai-output-text` / `.ai-output-close` / `.ai-model`
 * rules.
 */
export function AiOutputDialog() {
  const aiKind = useRepoStore((s) => s.aiKind);
  const setAiKind = useRepoStore((s) => s.setAiKind);
  const pushToast = useRepoStore((s) => s.pushToast);
  const runAi = useRepoStore((s) => s.runAi);
  const aiOutput = useRepoStore((s) => s.aiOutput);
  const aiLoading = useRepoStore((s) => s.aiLoading);
  const aiError = useRepoStore((s) => s.aiError);
  const setSettingsOpen = useRepoStore((s) => s.setSettingsOpen);

  // Kick off the run when aiKind changes — same dedupe pattern as the old
  // inline section so we don't loop on re-render.
  const lastRunRef = useRef<AiKind | null>(null);
  useEffect(() => {
    if (!aiKind) {
      lastRunRef.current = null;
      return;
    }
    if (lastRunRef.current === aiKind) return;
    lastRunRef.current = aiKind;
    runAi(aiKind).catch(() => {
      /* errors land in aiError */
    });
  }, [aiKind, runAi]);

  if (!aiKind) return null;
  const tab = TABS.find((t) => t.id === aiKind);
  const currentLabel = tab?.label ?? "";

  const close = () => setAiKind(null);
  const copy = async () => {
    if (!aiOutput) return;
    try {
      await navigator.clipboard.writeText(aiOutput.text);
      pushToast("Copied to clipboard");
    } catch {
      pushToast("Clipboard unavailable");
    }
  };
  const regenerate = () => {
    lastRunRef.current = null;
    runAi(aiKind).catch(() => {
      /* errors land in aiError */
    });
  };

  return (
    <Overlay onClose={close} centered>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`AI · ${currentLabel}`}
        className={cn(
          "w-[min(720px,92vw)] max-h-[80vh] flex flex-col overflow-hidden",
          "bg-bg-1 border border-bd-2 rounded-3 shadow-[0_24px_60px_rgba(0,0,0,0.55)]",
        )}
      >
        <div className="flex items-center gap-2 px-3.5 py-3 bg-bg-2 border-b border-bd-0">
          <span className="font-mono text-fg-2 text-[10px] uppercase tracking-[0.08em]">
            AI · {currentLabel}
          </span>
          <span className="flex-1" />
          <Button variant="unstyled"
            className="grid place-items-center w-5 h-5 rounded text-fg-3 hover:bg-bg-hover hover:text-fg-0"
            onClick={close}
            title="Close (Esc)"
            type="button"
          >
            {I.x}
          </Button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-4 pt-3.5 pb-3 flex flex-col gap-2.5">
          {aiLoading ? (
            <div className="flex items-center gap-2.5 px-3.5 py-3 text-fg-2 text-[12px]">
              <Spinner />
              <span>Running {currentLabel.toLowerCase()}…</span>
            </div>
          ) : aiError ? (
            <div
              className={cn(
                "p-3 rounded-2",
                "border border-[color-mix(in_oklab,var(--git-del)_30%,transparent)]",
                "bg-[color-mix(in_oklab,var(--git-del)_8%,transparent)]",
              )}
            >
              <div className="font-semibold text-[12px] text-fg-0 mb-1">
                Couldn't run AI
              </div>
              <div className="font-mono text-[11px] text-fg-2 whitespace-pre-wrap break-words mb-2.5">
                {aiError}
              </div>
              <div className="flex gap-1.5 mt-2.5">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    close();
                    setSettingsOpen(true);
                  }}
                  type="button"
                >
                  Open Preferences
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={regenerate}
                  type="button"
                >
                  {I.retry} Retry
                </Button>
              </div>
            </div>
          ) : aiOutput ? (
            <>
              <pre
                className={cn(
                  "m-0 px-3.5 py-3 bg-bg-0 border border-bd-1 rounded-2",
                  "font-mono text-[12px] leading-[1.55] text-fg-0",
                  "whitespace-pre-wrap break-words",
                )}
              >
                {aiOutput.text}
              </pre>
              <div className="flex items-center gap-2 pt-1">
                <span className="inline-flex items-center gap-1 font-mono text-fg-2 text-[10px]">
                  via {aiOutput.cliName}
                </span>
                <span className="flex-1" />
                <Button variant="outline" size="sm" onClick={copy} type="button">
                  {I.copy} Copy
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={regenerate}
                  type="button"
                >
                  {I.retry} Regenerate
                </Button>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </Overlay>
  );
}
