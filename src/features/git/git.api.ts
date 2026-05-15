import { invoke } from "@/lib/tauri";
import type {
  BinaryPreview,
  BranchInfo,
  ChangedFile,
  DiffResult,
  ExternalEditor,
  StashEntry,
} from "./git.types";

export async function getRepoStatus(repoPath: string): Promise<ChangedFile[]> {
  return invoke<ChangedFile[]>("git_status", { repoPath });
}

export async function getCurrentBranch(repoPath: string): Promise<string> {
  return invoke<string>("git_current_branch", { repoPath });
}

export async function getFileDiff(
  repoPath: string,
  filePath: string,
  staged: boolean,
): Promise<DiffResult> {
  return invoke<DiffResult>("git_file_diff", { repoPath, filePath, staged });
}

export async function stageFile(
  repoPath: string,
  filePath: string,
): Promise<void> {
  await invoke<void>("git_stage_file", { repoPath, filePath });
}

export async function unstageFile(
  repoPath: string,
  filePath: string,
): Promise<void> {
  await invoke<void>("git_unstage_file", { repoPath, filePath });
}

export async function stagePaths(
  repoPath: string,
  filePaths: string[],
): Promise<void> {
  await invoke<void>("git_stage_paths", { repoPath, filePaths });
}

export async function unstagePaths(
  repoPath: string,
  filePaths: string[],
): Promise<void> {
  await invoke<void>("git_unstage_paths", { repoPath, filePaths });
}

export async function discardPaths(
  repoPath: string,
  filePaths: string[],
): Promise<void> {
  await invoke<void>("git_discard_paths", { repoPath, filePaths });
}

export async function discardFile(
  repoPath: string,
  filePath: string,
): Promise<void> {
  await invoke<void>("git_discard_file", { repoPath, filePath });
}

export async function openInVscode(
  repoPath: string,
  filePath: string,
): Promise<void> {
  await invoke<void>("open_in_vscode", { repoPath, filePath });
}

export async function getBinaryPreview(
  repoPath: string,
  filePath: string,
  staged: boolean,
): Promise<BinaryPreview> {
  return invoke<BinaryPreview>("git_binary_preview", {
    repoPath,
    filePath,
    staged,
  });
}

export async function readWorkingFile(
  repoPath: string,
  filePath: string,
): Promise<string> {
  return invoke<string>("read_working_file", { repoPath, filePath });
}

export async function writeWorkingFile(
  repoPath: string,
  filePath: string,
  content: string,
): Promise<void> {
  await invoke<void>("write_working_file", { repoPath, filePath, content });
}

export type PatchTarget = "index" | "workdir";

export async function applyPatch(
  repoPath: string,
  patch: string,
  reverse: boolean,
  target: PatchTarget = "index",
): Promise<void> {
  await invoke<void>("git_apply_patch", { repoPath, patch, reverse, target });
}

export async function commit(repoPath: string, message: string): Promise<void> {
  await invoke<void>("git_commit", { repoPath, message });
}

export async function push(
  repoPath: string,
  setUpstream?: boolean,
): Promise<void> {
  await invoke<void>("git_push", { repoPath, setUpstream });
}

export async function pull(repoPath: string): Promise<void> {
  await invoke<void>("git_pull", { repoPath });
}

export async function fetchRemote(repoPath: string): Promise<void> {
  await invoke<void>("git_fetch", { repoPath });
}

export async function undoLastCommit(repoPath: string): Promise<void> {
  await invoke<void>("git_undo_last_commit", { repoPath });
}

export async function defaultBranch(repoPath: string): Promise<string> {
  return invoke<string>("git_default_branch", { repoPath });
}

export type GhStatus = {
  installed: boolean;
  authenticated: boolean;
  hostname: string | null;
};

export async function ghDetectStatus(): Promise<GhStatus> {
  return invoke<GhStatus>("gh_detect_status");
}

export async function ghPrCreate(args: {
  repoPath: string;
  title: string;
  body: string;
  base: string;
  head?: string;
}): Promise<string> {
  return invoke<string>("gh_pr_create", args);
}

export async function listRepoFiles(repoPath: string): Promise<string[]> {
  return invoke<string[]>("list_repo_files", { repoPath });
}

export async function listBranches(repoPath: string): Promise<BranchInfo[]> {
  return invoke<BranchInfo[]>("list_branches", { repoPath });
}

export async function checkoutBranch(
  repoPath: string,
  name: string,
): Promise<void> {
  await invoke<void>("checkout_branch", { repoPath, name });
}

export async function createBranch(
  repoPath: string,
  name: string,
  base?: string,
): Promise<void> {
  await invoke<void>("create_branch", { repoPath, name, base });
}

export async function detectEditors(): Promise<ExternalEditor[]> {
  return invoke<ExternalEditor[]>("detect_editors");
}

export async function openInEditor(
  editorId: string,
  repoPath: string,
  filePath: string,
): Promise<void> {
  await invoke<void>("open_in_editor", { editorId, repoPath, filePath });
}

// ----- stash ---------------------------------------------------------------

export async function stashPush(
  repoPath: string,
  message: string,
  includeUntracked: boolean,
): Promise<void> {
  await invoke<void>("git_stash_push", { repoPath, message, includeUntracked });
}

export async function stashList(repoPath: string): Promise<StashEntry[]> {
  return invoke<StashEntry[]>("git_stash_list", { repoPath });
}

export async function stashPop(repoPath: string, stashRef: string): Promise<void> {
  await invoke<void>("git_stash_pop", { repoPath, stashRef });
}

export async function stashApply(
  repoPath: string,
  stashRef: string,
): Promise<void> {
  await invoke<void>("git_stash_apply", { repoPath, stashRef });
}

export async function stashDrop(
  repoPath: string,
  stashRef: string,
): Promise<void> {
  await invoke<void>("git_stash_drop", { repoPath, stashRef });
}
