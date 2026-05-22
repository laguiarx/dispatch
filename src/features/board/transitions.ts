import type { BoardColumnId } from "./board.types";

/**
 * Manual drag-and-drop transitions allowed on the board. Every other
 * column transition happens via automation: agent spawn moves To Do →
 * In Progress, agent clean-exit moves it to Review, Approve → PR moves
 * it to Done. Letting the user drag past those gates would skip the
 * side effects (no worktree, no agent run, no PR).
 *
 * `in_progress` is normally a dead-end: while the agent is live,
 * dragging it elsewhere would orphan the process. But if the live
 * subscription is gone (crashed agent, force-quit) we DO want a manual
 * escape — `canManuallyMove` checks the `isRunning` flag so callers
 * can pass `false` to unlock the column. See `onDragEnd` in
 * board-view.tsx for the live check.
 */
const ALLOWED: Record<BoardColumnId, BoardColumnId[]> = {
  backlog: ["backlog", "todo"],
  todo: ["backlog", "todo"],
  in_progress: ["in_progress"],
  // Review is the inspection lane: the user can Approve → PR (Done),
  // send back to To Do for another run in the same worktree, or drop
  // to Backlog if the work is being abandoned.
  review: ["review", "todo", "backlog"],
  done: ["done"],
};

/** Extra escapes when the card looks `in_progress` in the DB but has
 *  no live agent attached — recovery from a crash. The user can pull
 *  the card back to To Do (queue picks it up again) or Backlog (kill
 *  the lane entirely). Review isn't offered: there's no clean exit to
 *  show, and Approve would commit garbage. */
const STUCK_IN_PROGRESS_ALLOWED: BoardColumnId[] = ["todo", "backlog"];

export function canManuallyMove(
  from: BoardColumnId,
  to: BoardColumnId,
  options?: { isRunning?: boolean },
): boolean {
  if (
    from === "in_progress" &&
    !options?.isRunning &&
    STUCK_IN_PROGRESS_ALLOWED.includes(to)
  ) {
    return true;
  }
  return ALLOWED[from]?.includes(to) ?? false;
}
