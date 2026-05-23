import { useState } from "react";
import { createPortal } from "react-dom";
import {
  DndContext,
  DragOverlay,
  pointerWithin,
  rectIntersection,
  PointerSensor,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useBoardStore } from "@/features/board/board.store";
import { useRepoStore } from "@/features/repository/repository.store";
import {
  BOARD_COLUMNS,
  type BoardColumnId,
} from "@/features/board/board.types";
import { canManuallyMove } from "@/features/board/transitions";
import { BoardColumn } from "./board-column";
import { CardTileGhost } from "./card-tile";
import { NewCardDialog } from "./new-card-dialog";
import { CardDetailModal } from "./card-detail-modal";

export function BoardView() {
  const activeProjectId = useBoardStore((s) => s.activeProjectId);
  const projectsById = useBoardStore((s) => s.projectsById);
  const projects = useBoardStore((s) => s.projects);
  const cards = useBoardStore((s) => s.cards);
  const moveCardTo = useBoardStore((s) => s.moveCardTo);
  const selectedCardId = useBoardStore((s) => s.selectedCardId);
  const newCardOpen = useBoardStore((s) => s.newCardOpen);
  const setNewCardOpen = useBoardStore((s) => s.setNewCardOpen);
  const setDraggingCardId = useBoardStore((s) => s.setDraggingCardId);
  const enterReviewMode = useRepoStore((s) => s.enterReviewMode);

  const activeProject = activeProjectId
    ? projectsById[activeProjectId] ?? null
    : null;

  const sensors = useSensors(
    // 4px activation distance — a real drag, not an accidental click on the
    // card body.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  // Track the active drag locally (so the `<DragOverlay>` ghost knows
  // which card to render) and mirror the id to the board store so
  // `BoardColumn` can disable its droppable when the transition would be
  // illegal. Width comes from the source's measured rect so the overlay
  // matches the column-sized card exactly (otherwise the ghost reflows
  // to its intrinsic content width and the cursor drifts away).
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [activeDragWidth, setActiveDragWidth] = useState<number | null>(null);
  const activeDragCard = activeDragId ? cards[activeDragId] ?? null : null;

  const onDragStart = (event: DragStartEvent) => {
    const id = String(event.active.id);
    setActiveDragId(id);
    setDraggingCardId(id);
    const rect = event.active.rect.current.initial;
    setActiveDragWidth(rect ? rect.width : null);
  };

  const onDragEnd = (event: DragEndEvent) => {
    setActiveDragId(null);
    setActiveDragWidth(null);
    setDraggingCardId(null);
    const { active, over } = event;
    if (!over) return;
    const cardId = String(active.id);
    const card = cards[cardId];
    if (!card) return;

    let column: BoardColumnId | null = null;
    const overId = String(over.id);
    if (overId.startsWith("col:")) {
      column = overId.slice(4) as BoardColumnId;
    } else {
      const target = cards[overId];
      if (target) column = target.columnId;
    }
    if (!column) return;
    // Same-column drop on the source card itself = no-op (a click).
    if (column === card.columnId && overId === cardId) return;
    // Block manual transitions outside the legal pairs — automation
    // (agent spawn, agent exit, approve→PR) handles the rest.
    // `isRunning` unlocks the in_progress → todo/backlog escape for
    // cards that lost their live agent (crash / force-quit).
    const isRunning = useBoardStore.getState().runningCardIds.has(card.id);
    if (!canManuallyMove(card.columnId, column, { isRunning })) return;
    void moveCardTo(card.id, column);
  };

  const onDragCancel = () => {
    setActiveDragId(null);
    setActiveDragWidth(null);
    setDraggingCardId(null);
  };

  // Hybrid collision: `pointerWithin` is the most accurate signal when the
  // pointer is actually inside a droppable (covers empty columns where
  // closest-corners would latch onto the source column's only card).
  // Fall back to `rectIntersection` when the pointer hovers in the gap
  // between columns mid-drag so the drop target never goes null.
  const collisionDetection: CollisionDetection = (args) => {
    const pointer = pointerWithin(args);
    if (pointer.length > 0) return pointer;
    return rectIntersection(args);
  };

  // Two top-level renders share the same parent: the board (columns) and
  // the card detail view. When a card is selected we swap the board out
  // — sidebar stays mounted because it lives in the parent layout, not
  // here. This is in-app navigation, not a modal overlay.
  if (selectedCardId) {
    return (
      <>
        <CardDetailModal
          onOpenReview={async (worktreePath) => {
            // Keep the card selected so the view pops back open when
            // the user clicks "← Back to board" — they shouldn't have
            // to re-find the card after reviewing its diff.
            await enterReviewMode(selectedCardId, worktreePath);
          }}
          onApprove={async () => {
            const store = useBoardStore.getState();
            const repoStore = useRepoStore.getState();
            try {
              const url = await store.approveCard(selectedCardId);
              repoStore.pushToast(`PR opened: ${url}`);
              store.selectCard(null);
            } catch (err) {
              repoStore.pushToast(
                err instanceof Error ? err.message : String(err),
                "danger",
              );
            }
          }}
        />
        {/* New card dialog still reachable via ⌘N from inside a card
            detail view (the shortcut is global). Render it here too so
            the user doesn't have to back-out to create a card. */}
        <NewCardDialog
          open={newCardOpen}
          onClose={() => setNewCardOpen(false)}
        />
      </>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      {/* Matches the sidebar's Workspace header (h-10) so the two
          chrome bars sit on the same baseline — they were 4px off
          before because `py-2` + a smaller inner button collapsed the
          sidebar to ~36px while this one was ~40px. */}
      <div className="flex items-center justify-between px-3 h-10 border-b border-bd-2 shrink-0">
        <div className="text-[12px] font-medium text-fg-1">
          {activeProject ? activeProject.name : "All projects"}
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="unstyled"
            size="xs"
            disabled={projects.length === 0}
            title={
              projects.length === 0
                ? "Add a project from the sidebar first"
                : activeProject
                  ? "Create a card in this project"
                  : "Create a card — you'll pick the project"
            }
            onClick={() => setNewCardOpen(true)}
            className={cn(
              "inline-flex items-center gap-1.5 h-6 px-2.5 rounded-[4px] text-[11px] font-medium",
              projects.length > 0
                ? "!bg-accent !bg-none text-accent-fg border-0 cursor-pointer hover:!bg-accent hover:!bg-none"
                : "bg-bg-2 text-fg-2 cursor-not-allowed",
            )}
          >
            + New card
          </Button>
        </div>
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
      >
        <div
          className={cn(
            "flex-1 min-h-0 overflow-x-auto overflow-y-hidden p-3",
            "flex items-stretch gap-3",
          )}
        >
          {BOARD_COLUMNS.map((col) => (
            <BoardColumn key={col} columnId={col} />
          ))}
        </div>
        {/* Portal the overlay to body. The main column applies
            `backdrop-filter`, which (per spec) creates a containing
            block for `position: fixed` descendants — that broke
            DragOverlay's viewport-relative positioning and was the root
            cause of the persistent drag-offset bug. Rendering outside
            the filtered subtree fixes the math. */}
        {createPortal(
          <DragOverlay
            dropAnimation={null}
            style={activeDragWidth ? { width: activeDragWidth } : undefined}
          >
            {activeDragCard ? <CardTileGhost card={activeDragCard} /> : null}
          </DragOverlay>,
          document.body,
        )}
      </DndContext>

      <NewCardDialog open={newCardOpen} onClose={() => setNewCardOpen(false)} />
    </div>
  );
}
