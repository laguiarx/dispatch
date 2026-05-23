import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";
import { Spinner } from "@/components/spinner";
import { I } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { useDismissableLayer } from "@/hooks/use-dismissable-layer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { iconNodeFor } from "./action-icon";
import { ChipPopover, type ChipOption } from "./chip-popover";
import { useBoardStore } from "@/features/board/board.store";
import { useRepoStore } from "@/features/repository/repository.store";
import type {
  AgentId,
  Attachment,
  Priority,
  ProjectScript,
  Run,
  RunLog,
} from "@/features/board/board.types";

// Stable empty refs so Zustand selectors don't trip the
// "getSnapshot returned a different value" infinite-loop warning by
// constructing `[]` on every read. Treat as read-only at the call sites.
const EMPTY_ATTACHMENTS: Attachment[] = [];
const EMPTY_SCRIPTS: ProjectScript[] = [];
const EMPTY_LOGS: RunLog[] = [];
import * as boardApi from "@/features/board/board.api";

type Props = {
  /** Open the worktree diff for this card in Review mode. */
  onOpenReview: (worktreePath: string) => void;
  /** Approve the card: auto-commit, push, open PR, move to Done. */
  onApprove?: () => void;
};

/**
 * Codex-style card detail modal: full-screen view with the primary
 * action surfaced in the header, secondary actions tucked behind a
 * kebab menu, a slim metadata sidebar, a conversational transcript of
 * the runs (rendered as markdown), and a follow-up input at the bottom.
 */
export function CardDetailModal({ onOpenReview, onApprove }: Props) {
  const cardId = useBoardStore((s) => s.selectedCardId);
  const card = useBoardStore((s) =>
    s.selectedCardId ? s.cards[s.selectedCardId] : null,
  );
  const project = useBoardStore((s) =>
    card ? s.projectsById[card.projectId] : null,
  );
  const selectCard = useBoardStore((s) => s.selectCard);
  const deleteCard = useBoardStore((s) => s.deleteCard);
  const updateCard = useBoardStore((s) => s.updateCard);
  const moveCardTo = useBoardStore((s) => s.moveCardTo);
  const enqueueFollowUp = useBoardStore((s) => s.enqueueFollowUp);
  const abortCard = useBoardStore((s) => s.abortCard);
  const archiveCard = useBoardStore((s) => s.archiveCard);
  const runs = useBoardStore((s) =>
    cardId ? s.runsByCard[cardId] ?? null : null,
  );
  const running = useBoardStore((s) =>
    cardId ? s.runningCardIds.has(cardId) : false,
  );
  const approving = useBoardStore((s) =>
    cardId ? s.approvingCardIds.has(cardId) : false,
  );
  const archiving = useBoardStore((s) =>
    cardId ? s.archivingCardIds.has(cardId) : false,
  );
  const reloadRuns = useBoardStore((s) => s.reloadRuns);
  const reloadRunLogs = useBoardStore((s) => s.reloadRunLogs);
  const reloadAttachments = useBoardStore((s) => s.reloadAttachments);
  const removeAttachment = useBoardStore((s) => s.removeAttachment);
  const attachments = useBoardStore((s) =>
    cardId ? s.attachmentsByCard[cardId] ?? EMPTY_ATTACHMENTS : EMPTY_ATTACHMENTS,
  );
  const logsByRun = useBoardStore((s) => s.logsByRun);
  const pushToast = useRepoStore((s) => s.pushToast);
  const setConfirm = useRepoStore((s) => s.setConfirm);

  const [followUp, setFollowUp] = useState("");
  const [chatFiles, setChatFiles] = useState<File[]>([]);
  const [chatDropActive, setChatDropActive] = useState(false);
  // Island visibility — persisted across reloads. The user might want it
  // hidden even on a wide window (less distraction while reading the
  // chat); we don't auto-collapse based on viewport width because the
  // explicit toggle is a clearer mental model. Default open: most users
  // benefit from seeing the Run config + Runs history at a glance.
  const [islandOpen, setIslandOpenState] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    const stored = window.localStorage.getItem("dispatch:detail-island-open");
    return stored === null ? true : stored === "1";
  });
  const setIslandOpen = (open: boolean) => {
    setIslandOpenState(open);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(
        "dispatch:detail-island-open",
        open ? "1" : "0",
      );
    }
  };
  // Title + description are editable in-place when the card is still in
  // backlog (no agent run yet). Once it leaves, edits would diverge from
  // what the agent already saw, so we lock them.
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState("");
  const descriptionTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const chatFileInputRef = useRef<HTMLInputElement | null>(null);
  const attachFile = useBoardStore((s) => s.attachFile);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  const reloadProjectScripts = useBoardStore((s) => s.reloadProjectScripts);
  const scripts = useBoardStore((s) =>
    card ? s.scriptsByProject[card.projectId] ?? EMPTY_SCRIPTS : EMPTY_SCRIPTS,
  );
  const runInTerminalAt = useRepoStore((s) => s.runInTerminalAt);

  useEffect(() => {
    if (!cardId) return;
    reloadRuns(cardId).catch(() => undefined);
    reloadAttachments(cardId).catch(() => undefined);
  }, [cardId, reloadRuns, reloadAttachments]);

  useEffect(() => {
    if (!card) return;
    reloadProjectScripts(card.projectId).catch(() => undefined);
  }, [card?.projectId, reloadProjectScripts]);

  // Only fetch logs for the *currently running* run (so historical
  // lines from the DB merge with the live stream). Completed runs are
  // collapsed by default in the UI and lazy-load when the user expands
  // them — opening a card with a dozen long completed runs no longer
  // blocks on a dozen IPC roundtrips + render passes.
  useEffect(() => {
    if (!runs || !running) return;
    const latest = runs[runs.length - 1];
    if (!latest) return;
    const snapshot = useBoardStore.getState().logsByRun;
    if (!snapshot[latest.id]) {
      reloadRunLogs(latest.id).catch(() => undefined);
    }
  }, [runs, running, reloadRunLogs]);

  // Auto-scroll to the bottom when a NEW card is opened. A chat-style
  // view is meant to land you on the most recent message, not the
  // original task brief — opening at the top forced the user to scroll
  // past 9 runs just to see what's happening now. We trigger on `cardId`
  // (the URL-level identity), not `card`, so collection re-fetches that
  // produce a new object reference for the same card don't reset the
  // scroll position the user already chose. The second pass via
  // `requestAnimationFrame` waits for the run bubbles to layout —
  // without it, `scrollHeight` reads the pre-layout viewport height
  // and the jump lands halfway up.
  useEffect(() => {
    if (!transcriptRef.current || !cardId) return;
    const el = transcriptRef.current;
    el.scrollTop = el.scrollHeight;
    const handle = requestAnimationFrame(() => {
      if (transcriptRef.current) {
        transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
      }
    });
    return () => cancelAnimationFrame(handle);
  }, [cardId]);

  // While an agent is streaming, keep the view pinned to the bottom so
  // new log lines stay visible. The `running`-gated approach is correct
  // for streaming UX: idle re-renders (theme switch, selection change,
  // etc.) don't yank the user back to the bottom if they scrolled up to
  // read an earlier run.
  useEffect(() => {
    if (!transcriptRef.current || !running) return;
    transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
  }, [running, runs?.length, logsByRun]);

  // Auto-grow the description textarea to fit its content. Without this
  // the textarea defaults to a fixed `rows` and any overflow becomes an
  // internal scroll — that scroll then hijacks the wheel event from the
  // transcript pane, so the user has to leave the textarea to scroll
  // further. Resetting `height` to "auto" before reading `scrollHeight`
  // is what lets the textarea SHRINK when content is deleted, too.
  useEffect(() => {
    if (!editingDescription) return;
    const ta = descriptionTextareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }, [editingDescription, descriptionDraft]);

  const orderedRuns = useMemo(
    () => (runs ? [...runs].reverse() : []),
    [runs],
  );

  if (!cardId || !card) return null;

  const isReview = card.columnId === "review";
  const isDone = card.columnId === "done";
  const isBacklog = card.columnId === "backlog";
  const isTodo = card.columnId === "todo";

  const agentOptions: ChipOption<AgentId>[] = [
    { value: "claude", label: "Claude Code", leading: <AgentDot agent="claude" /> },
    { value: "codex", label: "Codex", leading: <AgentDot agent="codex" /> },
  ];
  const priorityOptions: ChipOption<Priority>[] = [
    { value: "low", label: "Low", leading: <PriorityDot tone="low" /> },
    { value: "med", label: "Medium", leading: <PriorityDot tone="med" /> },
    { value: "high", label: "High", leading: <PriorityDot tone="high" /> },
  ];
  // Mirror of the option lists in new-card-dialog. Duplicated because
  // the file boundary is intentional — both surfaces will eventually
  // pull from a shared catalog (e.g. user-configured per project).
  const MODELS_BY_AGENT: Record<AgentId, { value: string | null; label: string }[]> = {
    claude: [
      { value: null, label: "Default" },
      { value: "opus-4.7", label: "Opus 4.7" },
      { value: "opus-4.7-1m", label: "Opus 4.7 1M" },
      { value: "sonnet-4.6", label: "Sonnet 4.6" },
      { value: "haiku-4.5", label: "Haiku 4.5" },
      { value: "opus-4.6-legacy", label: "Opus 4.6 Legacy" },
    ],
    codex: [
      { value: null, label: "Default" },
      { value: "gpt-5.5", label: "GPT-5.5" },
      { value: "gpt-5.4", label: "GPT-5.4" },
      { value: "gpt-5.4-mini", label: "GPT-5.4-Mini" },
      { value: "gpt-5.3-codex", label: "GPT-5.3-Codex" },
      { value: "gpt-5.3-codex-spark", label: "GPT-5.3-Codex-Spark" },
      { value: "gpt-5.2", label: "GPT-5.2" },
    ],
  };
  const REASONING_OPTIONS: ChipOption<string | null>[] = [
    { value: null, label: "Default" },
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
    { value: "extra-high", label: "Extra-high" },
    { value: "max", label: "Max" },
  ];
  const FAST_MODE_OPTIONS: ChipOption<boolean>[] = [
    { value: false, label: "Standard" },
    { value: true, label: "Fast" },
  ];

  const commitTitle = async () => {
    const next = titleDraft.trim();
    if (!next || next === card.title) {
      setEditingTitle(false);
      return;
    }
    await updateCard(card.id, { title: next });
    setEditingTitle(false);
  };
  const commitDescription = async () => {
    if (descriptionDraft === card.description) {
      setEditingDescription(false);
      return;
    }
    await updateCard(card.id, { description: descriptionDraft });
    setEditingDescription(false);
  };
  // Before the agent has touched the worktree (Backlog or queued in To
  // Do), the chat input is for adding context to the brief — sending
  // shouldn't spawn anything. Once the card is past To Do, sending is a
  // genuine re-run with extra instructions in the same worktree.
  const chatAppendsToBrief = (isBacklog || isTodo) && !running;

  const sendFollowUp = async () => {
    const extra = followUp.trim();
    const files = chatFiles;
    // Allow send when there's text OR attachments alone (handy for
    // dropping a mockup mid-conversation).
    if ((!extra && files.length === 0) || running) return;
    setFollowUp("");
    setChatFiles([]);
    try {
      // Persist attachments first so the agent run (next path) picks
      // them up via `attachment_stage_for_run`.
      for (const f of files) {
        try {
          await attachFile(card.id, f);
        } catch {
          /* one failed attach shouldn't block the message */
        }
      }
      if (chatAppendsToBrief) {
        // Append to the description with a separator so the brief reads
        // chronologically. Skip empty text — attachments alone are fine.
        if (extra) {
          const sep = card.description.trim() ? "\n\n" : "";
          await updateCard(card.id, {
            description: `${card.description}${sep}${extra}`,
          });
        }
      } else {
        // Re-run from Review (or any post-worktree state): never spawn
        // synchronously here. `enqueueFollowUp` parks the prompt and
        // moves the card back to To Do; `drainQueue` promotes it to
        // In Progress when there's a slot under MAX_CONCURRENT_AGENTS.
        // This keeps the parallel-agents cap honest even when the user
        // re-prompts from Review.
        await enqueueFollowUp(card.id, extra);
      }
    } catch (err) {
      pushToast(
        err instanceof Error ? err.message : String(err),
        "danger",
      );
    }
  };

  const addChatFiles = (incoming: FileList | File[]) => {
    const arr = Array.from(incoming);
    if (arr.length === 0) return;
    setChatFiles((prev) => [...prev, ...arr]);
  };

  // Paste anywhere in the modal while it's open — captures clipboard
  // images and files into the chat composer. The text inputs ignore this
  // (they don't get focus-stealing here because the handler checks for
  // file items, not text).
  useEffect(() => {
    if (!cardId) return;
    function onPaste(e: ClipboardEvent) {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (const item of Array.from(items)) {
        if (item.kind === "file") {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        setChatFiles((prev) => [...prev, ...files]);
      }
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [cardId]);

  const openDiff = () => {
    if (!card.worktreePath) return;
    const proj = useBoardStore.getState().projectsById[card.projectId];
    if (!proj) return;
    const abs = card.worktreePath.startsWith("/")
      ? card.worktreePath
      : `${proj.repoPath}/${card.worktreePath}`;
    onOpenReview(abs);
  };

  const openPr = () => {
    if (!card.prUrl) return;
    void openUrl(card.prUrl).catch(() => undefined);
  };

  // Build the kebab items mode-aware so each column only surfaces the
  // secondary actions that apply there.
  const kebabItems: KebabItem[] = [];
  if (card.worktreePath && (isReview || isDone)) {
    kebabItems.push({
      label: "Open diff",
      icon: "⌘",
      onClick: openDiff,
    });
  }
  if (isDone && card.worktreePath) {
    kebabItems.push({
      label: archiving ? "Archiving worktree..." : "Archive worktree",
      icon: "↧",
      disabled: archiving,
      onClick: async () => {
        await archiveCard(card.id);
        pushToast("Worktree removed");
      },
    });
  }
  kebabItems.push({
    label: "Delete card",
    icon: "⌫",
    danger: true,
    onClick: () => {
      setConfirm({
        title: "Delete card?",
        body: `"${card.title}" — its worktree, runs, attachments and history go with it.`,
        confirmLabel: "Delete",
        danger: true,
        onConfirm: async () => {
          setConfirm(null);
          await deleteCard(card.id);
          pushToast("Card deleted");
        },
      });
    },
  });

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden bg-bg-1">
      {/* Header — back arrow + task tag + title, with primary action +
          kebab on the right. No `X` here: closing the view means going
          back to the board, which the arrow already conveys. */}
      <div className="flex items-center gap-2 px-3 h-10 border-b border-bd-2 shrink-0">
        <Button variant="unstyled"
          type="button"
          onClick={() => selectCard(null)}
          title="Back to board"
          className={cn(
            "h-[26px] inline-flex items-center gap-1.5 px-2 rounded-[5px]",
            "text-[11.5px] text-fg-2 bg-transparent border border-bd-2",
            "hover:bg-bg-hover hover:text-fg-0 hover:border-bd-1",
          )}
        >
          <span className="text-[12px] leading-none">←</span>
          <span>Back</span>
        </Button>
        {/* Header title is read-only — the bubble below is where edits
            happen so the affordance lives in one obvious spot. */}
        <span className="text-[14px] font-semibold tracking-[-0.01em] truncate flex-1 min-w-0">
          {card.taskNumber ? (
            <span className="font-mono text-fg-3 mr-2">T{card.taskNumber}</span>
          ) : null}
          {card.title}
        </span>

          <div className="flex items-center gap-1.5">
            {isBacklog ? (
              <HeaderBtn
                primary
                onClick={() => moveCardTo(card.id, "todo")}
              >
                Send to To Do
              </HeaderBtn>
            ) : null}
            {/* Scripts only make sense once there's a worktree to run
                them in. Surface in Review (where the user vets output)
                and Done (where they might want to re-run the dev server
                to inspect again). Each click drops the command into the
                terminal drawer pinned to the card's worktree. */}
            {(isReview || isDone) && card.worktreePath && scripts.length > 0 ? (
              <ScriptRunPicker
                scripts={scripts}
                onRun={(script) => {
                  const proj =
                    useBoardStore.getState().projectsById[card.projectId];
                  if (!proj || !card.worktreePath) return;
                  const abs = card.worktreePath.startsWith("/")
                    ? card.worktreePath
                    : `${proj.repoPath}/${card.worktreePath}`;
                  runInTerminalAt(abs, script.command);
                }}
              />
            ) : null}
            {isReview && onApprove ? (
              <HeaderBtn
                primary
                onClick={onApprove}
                disabled={approving || running}
                icon={approving ? <Spinner className="w-3 h-3" /> : null}
              >
                {approving ? "Opening PR…" : "Approve → PR"}
              </HeaderBtn>
            ) : null}
            {isDone && card.prUrl ? (
              <HeaderBtn primary onClick={openPr}>
                Open PR
              </HeaderBtn>
            ) : null}
            {archiving ? (
              <HeaderBtn
                disabled
                icon={<Spinner className="w-3 h-3" />}
                onClick={() => undefined}
              >
                Archiving...
              </HeaderBtn>
            ) : null}
            {running ? (
              <HeaderBtn onClick={() => abortCard(card.id)}>Abort</HeaderBtn>
            ) : null}

          <KebabMenu items={kebabItems} />
        </div>
      </div>

        {/* Body — the sidebar floats absolutely on the right (à la
            Codex) so the chat's max-width never shrinks because of it.
            The transcript + composer live in a centered column with a
            fixed cap, leaving negative space on the left at wide
            viewports rather than stretching the chat to fill. */}
        <div className="flex-1 min-h-0 relative">
          {/* Transcript + composer column. Centered in the FULL chat
              section (sidebar → right edge) — no right padding to
              "reserve" space for the floating island. The bubbles use
              `max-w-[760px] mx-auto` and the island is only 240px wide
              at the right corner, so on any reasonable viewport the
              centered bubble stops well before the island starts (try
              the math: at 2000px screen with a 280px sidebar, a 792px
              bubble centered in 1720px ends at ~x=1536; the island
              starts at ~x=1748 — clean ~210px gap).
              We tried reserving width via `pr-[Xpx]` to "make room"
              for the island, but that shrinks the centering area on
              the right side, which actually shifts the brief FURTHER
              to the left. Counter-intuitive but math'd out: less
              available width on one side moves `mx-auto`'s midpoint
              to that side. */}
          <section className="absolute inset-0 flex flex-col min-h-0">
            <div
              ref={transcriptRef}
              className="flex-1 overflow-y-auto px-8 py-6 flex flex-col gap-5 min-h-0"
            >
              <ChatBubble
                role="user"
                title="Task brief"
                timestamp={card.createdAt}
                // Copy = title + description, joined the same way the
                // composed agent prompt does. Lets the user paste the
                // full task into another tool (issue tracker, slack)
                // without retyping anything.
                copyText={
                  card.description
                    ? `${card.title}\n\n${card.description}`
                    : card.title
                }
              >
                {editingTitle && isBacklog ? (
                  <input
                    autoFocus
                    value={titleDraft}
                    onChange={(e) => setTitleDraft(e.target.value)}
                    onBlur={commitTitle}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void commitTitle();
                      } else if (e.key === "Escape") {
                        setEditingTitle(false);
                      }
                    }}
                    className={cn(
                      "w-full text-[13px] font-medium text-fg-0 mb-2",
                      "bg-bg-1 border border-bd-1 rounded-[5px] px-2 h-8 outline-none",
                      "focus:border-bd-1",
                    )}
                  />
                ) : (
                  <Button variant="unstyled"
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!isBacklog) return;
                      setTitleDraft(card.title);
                      setEditingTitle(true);
                    }}
                    disabled={!isBacklog}
                    title={isBacklog ? "Click to rename" : undefined}
                    className={cn(
                      "block w-full text-[13px] font-medium text-fg-0 mb-2 text-left",
                      "bg-transparent border-0 py-1 px-2 -mx-2 rounded-[5px]",
                      isBacklog
                        ? "cursor-text hover:bg-bg-hover hover:ring-1 hover:ring-bd-2"
                        : "cursor-default",
                    )}
                  >
                    {card.title}
                  </Button>
                )}
                {editingDescription && isBacklog ? (
                  <textarea
                    ref={descriptionTextareaRef}
                    autoFocus
                    value={descriptionDraft}
                    onChange={(e) => setDescriptionDraft(e.target.value)}
                    onBlur={commitDescription}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        void commitDescription();
                      } else if (e.key === "Escape") {
                        setEditingDescription(false);
                      }
                    }}
                    placeholder="Describe what the agent should do…"
                    // No `rows` / `resize` / `min-h` — height is driven by
                    // the auto-grow effect above, so the textarea matches
                    // its content exactly and never has its own scroll.
                    style={{ overflow: "hidden" }}
                    className={cn(
                      "w-full text-[12.5px] font-mono leading-relaxed",
                      "bg-bg-2 border border-bd-1 rounded-[5px] p-2 outline-none",
                      "placeholder:text-fg-3 focus:border-bd-1 resize-none",
                    )}
                  />
                ) : card.description ? (
                  <Button variant="unstyled"
                    type="button"
                    onClick={() => {
                      if (!isBacklog) return;
                      setDescriptionDraft(card.description);
                      setEditingDescription(true);
                    }}
                    disabled={!isBacklog}
                    title={isBacklog ? "Click to edit (⌘↵ to save)" : undefined}
                    className={cn(
                      "block w-full text-left bg-transparent border-0 p-0",
                      isBacklog
                        ? "cursor-text hover:bg-bg-hover/40 rounded-[4px] -mx-1 px-1"
                        : "cursor-default",
                    )}
                  >
                    <MarkdownBody text={card.description} />
                  </Button>
                ) : isBacklog ? (
                  <Button variant="unstyled"
                    type="button"
                    onClick={() => {
                      setDescriptionDraft("");
                      setEditingDescription(true);
                    }}
                    className={cn(
                      "text-[12px] text-fg-3 italic text-left bg-transparent border-0 p-0",
                      "hover:text-fg-2 cursor-text",
                    )}
                  >
                    Click to add a description…
                  </Button>
                ) : (
                  <div className="text-[12px] text-fg-2 italic">
                    No description.
                  </div>
                )}
                {attachments.length > 0 ? (
                  <div className="flex flex-wrap gap-2 mt-3 pt-3 border-t border-bd-2">
                    {attachments.map((att) => (
                      <AttachmentThumb
                        key={att.id}
                        attachment={att}
                        onRemove={() => removeAttachment(card.id, att.id)}
                      />
                    ))}
                  </div>
                ) : null}
              </ChatBubble>

              {orderedRuns.length === 0 ? (
                <EmptyState
                  running={running}
                  message={
                    isBacklog
                      ? "Move the card to To Do to spawn the agent."
                      : "Run hasn't started yet."
                  }
                />
              ) : (
                orderedRuns.map((run, idx) => (
                  <RunTurn
                    key={run.id}
                    run={run}
                    index={idx + 1}
                    logs={logsByRun[run.id] ?? EMPTY_LOGS}
                    runningThis={running && idx === orderedRuns.length - 1}
                    onRequestLogs={() => {
                      void reloadRunLogs(run.id);
                    }}
                  />
                ))
              )}
            </div>

            {/* Composer pinned to the same max-width as the bubbles so
                the input column aligns with the transcript. Padding
                matches the transcript so the visual gutter is shared. */}
            <div className="px-8 pb-4">
              <div className="max-w-[760px] mx-auto w-full">
                <ChatComposer
                  value={followUp}
                  onChange={setFollowUp}
                  onSend={sendFollowUp}
                  onAttachClick={() => chatFileInputRef.current?.click()}
                  disabled={running || approving}
                  files={chatFiles}
                  onRemoveFile={(idx) =>
                    setChatFiles((prev) => prev.filter((_, i) => i !== idx))
                  }
                  dropActive={chatDropActive}
                  onDragOver={(e) => {
                    if (e.dataTransfer.types.includes("Files")) {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "copy";
                      setChatDropActive(true);
                    }
                  }}
                  onDragLeave={() => setChatDropActive(false)}
                  onDrop={(e) => {
                    if (!e.dataTransfer.types.includes("Files")) return;
                    e.preventDefault();
                    setChatDropActive(false);
                    addChatFiles(e.dataTransfer.files);
                  }}
                  placeholder={
                    running
                      ? "Agent is running — wait for it to finish or abort."
                      : chatAppendsToBrief
                        ? "Add more context to the brief…"
                        : "Ask for follow-up changes…"
                  }
                  hint={
                    chatAppendsToBrief
                      ? "appends to the brief — drag to To Do when ready"
                      : "the agent re-runs in the same worktree"
                  }
                  sendTitle={
                    chatAppendsToBrief
                      ? "Append this to the task brief (⌘↵)"
                      : "Re-run agent with this as additional instructions (⌘↵)"
                  }
                />
              </div>
            </div>
            <input
              ref={chatFileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) addChatFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </section>

          {/* Right sidebar — floats absolutely so the chat below is
              free to size itself by its own max-width. On a wide
              window the sidebar parks at the right edge and the chat
              centers in the remaining space; on a narrow window the
              sidebar overlays the right of the transcript (the chat
              has built-in max-width so its content never reaches that
              far anyway). */}
          {/* `bottom-4` together with the Runs-section max-h below
              keeps the island from ever overflowing the viewport. The
              Runs list (which can have 50+ entries) gets its own
              internal scroll, but other sections like a long branch
              name or an unusually verbose Run config could still push
              past the bottom on a small window — the outer cap is the
              ultimate safety net. */}
          {/* `bottom-4` together with the Runs-section max-h below
              keeps the island from ever overflowing the viewport. The
              Runs list (which can have 50+ entries) gets its own
              internal scroll first; if the other sections plus the
              capped Runs still exceed the available height, the inner
              card scrolls as a whole — `overflow-y-auto` instead of
              the old `overflow-hidden` (which would have clipped the
              bottom section silently). */}
          {!islandOpen ? (
            <Button variant="unstyled"
              type="button"
              onClick={() => setIslandOpen(true)}
              className={cn(
                "absolute top-[24px] right-6 z-20",
                "h-5 w-5 grid place-items-center rounded-[5px]",
                "bg-bg-1 border border-bd-2 text-fg-2",
                "shadow-[0_4px_16px_rgba(0,0,0,0.25)]",
                "hover:text-fg-0 hover:border-bd-1",
                "cursor-pointer",
              )}
              title="Show details panel"
              aria-label="Show details panel"
            >
              {I.sidebarRight}
            </Button>
          ) : null}
          <aside
            className={cn(
              "absolute top-4 right-3 bottom-4 w-[240px] z-10 pointer-events-none flex",
              !islandOpen && "hidden",
            )}
          >
            <div
              className={cn(
                "flex w-full flex-col rounded-[10px]",
                "bg-bg-1 border border-bd-2 pointer-events-auto",
                "shadow-[0_4px_16px_rgba(0,0,0,0.25)]",
                "min-h-0 max-h-full overflow-y-auto",
                // Thin scrollbar so the chrome stays calm even when
                // the island falls back to scrolling on small viewports.
                "[scrollbar-width:thin] [scrollbar-color:var(--bd-2)_transparent]",
                "[&::-webkit-scrollbar]:w-1.5",
                "[&::-webkit-scrollbar-thumb]:bg-bd-2 [&::-webkit-scrollbar-thumb]:rounded",
              )}
            >
              <IslandSection
                title="Project"
                action={
                  <Button variant="unstyled"
                    type="button"
                    onClick={() => setIslandOpen(false)}
                    className={cn(
                      "h-5 w-5 grid place-items-center rounded-[5px]",
                      "text-fg-2 hover:bg-bg-hover hover:text-fg-0",
                      "cursor-pointer",
                    )}
                    title="Hide details panel"
                    aria-label="Hide details panel"
                  >
                    {I.x}
                  </Button>
                }
              >
                <Field label="Repo">{project?.name ?? "—"}</Field>
              </IslandSection>

              <IslandSection title="Run config">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10.5px] uppercase tracking-[0.04em] text-fg-3">
                    Agent
                  </span>
                  {isBacklog ? (
                    <ChipPopover<AgentId>
                      label=""
                      value={card.agent}
                      options={agentOptions}
                      onChange={(v) =>
                        void updateCard(card.id, { agent: v })
                      }
                      searchable={false}
                    />
                  ) : (
                    <span className="text-[11px] text-fg-1 font-mono">
                      {card.agent}
                    </span>
                  )}
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10.5px] uppercase tracking-[0.04em] text-fg-3">
                    Priority
                  </span>
                  {isBacklog ? (
                    <ChipPopover<Priority>
                      label=""
                      value={card.priority}
                      options={priorityOptions}
                      onChange={(v) =>
                        void updateCard(card.id, { priority: v })
                      }
                      searchable={false}
                    />
                  ) : (
                    <span className="text-[11px] text-fg-1 font-mono">
                      {card.priority}
                    </span>
                  )}
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10.5px] uppercase tracking-[0.04em] text-fg-3">
                    Model
                  </span>
                  {isBacklog ? (
                    <ChipPopover<string | null>
                      label=""
                      value={card.model}
                      options={MODELS_BY_AGENT[card.agent].map((m) => ({
                        value: m.value,
                        label: m.label,
                      }))}
                      onChange={(v) =>
                        void updateCard(card.id, { model: v ?? undefined })
                      }
                      allowCustom
                    />
                  ) : (
                    <span className="text-[11px] text-fg-1 font-mono">
                      {card.model ?? "default"}
                    </span>
                  )}
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10.5px] uppercase tracking-[0.04em] text-fg-3">
                    Reasoning
                  </span>
                  {isBacklog ? (
                    <ChipPopover<string | null>
                      label=""
                      value={card.reasoning}
                      options={REASONING_OPTIONS}
                      onChange={(v) =>
                        void updateCard(card.id, {
                          reasoning: v ?? undefined,
                        })
                      }
                      searchable={false}
                    />
                  ) : (
                    <span className="text-[11px] text-fg-1 font-mono">
                      {card.reasoning ?? "default"}
                    </span>
                  )}
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10.5px] uppercase tracking-[0.04em] text-fg-3">
                    Mode
                  </span>
                  {isBacklog ? (
                    <ChipPopover<boolean>
                      label=""
                      value={Boolean(card.fastMode)}
                      options={FAST_MODE_OPTIONS}
                      onChange={(v) =>
                        void updateCard(card.id, { fastMode: v })
                      }
                      searchable={false}
                    />
                  ) : (
                    <span className="text-[11px] text-fg-1 font-mono">
                      {card.fastMode ? "Fast" : "Standard"}
                    </span>
                  )}
                </div>
              </IslandSection>

              {card.branchName || card.baseBranch ? (
                <IslandSection title="Git">
                  {card.branchName ? (
                    <CopyableField
                      label="Branch"
                      value={card.branchName}
                      onCopied={() =>
                        pushToast(`Branch copied`)
                      }
                    />
                  ) : null}
                  {card.baseBranch ? (
                    <CopyableField
                      label="Base"
                      value={card.baseBranch}
                      onCopied={() =>
                        pushToast(`Base copied`)
                      }
                    />
                  ) : null}
                  {card.prUrl ? (
                    <div className="mt-1 flex flex-col gap-1.5">
                      {isDone ? (
                        <Button variant="unstyled"
                          type="button"
                          onClick={openPr}
                          className={cn(
                            "h-7 w-full inline-flex items-center justify-center rounded-[5px] px-2",
                            "text-[11px] font-medium !bg-accent !bg-none text-white",
                            "hover:!bg-accent hover:!bg-none active:!bg-accent active:!bg-none",
                          )}
                          title="Open PR in browser"
                        >
                          Open PR
                        </Button>
                      ) : null}
                      <Button variant="unstyled"
                        type="button"
                        onClick={openPr}
                        className="text-[11px] text-accent hover:underline text-left truncate font-mono"
                        title="Open PR in browser"
                      >
                        {card.prUrl}
                      </Button>
                    </div>
                  ) : null}
                </IslandSection>
              ) : null}

              {orderedRuns.length > 0 ? (
                <IslandSection
                  title={`Runs · ${orderedRuns.length}`}
                  last
                >
                  {/* Cap the runs list so it can't push the island past
                      the viewport (a card with 50+ retries was breaking
                      the layout on smaller screens). `max-h-[240px]`
                      shows ~10 rows; anything past that becomes a
                      scrollable area inside the island. Thin scrollbar
                      keeps the chrome quiet. */}
                  <div
                    className={cn(
                      "flex flex-col gap-1.5",
                      "max-h-[240px] overflow-y-auto pr-1 -mr-1",
                      "[scrollbar-width:thin] [scrollbar-color:var(--bd-2)_transparent]",
                      "[&::-webkit-scrollbar]:w-1.5",
                      "[&::-webkit-scrollbar-thumb]:bg-bd-2 [&::-webkit-scrollbar-thumb]:rounded",
                    )}
                  >
                    {orderedRuns
                      .slice()
                      .reverse()
                      .map((run, idx) => (
                        <div
                          key={run.id}
                          className="flex items-center justify-between text-[10.5px] font-mono text-fg-2"
                        >
                          <span>
                            #{orderedRuns.length - idx} · {run.status}
                          </span>
                          <span className="text-fg-3">
                            {new Date(run.startedAt).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </span>
                        </div>
                      ))}
                  </div>
                </IslandSection>
              ) : null}
            </div>
          </aside>
        </div>
      </div>
  );
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

type KebabItem = {
  label: string;
  onClick: () => void | Promise<void>;
  danger?: boolean;
  disabled?: boolean;
  icon?: ReactNode;
};

/**
 * Three-dot menu anchored to a small button. Portal'd to document.body
 * so the modal's `overflow-hidden` doesn't clip it. Closes on outside
 * click + Escape.
 */
function KebabMenu({ items }: { items: KebabItem[] }) {
  if (items.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="unstyled"
          type="button"
          title="More actions"
          className={cn(
            "h-7 w-7 grid place-items-center rounded-[5px] border border-bd-2",
            "text-fg-1 bg-transparent transition-colors duration-100",
            "hover:bg-bg-hover hover:border-bd-1",
            "data-[state=open]:bg-bg-2 data-[state=open]:border-bd-1",
            "focus:outline-none focus-visible:outline-none focus-visible:ring-0",
          )}
        >
          <span className="text-[14px] leading-none">⋯</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={3}
        className={cn(
          "min-w-[188px] border border-bd-1 bg-bg-1 p-1 text-fg-1",
          "rounded-[7px] shadow-[0_14px_36px_rgba(0,0,0,0.42)]",
          "outline-none ring-0 focus:outline-none focus-visible:outline-none",
        )}
      >
        {items.map((item, i) => (
          <DropdownMenuItem
            key={i}
            disabled={item.disabled}
            variant={item.danger ? "destructive" : "default"}
            onSelect={(event) => {
              if (item.disabled) {
                event.preventDefault();
                return;
              }
              void item.onClick();
            }}
            className={cn(
              "h-8 gap-2 rounded-[5px] px-2.5 text-[12px]",
              "focus:bg-bg-hover focus:text-fg-0",
              item.danger &&
                "text-diff-del-mark focus:bg-[color-mix(in_oklab,var(--diff-del-mark)_8%,transparent)] focus:text-diff-del-mark",
            )}
          >
            {item.icon ? (
              <span className="w-4 shrink-0 grid place-items-center text-[12px]">
                {item.icon}
              </span>
            ) : (
              <span className="w-4 shrink-0" />
            )}
            <span className="truncate">{item.label}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Row inside the floating sidebar "island". Stacks the section header
 * above its children and adds a subtle divider between sections (no
 * divider on the last one). Keeping this distinct from `Section` so the
 * non-island callers (none right now) don't inherit the padding.
 */
function IslandSection({
  title,
  children,
  action,
  last,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
  last?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 px-3 py-2.5",
        !last && "border-b border-bd-2",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] font-mono uppercase tracking-wider text-fg-3">
          {title}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

function Field({
  label,
  children,
  mono,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2 text-[11.5px]">
      <span className="text-fg-3">{label}</span>
      <span
        className={cn(
          "text-fg-1 truncate text-right min-w-0",
          mono && "font-mono text-[11px]",
        )}
      >
        {children}
      </span>
    </div>
  );
}

/**
 * Field variant whose value is too long to display in the narrow
 * sidebar — wraps the truncated text in a button with a `title`
 * tooltip (shows the full string on hover) and click-to-copy. Used
 * for Branch / Base in the Git island where the branch name almost
 * always overflows the 240px column.
 */
function CopyableField({
  label,
  value,
  onCopied,
}: {
  label: string;
  value: string;
  onCopied?: () => void;
}) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      onCopied?.();
    } catch {
      /* clipboard API can fail under odd permissions; fall back to a
         transient prompt? for now we just swallow — the value is
         visible in the tooltip, so the user can still grab it. */
    }
  };
  return (
    <div className="flex items-center justify-between gap-2 text-[11.5px]">
      <span className="text-fg-3 shrink-0">{label}</span>
      <Button variant="unstyled"
        type="button"
        onClick={copy}
        title={`${value}\nClick to copy`}
        className={cn(
          "min-w-0 truncate text-right font-mono text-[11px] text-fg-1",
          "bg-transparent border-0 p-0 cursor-pointer",
          "hover:text-accent hover:underline underline-offset-2",
        )}
      >
        {value}
      </Button>
    </div>
  );
}

function HeaderBtn({
  children,
  onClick,
  primary,
  disabled,
  icon,
}: {
  children: ReactNode;
  onClick: () => void;
  primary?: boolean;
  disabled?: boolean;
  icon?: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="unstyled"
      size="sm"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "h-7 px-2.5 rounded-[5px] inline-flex items-center gap-1.5",
        "text-[11.5px] border shrink-0",
        primary
          ? "!bg-accent !bg-none text-accent-fg border-0 cursor-pointer hover:!bg-accent hover:!bg-none"
          : "bg-transparent text-fg-1 border-bd-2 hover:bg-bg-hover hover:border-bd-1",
        disabled && "opacity-50 cursor-not-allowed hover:bg-transparent",
      )}
    >
      {icon}
      <span>{children}</span>
    </Button>
  );
}

function ChatBubble({
  role,
  title,
  timestamp,
  children,
  copyText,
}: {
  role: "user" | "agent";
  title: string;
  timestamp?: number;
  children: ReactNode;
  /**
   * Plain-text payload behind this bubble. When provided we expose a
   * "Copy" affordance in the header — useful for run output (agent
   * messages can be many KB of stream and selecting them by hand is
   * fiddly) and for echoing the user's own follow-up prompts. The brief
   * bubble passes the card title + description so the user can paste
   * the whole task elsewhere without retyping.
   */
  copyText?: string;
}) {
  const isUser = role === "user";
  const [copied, setCopied] = useState(false);
  const pushToast = useRepoStore((s) => s.pushToast);

  const handleCopy = async () => {
    if (!copyText) return;
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      // Brief inline confirmation; long enough to read, short enough
      // that double-clicking copy doesn't get a stale "Copied" label.
      setTimeout(() => setCopied(false), 1400);
    } catch {
      pushToast("Could not copy to clipboard.", "danger");
    }
  };

  return (
    <div className="group flex flex-col gap-2 max-w-[760px] w-full mx-auto">
      <div className="flex items-center gap-2 text-[10.5px] font-mono text-fg-3 uppercase tracking-wider">
        <span className={isUser ? "text-fg-1" : "text-accent"}>{title}</span>
        {timestamp ? (
          <span>
            {new Date(timestamp).toLocaleString([], {
              hour: "2-digit",
              minute: "2-digit",
              month: "short",
              day: "numeric",
            })}
          </span>
        ) : null}
        <span className="flex-1" />
        {copyText ? (
          // Only fade in on hover so the header stays calm at rest, but
          // stays fully visible right after a copy so the confirmation
          // doesn't disappear before the user reads it.
          <Button variant="unstyled"
            type="button"
            onClick={handleCopy}
            className={cn(
              "inline-flex items-center gap-1 px-1.5 py-px rounded-[3px]",
              "text-[10px] font-mono normal-case tracking-normal",
              "border border-bd-2 bg-bg-2 text-fg-2",
              "hover:text-fg-0 hover:border-bd-1 hover:bg-bg-3",
              "transition-opacity duration-100",
              copied
                ? "opacity-100 text-accent border-accent/40"
                : "opacity-0 group-hover:opacity-100 focus:opacity-100",
            )}
            title="Copy bubble contents"
          >
            {copied ? "Copied" : "Copy"}
          </Button>
        ) : null}
      </div>
      {/*
        `select-text` lifts the app-wide `user-select: none` so the user
        can drag-select inside the bubble — handy when they just want a
        snippet of agent output, not the whole message. The class lives
        on the content wrapper (not the header) so timestamps and the
        copy button still feel like chrome.
      */}
      <div
        className={cn(
          "rounded-[10px] border px-4 py-3.5 select-text",
          // `min-w-0` so the bubble respects the parent's `max-w-[760px]`
          // even when a child contains a 500-char unbroken token
          // (Turbopack module ids, stack frame paths, base64 blobs…).
          // Without this, flexbox's default min-width: auto lets the
          // child push the bubble past the column edge and breaks the
          // layout.
          "min-w-0 max-w-full",
          isUser ? "border-bd-2 bg-bg-2" : "border-bd-2 bg-bg-0",
        )}
      >
        {children}
      </div>
    </div>
  );
}

// react-markdown + remark-gfm parse on every render — expensive for the
// long task briefs we see in the wild. Memo so identical `text` skips
// the parse entirely. The parent re-renders dozens of times per second
// during streaming; the brief bubble in particular shouldn't re-parse
// just because a sibling run got a new log line.
const MarkdownBody = memo(function MarkdownBody({ text }: { text: string }) {
  return (
    <div
      className={cn(
        "text-[12.5px] text-fg-1 leading-relaxed",
        // Force-wrap absurdly long unbroken tokens (Turbopack
        // module ids, stack frame paths, base64 blobs, etc.) at the
        // bubble's right edge instead of overflowing it. `min-w-0`
        // on the wrapper opts out of flexbox's default min-width:
        // auto so the bubble's `max-w-[760px]` actually constrains
        // the children. `[overflow-wrap:anywhere]` allows a break
        // mid-identifier — `break-words` alone leaves Webkit hesitant
        // to break inside what it considers "a word".
        "min-w-0 [overflow-wrap:anywhere]",
        "[&_h1]:text-[14px] [&_h1]:font-semibold [&_h1]:text-fg-0 [&_h1]:mt-3 [&_h1]:mb-2",
        "[&_h2]:text-[13px] [&_h2]:font-semibold [&_h2]:text-fg-0 [&_h2]:mt-3 [&_h2]:mb-1.5",
        "[&_h3]:text-[12.5px] [&_h3]:font-semibold [&_h3]:text-fg-0 [&_h3]:mt-2 [&_h3]:mb-1",
        "[&_p]:my-1.5 [&_p]:first:mt-0 [&_p]:last:mb-0",
        "[&_ul]:list-disc [&_ul]:pl-5 [&_ul]:my-1.5",
        "[&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:my-1.5",
        "[&_li]:my-0.5",
        "[&_code]:font-mono [&_code]:text-[11.5px] [&_code]:px-1 [&_code]:py-px",
        "[&_code]:rounded-[3px] [&_code]:bg-bg-2 [&_code]:border [&_code]:border-bd-2",
        // Inline code participates in the same anywhere-break so a
        // long path inside `like/this` doesn't push the bubble wider
        // than its max width.
        "[&_code]:[overflow-wrap:anywhere]",
        "[&_pre]:bg-bg-1 [&_pre]:border [&_pre]:border-bd-2 [&_pre]:rounded-[6px]",
        // `pre` keeps `overflow-x-auto` so multi-line code blocks
        // scroll horizontally (preserving indent + alignment) rather
        // than wrapping mid-line. The wrapping override above only
        // applies to inline content; code blocks are still scroll.
        "[&_pre]:p-3 [&_pre]:my-2 [&_pre]:overflow-x-auto",
        "[&_pre>code]:bg-transparent [&_pre>code]:border-0 [&_pre>code]:p-0",
        "[&_pre>code]:text-[11.5px] [&_pre>code]:leading-relaxed",
        "[&_pre>code]:[overflow-wrap:normal] [&_pre>code]:whitespace-pre",
        "[&_strong]:text-fg-0 [&_strong]:font-semibold",
        "[&_em]:italic",
        "[&_a]:text-accent [&_a]:underline [&_a]:underline-offset-2",
        // Links also wrap — URL agents emit can be >120 chars.
        "[&_a]:[overflow-wrap:anywhere]",
        "[&_blockquote]:border-l-2 [&_blockquote]:border-bd-1",
        "[&_blockquote]:pl-3 [&_blockquote]:text-fg-2 [&_blockquote]:my-2",
        "[&_table]:my-2 [&_table]:border [&_table]:border-bd-2 [&_table]:rounded-[4px]",
        "[&_th]:border [&_th]:border-bd-2 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-semibold",
        "[&_td]:border [&_td]:border-bd-2 [&_td]:px-2 [&_td]:py-1",
        "[&_hr]:my-3 [&_hr]:border-bd-2",
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(e) => {
                e.preventDefault();
                // Agent output can contain arbitrary markdown links —
                // gate at the renderer so `file://`, `javascript:`,
                // `data:`, etc never reach the system opener. Only
                // http(s) is forwarded.
                if (!href) return;
                if (!/^https?:\/\//i.test(href)) return;
                void openUrl(href).catch(() => undefined);
              }}
            >
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

// Memo so non-running runs stop re-rendering when the streaming run
// gets a new log batch. Default shallow prop comparison is exactly
// right here — `logs` is replaced by a new array every flush, but only
// for the run that's actually streaming. Completed runs default to
// collapsed (header only) and lazy-load their logs the first time the
// user expands them — opening a card with N old runs is now ~free.
const RunTurn = memo(function RunTurn({
  run,
  index,
  logs,
  runningThis,
  onRequestLogs,
}: {
  run: Run;
  index: number;
  logs: RunLog[];
  runningThis: boolean;
  /** Called when the user expands a collapsed run and we don't have
   *  logs cached yet. Parent supplies `() => reloadRunLogs(run.id)`. */
  onRequestLogs: () => void;
}) {
  const statusTone =
    run.status === "succeeded"
      ? "text-diff-add-mark"
      : run.status === "failed"
        ? "text-diff-del-mark"
        : run.status === "aborted"
          ? "text-fg-2"
          : "text-accent";

  // Everything starts collapsed — even the live-running run. Watching
  // the raw `OpenAI Codex v0.132.0 / workdir: … / reasoning effort: …`
  // dump scroll by while the agent is thinking is noise that pushes
  // the actual task brief off-screen. The user gets a `running`
  // indicator in the header; clicking expands the live stream.
  const [expanded, setExpanded] = useState(false);

  const { narrative, fullText } = useMemo(() => {
    if (!expanded) return { narrative: "", fullText: "" };
    const out = logs
      .filter((l) => l.stream !== "stderr")
      .map((l) => l.line)
      .join("\n");
    return { narrative: extractNarrativeTail(out), fullText: out };
  }, [logs, expanded]);

  // The DB stores the *composed* prompt: SCOPE_PREAMBLE + task body +
  // attachments + the user's "# Additional instructions" section. The
  // preamble is identical boilerplate on every run and the task body is
  // already visible in the card header, so showing them again is just
  // noise — and worse, with the old 600-char preview the user's actual
  // follow-up was getting truncated off-screen, making it look like
  // their message wasn't saved at all. We extract just the follow-up
  // and render that as the bubble; if there is no follow-up section
  // (i.e. the very first run, prompted from the original brief), we
  // hide the bubble entirely.
  const followUpText = useMemo(() => {
    const marker = "# Additional instructions\n";
    const at = run.prompt.indexOf(marker);
    if (at < 0) return null;
    return run.prompt.slice(at + marker.length).trim();
  }, [run.prompt]);
  const showsPromptBubble = followUpText !== null && followUpText.length > 0;

  const handleToggle = () => {
    const next = !expanded;
    setExpanded(next);
    // Lazy-load when expanding for the first time. Subsequent toggles
    // are free — the data is cached in the store.
    if (next && logs.length === 0 && !runningThis) {
      onRequestLogs();
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {showsPromptBubble ? (
        <ChatBubble
          role="user"
          title={`Run #${index} · follow-up`}
          timestamp={run.startedAt}
          copyText={followUpText ?? undefined}
        >
          <div className="text-[12px] text-fg-1 whitespace-pre-wrap leading-relaxed [overflow-wrap:anywhere] min-w-0">
            {followUpText}
          </div>
        </ChatBubble>
      ) : null}

      <ChatBubble
        role="agent"
        title={`${run.agent} · run #${index}`}
        timestamp={run.startedAt}
        // When the user has the run expanded we know the full text (we
        // computed it for rendering); copy the same payload they see.
        // Collapsed runs intentionally don't show Copy — there's no
        // content to copy yet, and showing the button would imply the
        // logs are already loaded.
        copyText={expanded && fullText ? fullText : undefined}
      >
        <div className="flex items-center gap-2 mb-2 text-[10.5px] font-mono">
          <span className={statusTone}>
            {runningThis ? "running" : run.status}
          </span>
          {runningThis ? <Spinner className="w-3 h-3" /> : null}
          {run.exitCode !== null && run.exitCode !== undefined ? (
            <span className="text-fg-3">exit {run.exitCode}</span>
          ) : null}
          {run.endedAt ? (
            <span className="text-fg-3">
              {Math.max(1, Math.round((run.endedAt - run.startedAt) / 1000))}s
            </span>
          ) : null}
          <span className="flex-1" />
          {/* Toggle works for running runs too — clicking expands the
              live stream. Default collapsed even mid-run (see useState
              above) keeps the bubble compact. */}
          <Button variant="unstyled"
            type="button"
            onClick={handleToggle}
            className={cn(
              "text-[10.5px] text-fg-3 hover:text-fg-1",
              "px-1.5 py-0.5 rounded hover:bg-bg-hover",
            )}
          >
            {expanded ? "Hide output" : "View output"}
          </Button>
        </div>

        {!expanded ? null : logs.length === 0 ? (
          runningThis ? (
            <div className="text-[11px] text-fg-2 flex items-center gap-2">
              <Spinner className="w-3 h-3" /> Waiting for output…
            </div>
          ) : (
            <div className="text-[11px] text-fg-3 italic flex items-center gap-2">
              <Spinner className="w-3 h-3" /> Loading…
            </div>
          )
        ) : (
          <>
            {narrative ? <MarkdownBody text={narrative} /> : null}
            <RawLogsToggle logs={logs} fullText={fullText} hidden={!!narrative} />
          </>
        )}
      </ChatBubble>
    </div>
  );
});

function extractNarrativeTail(text: string): string {
  if (!text.trim()) return "";
  const lines = text.split("\n");
  const noiseHints = [
    /^exec\b/i,
    /^\/(?:bin|usr|tmp|var|Users)\//,
    /succeeded in \d+ms/i,
    /^\$\s/,
    /^\[/,
    /^reasoning effort:/i,
    /^session id:/i,
    /^OpenAI Codex/i,
    /^Reading additional input/i,
    /^workdir:/i,
    /^model:/i,
    /^provider:/i,
    /^approval:/i,
    /^sandbox:/i,
    /^--------+$/,
  ];
  const out: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    if (noiseHints.some((re) => re.test(line))) break;
    out.push(line);
  }
  const narrative = out.reverse().join("\n").trim();
  return narrative.length > 20 ? narrative : "";
}

function RawLogsToggle({
  logs,
  fullText,
  hidden,
}: {
  logs: RunLog[];
  fullText: string;
  hidden: boolean;
}) {
  const [open, setOpen] = useState(!hidden);
  return (
    <div className="mt-2">
      <Button variant="unstyled"
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-[10.5px] font-mono text-fg-3 hover:text-fg-1"
      >
        {open ? "▾ Hide raw output" : "▸ Show raw output"} ({logs.length} lines
        {fullText ? `, ${Math.round(fullText.length / 1024)}kb` : ""})
      </Button>
      {open ? (
        <div
          className={cn(
            "mt-1.5 rounded-[4px] bg-bg-1 border border-bd-2 p-2",
            "font-mono text-[10.5px] leading-relaxed",
            "max-h-[420px] overflow-y-auto",
          )}
        >
          {logs.map((l) => (
            <div
              key={l.id}
              className={cn(
                "whitespace-pre-wrap break-words",
                l.stream === "stderr" ? "text-diff-del-mark" : "text-fg-1",
              )}
            >
              {l.line}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function EmptyState({
  running,
  message,
}: {
  running: boolean;
  message: string;
}) {
  return (
    <div className="grid place-items-center py-10 text-center">
      <div className="flex flex-col gap-2 items-center">
        {running ? (
          <Spinner className="w-5 h-5" />
        ) : (
          <div className="w-8 h-8 rounded-full border border-bd-2 grid place-items-center text-fg-3">
            {I.sparkles}
          </div>
        )}
        <div className="text-[12px] text-fg-2">{message}</div>
      </div>
    </div>
  );
}

/**
 * Thumbnail for a persisted attachment. For images we fetch the bytes
 * once and render an object URL preview; for everything else we show
 * the filename + extension. Clicking opens the file in the system
 * default app via the opener plugin.
 */
function AttachmentThumb({
  attachment,
  onRemove,
}: {
  attachment: Attachment;
  onRemove: () => void;
}) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const isImage = attachment.mimeType.startsWith("image/");
  useEffect(() => {
    if (!isImage) return;
    let revoked = false;
    let url: string | null = null;
    (async () => {
      try {
        const bytes = await boardApi.attachmentReadBytes(attachment.id);
        if (revoked) return;
        const blob = new Blob([bytes.slice().buffer], {
          type: attachment.mimeType || "image/png",
        });
        url = URL.createObjectURL(blob);
        setPreviewUrl(url);
      } catch {
        /* preview is best-effort */
      }
    })();
    return () => {
      revoked = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [attachment.id, attachment.mimeType, isImage]);

  const ext = (attachment.filename.match(/\.([a-z0-9]+)$/i)?.[1] ?? "FILE")
    .toUpperCase();

  return (
    <div className="relative group">
      <Button variant="unstyled"
        type="button"
        onClick={() => {
          // Open in the user's default app for that file type.
          if (attachment.storedPath) {
            void openUrl(`file://${attachment.storedPath}`).catch(
              () => undefined,
            );
          }
        }}
        title={`${attachment.filename} · ${formatBytes(attachment.sizeBytes)}`}
        className={cn(
          "w-[80px] h-[80px] rounded-[6px] border border-bd-2 bg-bg-2",
          "overflow-hidden grid place-items-center text-fg-3 cursor-pointer",
          "hover:border-bd-1",
        )}
      >
        {isImage && previewUrl ? (
          <img
            src={previewUrl}
            alt={attachment.filename}
            className="w-full h-full object-cover"
          />
        ) : (
          <span className="text-[10px] font-mono px-1 text-center break-all leading-tight">
            {ext}
          </span>
        )}
      </Button>
      <Button variant="unstyled"
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          // Confirm via the shared ConfirmDialog (mounted at app root)
          // so the prompt matches the rest of the app's chrome.
          useRepoStore.getState().setConfirm({
            title: "Remove attachment?",
            body: `"${attachment.filename}" will be deleted from disk and unstaged from future runs.`,
            confirmLabel: "Remove",
            danger: true,
            onConfirm: () => {
              useRepoStore.getState().setConfirm(null);
              onRemove();
            },
          });
        }}
        title="Remove attachment"
        className={cn(
          "absolute -top-1 -right-1 w-4 h-4 grid place-items-center",
          "rounded-full bg-bg-1 border border-bd-1 text-fg-2 text-[10px]",
          "opacity-0 group-hover:opacity-100 hover:text-diff-del-mark",
        )}
      >
        ×
      </Button>
      <div className="text-[10px] text-fg-3 mt-1 truncate w-[80px]">
        {attachment.filename}
      </div>
    </div>
  );
}

/**
 * Picker for project scripts. When there's exactly one script, renders
 * as a single button labeled with the script's title. With multiple
 * scripts, the primary action runs the first script and a chevron
 * opens a dropdown for the rest — same UX as the GitHub "Code" button.
 */
function ScriptRunPicker({
  scripts,
  onRun,
}: {
  scripts: ProjectScript[];
  onRun: (script: ProjectScript) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(
    null,
  );

  useDismissableLayer(open, setOpen, [triggerRef, menuRef]);

  useEffect(() => {
    if (!open) return;
    if (triggerRef.current) {
      const r = triggerRef.current.getBoundingClientRect();
      setAnchor({ top: r.bottom + 4, right: window.innerWidth - r.right });
    }
  }, [open]);

  const first = scripts[0];
  if (!first) return null;

  if (scripts.length === 1) {
    return (
      <Button variant="unstyled"
        type="button"
        onClick={() => onRun(first)}
        title={`Run \`${first.command}\` in the worktree`}
        className={cn(
          "h-7 px-2.5 rounded-[5px] inline-flex items-center gap-1.5",
          "text-[11.5px] border transition-colors duration-100 shrink-0",
          "bg-transparent text-fg-1 border-bd-2 hover:bg-bg-hover hover:border-bd-1",
        )}
      >
        <span className="[&_svg]:w-2.5 [&_svg]:h-2.5">
          {iconNodeFor(first.icon)}
        </span>
        <span>{first.title}</span>
      </Button>
    );
  }

  return (
    <>
      <div className="inline-flex items-stretch h-7 rounded-[5px] border border-bd-2 overflow-hidden shrink-0">
        <Button variant="unstyled"
          type="button"
          onClick={() => onRun(first)}
          title={`Run \`${first.command}\` in the worktree`}
          className={cn(
            "h-7 px-2.5 inline-flex items-center gap-1.5",
            "text-[11.5px] text-fg-1 bg-transparent",
            "hover:bg-bg-hover transition-colors duration-100",
          )}
        >
          <span className="[&_svg]:w-2.5 [&_svg]:h-2.5">
            {iconNodeFor(first.icon)}
          </span>
          <span>{first.title}</span>
        </Button>
        <Button variant="unstyled"
          ref={triggerRef}
          type="button"
          onClick={() => setOpen((o) => !o)}
          title="More scripts"
          className={cn(
            "h-7 w-6 grid place-items-center border-l border-bd-2",
            "text-fg-2 bg-transparent hover:bg-bg-hover hover:text-fg-0",
            open && "bg-bg-2 text-fg-0",
          )}
        >
          {/* I.chevron points down by default; rotate -90° when closed so
              it points right, then back to 0° (down) when the menu is
              open. Matches the disclosure idiom used in the sidebar. */}
          <span
            className={cn(
              "inline-flex transition-transform duration-100",
              open ? "rotate-0" : "-rotate-90",
            )}
          >
            {I.chevron}
          </span>
        </Button>
      </div>
      {open && anchor
        ? createPortal(
            <div
              ref={menuRef}
              style={{
                position: "fixed",
                top: anchor.top,
                right: anchor.right,
                minWidth: 200,
              }}
              className={cn(
                "z-[1000] bg-bg-1 border border-bd-1 rounded-[6px]",
                "shadow-[0_12px_32px_rgba(0,0,0,0.5)] py-1",
              )}
            >
              {scripts.map((s) => (
                <Button variant="unstyled"
                  key={s.id}
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onRun(s);
                  }}
                  className={cn(
                    "w-full text-left px-3 py-1.5 text-[12px]",
                    "text-fg-1 hover:bg-bg-hover hover:text-fg-0",
                    "flex items-center gap-2",
                  )}
                >
                  <span className="text-fg-3 [&_svg]:w-2.5 [&_svg]:h-2.5">
                    {iconNodeFor(s.icon)}
                  </span>
                  <span className="flex-1 truncate">{s.title}</span>
                  <span className="text-[10px] font-mono text-fg-3 truncate max-w-[100px]">
                    {s.command}
                  </span>
                </Button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

/**
 * Codex-style follow-up composer. Single rounded panel with the
 * textarea on top and an action row at the bottom (attach + send).
 * Files staged via the `+` button or drag/paste preview as thumbnails
 * above the textarea and ship along with the next message — agent
 * runs pick them up via the existing attachment_stage_for_run flow.
 */
function ChatComposer({
  value,
  onChange,
  onSend,
  onAttachClick,
  disabled,
  files,
  onRemoveFile,
  dropActive,
  onDragOver,
  onDragLeave,
  onDrop,
  placeholder,
  hint,
  sendTitle,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onAttachClick: () => void;
  disabled: boolean;
  files: File[];
  onRemoveFile: (idx: number) => void;
  dropActive: boolean;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
  placeholder: string;
  hint: string;
  sendTitle: string;
}) {
  const canSend = (!!value.trim() || files.length > 0) && !disabled;
  return (
    <div className="px-4 py-3 shrink-0">
      <div
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={cn(
          "relative flex flex-col rounded-[10px] border bg-bg-2",
          "transition-colors duration-100",
          dropActive
            ? "border-accent/60 ring-2 ring-accent/40"
            : "border-bd-2 focus-within:border-bd-1",
        )}
      >
        {dropActive ? (
          <div className="absolute inset-0 z-10 pointer-events-none bg-accent/10 border-2 border-dashed border-accent/60 rounded-[10px] grid place-items-center">
            <span className="text-[12px] font-mono text-accent">
              Drop to attach
            </span>
          </div>
        ) : null}

        {files.length > 0 ? (
          <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
            {files.map((file, i) => (
              <ComposerFileChip
                key={`${file.name}-${i}-${file.size}`}
                file={file}
                onRemove={() => onRemoveFile(i)}
              />
            ))}
          </div>
        ) : null}

        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              onSend();
            }
          }}
          placeholder={placeholder}
          rows={2}
          disabled={disabled}
          className={cn(
            "w-full min-w-0 text-[12.5px] text-fg-0 leading-snug",
            "bg-transparent border-0 outline-none resize-none",
            "px-3 pt-3 pb-1",
            "placeholder:text-fg-3",
            "disabled:opacity-50 disabled:cursor-not-allowed",
          )}
        />

        <div className="flex items-center gap-1.5 px-2 pb-2">
          <Button variant="unstyled"
            type="button"
            onClick={onAttachClick}
            title="Attach files (or drag-drop / ⌘V to paste)"
            disabled={disabled}
            className={cn(
              "h-7 w-7 grid place-items-center rounded-[5px]",
              "text-fg-2 hover:bg-bg-hover hover:text-fg-0",
              "disabled:opacity-40 disabled:cursor-not-allowed",
            )}
          >
            {I.paperclip}
          </Button>
          <span className="flex-1 text-[10.5px] font-mono text-fg-3">
            ⌘ ↵ · {hint}
          </span>
          <Button variant="unstyled"
            type="button"
            onClick={onSend}
            disabled={!canSend}
            title={sendTitle}
            className={cn(
              "h-7 w-7 grid place-items-center rounded-full",
              "transition-colors duration-100",
              canSend
                ? "!bg-accent !bg-none text-accent-fg hover:!bg-accent hover:!bg-none"
                : "bg-bg-2 text-fg-3 cursor-not-allowed",
            )}
          >
            {I.send}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ComposerFileChip({
  file,
  onRemove,
}: {
  file: File;
  onRemove: () => void;
}) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const isImage = file.type.startsWith("image/");
  useEffect(() => {
    if (!isImage) return;
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file, isImage]);
  return (
    <div className="relative group inline-flex items-center gap-1.5 h-6 pl-1 pr-2 rounded-[4px] bg-bg-2 border border-bd-2 text-[11px] text-fg-1">
      {isImage && previewUrl ? (
        <img
          src={previewUrl}
          alt=""
          className="w-4 h-4 rounded-[2px] object-cover"
        />
      ) : (
        <span className="text-[9px] font-mono text-fg-3 w-4 text-center">
          {(file.name.match(/\.([a-z0-9]+)$/i)?.[1] ?? "FILE").toUpperCase()}
        </span>
      )}
      <span className="truncate max-w-[140px] font-mono">{file.name}</span>
      <Button variant="unstyled"
        type="button"
        onClick={onRemove}
        title="Remove"
        className="text-fg-3 hover:text-diff-del-mark text-[12px] leading-none"
      >
        ×
      </Button>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

// Tiny visual leaders for the agent/priority chips. Copied (not shared)
// from new-card-dialog because keeping each surface's chips self-contained
// avoids accidental coupling when one diverges.
function PriorityDot({ tone }: { tone: Priority }) {
  const color =
    tone === "high"
      ? "text-diff-del-mark"
      : tone === "med"
        ? "text-accent"
        : "text-fg-3";
  const dots = tone === "high" ? "●●●" : tone === "med" ? "●●" : "●";
  return <span className={cn("text-[10px]", color)}>{dots}</span>;
}

function AgentDot({ agent }: { agent: AgentId }) {
  const color = agent === "claude" ? "text-diff-add-mark" : "text-accent";
  return <span className={cn("text-[10px]", color)}>●</span>;
}
