import { invoke } from "@/lib/tauri";
import type { AiCliInfo } from "./ai.types";

export type Integration = {
  id: string;
  name: string;
  purpose: string;
  /** Human-readable description of how to install (e.g. "brew install gh"). */
  installHint: string;
  /**
   * The exact shell command the integrated terminal should run when the user
   * clicks the ▶ button next to this row. Sometimes equal to `installHint`,
   * sometimes longer (Homebrew's installer is multi-step curl-piped bash).
   */
  installCommand: string;
  /**
   * The id of another integration whose absence makes `installCommand`
   * fail. In practice always `"brew"` for the tool rows — the onboarding
   * UI grays out the ▶ button until Homebrew is installed.
   */
  requires: string | null;
  available: boolean;
};

export type IntegrationsReport = {
  integrations: Integration[];
};

export async function detectIntegrations(): Promise<IntegrationsReport> {
  return invoke<IntegrationsReport>("detect_integrations");
}

export async function detectAiClis(): Promise<AiCliInfo[]> {
  return invoke<AiCliInfo[]>("detect_ai_clis");
}

export async function runAiCli(
  cliId: string,
  prompt: string,
  repoPath: string,
): Promise<string> {
  return invoke<string>("run_ai_cli", { cliId, prompt, repoPath });
}

export type DiffScope = "staged" | "working" | "branch";

export async function getDiffForAi(
  repoPath: string,
  scope: DiffScope,
): Promise<string> {
  return invoke<string>("git_diff_for_ai", { repoPath, scope });
}

export async function getLogForAi(
  repoPath: string,
  scope: DiffScope,
): Promise<string> {
  return invoke<string>("git_log_for_ai", { repoPath, scope });
}
