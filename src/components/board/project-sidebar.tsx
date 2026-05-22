import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import { cn } from "@/lib/utils";
import { Spinner } from "@/components/spinner";
import { I } from "@/components/icons";
import { useBoardStore } from "@/features/board/board.store";
import { useRepoStore } from "@/features/repository/repository.store";
import type {
  BoardColumnId,
  Card,
} from "@/features/board/board.types";
import { ProjectScriptsDialog } from "./project-scripts-dialog";
import { ProjectSetupDialog } from "./project-setup-dialog";

/**
 * Left rail of the workspace. Each project is collapsible and surfaces
 * its cards inline (ordered by activity recency) with a status
 * indicator. The project row carries two hover-only affordances: a
 * "+ New card" mini-button that pre-selects the project in the New Card
 * dialog, and a kebab menu with Pin / Rename / Remove.
 */
export function ProjectSidebar() {
  const projects = useBoardStore((s) => s.projects);
  const activeProjectId = useBoardStore((s) => s.activeProjectId);
  const setActiveProject = useBoardStore((s) => s.setActiveProject);
  const addProjectFromPicker = useBoardStore((s) => s.addProjectFromPicker);
  const removeProject = useBoardStore((s) => s.removeProject);
  const renameProject = useBoardStore((s) => s.renameProject);
  const reorderProjects = useBoardStore((s) => s.reorderProjects);
  const openNewCardForProject = useBoardStore(
    (s) => s.openNewCardForProject,
  );
  const cards = useBoardStore((s) => s.cards);
  const runningCardIds = useBoardStore((s) => s.runningCardIds);
  const selectedCardId = useBoardStore((s) => s.selectedCardId);
  const selectCard = useBoardStore((s) => s.selectCard);
  const pushToast = useRepoStore((s) => s.pushToast);
  const setConfirm = useRepoStore((s) => s.setConfirm);

  const [adding, setAdding] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [scriptsProjectId, setScriptsProjectId] = useState<string | null>(
    null,
  );
  const [setupProjectId, setSetupProjectId] = useState<string | null>(null);

  // Group cards under their projects. Active stuff (in_progress, review)
  // floats to the top within each project so the most useful rows are
  // visible without scrolling.
  const cardsByProject = useMemo(() => {
    const out: Record<string, Card[]> = {};
    for (const c of Object.values(cards)) {
      (out[c.projectId] ??= []).push(c);
    }
    const order: Record<BoardColumnId, number> = {
      in_progress: 0,
      review: 1,
      todo: 2,
      done: 3,
      backlog: 4,
    };
    for (const arr of Object.values(out)) {
      arr.sort(
        (a, b) =>
          order[a.columnId] - order[b.columnId] ||
          b.updatedAt - a.updatedAt,
      );
    }
    return out;
  }, [cards]);

  const onAdd = async () => {
    setAdding(true);
    try {
      const result = await addProjectFromPicker();
      // Brand-new projects get an onboarding nudge: pop the setup dialog
      // so the user can hit ✨ Suggest with AI before kicking off any
      // card. Re-picks of an already-known repo skip it.
      if (result?.created) {
        setSetupProjectId(result.projectId);
      }
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), "danger");
    } finally {
      setAdding(false);
    }
  };

  const toggleCollapse = (projectId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  return (
    <aside
      className={cn(
        "flex flex-col h-full min-h-0 min-w-0",
        "border border-bd-2 rounded-[10px] bg-bg-1 overflow-hidden",
      )}
    >
      {/* Header height pinned to `h-10` so it matches the board-view's
          own header (All projects + New card). Previously both used
          `py-2` but the inner controls had different intrinsic heights
          (h-5 here vs h-6 there) — the 4px mismatch was small but
          visible side-by-side. */}
      <div className="flex items-center justify-between px-3 h-10 border-b border-bd-2 shrink-0">
        <span className="text-[10.5px] font-mono uppercase tracking-wider text-fg-2">
          Workspace
        </span>
        <button
          type="button"
          onClick={onAdd}
          disabled={adding}
          title="Add a project (⌘O)"
          className={cn(
            "h-6 w-6 grid place-items-center rounded text-fg-2",
            "hover:bg-bg-hover hover:text-fg-0 disabled:opacity-50",
          )}
        >
          +
        </button>
      </div>

      <nav className="flex flex-col gap-px p-1.5 overflow-y-auto flex-1 min-h-0">
        <AllProjectsRow
          active={activeProjectId === null}
          onSelect={() => setActiveProject(null)}
        />
        <div className="h-px bg-bd-2 my-1 mx-1" />

        {projects.length === 0 ? (
          <div className="px-2 py-2 text-[11px] text-fg-2 leading-snug">
            No projects yet. Click <span className="text-fg-1">+</span> above to
            add a Git repo.
          </div>
        ) : (
          <ProjectsList
            ids={projects.map((p) => p.id)}
            onReorder={(ids) => reorderProjects(ids)}
            renderDraggingPreview={(id) => {
              const p = projects.find((x) => x.id === id);
              if (!p) return null;
              return <DraggingProjectPreview name={p.name} />;
            }}
          >
            {projects.map((p) => {
              const projectCards = cardsByProject[p.id] ?? [];
              const isCollapsed = collapsed.has(p.id);
              const isRenaming = renamingId === p.id;
              return (
                <SortableProjectGroup key={p.id} id={p.id}>
                  {(dragHandleProps) =>
                    isRenaming ? (
                      <RenameRow
                        initial={p.name}
                        onCancel={() => setRenamingId(null)}
                        onSubmit={async (name) => {
                          await renameProject(p.id, name);
                          setRenamingId(null);
                        }}
                      />
                    ) : (
                      <>
                        <ProjectRow
                          label={p.name}
                          active={activeProjectId === p.id}
                          collapsed={isCollapsed}
                          onToggleCollapse={() => toggleCollapse(p.id)}
                          onSelect={() => setActiveProject(p.id)}
                          onNewCard={() => openNewCardForProject(p.id)}
                          onRename={() => setRenamingId(p.id)}
                          onConfigureScripts={() =>
                            setScriptsProjectId(p.id)
                          }
                          onConfigureSetup={() => setSetupProjectId(p.id)}
                          onRemove={() => {
                            setConfirm({
                              title: "Remove project?",
                              body: `"${p.name}" — every card and its on-disk worktree will be deleted. This can't be undone.`,
                              confirmLabel: "Remove",
                              danger: true,
                              onConfirm: async () => {
                                setConfirm(null);
                                await removeProject(p.id);
                              },
                            });
                          }}
                          dragHandleProps={dragHandleProps}
                        />
                        {!isCollapsed
                          ? projectCards.map((card) => (
                              <CardRow
                                key={card.id}
                                card={card}
                                selected={selectedCardId === card.id}
                                running={runningCardIds.has(card.id)}
                                onClick={() => selectCard(card.id)}
                              />
                            ))
                          : null}
                        {!isCollapsed && projectCards.length === 0 ? (
                          <div className="px-7 py-1 text-[10.5px] text-fg-3 italic">
                            No cards yet
                          </div>
                        ) : null}
                      </>
                    )
                  }
                </SortableProjectGroup>
              );
            })}
          </ProjectsList>
        )}
      </nav>
      <ProjectScriptsDialog
        projectId={scriptsProjectId}
        onClose={() => setScriptsProjectId(null)}
      />
      <ProjectSetupDialog
        projectId={setupProjectId}
        onClose={() => setSetupProjectId(null)}
      />
    </aside>
  );
}

function AllProjectsRow({
  active,
  onSelect,
}: {
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-1 px-1.5 py-1 rounded-[4px] cursor-pointer",
        active
          ? "bg-bg-2 text-fg-0"
          : "text-fg-1 hover:bg-bg-hover hover:text-fg-0",
      )}
      onClick={onSelect}
    >
      <div className="w-4 shrink-0" />
      <span className="text-[12px] flex-1 min-w-0 truncate font-medium">
        All projects
      </span>
    </div>
  );
}

type DragHandleProps = {
  attributes: Record<string, unknown>;
  listeners: Record<string, unknown> | undefined;
};

function ProjectRow({
  label,
  active,
  collapsed,
  onSelect,
  onToggleCollapse,
  onNewCard,
  onRename,
  onConfigureScripts,
  onConfigureSetup,
  onRemove,
  dragHandleProps,
}: {
  label: string;
  active: boolean;
  collapsed: boolean;
  onSelect: () => void;
  onToggleCollapse: () => void;
  onNewCard: () => void;
  onRename: () => void;
  onConfigureScripts: () => void;
  onConfigureSetup: () => void;
  onRemove: () => Promise<void> | void;
  dragHandleProps?: DragHandleProps;
}) {
  return (
    <div
      className={cn(
        "group flex items-center gap-1 px-1.5 py-1 rounded-[4px] cursor-pointer",
        active
          ? "bg-bg-2 text-fg-0"
          : "text-fg-1 hover:bg-bg-hover hover:text-fg-0",
      )}
      onClick={onSelect}
    >
      {/* Drag handle — only visible on hover so it doesn't crowd the
          row when idle. Pointer-down begins the sortable drag thanks to
          its listeners; clicks fall through to the row's onClick. */}
      {dragHandleProps ? (
        <button
          type="button"
          {...dragHandleProps.attributes}
          {...dragHandleProps.listeners}
          onClick={(e) => e.stopPropagation()}
          title="Drag to reorder"
          className={cn(
            "w-3 h-4 grid place-items-center text-fg-3 shrink-0",
            "cursor-grab active:cursor-grabbing hover:text-fg-1",
          )}
        >
          <span className="text-[10px] leading-none">⋮⋮</span>
        </button>
      ) : null}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onToggleCollapse();
        }}
        className={cn(
          "w-4 h-4 grid place-items-center text-fg-3 shrink-0",
          "transition-transform duration-100",
          collapsed ? "" : "rotate-90",
        )}
        title={collapsed ? "Expand" : "Collapse"}
      >
        <span className="text-[8px]">▶</span>
      </button>
      <span className="text-[12px] flex-1 min-w-0 truncate font-medium">
        {label}
      </span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onNewCard();
        }}
        title="New card in this project"
        className="opacity-0 group-hover:opacity-100 w-4 h-4 grid place-items-center rounded text-fg-2 hover:bg-bg-hover hover:text-fg-0 text-[12px] leading-none shrink-0"
      >
        +
      </button>
      <KebabMenu
        items={[
          {
            label: "Configure setup",
            onClick: onConfigureSetup,
          },
          {
            label: "Configure actions",
            onClick: onConfigureScripts,
          },
          {
            label: "Rename project",
            onClick: onRename,
          },
          {
            label: "Remove",
            onClick: onRemove,
            danger: true,
          },
        ]}
      />
    </div>
  );
}

function RenameRow({
  initial,
  onSubmit,
  onCancel,
}: {
  initial: string;
  onSubmit: (name: string) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <div className="flex items-center gap-1 px-1.5 py-1 rounded-[4px] bg-bg-2">
      <div className="w-4 shrink-0" />
      <input
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void onSubmit(value);
          if (e.key === "Escape") onCancel();
        }}
        onBlur={() => onCancel()}
        className={cn(
          "flex-1 min-w-0 text-[12px] text-fg-0 font-medium",
          "bg-transparent border-0 outline-none p-0",
        )}
      />
    </div>
  );
}

function CardRow({
  card,
  selected,
  running,
  onClick,
}: {
  card: Card;
  selected: boolean;
  running: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-1.5 pl-6 pr-1.5 py-1 rounded-[4px] text-left",
        "transition-colors duration-100 min-w-0",
        selected
          ? "bg-bg-2 text-fg-0"
          : "text-fg-2 hover:bg-bg-hover hover:text-fg-1",
      )}
      title={card.title}
    >
      <StatusIcon columnId={card.columnId} running={running} />
      <span className="text-[11.5px] flex-1 min-w-0 truncate">
        {card.title}
      </span>
    </button>
  );
}

function StatusIcon({
  columnId,
  running,
}: {
  columnId: BoardColumnId;
  running: boolean;
}) {
  if (running) {
    return (
      <span className="w-3 h-3 shrink-0 grid place-items-center text-accent">
        <Spinner className="w-3 h-3" />
      </span>
    );
  }
  if (columnId === "review") {
    return (
      <span className="w-3 h-3 shrink-0 grid place-items-center text-yellow-500 [&_svg]:w-3 [&_svg]:h-3">
        {I.review}
      </span>
    );
  }
  if (columnId === "done") {
    return (
      <span className="w-3 h-3 shrink-0 grid place-items-center text-diff-add-mark [&_svg]:w-3 [&_svg]:h-3">
        {I.check}
      </span>
    );
  }
  if (columnId === "in_progress") {
    return (
      <span className="w-3 h-3 shrink-0 grid place-items-center">
        <span className="w-1.5 h-1.5 rounded-full bg-accent/70" />
      </span>
    );
  }
  const tone = columnId === "todo" ? "bg-fg-2" : "bg-fg-3";
  return (
    <span className="w-3 h-3 shrink-0 grid place-items-center">
      <span className={cn("w-1.5 h-1.5 rounded-full", tone)} />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Kebab menu (portal'd so it isn't clipped by sidebar's overflow-hidden)
// ---------------------------------------------------------------------------

type KebabItem = {
  label: string;
  onClick: () => void | Promise<void>;
  danger?: boolean;
};

function KebabMenu({ items }: { items: KebabItem[] }) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(
    null,
  );
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    if (triggerRef.current) {
      const r = triggerRef.current.getBoundingClientRect();
      setAnchor({ top: r.bottom + 4, left: r.left });
    }
    function onDocClick(e: MouseEvent) {
      const t = e.target as Node | null;
      const insideTrigger =
        triggerRef.current && t && triggerRef.current.contains(t);
      const insideMenu =
        menuRef.current && t && menuRef.current.contains(t);
      if (!insideTrigger && !insideMenu) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        title="More actions"
        className={cn(
          "opacity-0 group-hover:opacity-100 w-4 h-4 grid place-items-center",
          "rounded text-fg-2 hover:bg-bg-hover hover:text-fg-0 text-[14px] leading-none shrink-0",
          open && "opacity-100 bg-bg-hover text-fg-0",
        )}
      >
        ⋯
      </button>
      {open && anchor
        ? createPortal(
            <div
              ref={menuRef}
              style={{
                position: "fixed",
                top: anchor.top,
                left: anchor.left,
              }}
              className={cn(
                "z-[1000] bg-bg-1 border border-bd-1 rounded-[6px]",
                // `inline-flex flex-col` lets the dropdown size to the
                // widest child's intrinsic width — `w-max` on its own
                // fights with `w-full` items (the children's stretched
                // width has no fixed reference until the parent is
                // sized, so browsers resolve it loosely and the menu
                // ends up much wider than the longest label).
                "shadow-[0_12px_32px_rgba(0,0,0,0.5)] py-1 inline-flex flex-col",
              )}
            >
              {items.map((item, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={async (e) => {
                    e.stopPropagation();
                    setOpen(false);
                    await item.onClick();
                  }}
                  className={cn(
                    "w-full text-left px-2.5 py-1 text-[11.5px] whitespace-nowrap",
                    item.danger
                      ? // Default red so the user always reads it as
                        // destructive at a glance; hover bumps to a
                        // brighter red + soft red bg for affirmation.
                        "text-diff-del-mark hover:text-[color:color-mix(in_oklab,var(--diff-del-mark)_70%,white)] hover:bg-[color-mix(in_oklab,var(--diff-del-mark)_12%,transparent)]"
                      : "text-fg-1 hover:bg-bg-hover hover:text-fg-0",
                  )}
                >
                  {item.label}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Sortable plumbing
// ---------------------------------------------------------------------------

function ProjectsList({
  ids,
  onReorder,
  renderDraggingPreview,
  children,
}: {
  ids: string[];
  onReorder: (ids: string[]) => void;
  /** Snapshot rendered inside `<DragOverlay>` for the active drag. The
   * source row in the list is hidden while dragging so the overlay is
   * the only visible representation — keeps text crisp instead of the
   * subpixel-blurry result of transforming the source in place. */
  renderDraggingPreview: (id: string) => React.ReactNode;
  children: React.ReactNode;
}) {
  // 4px activation distance lets the row's click/select fire normally;
  // anything past that becomes a drag. Same pattern as the board view.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(String(event.active.id));
  };
  const handleDragEnd = (event: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIdx = ids.indexOf(String(active.id));
    const newIdx = ids.indexOf(String(over.id));
    if (oldIdx < 0 || newIdx < 0) return;
    const next = [...ids];
    const [moved] = next.splice(oldIdx, 1);
    next.splice(newIdx, 0, moved);
    onReorder(next);
  };
  const handleDragCancel = () => setActiveId(null);
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {children}
      </SortableContext>
      {/* Portal to body — the sidebar has `overflow-hidden` which would
          clip a position:fixed overlay measured against this container. */}
      {createPortal(
        <DragOverlay dropAnimation={null}>
          {activeId ? renderDraggingPreview(activeId) : null}
        </DragOverlay>,
        document.body,
      )}
    </DndContext>
  );
}

function SortableProjectGroup({
  id,
  children,
}: {
  id: string;
  children: (handle: DragHandleProps) => React.ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });
  const style: React.CSSProperties = {
    // Source row holds its layout slot but goes invisible — the
    // DragOverlay carries the visible representation. Applying the
    // sortable transform here would stretch / blur the text on the
    // active row, which is what the user saw.
    transform: isDragging ? undefined : CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0 : 1,
  };
  return (
    <div ref={setNodeRef} style={style} className="flex flex-col gap-px">
      {children({
        attributes: attributes as unknown as Record<string, unknown>,
        listeners: listeners as unknown as Record<string, unknown> | undefined,
      })}
    </div>
  );
}

/** Floating snapshot rendered into the DragOverlay. Intentionally a
 * pill (not the full sidebar row) so it reads like "you picked up
 * <project>" without trying to match the row's hover affordances. */
function DraggingProjectPreview({ name }: { name: string }) {
  return (
    <div
      className={cn(
        "inline-flex items-center gap-1.5 px-2 py-1 rounded-[6px]",
        "bg-bg-1 border border-bd-1 text-[12px] font-medium text-fg-0",
        "shadow-[0_12px_32px_rgba(0,0,0,0.5)]",
        "pointer-events-none",
      )}
    >
      <span className="text-fg-3 [&_svg]:w-3 [&_svg]:h-3">{I.folder}</span>
      <span className="truncate max-w-[200px]">{name}</span>
    </div>
  );
}
