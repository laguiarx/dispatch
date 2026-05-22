import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";
import { Overlay } from "@/components/overlay";
import { Kbd } from "@/components/kbd";
import { I } from "@/components/icons";
import { useBoardStore } from "@/features/board/board.store";
import { useRepoStore } from "@/features/repository/repository.store";
import type { ProjectScript } from "@/features/board/board.types";
import { ActionIconPicker, iconNodeFor, type ActionIconId } from "./action-icon";

const EMPTY_SCRIPTS: ProjectScript[] = [];

type Props = {
  projectId: string | null;
  onClose: () => void;
};

/**
 * Run-actions manager dialog. Lives on the project (kebab → "Configure
 * actions…") and is strictly about named commands the user can trigger
 * from a card in Review / Done (Dev, Test, Lint…). The setup script —
 * which runs once on worktree creation, before the agent — has its own
 * dialog (`ProjectSetupDialog`).
 *
 * Actions created here show up automatically in the card detail
 * modal's run picker — `ScriptRunPicker` reads
 * `scriptsByProject[card.projectId]` from the board store.
 */
export function ProjectScriptsDialog({ projectId, onClose }: Props) {
  const project = useBoardStore((s) =>
    projectId ? s.projectsById[projectId] ?? null : null,
  );
  const scripts = useBoardStore((s) =>
    projectId ? s.scriptsByProject[projectId] ?? EMPTY_SCRIPTS : EMPTY_SCRIPTS,
  );
  const reloadProjectScripts = useBoardStore((s) => s.reloadProjectScripts);
  const addScript = useBoardStore((s) => s.addProjectScript);
  const updateScript = useBoardStore((s) => s.updateProjectScript);
  const deleteScript = useBoardStore((s) => s.deleteProjectScript);
  const setConfirm = useRepoStore((s) => s.setConfirm);

  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftCommand, setDraftCommand] = useState("");
  const [draftIcon, setDraftIcon] = useState<ActionIconId>("play");

  useEffect(() => {
    if (!projectId) return;
    reloadProjectScripts(projectId).catch(() => undefined);
  }, [projectId, reloadProjectScripts]);

  if (!projectId || !project) return null;

  const startAdd = () => {
    setEditingId(null);
    setDraftTitle("");
    setDraftCommand("");
    setDraftIcon("play");
    setAdding(true);
  };
  const startEdit = (s: ProjectScript) => {
    setAdding(false);
    setEditingId(s.id);
    setDraftTitle(s.title);
    setDraftCommand(s.command);
    setDraftIcon((s.icon as ActionIconId) || "play");
  };
  const cancel = () => {
    setAdding(false);
    setEditingId(null);
  };
  const save = async () => {
    const t = draftTitle.trim();
    const c = draftCommand.trim();
    if (!t || !c) return;
    if (adding) {
      await addScript(projectId, t, c, draftIcon);
    } else if (editingId) {
      await updateScript(editingId, {
        title: t,
        command: c,
        icon: draftIcon,
      });
    }
    cancel();
  };

  return (
    <Overlay onClose={onClose} centered>
      <div
        className={cn(
          "w-[min(640px,94vw)] max-h-[min(720px,88vh)] flex flex-col overflow-hidden",
          "bg-bg-1 border border-bd-2 rounded-3 shadow-[0_24px_60px_rgba(0,0,0,0.55)]",
        )}
      >
        <div className="flex items-center gap-2 px-3.5 py-3 border-b border-bd-1">
          <span className="text-[14px] font-semibold tracking-[-0.01em]">
            Actions · {project.name}
          </span>
          <span className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            title="Close"
            className="w-[22px] h-[22px] grid place-items-center rounded-[4px] text-fg-3 bg-transparent border-0 cursor-pointer hover:bg-bg-hover hover:text-fg-0"
          >
            {I.x}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-2.5">
          {adding ? (
            <ScriptForm
              title={draftTitle}
              command={draftCommand}
              icon={draftIcon}
              onTitleChange={setDraftTitle}
              onCommandChange={setDraftCommand}
              onIconChange={setDraftIcon}
              onSave={save}
              onCancel={cancel}
            />
          ) : scripts.length === 0 ? (
            <EmptyState onAdd={startAdd} />
          ) : (
            <>
              {scripts.map((s) =>
                editingId === s.id ? (
                  <ScriptForm
                    key={s.id}
                    title={draftTitle}
                    command={draftCommand}
                    icon={draftIcon}
                    onTitleChange={setDraftTitle}
                    onCommandChange={setDraftCommand}
                    onIconChange={setDraftIcon}
                    onSave={save}
                    onCancel={cancel}
                    onDelete={() => {
                      setConfirm({
                        title: "Delete action?",
                        body: `"${s.title}" will be removed from this project.`,
                        confirmLabel: "Delete",
                        danger: true,
                        onConfirm: async () => {
                          setConfirm(null);
                          await deleteScript(projectId, s.id);
                          cancel();
                        },
                      });
                    }}
                  />
                ) : (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => startEdit(s)}
                    className={cn(
                      "group w-full flex items-center gap-2.5 px-3 py-2.5 rounded-[6px]",
                      "border border-bd-2 bg-bg-2 text-left",
                      "hover:bg-bg-hover hover:border-bd-1 transition-colors",
                    )}
                  >
                    <span
                      className={cn(
                        "w-8 h-8 grid place-items-center rounded-[5px] shrink-0",
                        "bg-bg-1 border border-bd-2 text-fg-2",
                        "[&_svg]:w-3.5 [&_svg]:h-3.5",
                      )}
                    >
                      {iconNodeFor(s.icon)}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-[12px] font-medium text-fg-0 truncate">
                        {s.title}
                      </div>
                      <div className="text-[11px] font-mono text-fg-2 truncate">
                        {s.command}
                      </div>
                    </div>
                    <span className="text-[10.5px] text-fg-3 opacity-0 group-hover:opacity-100">
                      Edit
                    </span>
                  </button>
                ),
              )}
              <button
                type="button"
                onClick={startAdd}
                className={cn(
                  "h-9 mt-1 inline-flex items-center justify-center gap-1.5",
                  "rounded-[6px] border border-dashed border-bd-2",
                  "text-[11.5px] text-fg-2 hover:bg-bg-hover hover:text-fg-0 hover:border-bd-1",
                )}
              >
                <span className="text-[14px] leading-none">+</span>
                Add action
              </button>
            </>
          )}
        </div>

        <div className="flex items-center gap-2 px-4 py-2.5 bg-bg-2 border-t border-bd-1 text-[11px]">
          <span className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            className={cn(
              "inline-flex items-center gap-1.5 px-2 py-1 rounded text-[11px]",
              "border border-bd-2 bg-transparent text-fg-2",
              "hover:bg-bg-hover hover:text-fg-0 hover:border-bd-1",
            )}
          >
            Done <Kbd>Esc</Kbd>
          </button>
        </div>
      </div>
    </Overlay>
  );
}

function ScriptForm({
  title,
  command,
  icon,
  onTitleChange,
  onCommandChange,
  onIconChange,
  onSave,
  onCancel,
  onDelete,
}: {
  title: string;
  command: string;
  icon: ActionIconId;
  onTitleChange: (v: string) => void;
  onCommandChange: (v: string) => void;
  onIconChange: (v: ActionIconId) => void;
  onSave: () => void;
  onCancel: () => void;
  /** Only present when editing an existing action — drives the trash
   *  icon in the form footer. The "add new" form leaves it undefined. */
  onDelete?: () => void;
}) {
  return (
    <div className="flex flex-col gap-4 p-3.5 rounded-[8px] bg-bg-2 border border-bd-1">
      <section className="flex flex-col gap-1.5">
        <label className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-fg-2">
          Name
        </label>
        <div className="flex items-stretch gap-2">
          <ActionIconPicker value={icon} onChange={onIconChange} />
          <input
            autoFocus
            value={title}
            onChange={(e) => onTitleChange(e.target.value)}
            placeholder="Dev"
            onKeyDown={(e) => {
              if (e.key === "Enter") onSave();
              if (e.key === "Escape") onCancel();
            }}
            className={cn(
              "flex-1 h-9 px-2.5 rounded-[6px]",
              "text-[12.5px] text-fg-0 bg-bg-1 border border-bd-2 outline-none",
              "placeholder:text-fg-3 focus:border-bd-1",
            )}
          />
        </div>
      </section>

      <section className="flex flex-col gap-1.5">
        <label className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-fg-2">
          Action script
        </label>
        <textarea
          value={command}
          onChange={(e) => onCommandChange(e.target.value)}
          placeholder="bun run dev"
          rows={4}
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onSave();
            if (e.key === "Escape") onCancel();
          }}
          className={cn(
            "text-[12px] font-mono text-fg-1 bg-bg-1",
            "border border-bd-2 rounded-[6px] p-2.5 outline-none",
            "placeholder:text-fg-3 leading-relaxed resize-y min-h-[88px]",
            "focus:border-bd-1",
          )}
        />
      </section>

      <div className="flex items-center gap-2 pt-1">
        {onDelete ? (
          <button
            type="button"
            onClick={onDelete}
            title="Delete action"
            className={cn(
              "w-7 h-7 grid place-items-center rounded-[5px]",
              "text-fg-3 bg-transparent border border-bd-2",
              "hover:text-diff-del-mark hover:border-diff-del-mark/40",
              "hover:bg-[color-mix(in_oklab,var(--diff-del-mark)_8%,transparent)]",
              "[&_svg]:w-3.5 [&_svg]:h-3.5",
            )}
          >
            {I.discard}
          </button>
        ) : null}
        <span className="flex-1" />
        <button
          type="button"
          onClick={onCancel}
          className={cn(
            "h-7 px-2.5 rounded-[5px] text-[11.5px]",
            "text-fg-2 bg-transparent border border-bd-2",
            "hover:bg-bg-hover hover:text-fg-0 hover:border-bd-1",
          )}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={!title.trim() || !command.trim()}
          className={cn(
            "h-7 px-3 rounded-[5px] text-[11.5px] font-medium",
            "bg-accent text-accent-fg",
            "hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed",
          )}
        >
          Save
        </button>
      </div>
    </div>
  );
}

/**
 * Centered illustration + headline + CTA, shown when the project has no
 * actions yet. The whole panel is tall enough that the modal doesn't
 * feel half-empty before the user adds anything.
 */
function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div
      className={cn(
        "flex-1 flex flex-col items-center justify-center gap-3 py-10 px-6",
        "rounded-[8px] border border-dashed border-bd-2 bg-bg-2/40",
      )}
    >
      <div
        className={cn(
          "w-12 h-12 grid place-items-center rounded-[10px]",
          "bg-bg-1 border border-bd-2 text-fg-2",
          "[&_svg]:w-5 [&_svg]:h-5",
        )}
      >
        {I.play}
      </div>
      <div className="text-center flex flex-col gap-1">
        <div className="text-[13px] font-semibold text-fg-0">
          No actions yet
        </div>
        <div className="text-[11.5px] text-fg-2 max-w-[360px] leading-relaxed">
          Add named commands like{" "}
          <code className="font-mono text-fg-1">dev</code> /{" "}
          <code className="font-mono text-fg-1">test</code> /{" "}
          <code className="font-mono text-fg-1">lint</code> to run inside
          a card's worktree from Review or Done.
        </div>
      </div>
      <button
        type="button"
        onClick={onAdd}
        className={cn(
          "mt-1 inline-flex items-center gap-1.5 h-8 px-3 rounded-[6px]",
          "text-[12px] font-medium bg-accent text-accent-fg",
          "hover:opacity-90",
        )}
      >
        <span className="text-[14px] leading-none">+</span>
        Add action
      </button>
    </div>
  );
}
