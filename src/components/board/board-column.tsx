import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useDroppable } from "@dnd-kit/core";

import { cn } from "@/lib/utils";
import { useBoardStore } from "@/features/board/board.store";
import type { BoardColumnId } from "@/features/board/board.types";
import { canManuallyMove } from "@/features/board/transitions";
import { CardTile } from "./card-tile";

const TITLES: Record<BoardColumnId, string> = {
  backlog: "Backlog",
  todo: "To Do",
  in_progress: "In Progress",
  review: "Review",
  done: "Done",
};

/**
 * Per-column accent strip. Pulls from the existing theme vars so the
 * board respects whichever Preferences > Appearance preset the user
 * picked — no hard-coded hexes. The strip lives in the column header
 * (4px on the left) so the columns read as distinct workflow stages
 * without the rest of the chrome shouting for attention.
 */
const ACCENT_BY_COLUMN: Record<BoardColumnId, string> = {
  backlog: "bg-fg-3",
  todo: "bg-accent-hi",
  in_progress: "bg-accent",
  review: "bg-git-mod",
  done: "bg-diff-add-mark",
};

/**
 * Idle-state empty messages — what appears when nothing is being
 * dragged and the column has no cards. Each is tailored to the column's
 * meaning so the user gets a sense of what *would* live there. The
 * generic "Drop here" we used to render gave zero information and
 * showed up in 5 places at once, which made the board look unfinished.
 */
const EMPTY_BY_COLUMN: Record<BoardColumnId, { title: string; hint: string }> = {
  backlog: {
    title: "Park ideas here",
    hint: "Capture work without committing to do it yet.",
  },
  todo: {
    title: "Queue is clear",
    hint: "Drag a card from Backlog when you're ready to start.",
  },
  in_progress: {
    title: "No agents working",
    hint: "Cards land here automatically when an agent picks them up.",
  },
  review: {
    title: "Nothing to review",
    hint: "Finished runs (good or bad) show up here for your call.",
  },
  done: {
    title: "Ship something",
    hint: "Approved cards open a PR and rest here.",
  },
};

type Props = {
  columnId: BoardColumnId;
};

export function BoardColumn({ columnId }: Props) {
  const cardIds = useBoardStore((s) => s.cardIdsByColumn[columnId]);
  const cards = useBoardStore((s) => s.cards);
  const selectCard = useBoardStore((s) => s.selectCard);

  // The drop is only legal when there's no active drag, or when the
  // active drag's source column can legally transition into this column.
  // We pass that to useDroppable as `disabled`, which suppresses both
  // dnd-kit's hover detection AND the onDragEnd target — so the user
  // gets honest visual feedback that they can't drop here.
  const draggingCardId = useBoardStore((s) => s.draggingCardId);
  const sourceCard = draggingCardId ? cards[draggingCardId] : null;
  // `isRunning` unlocks the in_progress → todo/backlog escape for cards
  // that lost their live agent (crash / force-quit). Without this the
  // column stays `disabled` and the drop indicator never lights up.
  const sourceIsRunning = useBoardStore((s) =>
    draggingCardId ? s.runningCardIds.has(draggingCardId) : false,
  );
  const dropAllowed = sourceCard
    ? canManuallyMove(sourceCard.columnId, columnId, {
        isRunning: sourceIsRunning,
      })
    : true;

  const { setNodeRef, isOver } = useDroppable({
    id: `col:${columnId}`,
    disabled: !dropAllowed,
  });

  const isDragging = draggingCardId !== null;
  const empty = EMPTY_BY_COLUMN[columnId];

  return (
    <div
      ref={setNodeRef}
      className={cn(
        // flex-1 + min-w lets columns share the viewport evenly while
        // still scrolling horizontally on narrow windows.
        "flex flex-col flex-1 min-w-[252px] bg-transparent",
        "border-r border-bd-1 last:border-r-0 transition-colors",
        // Drop affordance: light up when the active drag is allowed
        // here, dim when not. Previously we only highlighted `isOver`,
        // which left disallowed columns looking identical to legal ones
        // until the user actually hovered them.
        isDragging && dropAllowed && "bg-bg-1/45",
        isDragging && !dropAllowed && "opacity-50",
        isOver && dropAllowed && "bg-bg-1",
      )}
    >
      <div className="flex items-center gap-2 px-3 h-11 border-b border-bd-1/70 shrink-0">
        {/* Small accent dot — pulls identity from the existing theme
            vars (see ACCENT_BY_COLUMN above). Distinct enough that the
            user can scan the 5 columns at a glance without us
            committing to per-column backgrounds, which felt loud. */}
        <span
          className={cn(
            "w-1.5 h-1.5 rounded-full shrink-0",
            ACCENT_BY_COLUMN[columnId],
          )}
        />
        <span className="text-[11px] font-semibold text-fg-1 uppercase tracking-[0.08em] flex-1 min-w-0 truncate">
          {TITLES[columnId]}
        </span>
        <span
          className={cn(
            "min-w-5 h-5 inline-flex items-center justify-center",
            "text-[10px] font-mono rounded-[5px]",
            cardIds.length > 0
              ? "bg-bg-3 border border-bd-2 text-fg-1"
              : "text-fg-3",
          )}
        >
          {cardIds.length}
        </span>
      </div>
      <SortableContext items={cardIds} strategy={verticalListSortingStrategy}>
        {/* flex-1 so the droppable area fills the whole column body —
            without it, dropping into an empty column required hitting the
            ~60px placeholder strip near the top, which made the board
            feel finicky. */}
        <div className="flex flex-col gap-2 p-3 overflow-y-auto flex-1 min-h-[60px]">
          {cardIds.map((id) => {
            const card = cards[id];
            if (!card) return null;
            return (
              <CardTile
                key={id}
                card={card}
                onClick={() => selectCard(id)}
              />
            );
          })}
          {cardIds.length === 0 ? (
            <EmptyColumn
              title={empty.title}
              hint={empty.hint}
              dragging={isDragging}
              dropAllowed={dropAllowed}
            />
          ) : null}
        </div>
      </SortableContext>
    </div>
  );
}

/**
 * Idle / drag empty state. Three modes:
 *   1. Idle (nothing dragging): two-line contextual message — what
 *      this column is for and how cards get here.
 *   2. Drag-allowed: bordered drop zone with "Drop to add" prompt.
 *   3. Drag-disallowed: faded message explaining the column won't
 *      accept this card right now.
 */
function EmptyColumn({
  title,
  hint,
  dragging,
  dropAllowed,
}: {
  title: string;
  hint: string;
  dragging: boolean;
  dropAllowed: boolean;
}) {
  if (dragging && dropAllowed) {
    return (
      <div
        className={cn(
          "mt-0.5 flex-1 min-h-[96px] rounded-[7px] border border-dashed",
          "border-accent/60 bg-accent/[0.04]",
          "grid place-items-center select-none",
          "text-[11px] text-accent font-medium",
        )}
      >
        Drop to add
      </div>
    );
  }
  if (dragging && !dropAllowed) {
    return (
      <div
        className={cn(
          "mt-0.5 flex-1 min-h-[96px] rounded-[7px] border border-dashed",
          "border-bd-2",
          "grid place-items-center select-none px-3 text-center",
          "text-[10.5px] text-fg-3 leading-snug",
        )}
      >
        Can't drop here
      </div>
    );
  }
  return (
    <div
      className={cn(
        "mt-1 min-h-[88px] px-3 py-3 flex flex-col justify-center gap-1 select-none",
        "text-fg-3",
      )}
    >
      <span className="text-[11px] font-semibold text-fg-2">{title}</span>
      <span className="text-[10.5px] leading-snug max-w-[220px]">{hint}</span>
    </div>
  );
}
