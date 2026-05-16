import { useEffect, useRef, useState } from "react";
import { BTN_GHOST, BTN_PRIMARY } from "@/lib/btn";
import { cn } from "@/lib/utils";
import { I } from "./icons";
import { Spinner } from "./spinner";

type Props = {
  hunkIdx: number;
  filePath: string;
  busy: boolean;
  reverse: boolean; // true when the action unstages
  onCancel: () => void;
  onStageOnly: () => void;
  onStageAndCommit: (message: string) => void;
  /**
   * Optional AI generator — when provided, the "Generate" button is enabled
   * and clicking it fills the textarea with a draft. While unset, the button
   * renders as a "coming soon" placeholder.
   */
  onGenerate?: (signal: AbortSignal) => Promise<string>;
};

/**
 * Popover mounted inside `.hunk-popover-host` (the diff body components
 * wrap us in that host element so HunkActionBar's
 * `group-[:has(.hunk-popover-host)]:opacity-100` selector keeps the
 * action cluster visible while we're shown). Migrated from the
 * `.hunk-popover*` rules.
 */
export function HunkStagePopover({
  hunkIdx,
  filePath,
  busy,
  reverse,
  onCancel,
  onStageOnly,
  onStageAndCommit,
  onGenerate,
}: Props) {
  const [message, setMessage] = useState("");
  const [generating, setGenerating] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    return () => abortRef.current?.abort();
  }, []);

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
      return;
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (message.trim()) onStageAndCommit(message.trim());
      else onStageOnly();
    }
  }

  async function generate() {
    if (!onGenerate || generating) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setGenerating(true);
    try {
      const draft = await onGenerate(controller.signal);
      if (!controller.signal.aborted) setMessage(draft);
    } catch {
      /* swallow — caller should surface its own errors */
    } finally {
      setGenerating(false);
      abortRef.current = null;
    }
  }

  const stageLabel = reverse ? "Unstage only" : "Stage only";
  const commitLabel = reverse ? "Unstage & commit" : "Stage & commit";
  const eyebrow = reverse
    ? `Unstage hunk #${hunkIdx + 1}`
    : `Stage hunk #${hunkIdx + 1}`;
  const aiEnabled = !!onGenerate;

  return (
    <div
      className={cn(
        "w-[min(480px,calc(100%-8px))] bg-bg-2 border border-bd-3 rounded-3",
        "flex flex-col gap-2 px-3 py-2.5 font-sans",
        "shadow-[0_14px_40px_rgba(0,0,0,0.45),inset_0_0_0_0.5px_rgba(255,255,255,0.05)]",
      )}
    >
      <div className="grid grid-cols-[auto_1fr_auto] gap-2.5 items-baseline">
        <div className="font-mono text-fg-2 text-[10.5px] uppercase tracking-[0.04em]">
          {eyebrow}
        </div>
        <div
          className="font-mono text-fg-2 text-[11px] whitespace-nowrap overflow-hidden text-ellipsis min-w-0"
          title={filePath}
        >
          {filePath}
        </div>
        <button
          className="grid place-items-center w-[22px] h-[22px] rounded text-fg-3 hover:bg-bg-hover hover:text-fg-0"
          onClick={onCancel}
          title="Cancel (Esc)"
        >
          {I.x}
        </button>
      </div>
      <div className="relative">
        <textarea
          ref={inputRef}
          className={cn(
            "w-full min-h-14 px-2.5 pt-2 pb-[34px] resize-y",
            "rounded-2 border border-bd-2 bg-bg-0 text-fg-0",
            "font-mono text-[12px] leading-[1.45]",
            "focus:border-accent focus-within:border-accent outline-none",
          )}
          placeholder={
            generating
              ? "Generating commit message…"
              : "Commit message (optional) — ⌘↵ to confirm"
          }
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          disabled={busy || generating}
        />
        <button
          type="button"
          className={cn(
            "absolute bottom-1.5 right-2 inline-flex items-center gap-1.5",
            "h-[22px] pl-2 pr-2.5 rounded-full text-[11px] font-medium",
            "bg-accent-softer text-accent-hi",
            "border border-[color-mix(in_oklab,var(--accent)_30%,transparent)]",
            "transition-colors duration-[120ms]",
            "hover:bg-accent-soft hover:border-accent hover:text-accent-fg",
            "disabled:opacity-70 disabled:cursor-default",
          )}
          onClick={generate}
          disabled={busy || generating || !aiEnabled}
          title={
            aiEnabled
              ? "Generate commit message from this hunk"
              : "AI assist — coming soon"
          }
        >
          <span className="grid place-items-center [&_svg]:h-3 [&_svg]:w-3">
            {generating ? (
              <Spinner />
            ) : (
              I.sparkles
            )}
          </span>
          <span>{generating ? "Generating…" : "Generate"}</span>
          {!aiEnabled ? (
            <span className="font-mono text-fg-2 text-[9px] uppercase tracking-[0.06em] bg-white/[0.06] px-[5px] py-px rounded-[3px] ml-0.5">
              soon
            </span>
          ) : null}
        </button>
      </div>
      <div className="flex flex-col gap-2 text-[11px]">
        <div className="font-mono text-fg-2 text-[11px] leading-[1.4]">
          {generating
            ? "Drafting from the hunk diff…"
            : message.trim()
              ? "Will commit the index after staging."
              : "Type a message to commit, or stage only."}
        </div>
        <div className="flex flex-wrap justify-end items-center gap-1.5">
          <button
            className={BTN_GHOST}
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            className={BTN_GHOST}
            onClick={onStageOnly}
            disabled={busy || generating}
          >
            {stageLabel}
          </button>
          <button
            className={BTN_PRIMARY}
            onClick={() => onStageAndCommit(message.trim())}
            disabled={busy || generating || !message.trim()}
          >
            {commitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
