import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";

import { cn } from "@/lib/utils";
import { Overlay } from "@/components/overlay";
import { Kbd } from "@/components/kbd";
import { I } from "@/components/icons";
import { useBoardStore } from "@/features/board/board.store";
import { useRepoStore } from "@/features/repository/repository.store";
import * as boardApi from "@/features/board/board.api";
import type { ProjectDetection } from "@/features/board/board.api";

type Props = {
  projectId: string | null;
  onClose: () => void;
};

/**
 * Setup script dialog. Lives on the project (kebab → "Configure
 * setup") AND auto-opens when a project is freshly added so the user
 * sets up `bun install` / `.env` copy before the first card runs.
 *
 * The dialog inspects the repo with `project_detect` to show what we
 * can see (package manager, monorepo shape, env files); for a real
 * suggestion the user hits the ✨ button in the Setup script header,
 * which delegates to claude/codex via `project_suggest_setup_script`.
 */
export function ProjectSetupDialog({
  projectId,
  onClose,
}: Props) {
  const project = useBoardStore((s) =>
    projectId ? s.projectsById[projectId] ?? null : null,
  );
  const updateSetupScript = useBoardStore((s) => s.updateProjectSetupScript);

  const [draft, setDraft] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [detection, setDetection] = useState<ProjectDetection | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  // True after a successful AI run on the current draft — clears as
  // soon as the user types so the "AI-filled" tag doesn't lie.
  const [aiFilled, setAiFilled] = useState(false);
  const preferredAi = useRepoStore((s) => s.settings.preferredAiCli);
  const aiClis = useRepoStore((s) => s.aiCliList);
  // Pick a CLI that's actually installed — fall back to the user's
  // preference even if `aiCliList` hasn't loaded yet so the first click
  // doesn't error before detection finishes.
  const aiCli = useMemo<"claude" | "codex">(() => {
    const installed = aiClis.find(
      (c) => c.available && (c.id === "claude" || c.id === "codex"),
    );
    if (installed) return installed.id as "claude" | "codex";
    return preferredAi === "codex" ? "codex" : "claude";
  }, [aiClis, preferredAi]);

  // Hydrate the draft from the project, and (re)run detection whenever we
  // open a different project.
  useEffect(() => {
    if (!project) return;
    setDraft(project.setupScript ?? "");
    setDirty(false);
    setAiFilled(false);
    setAiError(null);
    setDetecting(true);
    boardApi
      .projectDetect(project.repoPath)
      .then((d) => setDetection(d))
      .catch(() => setDetection(null))
      .finally(() => setDetecting(false));
  }, [project?.id, project?.repoPath, project?.setupScript]);

  if (!projectId || !project) return null;

  const save = async () => {
    if (!dirty) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      await updateSetupScript(projectId, draft);
      setDirty(false);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const runAiSuggest = async () => {
    if (!project) return;
    setAiLoading(true);
    setAiError(null);
    try {
      const script = await boardApi.projectSuggestSetupScript(
        project.repoPath,
        aiCli,
      );
      const trimmed = script.trim();
      if (!trimmed) {
        setAiError("Empty response from the AI CLI.");
        return;
      }
      // Drop the result straight into the textarea — that's the
      // common case (user wanted it filled, asked the AI, takes it).
      // If they want to compare with what they had, undo (⌘Z in the
      // textarea) still works.
      setDraft(trimmed);
      setDirty(true);
      setAiFilled(true);
    } catch (err) {
      setAiError(err instanceof Error ? err.message : String(err));
    } finally {
      setAiLoading(false);
    }
  };

  return (
    <Overlay onClose={onClose} centered>
      <div
        className={cn(
          "w-[min(680px,94vw)] max-h-[min(760px,90vh)] flex flex-col overflow-hidden",
          "bg-bg-1 border border-bd-2 rounded-3 shadow-[0_24px_60px_rgba(0,0,0,0.55)]",
        )}
      >
        <div className="flex items-center gap-2 px-3.5 py-3 border-b border-bd-1">
          <span className="text-[14px] font-semibold tracking-[-0.01em]">
            Setup · {project.name}
          </span>
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

        <div className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <div className="text-[11.5px] text-fg-1 leading-relaxed">
              Bash that runs inside the worktree before the agent spawns
              — typically <code className="font-mono">bun install</code>{" "}
              and a <code className="font-mono">.env</code> copy.
            </div>
            <div className="text-[10.5px] text-fg-3 leading-relaxed">
              Output streams into a Setup tab in the terminal. Non-zero
              exit cancels the run and sends the card back to the backlog.
            </div>
          </div>

          <DetectionPanel detection={detection} detecting={detecting} />

          {aiError ? (
            <div
              className={cn(
                "text-[11px] text-diff-del-mark px-2.5 py-1.5 rounded-[5px]",
                "border border-diff-del-mark/30",
                "bg-[color-mix(in_oklab,var(--diff-del-mark)_6%,transparent)]",
              )}
            >
              {aiError}
            </div>
          ) : null}

          <section
            className={cn(
              "flex flex-col gap-2 p-3.5 rounded-[8px]",
              "bg-bg-2 border border-bd-1",
            )}
          >
            <div className="flex items-center gap-2">
              <label className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-fg-2">
                Setup script
              </label>
              <span className="text-[10.5px] text-fg-3 font-mono">bash</span>
              {aiFilled ? (
                <span className="text-[10.5px] text-fg-3">
                  filled by {aiCli}
                </span>
              ) : null}
              <span className="flex-1" />
              {dirty ? (
                <span className="text-[10.5px] text-accent">unsaved</span>
              ) : null}
              <Button variant="unstyled"
                type="button"
                onClick={runAiSuggest}
                disabled={aiLoading}
                title={`Run ${aiCli} headless against your repo files`}
                className={cn(
                  "inline-flex items-center gap-1.5 h-6 px-2 rounded-[5px]",
                  "text-[11px] font-medium border",
                  aiLoading
                    ? "border-bd-2 text-fg-3 cursor-wait"
                    : "border-bd-2 text-fg-1 bg-bg-1 hover:bg-bg-hover hover:border-bd-1",
                )}
              >
                <span aria-hidden="true">✨</span>
                {aiLoading
                  ? `Asking ${aiCli}…`
                  : aiFilled
                    ? "Regenerate"
                    : "Suggest with AI"}
              </Button>
            </div>
            <textarea
              autoFocus
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setDirty(true);
                setAiFilled(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void save();
                }
              }}
              spellCheck={false}
              rows={10}
              placeholder={
                "# example\nbun install\ncp -n .env.example .env || true\n"
              }
              className={cn(
                "text-[12px] font-mono text-fg-1 bg-bg-1",
                "border border-bd-2 rounded-[6px] p-2.5 outline-none",
                "placeholder:text-fg-3 leading-relaxed resize-y",
                "focus:border-bd-1 min-h-[180px]",
              )}
            />
            <div className="text-[10.5px] text-fg-3 font-mono pt-0.5">
              env: <code className="text-fg-2">$WORKTREE_PATH</code>,{" "}
              <code className="text-fg-2">$SOURCE_REPO</code>
            </div>
          </section>
        </div>

        <div className="flex items-center gap-2 px-4 py-2.5 bg-bg-2 border-t border-bd-1 text-[11px]">
          <span className="text-fg-2 font-mono">
            <Kbd>⌘</Kbd>
            <Kbd>↵</Kbd> save & close
          </span>
          <span className="flex-1" />
          <Button variant="unstyled"
            type="button"
            onClick={onClose}
            className={cn(
              "inline-flex items-center gap-1.5 px-2 py-1 rounded text-[11px]",
              "border border-bd-2 bg-transparent text-fg-2",
              "hover:bg-bg-hover hover:text-fg-0 hover:border-bd-1",
            )}
          >
            Cancel <Kbd>Esc</Kbd>
          </Button>
          <Button variant="unstyled"
            type="button"
            onClick={save}
            disabled={saving}
            className={cn(
              "inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-medium",
              "!bg-accent !bg-none text-accent-fg border-0",
              "hover:!bg-accent hover:!bg-none disabled:opacity-40 disabled:cursor-not-allowed",
            )}
          >
            {saving ? "Saving…" : dirty ? "Save & close" : "Close"}
          </Button>
        </div>
      </div>
    </Overlay>
  );
}

function DetectionPanel({
  detection,
  detecting,
}: {
  detection: ProjectDetection | null;
  detecting: boolean;
}) {
  if (detecting) {
    return (
      <div className="text-[11px] text-fg-3 italic">Inspecting project…</div>
    );
  }
  if (!detection) return null;

  const chips: string[] = [];
  if (!detection.isNode) chips.push("Non-Node project");
  if (detection.packageManager) chips.push(detection.packageManager);
  if (detection.monorepoTool) chips.push(`${detection.monorepoTool} monorepo`);
  if (detection.workspaces.length > 0) {
    chips.push(`${detection.workspaces.length} workspaces`);
  }

  const envIssues = detection.envStatus.filter(
    (e) => !e.hasEnv && e.hasEnvExample,
  );
  const missingEnvs = detection.envStatus.filter(
    (e) => !e.hasEnv && !e.hasEnvExample,
  );

  if (chips.length === 0 && envIssues.length === 0 && missingEnvs.length === 0) {
    return null;
  }

  return (
    <section
      className={cn(
        "flex flex-col gap-2 p-3 rounded-[8px]",
        "bg-bg-2 border border-bd-1",
      )}
    >
      <div className="flex items-center gap-2">
        <label className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-fg-2">
          Detected
        </label>
        <span className="flex-1" />
        <span className="text-[10.5px] text-fg-3">
          for the AI suggestion below
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {chips.map((c) => (
          <span
            key={c}
            className={cn(
              "inline-flex items-center px-2 py-0.5 rounded-[4px] text-[10.5px]",
              "font-mono text-fg-1 bg-bg-1 border border-bd-2",
            )}
          >
            {c}
          </span>
        ))}
      </div>
      {envIssues.length > 0 || missingEnvs.length > 0 ? (
        <ul className="text-[11px] text-fg-2 leading-relaxed flex flex-col gap-0.5">
          {envIssues.map((e) => (
            <li key={`ex-${e.workspace}`} className="flex gap-1.5">
              <span className="text-accent shrink-0">•</span>
              <span>
                <code className="font-mono text-fg-1">
                  {e.workspace || "root"}
                </code>{" "}
                has <code className="font-mono">.env.example</code> but no{" "}
                <code className="font-mono">.env</code> — copy your real
                one from the source repo.
              </span>
            </li>
          ))}
          {missingEnvs.map((e) => (
            <li key={`m-${e.workspace}`} className="flex gap-1.5 text-fg-3">
              <span className="shrink-0">•</span>
              <span>
                <code className="font-mono text-fg-2">
                  {e.workspace || "root"}
                </code>{" "}
                has no <code className="font-mono">.env</code> on disk —
                supply secrets manually if needed.
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
