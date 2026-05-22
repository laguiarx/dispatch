/**
 * Type mirrors of the Rust models in `src-tauri/src/db/models.rs` and the
 * payloads emitted by `commands/agent.rs`. Tauri's serde wraps these in
 * `camelCase` thanks to `#[serde(rename_all = "camelCase")]`, so the field
 * names here are the ones the wire actually uses.
 */

export const BOARD_COLUMNS = [
  "backlog",
  "todo",
  "in_progress",
  "review",
  "done",
] as const;

export type BoardColumnId = (typeof BOARD_COLUMNS)[number];

export type AgentId = "claude" | "codex";

export type Priority = "low" | "med" | "high";

export const PRIORITIES: Priority[] = ["low", "med", "high"];

export type Project = {
  id: string;
  repoPath: string;
  name: string;
  defaultBase: string | null;
  createdAt: number;
  pinnedAt: number | null;
  position: number | null;
  /** Bash that runs on worktree creation, before the agent spawns. NULL
   *  / empty means we still copy the bootstrap `.env*` files, but don't
   *  run anything else. */
  setupScript: string | null;
};

export type Card = {
  id: string;
  projectId: string;
  title: string;
  description: string;
  columnId: BoardColumnId;
  position: number;
  agent: AgentId;
  priority: Priority;
  branchName: string | null;
  worktreePath: string | null;
  baseBranch: string | null;
  prUrl: string | null;
  createdAt: number;
  updatedAt: number;
  /** Per-project 1-based sequence used everywhere humans read about the
   *  card (branch name, PR body, the chip on the tile). Optional only
   *  to tolerate decoding pre-v8 rows on first boot. */
  taskNumber: number | null;
  /** CLI-specific model id (`sonnet`, `gpt-5-codex`, …). null = use
   *  the CLI default. Editable until the card leaves Backlog. */
  model: string | null;
  /** Reasoning effort — currently mapped to `codex -c
   *  model_reasoning_effort=<value>`. null = CLI default. */
  reasoning: string | null;
  /** Speed-over-depth hint. For codex this overrides reasoning to
   *  `minimal`; for claude it's stored but not yet flag-mapped. */
  fastMode: boolean;
};

export type ReasoningLevel = "low" | "medium" | "high" | "extra-high";

export const REASONING_LEVELS: ReasoningLevel[] = [
  "low",
  "medium",
  "high",
  "extra-high",
];

export type CardPatch = Partial<
  Pick<
    Card,
    | "title"
    | "description"
    | "agent"
    | "priority"
    | "branchName"
    | "worktreePath"
    | "baseBranch"
    | "prUrl"
    | "model"
    | "reasoning"
    | "fastMode"
  >
>;

export type RunStatus = "running" | "succeeded" | "failed" | "aborted";

export type Run = {
  id: string;
  cardId: string;
  prompt: string;
  agent: AgentId;
  status: RunStatus;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
};

export type LogStream = "stdout" | "stderr" | "meta";

export type ProjectScript = {
  id: string;
  projectId: string;
  title: string;
  command: string;
  icon: string;
  position: number;
  createdAt: number;
};

export type Attachment = {
  id: string;
  cardId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  storedPath: string;
  createdAt: number;
};

export type RunLog = {
  id: number;
  runId: string;
  ts: number;
  stream: LogStream;
  line: string;
};

/** Payload of `agent://card/<id>/log` events. */
export type AgentLogEvent = {
  runId: string;
  stream: LogStream;
  line: string;
  ts: number;
};

export type AgentExitReason = "clean" | "killed" | "idle_timeout" | "error";

/** Payload of `agent://card/<id>/exit` events. */
export type AgentExitEvent = {
  runId: string;
  code: number | null;
  hadChanges: boolean;
  reason: AgentExitReason;
};

export type AgentStatus = {
  running: boolean;
  runId: string | null;
};
