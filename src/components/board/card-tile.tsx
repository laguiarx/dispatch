import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";

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

const CARD_ACCENT_BY_COLUMN: Record<BoardColumnId, string> = {
  backlog: "bg-fg-3",
  todo: "bg-accent-hi",
  in_progress: "bg-accent",
  review: "bg-git-mod",
  done: "bg-diff-add-mark",
};

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
  const priorityLabel =
    card.priority === "high" ? "High" : card.priority === "med" ? "Med" : "Low";
  const priorityClass =
    card.priority === "high"
      ? "text-diff-del-mark border-diff-del-mark/30 bg-[color-mix(in_oklab,var(--diff-del-mark)_8%,transparent)]"
      : card.priority === "med"
        ? "text-accent-hi border-accent/30 bg-accent-softer"
        : "text-fg-2 border-bd-2 bg-bg-2";

  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-[8px] border border-bd-2 bg-bg-1 p-3",
        "shadow-[0_1px_0_rgba(255,255,255,0.025)]",
        interactive
          ? draggable
            ? "cursor-grab hover:border-bd-3 hover:bg-bg-2 transition-[background,border-color,box-shadow,transform] hover:shadow-[0_8px_26px_rgba(0,0,0,0.18)]"
            : "cursor-pointer hover:border-bd-3 hover:bg-bg-2 transition-[background,border-color,box-shadow,transform] hover:shadow-[0_8px_26px_rgba(0,0,0,0.18)]"
          : "shadow-[0_12px_32px_rgba(0,0,0,0.5)]",
        busy && "border-accent/40 bg-[color-mix(in_oklab,var(--accent)_6%,var(--bg-1))]",
        // Setup failed → red border + soft red bg so the user can spot
        // the stuck card in a busy To Do column.
        setupFailed &&
          "border-diff-del-mark/50 bg-[color-mix(in_oklab,var(--diff-del-mark)_5%,transparent)]",
      )}
    >
      <div
        className={cn(
          "absolute inset-x-0 top-0 h-px opacity-80",
          CARD_ACCENT_BY_COLUMN[card.columnId],
        )}
      />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          {card.taskNumber ? (
            <span
              className={cn(
                "inline-flex items-center h-4 px-1.5 rounded-[4px] mr-1.5 align-[1px]",
                "font-mono text-[9.5px] text-fg-2 bg-bg-2 border border-bd-2",
              )}
            >
              T{card.taskNumber}
            </span>
          ) : null}
          <span className="text-[12.5px] font-semibold text-fg-0 leading-snug">
            {card.title}
          </span>
        </div>
        {busy ? (
          <div className="h-5 w-5 grid place-items-center rounded-[5px] bg-accent-softer border border-accent/25 shrink-0">
            <Spinner className="w-3 h-3" />
          </div>
        ) : setupFailed ? (
          <span
            className="text-[9.5px] font-mono text-diff-del-mark shrink-0 mt-0.5 rounded-[4px] border border-diff-del-mark/30 px-1.5 py-0.5"
            title="Setup script failed — check the Setup tab in the terminal. Drag the card to Backlog to clear."
          >
            setup ✗
          </span>
        ) : null}
      </div>
      {card.description ? (
        <div className="text-[11px] text-fg-2 mt-2 leading-[1.35] line-clamp-3">
          {card.description}
        </div>
      ) : null}
      <div className="flex items-center gap-1.5 mt-3 text-[10px] font-mono text-fg-2 flex-wrap">
        {projectChip ? (
          <span className="h-5 inline-flex items-center px-1.5 rounded-[4px] bg-bg-2 border border-bd-2 truncate max-w-[128px]">
            {projectChip}
          </span>
        ) : null}
        <span className="h-5 inline-flex items-center px-1.5 rounded-[4px] bg-bg-2 border border-bd-2">
          {card.agent}
        </span>
        <span
          className={cn(
            "h-5 px-1.5 rounded-[4px] border",
            "inline-flex items-center gap-1",
            priorityClass,
          )}
          title={`Priority: ${card.priority}`}
        >
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
          {priorityLabel}
        </span>
        {card.branchName ? (
          <span className="h-5 inline-flex items-center px-1.5 rounded-[4px] bg-bg-0/60 border border-bd-1 truncate max-w-full">
            {card.branchName}
          </span>
        ) : null}
        {card.prUrl ? (
          card.columnId === "done" ? (
            <Button variant="unstyled"
              type="button"
              className="h-5 inline-flex items-center px-1.5 rounded-[4px] text-accent bg-accent-softer border border-accent/25 hover:bg-accent-soft"
              title="Open PR in browser"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                const url = card.prUrl;
                if (url) void openUrl(url).catch(() => undefined);
              }}
            >
              Open PR ↗
            </Button>
          ) : (
            <span className="h-5 inline-flex items-center px-1.5 rounded-[4px] text-accent bg-accent-softer border border-accent/25">
              PR ↗
            </span>
          )
        ) : null}
      </div>
    </div>
  );
}
