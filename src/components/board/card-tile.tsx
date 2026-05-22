import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import { cn } from "@/lib/utils";
import { Spinner } from "@/components/spinner";
import { useBoardStore } from "@/features/board/board.store";
import type { Card, BoardColumnId } from "@/features/board/board.types";

type Props = {
  card: Card;
  onClick: () => void;
};

/**
 * Only cards living in Backlog or To Do are manually draggable. The rest
 * advance through Review and Done via agent / Approve automation, so
 * letting the user pick them up would suggest a manual move that the
 * drag-end gate would silently reject anyway.
 */
// Columns where the user can pick up a card and drag it elsewhere.
// Review is included so a card with aborted / unwanted output can be
// sent back to To Do (retry) or Backlog (abandon). In Progress is
// added dynamically when the card has no live agent (crash recovery).
const DRAGGABLE_COLUMNS = new Set<BoardColumnId>(["backlog", "todo", "review"]);

/**
 * Sortable card tile rendered inside a column. The visual is shared with
 * `CardTileGhost` (used by `DragOverlay`) — keeping them separate avoids
 * stacking two `useSortable` transforms on the dragged card, which
 * otherwise shifted the overlay several pixels away from the cursor.
 */
export function CardTile({ card, onClick }: Props) {
  // Track running so an `in_progress` card whose agent died can be
  // dragged out (recovery from crash). Live-running cards stay locked
  // — dragging them would orphan the process.
  const isRunning = useBoardStore((s) => s.runningCardIds.has(card.id));
  const draggable =
    DRAGGABLE_COLUMNS.has(card.columnId) ||
    (card.columnId === "in_progress" && !isRunning);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: card.id, disabled: !draggable });

  const style: React.CSSProperties = {
    // While `isDragging` we let `<DragOverlay>` render the floating ghost
    // and keep the source visually static — applying useSortable's
    // transform here would shift the source AND offset dnd-kit's overlay
    // measurement, making the ghost float several pixels off the cursor.
    transform: isDragging ? undefined : CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <CardTileVisual card={card} interactive draggable={draggable} />
    </div>
  );
}

/**
 * Render-only version used by `<DragOverlay>`. No dnd-kit hooks here so
 * the cursor offset matches exactly what the overlay positions.
 */
export function CardTileGhost({ card }: { card: Card }) {
  return (
    <div className="pointer-events-none">
      <CardTileVisual card={card} interactive={false} draggable={false} />
    </div>
  );
}

function CardTileVisual({
  card,
  interactive,
  draggable,
}: {
  card: Card;
  interactive: boolean;
  draggable: boolean;
}) {
  const running = useBoardStore((s) => s.runningCardIds.has(card.id));
  const approving = useBoardStore((s) => s.approvingCardIds.has(card.id));
  const setupFailed = useBoardStore((s) => s.setupFailedCardIds.has(card.id));
  // Cards in `in_progress` are by definition "agent is working" —
  // surface the spinner even during the tiny window between the exit
  // event (which clears runningCardIds) and the auto-move to Review.
  // Stuck cards without a live agent (orphaned on crash) still show the
  // spinner; the drag escape from in_progress → todo/backlog covers
  // that recovery case.
  const inProgress = card.columnId === "in_progress";
  const busy = running || approving || inProgress;
  // Always show the project name (even when filtered to one project) —
  // it doubles as the "what is this card?" anchor at a glance and lets
  // the All-projects view + single-project view use the same chip layout.
  const projectChip = useBoardStore(
    (s) => s.projectsById[card.projectId]?.name ?? null,
  );

  return (
    <div
      className={cn(
        "group relative rounded-[6px] border border-bd-2 bg-bg-1 p-2.5",
        interactive
          ? draggable
            ? "cursor-grab hover:border-bd-1 hover:bg-bg-2 transition-colors"
            : "cursor-pointer hover:border-bd-1 hover:bg-bg-2 transition-colors"
          : "shadow-[0_12px_32px_rgba(0,0,0,0.5)]",
        busy && "border-accent/40",
        // Setup failed → red border + soft red bg so the user can spot
        // the stuck card in a busy To Do column.
        setupFailed &&
          "border-diff-del-mark/50 bg-[color-mix(in_oklab,var(--diff-del-mark)_5%,transparent)]",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="text-[12px] font-medium text-fg-0 leading-snug min-w-0">
          {card.taskNumber ? (
            <span className="font-mono text-fg-3 mr-1.5">
              T{card.taskNumber}
            </span>
          ) : null}
          {card.title}
        </div>
        {busy ? (
          <Spinner className="w-3 h-3 shrink-0 mt-0.5" />
        ) : setupFailed ? (
          <span
            className="text-[9.5px] font-mono text-diff-del-mark shrink-0 mt-0.5"
            title="Setup script failed — check the Setup tab in the terminal. Drag the card to Backlog to clear."
          >
            setup ✗
          </span>
        ) : null}
      </div>
      {card.description ? (
        <div className="text-[11px] text-fg-2 mt-1 line-clamp-2">
          {card.description}
        </div>
      ) : null}
      <div className="flex items-center gap-1.5 mt-2 text-[10.5px] font-mono text-fg-2 flex-wrap">
        {projectChip ? (
          <span className="px-1.5 py-px rounded-[3px] bg-bg-2 border border-bd-2 truncate max-w-[120px]">
            {projectChip}
          </span>
        ) : null}
        <span className="px-1.5 py-px rounded-[3px] bg-bg-2 border border-bd-2">
          {card.agent}
        </span>
        <span
          className={cn(
            "px-1.5 py-px rounded-[3px] border border-bd-2 bg-bg-2",
            "inline-flex items-center gap-1 text-fg-2",
          )}
          title={`Priority: ${card.priority}`}
        >
          {/* Border/text colors are uniform across priorities — only the
              leading dot tints (gray / blue / red) so the chip itself
              doesn't shout for attention on every card. */}
          <span
            className={cn(
              "text-[8px] leading-none",
              card.priority === "high"
                ? "text-diff-del-mark"
                : card.priority === "med"
                  ? "text-accent"
                  : "text-fg-3",
            )}
          >
            {card.priority === "high"
              ? "●●●"
              : card.priority === "med"
                ? "●●"
                : "●"}
          </span>
          {card.priority}
        </span>
        {card.branchName ? (
          <span className="truncate">{card.branchName}</span>
        ) : null}
        {card.prUrl ? <span className="text-accent">PR ↗</span> : null}
      </div>
    </div>
  );
}
