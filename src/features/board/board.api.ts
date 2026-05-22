/**
 * Typed wrappers over the Rust `board_*` / `agent_*` / `git_worktree_*`
 * Tauri commands plus listener helpers for the two streaming events
 * emitted by `commands/agent.rs`.
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { invoke } from "@/lib/tauri";
import type {
  AgentExitEvent,
  AgentId,
  AgentLogEvent,
  AgentStatus,
  Attachment,
  BoardColumnId,
  Card,
  CardPatch,
  Priority,
  Project,
  ProjectScript,
  Run,
  RunLog,
} from "./board.types";

// ---------- projects ----------

export async function listProjects(): Promise<Project[]> {
  return invoke<Project[]>("board_list_projects");
}

export async function ensureProject(
  repoPath: string,
  name: string,
  defaultBase: string | null,
): Promise<Project> {
  return invoke<Project>("board_ensure_project", {
    repoPath,
    name,
    defaultBase,
  });
}

export async function updateProject(
  id: string,
  patch: { name?: string; setupScript?: string },
): Promise<Project> {
  return invoke<Project>("board_update_project", {
    id,
    name: patch.name ?? null,
    pinned: null,
    setupScript: patch.setupScript ?? null,
  });
}

export async function reorderProjects(ids: string[]): Promise<void> {
  await invoke<void>("board_reorder_projects", { ids });
}

// ---------- cards ----------

export async function listCards(projectId: string): Promise<Card[]> {
  return invoke<Card[]>("board_list_cards", { projectId });
}

export async function listAllCards(): Promise<Card[]> {
  return invoke<Card[]>("board_list_all_cards");
}

export async function createCard(
  projectId: string,
  title: string,
  description: string,
  agent: AgentId,
  priority: Priority | null,
  branchName: string | null,
  baseBranch: string | null,
  runConfig?: {
    model?: string | null;
    reasoning?: string | null;
    fastMode?: boolean;
  },
): Promise<Card> {
  return invoke<Card>("board_create_card", {
    projectId,
    title,
    description,
    agent,
    priority,
    branchName,
    baseBranch,
    model: runConfig?.model ?? null,
    reasoning: runConfig?.reasoning ?? null,
    fastMode: runConfig?.fastMode ?? false,
  });
}

export async function updateCard(id: string, patch: CardPatch): Promise<Card> {
  return invoke<Card>("board_update_card", { id, patch });
}

export async function moveCard(
  id: string,
  columnId: BoardColumnId,
  position?: number,
): Promise<Card> {
  return invoke<Card>("board_move_card", {
    args: { id, columnId, position: position ?? null },
  });
}

export async function deleteCard(id: string): Promise<{
  worktreePath: string | null;
  branchName: string | null;
}> {
  return invoke("board_delete_card", { id });
}

export async function clearCardWorktree(id: string): Promise<Card> {
  return invoke<Card>("board_clear_card_worktree", { id });
}

// ---------- runs / logs ----------

export async function listRuns(cardId: string): Promise<Run[]> {
  return invoke<Run[]>("board_list_runs", { cardId });
}

export async function listRunLogs(
  runId: string,
  afterId: number | null,
): Promise<RunLog[]> {
  return invoke<RunLog[]>("board_list_run_logs", { runId, afterId });
}

// ---------- project scripts ----------

export async function projectScriptList(
  projectId: string,
): Promise<ProjectScript[]> {
  return invoke<ProjectScript[]>("project_script_list", { projectId });
}

export async function projectScriptCreate(
  projectId: string,
  title: string,
  command: string,
  icon?: string,
): Promise<ProjectScript> {
  return invoke<ProjectScript>("project_script_create", {
    projectId,
    title,
    command,
    icon: icon ?? null,
  });
}

export async function projectScriptUpdate(
  id: string,
  patch: { title?: string; command?: string; icon?: string },
): Promise<ProjectScript> {
  return invoke<ProjectScript>("project_script_update", {
    id,
    title: patch.title ?? null,
    command: patch.command ?? null,
    icon: patch.icon ?? null,
  });
}

export async function projectScriptDelete(id: string): Promise<void> {
  await invoke<void>("project_script_delete", { id });
}

// ---------- attachments ----------

export async function attachmentSave(
  cardId: string,
  filename: string,
  mimeType: string,
  bytes: Uint8Array,
): Promise<Attachment> {
  return invoke<Attachment>("attachment_save", {
    cardId,
    filename,
    mimeType,
    // Tauri serializes Uint8Array as a number array — for typical
    // attachment sizes (<20MB) this is fine. Larger files would benefit
    // from a fs-plugin handoff instead.
    bytes: Array.from(bytes),
  });
}

export async function attachmentList(cardId: string): Promise<Attachment[]> {
  return invoke<Attachment[]>("attachment_list", { cardId });
}

export async function attachmentDelete(id: string): Promise<void> {
  await invoke<void>("attachment_delete", { id });
}

export async function attachmentReadBytes(id: string): Promise<Uint8Array> {
  const arr = await invoke<number[]>("attachment_read_bytes", { id });
  return new Uint8Array(arr);
}

/** Copy every attachment of a card into `<worktree>/.squint/attachments/`
 * and return the list of filenames. Called right before spawning an
 * agent so it can read the staged files from a known location. */
export async function attachmentStageForRun(
  cardId: string,
  worktreePath: string,
): Promise<string[]> {
  return invoke<string[]>("attachment_stage_for_run", { cardId, worktreePath });
}

// ---------- agent runner ----------

export async function agentStart(
  cardId: string,
  prompt: string,
  agentId: AgentId,
  worktreePath: string,
): Promise<{ runId: string }> {
  return invoke<{ runId: string }>("agent_start", {
    cardId,
    prompt,
    agentId,
    worktreePath,
  });
}

export async function agentAbort(cardId: string): Promise<void> {
  await invoke<void>("agent_abort", { cardId });
}

export async function agentStatus(cardId: string): Promise<AgentStatus> {
  return invoke<AgentStatus>("agent_status", { cardId });
}

// ---------- git ops we drive directly from the board ----------

/** Run `git status --porcelain` against an arbitrary path (worktree). */
export async function gitStatusPorcelain(
  repoPath: string,
): Promise<{ path: string; status: string; staged: boolean }[]> {
  // Reuses the existing `git_status` command; the type from the Rust side
  // is `Vec<ChangedFile>` but we only need a tiny shape here.
  return invoke("git_status", { repoPath });
}

export async function gitCommitAll(
  repoPath: string,
  message: string,
): Promise<void> {
  await invoke<void>("git_commit_all", { repoPath, message });
}

export async function gitPush(
  repoPath: string,
  setUpstream: boolean,
): Promise<void> {
  await invoke<void>("git_push", { repoPath, setUpstream });
}

export async function ghPrCreate(
  repoPath: string,
  title: string,
  body: string,
  base: string,
  head: string | null,
): Promise<string> {
  return invoke<string>("gh_pr_create", {
    repoPath,
    title,
    body,
    base,
    head,
  });
}

// ---------- worktree ----------

export type WorktreeEntry = {
  path: string;
  head: string | null;
  branch: string | null;
  bare: boolean;
  detached: boolean;
};

export async function worktreeAdd(
  repoPath: string,
  branch: string,
  base: string,
  worktreePath: string,
): Promise<string> {
  return invoke<string>("git_worktree_add", {
    repoPath,
    branch,
    base,
    worktreePath,
  });
}

export async function worktreeRemove(
  repoPath: string,
  worktreePath: string,
  /** When set, the branch is also deleted (`git branch -D`) after the
   *  worktree is gone. Pass for `deleteCard` (abandon entirely),
   *  leave undefined for archive flows that should preserve the PR's
   *  branch. */
  branchName?: string | null,
): Promise<void> {
  await invoke<void>("git_worktree_remove", {
    repoPath,
    worktreePath,
    branchName: branchName ?? null,
  });
}

export async function worktreeList(
  repoPath: string,
): Promise<WorktreeEntry[]> {
  return invoke<WorktreeEntry[]>("git_worktree_list", { repoPath });
}

// ---------- streaming events ----------

export async function listenAgentLog(
  cardId: string,
  handler: (event: AgentLogEvent) => void,
): Promise<UnlistenFn> {
  return listen<AgentLogEvent>(`agent://card/${cardId}/log`, (e) =>
    handler(e.payload),
  );
}

export async function listenAgentExit(
  cardId: string,
  handler: (event: AgentExitEvent) => void,
): Promise<UnlistenFn> {
  return listen<AgentExitEvent>(`agent://card/${cardId}/exit`, (e) =>
    handler(e.payload),
  );
}

// ---------- setup script ----------

export type SetupDataEvent = {
  runId: string;
  line: string;
  stream: "stdout" | "stderr";
};

export type SetupExitEvent = {
  runId: string;
  code: number | null;
  reason: "clean" | "spawn_error" | "await_error";
};

export async function setupRunStart(
  runId: string,
  projectId: string,
  worktreePath: string,
): Promise<void> {
  await invoke<void>("setup_run_start", { runId, projectId, worktreePath });
}

export async function listenSetupData(
  runId: string,
  handler: (event: SetupDataEvent) => void,
): Promise<UnlistenFn> {
  return listen<SetupDataEvent>(`setup://run/${runId}/data`, (e) =>
    handler(e.payload),
  );
}

export async function listenSetupExit(
  runId: string,
  handler: (event: SetupExitEvent) => void,
): Promise<UnlistenFn> {
  return listen<SetupExitEvent>(`setup://run/${runId}/exit`, (e) =>
    handler(e.payload),
  );
}

// ---------- project detection ----------

export type ProjectEnvStatus = {
  workspace: string;
  hasEnv: boolean;
  hasEnvExample: boolean;
};

export type ProjectDetection = {
  isNode: boolean;
  packageManager: "bun" | "pnpm" | "yarn" | "npm" | null;
  monorepoTool: "turbo" | "pnpm" | "workspaces" | null;
  workspaces: string[];
  envStatus: ProjectEnvStatus[];
};

export async function projectDetect(
  repoPath: string,
): Promise<ProjectDetection> {
  return invoke<ProjectDetection>("project_detect", { repoPath });
}

/**
 * Ask the configured AI CLI (claude / codex) to recommend a setup script
 * for this project. Returns the cleaned-up bash output (markdown fences
 * stripped). Long-running — the model may take 10-30s; surface a
 * spinner while it works.
 */
export async function projectSuggestSetupScript(
  repoPath: string,
  agentId: string,
): Promise<string> {
  return invoke<string>("project_suggest_setup_script", {
    repoPath,
    agentId,
  });
}
