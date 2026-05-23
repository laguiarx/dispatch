import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useRepoStore } from "@/features/repository/repository.store";
import { I } from "./icons";
import { Overlay } from "./overlay";

/**
 * Confirm-stash-then-switch dialog. Surfaces when the store catches a
 * dirty-tree checkout and parks the request in `pendingStashCheckout`.
 *
 * Migrated from `.stash-prompt*` rules. The X close button uses inline
 * Tailwind (22×22 ghost button); the same shape is repeated in
 * Settings/Shortcuts/Onboarding — short enough that a shared util didn't
 * earn its keep.
 */
export function StashPromptDialog() {
  const pending = useRepoStore((s) => s.pendingStashCheckout);
  const cancel = useRepoStore((s) => s.cancelPendingStashCheckout);
  const confirm = useRepoStore((s) => s.confirmStashAndCheckout);

  const [message, setMessage] = useState("");
  const [includeUntracked, setIncludeUntracked] = useState(true);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Seed the input with the suggested message when the dialog opens.
  useEffect(() => {
    if (pending) {
      setMessage(pending.suggestedMessage);
      setBusy(false);
      requestAnimationFrame(() => inputRef.current?.select());
    }
  }, [pending]);

  if (!pending) return null;

  const submit = async () => {
    if (!message.trim() || busy) return;
    setBusy(true);
    await confirm(message.trim(), includeUntracked);
    setBusy(false);
  };

  return (
    <Overlay onClose={cancel} centered>
      <div
        className={
          "w-[min(520px,92vw)] bg-bg-1 border border-bd-2 rounded-3 " +
          "flex flex-col overflow-hidden shadow-[0_24px_60px_rgba(0,0,0,0.55)]"
        }
      >
        <div className="flex items-center gap-2 px-3.5 py-3 border-b border-bd-1">
          <span className="text-[14px] font-semibold flex-1">
            Bring changes to the new branch
          </span>
          <Button variant="unstyled"
            className="w-[22px] h-[22px] grid place-items-center rounded-[4px] text-fg-3 bg-transparent border-0 cursor-pointer hover:bg-bg-hover hover:text-fg-0"
            onClick={cancel}
            title="Cancel"
            aria-label="Cancel"
          >
            {I.x}
          </Button>
        </div>
        <div className="flex flex-col gap-3 px-4 py-3.5">
          <p className="m-0 text-[12.5px] text-fg-2 leading-[1.5]">
            Your working tree has changes that would be overwritten by
            switching to <strong>{pending.target}</strong>. We'll stash
            them, switch, and re-apply on top of the new branch so you
            keep editing where you left off. If the changes conflict with{" "}
            <strong>{pending.target}</strong>, they stay safely in the
            stash list for you to resolve manually.
          </p>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-fg-3">Stash message</span>
            <input
              ref={inputRef}
              type="text"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                }
              }}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className={
                "h-7 px-2.5 text-[12.5px] rounded-2 bg-bg-2 border border-bd-2 " +
                "text-fg-0 outline-none focus:border-accent"
              }
            />
          </label>
          <label className="inline-flex items-center gap-2 text-[12px] text-fg-1 cursor-pointer">
            <input
              type="checkbox"
              checked={includeUntracked}
              onChange={(e) => setIncludeUntracked(e.target.checked)}
            />
            <span>Include untracked files</span>
          </label>
        </div>
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-bd-1 bg-bg-0">
          <Button
            variant="outline"
            size="sm"
            onClick={cancel}
            disabled={busy}
            type="button"
          >
            Cancel
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={submit}
            disabled={!message.trim() || busy}
            type="button"
          >
            {busy ? "Stashing…" : `Bring changes to ${pending.target}`}
          </Button>
        </div>
      </div>
    </Overlay>
  );
}
