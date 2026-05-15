import { useEffect, useRef, useState } from "react";
import { useRepoStore } from "@/features/repository/repository.store";
import { Overlay } from "./Overlay";
import { I } from "./Icons";

/**
 * Dialog shown before the `createPr` orchestrator fires. Lets the user
 * pick between:
 *   - "Use current branch" — commit/push/PR on whatever they're on
 *   - "Create new branch"  — name the branch (or let AI suggest one),
 *                            create it, then run the rest of the flow
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

  // Reset on each open.
  useEffect(() => {
    if (!open) return;
    setMode("current");
    setNewName("");
  }, [open]);

  useEffect(() => {
    if (open && mode === "new") {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open, mode]);

  if (!open) return null;

  const canRun =
    mode === "current" || (mode === "new" && newName.trim().length > 0);

  const onConfirm = () => {
    void createPr({
      newBranchName: mode === "new" ? newName.trim() : null,
    });
  };

  return (
    <Overlay onClose={closeDialog} centered>
      <div className="confirm-card" style={{ width: "min(480px, 92vw)" }}>
        <div className="confirm-title">Create Pull Request</div>
        <div className="confirm-body dim">
          Currently on{" "}
          <span className="mono">
            {repository?.currentBranch ?? "(no branch)"}
          </span>
          . What branch should the PR come from?
        </div>

        <div className="pr-branch-choice">
          <label
            className={`pr-branch-choice-row${mode === "current" ? " is-active" : ""}`}
          >
            <input
              type="radio"
              name="pr-branch-mode"
              checked={mode === "current"}
              onChange={() => setMode("current")}
            />
            <span className="pr-branch-choice-label">
              Use current branch
              <span className="dim mono">
                {repository?.currentBranch ?? ""}
              </span>
            </span>
          </label>
          <label
            className={`pr-branch-choice-row${mode === "new" ? " is-active" : ""}`}
          >
            <input
              type="radio"
              name="pr-branch-mode"
              checked={mode === "new"}
              onChange={() => setMode("new")}
            />
            <span className="pr-branch-choice-label">
              Create new branch from{" "}
              <span className="dim mono">
                {repository?.currentBranch ?? ""}
              </span>
            </span>
          </label>
          {mode === "new" ? (
            <div className="pr-branch-name-row">
              <input
                ref={inputRef}
                className="pr-branch-name-input mono"
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canRun) {
                    e.preventDefault();
                    onConfirm();
                  }
                }}
                placeholder="feature/new-branch-name"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
              />
              <button
                type="button"
                className="pr-branch-name-wand"
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
              >
                {generating ? <span className="ai-spinner" /> : I.sparkles}
              </button>
            </div>
          ) : null}
        </div>

        <div className="confirm-actions">
          <button className="ghost-btn" onClick={closeDialog} type="button">
            Cancel
          </button>
          <button
            className="primary-btn"
            onClick={onConfirm}
            disabled={!canRun}
            type="button"
          >
            Create PR
          </button>
        </div>
      </div>
    </Overlay>
  );
}
