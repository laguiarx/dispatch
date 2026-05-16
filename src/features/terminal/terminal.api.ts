import { invoke } from "@/lib/tauri";

/**
 * Thin wrappers over the Rust `term_*` Tauri commands. The PTY runs in the
 * Rust process; this module is essentially a typed IPC boundary. Data flows
 * back via Tauri events (`term://<id>/data`, `term://<id>/exit`) — see
 * `TerminalDrawer.tsx` for the listener wiring.
 */

export type TermOpenResult = { id: string };

export async function termOpen(
  cols: number,
  rows: number,
  cwd: string | null,
): Promise<TermOpenResult> {
  return invoke<TermOpenResult>("term_open", { cols, rows, cwd });
}

export async function termWrite(id: string, data: string): Promise<void> {
  await invoke<void>("term_write", { id, data });
}

export async function termResize(
  id: string,
  cols: number,
  rows: number,
): Promise<void> {
  await invoke<void>("term_resize", { id, cols, rows });
}

export async function termClose(id: string): Promise<void> {
  await invoke<void>("term_close", { id });
}
