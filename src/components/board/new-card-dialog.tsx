import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

import { cn } from "@/lib/utils";
import { Overlay } from "@/components/overlay";
import { Kbd } from "@/components/kbd";
import { I } from "@/components/icons";
import { useBoardStore } from "@/features/board/board.store";
import { useRepoStore } from "@/features/repository/repository.store";
import type { AgentId, Priority } from "@/features/board/board.types";
import * as gitApi from "@/features/git/git.api";
import { ChipPopover, type ChipOption } from "./chip-popover";

type Props = {
  open: boolean;
  onClose: () => void;
};

const AGENT_LABEL: Record<AgentId, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

// Curated quick-picks per CLI, mirrored from the model lists each CLI
// actually accepts today. Free-text input is still available in the
// chip (type any id + ↵) — these are just the common cases. Update
// when the upstream CLI ships a new family.
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

const PRIORITY_OPTIONS: ChipOption<Priority>[] = [
  {
    value: "low",
    label: "Low",
    leading: <PriorityDot tone="low" />,
  },
  {
    value: "med",
    label: "Medium",
    leading: <PriorityDot tone="med" />,
  },
  {
    value: "high",
    label: "High",
    leading: <PriorityDot tone="high" />,
  },
];

/**
 * Card creation dialog. Adopts the same modal chrome as Preferences and
 * uses Linear-style popover chips for Project / Agent / Priority — each
 * with a small search-and-select menu.
 */
export function NewCardDialog({ open, onClose }: Props) {
  const activeProjectId = useBoardStore((s) => s.activeProjectId);
  const projects = useBoardStore((s) => s.projects);
  const createCardForProject = useBoardStore((s) => s.createCardForProject);
  const moveCardTo = useBoardStore((s) => s.moveCardTo);
  const preferredAi = useRepoStore((s) => s.settings.preferredAiCli);
  const aiClis = useRepoStore((s) => s.aiCliList);

  const availableAgents = useMemo<AgentId[]>(() => {
    const candidates = aiClis
      .filter((c) => c.available && (c.id === "claude" || c.id === "codex"))
      .map((c) => c.id as AgentId);
    return candidates.length > 0 ? candidates : ["claude", "codex"];
  }, [aiClis]);

  const agentOptions = useMemo<ChipOption<AgentId>[]>(
    () =>
      (["claude", "codex"] as AgentId[]).map((id) => ({
        value: id,
        label: AGENT_LABEL[id],
        leading: <AgentDot agent={id} />,
        searchTokens: [id],
      })),
    [],
  );

  const projectOptions = useMemo<ChipOption<string>[]>(
    () =>
      projects.map((p) => ({
        value: p.id,
        label: p.name,
        leading: <span className="text-fg-3">{I.folder}</span>,
        searchTokens: [p.repoPath],
      })),
    [projects],
  );

  const newCardProjectId = useBoardStore((s) => s.newCardProjectId);
  // Project resolution priority: explicit override from the sidebar's
  // per-project "+" button → current board filter → first project.
  const defaultProjectId =
    newCardProjectId ?? activeProjectId ?? projects[0]?.id ?? null;
  const [projectId, setProjectId] = useState<string | null>(defaultProjectId);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [agent, setAgent] = useState<AgentId>(
    preferredAi === "codex" ? "codex" : "claude",
  );
  const [priority, setPriority] = useState<Priority>("med");
  // Run config — all optional. null/undefined falls through to the
  // CLI's own defaults, so a card created without touching these
  // behaves exactly like before this feature shipped.
  const [model, setModel] = useState<string | null>(null);
  const [reasoning, setReasoning] = useState<string | null>(null);
  const [fastMode, setFastMode] = useState<boolean>(false);
  // `null` means "use the project default at spawn time" — stored as
  // such on the card so the agent runner can still fall through to
  // project.defaultBase if we ever evolve the field. Local branches for
  // the currently-picked project, populated by the effect below.
  const [baseBranch, setBaseBranch] = useState<string | null>(null);
  const [branchOptions, setBranchOptions] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [dropActive, setDropActive] = useState(false);
  const titleRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const attachFile = useBoardStore((s) => s.attachFile);

  useEffect(() => {
    if (!open) return;
    setProjectId(defaultProjectId);
    setTitle("");
    setDescription("");
    setAgent(preferredAi === "codex" ? "codex" : "claude");
    setPriority("med");
    setModel(null);
    setReasoning(null);
    setFastMode(false);
    setBaseBranch(null);
    setBranchOptions([]);
    setPendingFiles([]);
    requestAnimationFrame(() => titleRef.current?.focus());
    // `defaultProjectId` itself depends on activeProjectId / projects /
    // newCardProjectId — listing it covers all three.
  }, [open, defaultProjectId, preferredAi]);

  // Re-fetch the local branch list whenever the dialog is open AND the
  // selected project changes. We deliberately scope this to local
  // branches (no remote-only refs) because the worktree command does
  // `git worktree add -b new-branch <path> <base>` — `base` has to be
  // resolvable locally for `git` not to error. The chip lets the user
  // type anything though (`allowCustom`), so an `origin/release/x`
  // they know is valid still works.
  const selectedProject = useMemo(
    () => projects.find((p) => p.id === projectId) ?? null,
    [projects, projectId],
  );
  useEffect(() => {
    if (!open || !selectedProject) return;
    let cancelled = false;
    void gitApi
      .listBranches(selectedProject.repoPath)
      .then((branches) => {
        if (cancelled) return;
        const locals = branches
          .filter((b) => !b.isRemote && !b.gone)
          .map((b) => b.name);
        setBranchOptions(locals);
        // Default the picker to the project's tracked default branch
        // when nothing has been chosen explicitly yet. We only adjust
        // when `baseBranch` is still `null` — once the user picks
        // something we trust that choice for the rest of the session.
        setBaseBranch((current) =>
          current ?? selectedProject.defaultBase ?? null,
        );
      })
      .catch(() => {
        // Non-fatal — leaves the picker in free-text mode. The user can
        // still type the branch they want.
        if (!cancelled) setBranchOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, selectedProject]);

  // Global paste handler — picks up clipboard images / files while the
  // dialog is open. Skips when focus is in a text field (the user is
  // pasting text, not an attachment).
  useEffect(() => {
    if (!open) return;
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
        setPendingFiles((prev) => [...prev, ...files]);
      }
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [open]);

  if (!open) return null;

  const addFiles = (files: FileList | File[]) => {
    const arr = Array.from(files);
    if (arr.length === 0) return;
    setPendingFiles((prev) => [...prev, ...arr]);
  };

  const removePending = (idx: number) => {
    setPendingFiles((prev) => prev.filter((_, i) => i !== idx));
  };

  const submit = async (alsoRun: boolean) => {
    if (!title.trim() || !projectId) return;
    setSubmitting(true);
    try {
      const card = await createCardForProject(
        projectId,
        title.trim(),
        description.trim(),
        agent,
        priority,
        null,
        baseBranch,
        { model, reasoning, fastMode },
      );
      if (card) {
        // Persist attachments now that the card row exists. Sequential
        // saves keep the DB inserts deterministic (and the files small
        // enough that latency doesn't matter for typical mockups).
        for (const file of pendingFiles) {
          try {
            await attachFile(card.id, file);
          } catch {
            /* one failed attachment shouldn't block the rest */
          }
        }
        if (alsoRun) {
          await moveCardTo(card.id, "todo");
        }
      }
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  const onDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("Files")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setDropActive(true);
    }
  };
  const onDragLeave = () => setDropActive(false);
  const onDrop = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    setDropActive(false);
    addFiles(e.dataTransfer.files);
  };

  return (
    <Overlay onClose={onClose} centered>
      <div
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={cn(
          "w-[640px] max-w-[calc(100vw-32px)] max-h-[calc(100vh-72px)] flex flex-col overflow-hidden relative",
          "bg-bg-1 border border-bd-2 rounded-3",
          dropActive && "ring-2 ring-accent/60",
        )}
      >
        {dropActive ? (
          <div className="absolute inset-0 z-10 pointer-events-none bg-accent/10 border-2 border-dashed border-accent/60 rounded-3 grid place-items-center">
            <span className="text-[12px] font-mono text-accent">
              Drop to attach
            </span>
          </div>
        ) : null}
        {/* Hidden file input — driven by the Attach button below. */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            // Reset so picking the same file twice still fires onChange.
            e.target.value = "";
          }}
        />
        {/* Header — same chrome as Preferences */}
        <div className="flex items-center gap-2 px-4 h-12 border-b border-bd-1 shrink-0">
          <span className="text-[14px] font-semibold tracking-[-0.01em]">
            New card
          </span>
          <Kbd>⌘N</Kbd>
          <span className="flex-1" />
          <Button variant="unstyled"
            type="button"
            onClick={onClose}
            title="Close"
            className="w-[22px] h-[22px] grid place-items-center rounded-[4px] text-fg-3 bg-transparent border-0 cursor-pointer hover:bg-bg-hover hover:text-fg-0"
          >
            {I.x}
          </Button>
        </div>

        {/* Body */}
        <div className="grid grid-cols-1 gap-4 px-4 py-4 overflow-y-auto md:grid-cols-[minmax(0,1fr)_220px]">
          <section className="min-w-0 flex flex-col gap-2">
            <label className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-fg-2">
              Brief
            </label>
            <input
              ref={titleRef}
              type="text"
              placeholder="Title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  void submit(true);
                } else if (e.key === "Escape") {
                  onClose();
                }
              }}
              className={cn(
                "h-9 px-2.5 rounded-[6px]",
                "text-[13.5px] font-medium text-fg-0 bg-bg-0 border border-bd-2 outline-none",
                "placeholder:text-fg-3 focus:border-bd-1",
              )}
            />
            <textarea
              placeholder="Describe the work the agent will pick up…"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  void submit(true);
                }
              }}
              rows={8}
              className={cn(
                "text-[12px] text-fg-1 bg-bg-0",
                "border border-bd-2 rounded-[6px] p-2.5 outline-none",
                "placeholder:text-fg-3 leading-relaxed resize-y min-h-[174px]",
                "focus:border-bd-1 font-mono",
              )}
            />

            <div className="flex items-center gap-2 pt-1">
              <Button
                variant="unstyled"
                type="button"
                onClick={() => fileInputRef.current?.click()}
                title="Attach files (or drag-drop / ⌘V to paste)"
                className={cn(
                  "h-7 inline-flex items-center gap-1.5 px-2 rounded-[5px]",
                  "text-[11px] text-fg-2 border border-bd-2 bg-bg-0",
                  "hover:bg-bg-hover hover:text-fg-0 hover:border-bd-1",
                  "transition-colors",
                )}
              >
                {I.paperclip}
                <span>Attach</span>
                {pendingFiles.length > 0 ? (
                  <span className="text-fg-3">· {pendingFiles.length}</span>
                ) : null}
              </Button>
            </div>

            {pendingFiles.length > 0 ? (
              <div className="flex flex-wrap gap-2 pt-1">
                {pendingFiles.map((file, i) => (
                  <PendingThumb
                    key={`${file.name}-${i}-${file.size}`}
                    file={file}
                    onRemove={() => removePending(i)}
                  />
                ))}
              </div>
            ) : null}
          </section>

          <section className="min-w-0 flex flex-col gap-2 border-t border-bd-1 pt-4 md:border-t-0 md:border-l md:pl-4 md:pt-0">
            <label className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-fg-2">
              Run config
            </label>
            <div className="flex flex-wrap items-center gap-1.5 md:flex-col md:items-stretch">
              {projects.length > 0 ? (
                <ChipPopover<string>
                  label="Project"
                  value={projectId ?? projects[0]?.id ?? ""}
                  options={projectOptions}
                  onChange={(id) => setProjectId(id)}
                  searchPlaceholder="Search projects…"
                  fullWidth
                  menuMinWidth={260}
                />
              ) : null}
              <ChipPopover<AgentId>
                label="Agent"
                value={agent}
                options={agentOptions}
                onChange={setAgent}
                enabledValues={availableAgents}
                searchable={false}
                fullWidth
              />
              <ChipPopover<Priority>
                label="Priority"
                value={priority}
                options={PRIORITY_OPTIONS}
                onChange={setPriority}
                searchable={false}
                fullWidth
              />
              <ChipPopover<string | null>
                label="Base"
                value={baseBranch}
                options={[
                  {
                    value: null,
                    label: selectedProject?.defaultBase
                      ? `Default (${selectedProject.defaultBase})`
                      : "Default",
                  },
                  ...branchOptions.map((name) => ({
                    value: name,
                    label: name,
                  })),
                ]}
                onChange={setBaseBranch}
                allowCustom
                searchPlaceholder="Search branches…"
                fullWidth
                menuMinWidth={260}
              />
              <ChipPopover<string | null>
                label="Model"
                value={model}
                options={MODELS_BY_AGENT[agent].map((m) => ({
                  value: m.value,
                  label: m.label,
                }))}
                onChange={setModel}
                allowCustom
                fullWidth
                menuMinWidth={260}
              />
              <ChipPopover<string | null>
                label="Reasoning"
                value={reasoning}
                options={REASONING_OPTIONS}
                onChange={setReasoning}
                searchable={false}
                fullWidth
              />
              <ChipPopover<boolean>
                label="Mode"
                value={fastMode}
                options={FAST_MODE_OPTIONS}
                onChange={setFastMode}
                searchable={false}
                fullWidth
              />
            </div>
          </section>
        </div>

        {/* Footer — same chrome as Preferences */}
        <div className="flex items-center gap-2 px-4 py-2.5 bg-bg-2 border-t border-bd-1 text-[11px]">
          <span className="text-fg-2 font-mono">
            <Kbd>⌘</Kbd>
            <Kbd>↵</Kbd> to create and run
          </span>
          <span className="flex-1" />
          <Button variant="unstyled"
            type="button"
            onClick={onClose}
            className={cn(
              "inline-flex items-center gap-1.5 px-2 py-1 rounded text-[11px]",
              "border border-bd-2 bg-transparent text-fg-2 cursor-pointer",
              "hover:bg-bg-hover hover:text-fg-0 hover:border-bd-1",
            )}
          >
            Cancel <Kbd>Esc</Kbd>
          </Button>
          <Button variant="unstyled"
            type="button"
            disabled={!title.trim() || !projectId || submitting}
            onClick={() => submit(false)}
            className={cn(
              "inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-medium",
              "!bg-accent !bg-none text-accent-fg border-0 cursor-pointer",
              "hover:!bg-accent hover:!bg-none disabled:opacity-40 disabled:cursor-not-allowed",
            )}
          >
            {submitting ? "Creating…" : "Create card"}
          </Button>
        </div>
      </div>
    </Overlay>
  );
}

function PriorityDot({ tone }: { tone: Priority }) {
  // 3-dot ramp ala Linear: 1 dot for low, 2 for med, 3 for high. Colored
  // only at "high" so the rest of the row stays calm.
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
  // Two-tone dot so the picker reads cleanly when scanning the list. The
  // colors are arbitrary — picked to be distinguishable, not branded.
  const color = agent === "claude" ? "text-diff-add-mark" : "text-accent";
  return <span className={cn("text-[10px]", color)}>●</span>;
}

/**
 * Thumbnail for an attachment that hasn't been persisted yet (the card
 * doesn't exist on disk until the user hits Create). For images we
 * render a Blob URL preview; for everything else we show an icon + name
 * + size. Blob URLs are revoked on unmount to avoid leaks.
 */
function PendingThumb({
  file,
  onRemove,
}: {
  file: File;
  onRemove: () => void;
}) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file.type.startsWith("image/")) return;
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const isImage = file.type.startsWith("image/");
  return (
    <div className="relative group">
      <div
        className={cn(
          "w-[64px] h-[64px] rounded-[6px] border border-bd-2 bg-bg-2",
          "overflow-hidden grid place-items-center text-fg-3",
        )}
        title={`${file.name} · ${formatBytes(file.size)}`}
      >
        {isImage && previewUrl ? (
          <img
            src={previewUrl}
            alt={file.name}
            className="w-full h-full object-cover"
          />
        ) : (
          <span className="text-[9.5px] font-mono px-1 text-center break-all leading-tight">
            {extOf(file.name) || "FILE"}
          </span>
        )}
      </div>
      <Button variant="unstyled"
        type="button"
        onClick={onRemove}
        title="Remove"
        className={cn(
          "absolute -top-1 -right-1 w-4 h-4 grid place-items-center",
          "rounded-full bg-bg-1 border border-bd-1 text-fg-2 text-[10px]",
          "opacity-0 group-hover:opacity-100 hover:text-diff-del-mark",
        )}
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

function extOf(name: string): string {
  const m = name.match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toUpperCase() : "";
}
