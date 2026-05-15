import { useRepoStore } from "@/features/repository/repository.store";
import { Overlay } from "./Overlay";
import { I } from "./Icons";

/**
 * Streaming progress modal for the `createPr` pipeline. Renders a single
 * status line that the orchestrator updates as each step completes
 * (resolving default branch → staging → commit → push → drafting PR →
 * gh pr create). On success swaps to a success card with the PR URL and
 * an Open PR button.
 */
export function PrFlowDialog() {
  const flow = useRepoStore((s) => s.prFlow);
  const reset = useRepoStore((s) => s.resetPrFlow);
  if (flow.state === "idle") return null;

  // While running, clicking the backdrop is intentionally a no-op (Esc
  // closes via Overlay — that just dismisses the modal, the underlying
  // job keeps running on the store; not ideal, but cancellation needs a
  // real abort signal we don't have yet).
  return (
    <Overlay onClose={reset} centered>
      <div className="pr-flow-dialog">
        <div className="pr-flow-head">
          <span className="pr-flow-eyebrow mono dim">Git · Create PR</span>
          <span className="flex-spacer" />
          <button
            className="pr-flow-close"
            onClick={reset}
            type="button"
            title="Close"
          >
            {I.x}
          </button>
        </div>

        <div className="pr-flow-body">
          {flow.state === "running" ? (
            <div className="pr-flow-running">
              <span className="ai-spinner" />
              <span className="pr-flow-message">{flow.message || "Working…"}</span>
            </div>
          ) : flow.state === "done" ? (
            <div className="pr-flow-done">
              <div className="pr-flow-done-head">
                <span className="pr-flow-check">{I.check}</span>
                <span className="pr-flow-done-title">{flow.message}</span>
              </div>
              {flow.url ? (
                <a
                  href={flow.url}
                  target="_blank"
                  rel="noreferrer"
                  className="pr-flow-url mono"
                >
                  {flow.url}
                </a>
              ) : null}
              <div className="pr-flow-actions">
                <button
                  className="ghost-btn"
                  onClick={reset}
                  type="button"
                >
                  Close
                </button>
                {flow.url ? (
                  <a
                    href={flow.url}
                    target="_blank"
                    rel="noreferrer"
                    className="primary-btn"
                  >
                    Open PR ↗
                  </a>
                ) : null}
              </div>
            </div>
          ) : flow.state === "error" ? (
            <div className="pr-flow-error">
              <div className="pr-flow-error-title">Couldn't create PR</div>
              <div className="pr-flow-error-body mono">{flow.error}</div>
              <div className="pr-flow-actions">
                <button
                  className="ghost-btn"
                  onClick={reset}
                  type="button"
                >
                  Close
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </Overlay>
  );
}
