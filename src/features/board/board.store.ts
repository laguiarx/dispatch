/**
 * Board store — holds the kanban state for the currently active project and
 * owns the orchestration around moving cards through the columns.
 *
 * Coupling rule (per the plan): one-way only. The board store reads
 * `repository.path` indirectly via the project object passed into
 * `loadProject`; it never reaches into the repository store. That keeps
 * repository.store.ts (~3100 lines) free of board concerns.
 */

import { create } from "zustand";
import type { UnlistenFn } from "@tauri-apps/api/event";

import * as api from "./board.api";
import * as aiApi from "@/features/ai/ai.api";
import { invoke } from "@/lib/tauri";
import { useRepoStore } from "@/features/repository/repository.store";
import { notifyCardTransition } from "@/lib/notify";
import type {
  AgentExitEvent,
  AgentId,
  AgentLogEvent,
  Attachment,
  BoardColumnId,
  Card,
  Priority,
  Project,
  ProjectScript,
  Run,
  RunLog,
} from "./board.types";

/**
 * Per-card live agent subscription. We keep these in module scope rather
 * than in the store because UnlistenFn isn't serializable; the store only
 * needs to know whether a card is running.
 */
const subscriptions = new Map<
  string,
  { logUnlisten: UnlistenFn; exitUnlisten: UnlistenFn; runId: string }
>();

function shortId(id: string): string {
  // The first 8 chars of a v4 uuid give us ~32 bits of entropy — plenty for
  // an active set of cards. We trim hyphens defensively in case the source
  // changes.
  return id.replace(/-/g, "").slice(0, 8);
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "")
    || "task";
}

function defaultBranchName(card: Card): string {
  // `agent/` namespace (not `dispatch/`) so the prefix can't be confused
  // with a project name — users naming a project after the app would
  // otherwise see e.g. `dispatch/...` on an atlas card and assume it
  // landed in the wrong repo. The human-friendly `T42-slug` tail
  // mirrors what we show on the card tile and in the PR body.
  const tag = card.taskNumber ? `T${card.taskNumber}` : shortId(card.id);
  return `agent/${tag}-${slugify(card.title)}`;
}

function defaultWorktreePath(card: Card): string {
  // Relative to the repo so git stores a stable, portable path. The actual
  // `.dispatch/worktrees/<short>` dir lives inside the user's project repo
  // and gets auto-excluded by `ensure_dispatch_excluded` on first add.
  return `.dispatch/worktrees/${shortId(card.id)}`;
}

const MAX_PR_DIFF_BYTES = 120_000;

function truncatePrDiff(s: string): string {
  return s.length > MAX_PR_DIFF_BYTES
    ? s.slice(0, MAX_PR_DIFF_BYTES) +
        `\n\n[...truncated ${s.length - MAX_PR_DIFF_BYTES} bytes]`
    : s;
}

function stripOuterCodeFence(raw: string): string {
  const lines = raw.split(/\r?\n/);
  if (lines.length < 2) return raw;
  const opener = lines[0].trim();
  if (!/^```[a-zA-Z0-9_+-]*$/.test(opener)) return raw;
  let lastIdx = lines.length - 1;
  while (lastIdx > 0 && lines[lastIdx].trim() === "") lastIdx--;
  if (lastIdx <= 0 || lines[lastIdx].trim() !== "```") return raw;
  return lines.slice(1, lastIdx).join("\n");
}

function changedFilesFromDiff(diff: string): string[] {
  const files = new Set<string>();
  for (const line of diff.split(/\r?\n/)) {
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (match) files.add(match[2]);
  }
  return [...files];
}

function buildDevelopmentPrPrompt(
  log: string,
  diff: string,
  userPrompt: string,
): string {
  const trimmedUserPrompt = userPrompt.trim();
  return [
    ...(trimmedUserPrompt
      ? ["USER INSTRUCTIONS:", trimmedUserPrompt, ""]
      : []),
    "Draft a pull-request title and body from the actual branch changes below.",
    "Write in Brazilian Portuguese.",
    "Use only the commit list and diff as source material.",
    "Do not copy the original task title, task objective, Figma notes, credentials, or acceptance-flow text.",
    "",
    "Output format (strict, no surrounding Markdown fence):",
    "Line 1: short PR title describing what changed, under 72 chars, no prefix.",
    "Line 2: blank.",
    "Line 3+: PR body exactly in this structure:",
    "",
    "# Resumo de Desenvolvimento",
    "",
    "**O que foi feito:**",
    "1. ...",
    "",
    "**Onde foi alterado (escopo técnico):**",
    "1. ...",
    "",
    "**Riscos/impactos:**",
    "1. ...",
    "",
    "COMMITS:",
    log.trim() || "(no commit history available)",
    "",
    "DIFF:",
    truncatePrDiff(diff.trim() || "(no diff available)"),
  ].join("\n");
}

function parseDevelopmentPrDraft(
  raw: string,
  fallbackTitle: string,
  fallbackBody: string,
): { title: string; body: string } {
  const cleaned = stripOuterCodeFence(raw).trim();
  if (!cleaned) return { title: fallbackTitle, body: fallbackBody };

  const lines = cleaned.split(/\r?\n/);
  let title = "";
  let bodyStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    if (/^#+\s*resumo de desenvolvimento\s*$/i.test(t)) {
      break;
    }
    title = t
      .replace(/^#+\s*/, "")
      .replace(/^(title|titulo|título|pr):\s*/i, "")
      .trim();
    bodyStart = i + 1;
    break;
  }

  let body = lines.slice(bodyStart).join("\n").trim();
  const resumoIndex = body.search(/^#\s+Resumo de Desenvolvimento/im);
  if (resumoIndex > 0) {
    body = body.slice(resumoIndex).trim();
  }

  if (!title || /^resumo de desenvolvimento$/i.test(title)) {
    title = fallbackTitle;
  }
  if (title.length > 100) {
    title = title.slice(0, 97).trimEnd() + "...";
  }
  if (!body.includes("# Resumo de Desenvolvimento")) {
    body = fallbackBody;
  }

  return { title, body };
}

function fallbackDevelopmentPrBody(diff: string, log: string): string {
  const files = changedFilesFromDiff(diff);
  const fileLines =
    files.length > 0
      ? files
          .slice(0, 8)
          .map((file, idx) => `${idx + 1}. \`${file}\``)
          .join("\n")
      : "1. Branch sem diff textual disponível para detalhar arquivos.";
  const extraFiles =
    files.length > 8
      ? `\n${Math.min(files.length, 9)}. Mais ${files.length - 8} arquivo(s) alterado(s).`
      : "";
  const commitCount = log.trim()
    ? log.trim().split(/\r?\n/).filter(Boolean).length
    : 0;

  return [
    "# Resumo de Desenvolvimento",
    "",
    "**O que foi feito:**",
    "1. Preparadas alterações da branch para revisão em pull request.",
    commitCount > 0
      ? `2. Consolidados ${commitCount} commit(s) com mudanças prontas para validação.`
      : "2. Consolidado o estado atual da branch para validação.",
    "",
    "**Onde foi alterado (escopo técnico):**",
    fileLines + extraFiles,
    "",
    "**Riscos/impactos:**",
    "1. Revisar o diff antes do merge para confirmar o comportamento esperado.",
    "2. Validar testes e fluxos afetados no repositório de destino.",
  ].join("\n");
}

function closeTerminalTabsForWorktree(worktreeAbs: string): void {
  queueMicrotask(() => {
    const repoState = useRepoStore.getState();
    const matching = repoState.terminalTabs.filter((tab) => {
      if (!tab.cwd) return false;
      return tab.cwd === worktreeAbs || tab.cwd.startsWith(`${worktreeAbs}/`);
    });
    for (const tab of matching) {
      repoState.closeTerminalTab(tab.id);
    }
  });
}

type State = {
  /** All projects known to the app. Loaded once on boot. */
  projects: Project[];
  /** Project id → Project for O(1) lookup (used to resolve a card's
   * worktree path and its display name in the All-projects view). */
  projectsById: Record<string, Project>;
  /** Currently selected project filter. `null` means "All projects". */
  activeProjectId: string | null;

  /** Card id → Card. */
  cards: Record<string, Card>;
  /** Column → ordered list of card ids (sorted by position ASC). Reflects
   * whichever filter is active: a single project, or all of them. */
  cardIdsByColumn: Record<BoardColumnId, string[]>;

  /** Run id → in-memory log tail (capped per run). */
  logsByRun: Record<string, RunLog[]>;
  /** Card id → run history (most recent first). */
  runsByCard: Record<string, Run[]>;
  /** Card id → attachments (oldest first). */
  attachmentsByCard: Record<string, Attachment[]>;
  /** Project id → ordered list of named scripts the user can run. */
  scriptsByProject: Record<string, ProjectScript[]>;
  /** Card ids that currently have a live agent. */
  runningCardIds: Set<string>;
  /** Card ids currently in the middle of the Approve → PR flow. Distinct
   * from `runningCardIds` so the UI can show the "pushing + opening PR"
   * spinner without confusing it with an active agent run. */
  approvingCardIds: Set<string>;
  /** Card ids currently removing their worktree from disk. */
  archivingCardIds: Set<string>;
  /** Card ids whose last setup-script attempt failed. Drained from
   *  drainQueue so we don't retry-forever, cleared when the card moves
   *  to a different column (user dragged to backlog to fix). Transient
   *  — not persisted; a restart re-attempts the setup. */
  setupFailedCardIds: Set<string>;
  /** Card id → extra prompt waiting to be picked up by the next spawn.
   *  Set by `enqueueFollowUp` when the user sends a chat message from
   *  the detail view after the agent has already worked on the card.
   *  Consumed (and cleared) by `spawnAgentForCard` as the agent starts.
   *  Transient — not persisted; if the app restarts before the queue
   *  drains, the pending prompt is lost and the user can re-send. */
  pendingFollowUpByCardId: Record<string, string>;

  /** UI: which card the detail drawer is bound to. */
  selectedCardId: string | null;
  /** UI: whether the "New card" dialog is currently open. Lifted to the
   * store so the ⌘N shortcut (which lives outside the board components)
   * can toggle it without prop-drilling. */
  newCardOpen: boolean;
  /** UI: when the dialog opens via "+ New card" on a specific project
   * row, this carries the project id so the dialog defaults to it even
   * if the active filter is "All projects". Cleared on close. */
  newCardProjectId: string | null;
  /** UI: id of the card currently being dragged. Lifted to the store so
   * `BoardColumn` can read it to decide whether its droppable should
   * accept the drop (only backlog ↔ todo manual moves are legal). */
  draggingCardId: string | null;

  // ----- loaders -----
  /** Load the project list from SQLite. Called once on boot. */
  loadProjects: () => Promise<void>;
  /** Filter the board. Pass `null` to show all projects. */
  setActiveProject: (projectId: string | null) => Promise<void>;
  /** Pick a folder, ensure a project row exists for it, refresh the
   * project list, and activate the new one. */
  /**
   * Prompt the user for a folder and register it as a project. Returns
   * the project id + `created` flag so callers can react to brand-new
   * adds (e.g. open the setup dialog) without firing on re-picks of an
   * already-tracked repo. `null` when the user cancels the picker.
   */
  addProjectFromPicker: () => Promise<{
    projectId: string;
    created: boolean;
  } | null>;
  /** Drop a project from the DB (and its cards via FK cascade). */
  removeProject: (projectId: string) => Promise<void>;
  /** Rename a project. Pinned state is preserved. */
  renameProject: (projectId: string, name: string) => Promise<void>;
  /** Save (or clear, with empty string) the project's setup script —
   *  bash that runs on worktree creation, before the agent. */
  updateProjectSetupScript: (
    projectId: string,
    script: string,
  ) => Promise<void>;
  /** Persist a new visual order for projects (drag-reorder). Updates
   * positions evenly so subsequent drags don't have to renumber. */
  reorderProjects: (ids: string[]) => Promise<void>;
  reloadCards: () => Promise<void>;
  reloadRuns: (cardId: string) => Promise<void>;
  reloadRunLogs: (runId: string) => Promise<void>;
  reloadAttachments: (cardId: string) => Promise<void>;
  /** Read a File (from drop / paste / picker), persist it as an
   * attachment on the card, and refresh local state. */
  attachFile: (cardId: string, file: File) => Promise<Attachment | null>;
  removeAttachment: (cardId: string, attachmentId: string) => Promise<void>;

  /** Load scripts for a project (called when settings or the modal
   * needs them). */
  reloadProjectScripts: (projectId: string) => Promise<void>;
  addProjectScript: (
    projectId: string,
    title: string,
    command: string,
    icon?: string,
  ) => Promise<ProjectScript>;
  updateProjectScript: (
    id: string,
    patch: { title?: string; command?: string; icon?: string },
  ) => Promise<void>;
  deleteProjectScript: (
    projectId: string,
    scriptId: string,
  ) => Promise<void>;

  // ----- mutations -----
  /** Create a card in the active project. Returns null when there's no
   * active project (e.g. the All-projects view) — use
   * `createCardForProject` to target one explicitly. */
  createCard: (
    title: string,
    description: string,
    agent: AgentId,
    priority?: Priority,
    branchName?: string | null,
  ) => Promise<Card | null>;
  /** Create a card in an explicit project. Lets the New Card dialog work
   * from the All-projects view (where there's no implicit target). */
  createCardForProject: (
    projectId: string,
    title: string,
    description: string,
    agent: AgentId,
    priority?: Priority,
    branchName?: string | null,
    /**
     * Base branch the agent's worktree will fork off of. `null` (or
     * omitted) means "use the project's default base at spawn time" —
     * keeps the existing call sites working and lets callers leave the
     * decision until later.
     */
    baseBranch?: string | null,
    runConfig?: {
      model?: string | null;
      reasoning?: string | null;
      fastMode?: boolean;
    },
  ) => Promise<Card | null>;
  updateCard: (
    id: string,
    patch: Partial<
      Pick<
        Card,
        | "title"
        | "description"
        | "agent"
        | "priority"
        | "model"
        | "reasoning"
        | "fastMode"
      >
    >,
  ) => Promise<void>;
  deleteCard: (id: string) => Promise<void>;

  /**
   * Move a card to `column`. The four meaningful transitions also fire
   * side effects:
   *   - `todo`        → ensures worktree + spawns agent (auto-advances to
   *                     in_progress once the agent reports its first byte).
   *   - `review`      → no automated side effect (the agent itself moves
   *                     cards here on exit; users only land here manually
   *                     when re-prompting or undoing).
   *   - `done`        → Task 8 will push + open the PR here.
   *   - everything else: pure DB write.
   */
  moveCardTo: (
    id: string,
    column: BoardColumnId,
    position?: number,
  ) => Promise<void>;

  /**
   * Re-prompt a card from the chat composer in the detail view. ALWAYS
   * goes through the queue: the card lands in To Do with `extraPrompt`
   * stashed in `pendingFollowUpByCardId`, and `drainQueue` promotes it
   * to In Progress (spawning the agent) only when there's a free slot
   * under MAX_CONCURRENT_AGENTS. We deliberately don't bypass the cap
   * even when the card was already in Review — running too many agents
   * in parallel freezes the app.
   */
  enqueueFollowUp: (id: string, extraPrompt: string) => Promise<void>;
  abortCard: (id: string) => Promise<void>;
  /**
   * Approve a card sitting in Review: auto-commit any pending changes,
   * push the branch, open a PR via gh, persist the URL on the card, and
   * move it to Done. Returns the PR URL (or throws on failure — the
   * caller surfaces the error via the existing toast machinery).
   */
  approveCard: (id: string) => Promise<string>;
  /** Archive a Done card: drop the worktree from disk and clear the
   * pointer on the card so the UI stops offering "Open diff". The card
   * stays in Done as historical record (PR url is preserved). */
  archiveCard: (id: string) => Promise<void>;

  // ----- UI -----
  selectCard: (id: string | null) => void;
  setNewCardOpen: (open: boolean) => void;
  /** Open the New Card dialog pre-selected on a project. */
  openNewCardForProject: (projectId: string) => void;
  setDraggingCardId: (id: string | null) => void;
};

const emptyColumns = (): Record<BoardColumnId, string[]> => ({
  backlog: [],
  todo: [],
  in_progress: [],
  review: [],
  done: [],
});

/** Sort projects by manual position when set (drag-reorder writes to
 * `position`); otherwise alphabetical so freshly-added projects land in
 * a predictable spot. */
function sortProjects(list: Project[]): Project[] {
  return [...list].sort((a, b) => {
    const aPos = a.position ?? Number.POSITIVE_INFINITY;
    const bPos = b.position ?? Number.POSITIVE_INFINITY;
    if (aPos !== bPos) return aPos - bPos;
    return a.name.localeCompare(b.name);
  });
}

function indexAll(cards: Card[]): Record<string, Card> {
  const byId: Record<string, Card> = {};
  for (const c of cards) byId[c.id] = c;
  return byId;
}

/** Build the column → ordered cardIds map for the BOARD VIEW, filtered
 * by `activeProjectId` (null = all projects). The full `cards` map is
 * kept intact so the sidebar can list cards across every project. */
function indexColumnsFor(
  cards: Record<string, Card>,
  activeProjectId: string | null,
): Record<BoardColumnId, string[]> {
  const byColumn = emptyColumns();
  for (const c of Object.values(cards)) {
    if (activeProjectId !== null && c.projectId !== activeProjectId) continue;
    byColumn[c.columnId].push(c.id);
  }
  for (const col of Object.keys(byColumn) as BoardColumnId[]) {
    byColumn[col].sort(
      (a, b) => (cards[a]?.position ?? 0) - (cards[b]?.position ?? 0),
    );
  }
  return byColumn;
}

/** Soft cap to keep memory bounded on long-running agents. The DB still
 * has the full history; UI just shows the last N. */
const LOG_TAIL_CAP = 5000;

/** Hard cap on concurrent in-flight agents. Cards beyond the cap sit in
 * To Do until a slot frees up. The cap is per-app, not per-project —
 * the constraint is local CPU / API rate limits, both of which scale
 * with total concurrency. */
const MAX_CONCURRENT_AGENTS = 5;

/**
 * Streaming logs hit the store at hundreds of events per second when
 * multiple agents run in parallel — a naive `set()` per line froze the
 * UI in observed testing. We batch by run id and flush at most every
 * `LOG_FLUSH_MS` so React sees one update per frame instead of dozens.
 *
 * The buffer lives at module scope so all subscriptions share the same
 * scheduler — adding another agent just appends to the same queue.
 */
const LOG_FLUSH_MS = 80;
const pendingLogs = new Map<string, RunLog[]>();
let pendingLogFlush: ReturnType<typeof setTimeout> | null = null;

function scheduleLogFlush(
  set: (
    partial: Partial<State> | ((s: State) => Partial<State>),
  ) => void,
) {
  if (pendingLogFlush !== null) return;
  pendingLogFlush = setTimeout(() => {
    pendingLogFlush = null;
    if (pendingLogs.size === 0) return;
    // Snapshot + clear so concurrent appends queued during the set()
    // call don't get dropped.
    const batches = Array.from(pendingLogs.entries());
    pendingLogs.clear();
    set((s) => {
      let logsByRun = s.logsByRun;
      let mutated = false;
      for (const [runId, entries] of batches) {
        const current = logsByRun[runId];
        const concatenated = current ? current.concat(entries) : entries;
        const trimmed =
          concatenated.length > LOG_TAIL_CAP
            ? concatenated.slice(concatenated.length - LOG_TAIL_CAP)
            : concatenated;
        if (!mutated) {
          logsByRun = { ...logsByRun };
          mutated = true;
        }
        logsByRun[runId] = trimmed;
      }
      return mutated ? { logsByRun } : s;
    });
  }, LOG_FLUSH_MS);
}

function bufferLog(
  set: (
    partial: Partial<State> | ((s: State) => Partial<State>),
  ) => void,
  entry: RunLog,
) {
  const existing = pendingLogs.get(entry.runId);
  if (existing) {
    existing.push(entry);
  } else {
    pendingLogs.set(entry.runId, [entry]);
  }
  scheduleLogFlush(set);
}

/** Snapshot key for the activeProjectId so it survives a reload. */
const ACTIVE_PROJECT_KEY = "dispatch.board.activeProjectId";
const SELECTED_CARD_KEY = "dispatch.board.selectedCardId";
const NEW_CARD_OPEN_KEY = "dispatch.board.newCardOpen";

function readActiveProjectId(): string | null {
  try {
    const v = localStorage.getItem(ACTIVE_PROJECT_KEY);
    return v && v !== "null" ? v : null;
  } catch {
    return null;
  }
}

function writeActiveProjectId(id: string | null) {
  try {
    if (id === null) localStorage.removeItem(ACTIVE_PROJECT_KEY);
    else localStorage.setItem(ACTIVE_PROJECT_KEY, id);
  } catch {
    /* private mode etc — non-fatal */
  }
}

function readSelectedCardId(): string | null {
  try {
    return localStorage.getItem(SELECTED_CARD_KEY);
  } catch {
    return null;
  }
}

function writeSelectedCardId(id: string | null) {
  try {
    if (id === null) localStorage.removeItem(SELECTED_CARD_KEY);
    else localStorage.setItem(SELECTED_CARD_KEY, id);
  } catch {
    /* ignore */
  }
}

function readNewCardOpen(): boolean {
  try {
    return localStorage.getItem(NEW_CARD_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

function writeNewCardOpen(open: boolean) {
  try {
    if (open) localStorage.setItem(NEW_CARD_OPEN_KEY, "1");
    else localStorage.removeItem(NEW_CARD_OPEN_KEY);
  } catch {
    /* ignore */
  }
}

export const useBoardStore = create<State>((set, get) => ({
  projects: [],
  projectsById: {},
  activeProjectId: null,
  cards: {},
  cardIdsByColumn: emptyColumns(),
  logsByRun: {},
  runsByCard: {},
  runningCardIds: new Set(),
  approvingCardIds: new Set(),
  archivingCardIds: new Set(),
  setupFailedCardIds: new Set(),
  pendingFollowUpByCardId: {},
  attachmentsByCard: {},
  scriptsByProject: {},
  selectedCardId: null,
  newCardOpen: false,
  newCardProjectId: null,
  draggingCardId: null,

  async loadProjects() {
    const raw = await api.listProjects();
    const projects = sortProjects(raw);
    const projectsById: Record<string, Project> = {};
    for (const p of projects) projectsById[p.id] = p;
    // Restore the previously active project + open modal state so
    // closing and reopening the app picks up exactly where the user
    // left off. We validate the selectedCardId after reloadCards() so a
    // deleted card doesn't ghost-open the detail modal.
    const saved = readActiveProjectId();
    const nextActive = saved && projectsById[saved] ? saved : null;
    const savedNewCardOpen = readNewCardOpen() && projects.length > 0;
    set({
      projects,
      projectsById,
      activeProjectId: nextActive,
      newCardOpen: savedNewCardOpen,
    });
    await get().reloadCards();
    // Restore selectedCardId only if the card actually exists.
    const savedCardId = readSelectedCardId();
    if (savedCardId && get().cards[savedCardId]) {
      set({ selectedCardId: savedCardId });
    } else if (savedCardId) {
      writeSelectedCardId(null);
    }
  },

  async setActiveProject(projectId) {
    writeActiveProjectId(projectId);
    // All cards are already in memory — switching the filter only
    // recomputes the column index used by the board view.
    set((s) => ({
      activeProjectId: projectId,
      selectedCardId: null,
      cardIdsByColumn: indexColumnsFor(s.cards, projectId),
    }));
  },

  async addProjectFromPicker() {
    // Lazy-load the dialog plugin so the import doesn't run at module
    // eval time (keeps Vitest / non-Tauri runners happy).
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Pick a Git repository to track on the board",
    });
    if (!selected || Array.isArray(selected)) return null;
    const path = String(selected);
    const name = path.split("/").filter(Boolean).pop() || path;
    // Detect the default branch best-effort so worktrees branch off the
    // right ref. Falls back to "main" later if unset.
    let defaultBase: string | null = null;
    try {
      defaultBase = await invoke<string>("git_default_branch", {
        repoPath: path,
      });
    } catch {
      /* repo may have no commits yet — fine */
    }
    // Tell brand-new adds from re-picks of an already-tracked repo. The
    // pre-existing project list is captured BEFORE we call ensureProject
    // (which idempotently inserts) so we don't race ourselves.
    const wasKnown = get().projects.some((p) => p.repoPath === path);
    const project = await api.ensureProject(path, name, defaultBase);
    const projects = sortProjects([
      ...get().projects.filter((p) => p.id !== project.id),
      project,
    ]);
    const projectsById = { ...get().projectsById, [project.id]: project };
    const wasOnAll = get().activeProjectId === null;
    set({ projects, projectsById });
    // Respect the user's current filter. If they were on All projects,
    // adding a new one shouldn't yank them out of the aggregate view —
    // they'll just see the new project appear in the sidebar.
    if (wasOnAll) {
      await get().reloadCards();
    } else {
      await get().setActiveProject(project.id);
    }
    return { projectId: project.id, created: !wasKnown };
  },

  async renameProject(projectId, name) {
    const trimmed = name.trim();
    if (!trimmed) return;
    const updated = await api.updateProject(projectId, { name: trimmed });
    set((s) => {
      const projects = sortProjects(
        s.projects.map((p) => (p.id === projectId ? updated : p)),
      );
      const projectsById = { ...s.projectsById, [projectId]: updated };
      return { projects, projectsById };
    });
  },

  async updateProjectSetupScript(projectId, script) {
    // Empty string clears (the backend treats blank/whitespace as NULL).
    const updated = await api.updateProject(projectId, { setupScript: script });
    set((s) => {
      const projects = sortProjects(
        s.projects.map((p) => (p.id === projectId ? updated : p)),
      );
      const projectsById = { ...s.projectsById, [projectId]: updated };
      return { projects, projectsById };
    });
  },

  async reorderProjects(ids) {
    // Optimistic: re-order the local list immediately, then persist.
    const map = new Map(get().projects.map((p) => [p.id, p]));
    const next: Project[] = [];
    for (let i = 0; i < ids.length; i++) {
      const p = map.get(ids[i]);
      if (p) next.push({ ...p, position: (i + 1) * 1024 });
    }
    // Keep any projects the caller didn't include (defensive — UI
    // should always pass the full list).
    for (const p of get().projects) {
      if (!ids.includes(p.id)) next.push(p);
    }
    const projectsById: Record<string, Project> = {};
    for (const p of next) projectsById[p.id] = p;
    set({ projects: sortProjects(next), projectsById });
    try {
      await api.reorderProjects(ids);
    } catch {
      /* server failed; next loadProjects will resync */
    }
  },

  async removeProject(projectId) {
    // Drop any live subscriptions tied to cards in this project first so
    // the agent runners stop trying to emit into a vanished state slot.
    for (const [cardId, sub] of subscriptions) {
      const card = get().cards[cardId];
      if (card && card.projectId === projectId) {
        sub.logUnlisten();
        sub.exitUnlisten();
        subscriptions.delete(cardId);
      }
    }
    await invoke<void>("board_delete_project", { id: projectId }).catch(
      () => {
        /* fallback: backend may not have a hard delete yet — leave it */
      },
    );
    const projects = get().projects.filter((p) => p.id !== projectId);
    const projectsById = { ...get().projectsById };
    delete projectsById[projectId];
    set({ projects, projectsById });
    if (get().activeProjectId === projectId) {
      await get().setActiveProject(null);
    } else {
      await get().reloadCards();
    }
  },

  async reloadCards() {
    // Always load every card so the sidebar can group cards under each
    // project regardless of the active filter. The board view's column
    // index is filtered separately via `indexColumnsFor`.
    const all = await api.listAllCards();
    const cards = indexAll(all);
    const cardIdsByColumn = indexColumnsFor(cards, get().activeProjectId);
    set({ cards, cardIdsByColumn });
    drainQueue(set, get);
  },

  async reloadRuns(cardId) {
    const runs = await api.listRuns(cardId);
    set((s) => ({ runsByCard: { ...s.runsByCard, [cardId]: runs } }));
  },

  async reloadRunLogs(runId) {
    const logs = await api.listRunLogs(runId, null);
    set((s) => ({ logsByRun: { ...s.logsByRun, [runId]: logs } }));
  },

  async reloadAttachments(cardId) {
    const items = await api.attachmentList(cardId);
    set((s) => ({
      attachmentsByCard: { ...s.attachmentsByCard, [cardId]: items },
    }));
  },

  async attachFile(cardId, file) {
    const buf = new Uint8Array(await file.arrayBuffer());
    const att = await api.attachmentSave(
      cardId,
      file.name,
      file.type || "",
      buf,
    );
    set((s) => {
      const existing = s.attachmentsByCard[cardId] ?? [];
      return {
        attachmentsByCard: {
          ...s.attachmentsByCard,
          [cardId]: [...existing, att],
        },
      };
    });
    return att;
  },

  async removeAttachment(cardId, attachmentId) {
    await api.attachmentDelete(attachmentId);
    set((s) => {
      const existing = s.attachmentsByCard[cardId] ?? [];
      return {
        attachmentsByCard: {
          ...s.attachmentsByCard,
          [cardId]: existing.filter((a) => a.id !== attachmentId),
        },
      };
    });
  },

  async reloadProjectScripts(projectId) {
    const items = await api.projectScriptList(projectId);
    set((s) => ({
      scriptsByProject: { ...s.scriptsByProject, [projectId]: items },
    }));
  },

  async addProjectScript(projectId, title, command, icon) {
    const script = await api.projectScriptCreate(
      projectId,
      title,
      command,
      icon,
    );
    set((s) => {
      const existing = s.scriptsByProject[projectId] ?? [];
      return {
        scriptsByProject: {
          ...s.scriptsByProject,
          [projectId]: [...existing, script],
        },
      };
    });
    return script;
  },

  async updateProjectScript(id, patch) {
    const updated = await api.projectScriptUpdate(id, patch);
    set((s) => {
      const list = s.scriptsByProject[updated.projectId] ?? [];
      return {
        scriptsByProject: {
          ...s.scriptsByProject,
          [updated.projectId]: list.map((x) => (x.id === id ? updated : x)),
        },
      };
    });
  },

  async deleteProjectScript(projectId, scriptId) {
    await api.projectScriptDelete(scriptId);
    set((s) => {
      const list = s.scriptsByProject[projectId] ?? [];
      return {
        scriptsByProject: {
          ...s.scriptsByProject,
          [projectId]: list.filter((x) => x.id !== scriptId),
        },
      };
    });
  },

  async createCard(title, description, agent, priority, branchName) {
    const projectId = get().activeProjectId;
    if (!projectId) return null;
    return get().createCardForProject(
      projectId,
      title,
      description,
      agent,
      priority,
      branchName,
    );
  },

  async createCardForProject(
    projectId,
    title,
    description,
    agent,
    priority,
    branchName,
    baseBranch,
    runConfig,
  ) {
    const card = await api.createCard(
      projectId,
      title,
      description,
      agent,
      priority ?? null,
      branchName ?? null,
      baseBranch ?? null,
      runConfig,
    );
    // Only inject into the local cards map when the card belongs to the
    // currently-displayed slice (active project, or All-projects view).
    const active = get().activeProjectId;
    if (active === null || active === projectId) {
      set((s) => {
        const cards = { ...s.cards, [card.id]: card };
        const col = [...s.cardIdsByColumn[card.columnId], card.id];
        return {
          cards,
          cardIdsByColumn: { ...s.cardIdsByColumn, [card.columnId]: col },
        };
      });
    }
    return card;
  },

  async updateCard(id, patch) {
    const updated = await api.updateCard(id, patch);
    set((s) => ({ cards: { ...s.cards, [id]: updated } }));
  },

  async deleteCard(id) {
    const card = get().cards[id];
    const project = card ? get().projectsById[card.projectId] : null;

    // 1. Kill any live agent process for this card. Without this,
    //    `git worktree remove` can fail on macOS because the child
    //    still has the worktree dir open.
    if (get().runningCardIds.has(id)) {
      try {
        await api.agentAbort(id);
      } catch {
        /* best-effort — backend may have already cleaned up */
      }
      // Tear down our local subscription so the exit handler (which
      // expects the card to still exist) doesn't run after we wipe it
      // from state below.
      const sub = subscriptions.get(id);
      if (sub) {
        sub.logUnlisten();
        sub.exitUnlisten();
        subscriptions.delete(id);
      }
    }

    // 2. Remove the worktree while the card metadata still exists. This
    //    used to run fire-and-forget after deleting the DB row, which
    //    made failures invisible and left orphaned worktrees on disk.
    //    Close card-owned terminal tabs first so no PTY keeps the cwd
    //    open while `git worktree remove --force` walks the directory.
    if (project && card?.worktreePath) {
      const worktreeAbs = card.worktreePath.startsWith("/")
        ? card.worktreePath
        : `${project.repoPath}/${card.worktreePath}`;
      closeTerminalTabsForWorktree(worktreeAbs);
      await api.worktreeRemove(
        project.repoPath,
        card.worktreePath,
        card.branchName,
      );
    }

    // 3. Drop the card from the DB after disk cleanup succeeds.
    await api.deleteCard(id);

    // 4. Remove from local state immediately so the UI updates.
    set((s) => {
      const cards = { ...s.cards };
      delete cards[id];
      const col = card
        ? s.cardIdsByColumn[card.columnId].filter((x) => x !== id)
        : [];
      const cardIdsByColumn = card
        ? { ...s.cardIdsByColumn, [card.columnId]: col }
        : s.cardIdsByColumn;
      const running = new Set(s.runningCardIds);
      running.delete(id);
      const next: Partial<State> = { cards, cardIdsByColumn, runningCardIds: running };
      if (s.selectedCardId === id) next.selectedCardId = null;
      return next as State;
    });

    // 5. Slot may have freed up — promote the next queued card.
    drainQueue(set, get);
  },

  async moveCardTo(id, column, position) {
    const card = get().cards[id];
    if (!card) return;
    const updated = await api.moveCard(id, column, position);
    relocateCard(set, card, updated);
    // Clear any prior setup-failed flag whenever the card lands in a
    // different column — the user is signaling "let me try again" by
    // moving it. Dragging back-into-To-Do from Backlog therefore
    // re-enables drainQueue for this card.
    if (card.columnId !== column) {
      set((s) => {
        if (!s.setupFailedCardIds.has(id)) return s;
        const next = new Set(s.setupFailedCardIds);
        next.delete(id);
        return { setupFailedCardIds: next };
      });
    }
    // To Do is a queue — agents only spawn when In Progress has a free
    // slot (capped at MAX_CONCURRENT). The queue drain runs after every
    // To Do landing AND after every In Progress exit (see the exit
    // handler in spawnAgentForCard).
    if (column === "todo") {
      drainQueue(set, get);
    }
  },

  async enqueueFollowUp(id, extraPrompt) {
    const card = get().cards[id];
    if (!card) return;
    const trimmed = extraPrompt.trim();
    // Snapshot the worktree path BEFORE the move so we can spin off the
    // terminal cleanup after the UI update. Re-prompting from Review
    // (or any post-worktree column) means the user wants the agent to
    // re-execute against a clean shell environment — leaving the dev
    // server, prisma db push, etc. running would let those processes
    // race the agent on the same filesystem and produce confusing
    // output. The cleanup is fire-and-forget so the chat-send latency
    // doesn't include closing a handful of PTYs.
    const worktreeForCleanup = card.worktreePath;
    const projectForCleanup = get().projectsById[card.projectId];
    // Stash the prompt FIRST (under the card id) so that whoever ends
    // up calling `spawnAgentForCard` for this card — either the move
    // landing in To Do below, or the next `drainQueue` tick — picks it
    // up. If a previous pending prompt was still waiting (user fired
    // two follow-ups before the queue drained), append them with a
    // blank line so neither is lost.
    if (trimmed) {
      set((s) => {
        const existing = s.pendingFollowUpByCardId[id];
        const merged = existing ? `${existing}\n\n${trimmed}` : trimmed;
        return {
          pendingFollowUpByCardId: {
            ...s.pendingFollowUpByCardId,
            [id]: merged,
          },
        };
      });
    }
    // Re-running from Review (or any other column) goes through the
    // queue: never spawn directly. If the card is already in To Do
    // (the user double-sent), we just rely on drainQueue picking it up
    // — the moveCard IPC is a no-op anyway.
    if (card.columnId !== "todo") {
      try {
        const moved = await api.moveCard(id, "todo");
        relocateCard(set, card, moved);
      } catch (err) {
        // Don't strand the pending prompt if the move IPC failed.
        set((s) => {
          const next = { ...s.pendingFollowUpByCardId };
          delete next[id];
          return { pendingFollowUpByCardId: next };
        });
        throw err;
      }
    }
    drainQueue(set, get);

    // Fire-and-forget terminal cleanup. We do this AFTER drainQueue +
    // the state update above so the chat composer feels instant — the
    // worktree cleanup runs on the next macrotask without blocking the
    // UI. Scope: every tab whose cwd is inside `worktreeAbs` (dev
    // server, db push, custom scripts, the agent's own shell — all of
    // them). The repo-store action also unmounts the pane which fires
    // `term_close` (kills the PTY child + drops the master).
    if (worktreeForCleanup && projectForCleanup) {
      const worktreeAbs = worktreeForCleanup.startsWith("/")
        ? worktreeForCleanup
        : `${projectForCleanup.repoPath}/${worktreeForCleanup}`;
      closeTerminalTabsForWorktree(worktreeAbs);
    }
  },

  async abortCard(id) {
    await api.agentAbort(id);
  },

  async approveCard(id) {
    const card = get().cards[id];
    const project = card ? get().projectsById[card.projectId] : null;
    if (!project || !card) {
      throw new Error("Card or project missing");
    }
    if (!card.worktreePath || !card.branchName || !card.baseBranch) {
      throw new Error("Card has no worktree to push from");
    }
    const worktreeAbs = card.worktreePath.startsWith("/")
      ? card.worktreePath
      : `${project.repoPath}/${card.worktreePath}`;

    // Flag the card as approving so the detail drawer's button + the
    // CardTile's status indicator can show a spinner. The flag clears
    // in `finally` so a failed push doesn't leave the UI stuck.
    set((s) => {
      const next = new Set(s.approvingCardIds);
      next.add(id);
      return { approvingCardIds: next };
    });
    try {
      // Only commit if there are tracked-file changes pending. `??` lines
      // in porcelain are untracked files — we intentionally don't sweep
      // those into the PR (matching git_commit_all's `-am`-only
      // behavior). Skipping the commit when nothing is tracked-dirty
      // also avoids git's "nothing to commit" error short-circuiting
      // the push.
      const status = await api.gitStatusPorcelain(worktreeAbs);
      const trackedDirty = status.some((s) => s.status !== "untracked");
      if (trackedDirty) {
        await api.gitCommitAll(worktreeAbs, `dispatch: ${card.title}`);
      }

      await api.gitPush(worktreeAbs, true);

      const [log, diff] = await Promise.all([
        aiApi.getLogForAi(worktreeAbs, "branch").catch(() => ""),
        aiApi.getDiffForAi(worktreeAbs, "branch").catch(() => ""),
      ]);
      const fallbackTitle = `Resumo de alterações da branch`;
      const fallbackBody = fallbackDevelopmentPrBody(diff, log);
      const repoPrPrompt =
        useRepoStore.getState().settings.aiSystemPrompts.pr ?? "";
      const cliCandidates = [
        useRepoStore.getState().settings.preferredAiCli,
        card.agent,
      ].filter((id, idx, arr): id is string =>
        Boolean(id) && arr.indexOf(id) === idx,
      );
      let draft = { title: fallbackTitle, body: fallbackBody };
      for (const cliId of cliCandidates) {
        try {
          const raw = await aiApi.runAiCli(
            cliId,
            buildDevelopmentPrPrompt(log, diff, repoPrPrompt),
            worktreeAbs,
          );
          draft = parseDevelopmentPrDraft(raw, fallbackTitle, fallbackBody);
          break;
        } catch {
          // Fall through to the next available CLI and finally to the
          // deterministic summary so approving a card can still open a PR.
        }
      }

      const prUrl = await api.ghPrCreate(
        worktreeAbs,
        draft.title,
        draft.body,
        card.baseBranch,
        card.branchName,
      );

      const updated = await api.updateCard(id, { prUrl });
      set((s) => ({ cards: { ...s.cards, [id]: updated } }));
      const moved = await api.moveCard(id, "done");
      relocateCard(set, updated, moved);
      closeTerminalTabsForWorktree(worktreeAbs);
      return prUrl;
    } finally {
      set((s) => {
        const next = new Set(s.approvingCardIds);
        next.delete(id);
        return { approvingCardIds: next };
      });
    }
  },

  async archiveCard(id) {
    const card = get().cards[id];
    const project = card ? get().projectsById[card.projectId] : null;
    if (!project || !card) return;
    set((s) => {
      const next = new Set(s.archivingCardIds);
      next.add(id);
      return { archivingCardIds: next };
    });
    try {
      if (card.worktreePath) {
        const worktreeAbs = card.worktreePath.startsWith("/")
          ? card.worktreePath
          : `${project.repoPath}/${card.worktreePath}`;
        closeTerminalTabsForWorktree(worktreeAbs);
        await api.worktreeRemove(project.repoPath, card.worktreePath).catch(() => {
          /* worktree may already be gone; non-fatal */
        });
      }
      const cleared = await api.clearCardWorktree(id);
      set((s) => ({ cards: { ...s.cards, [id]: cleared } }));
    } finally {
      set((s) => {
        const next = new Set(s.archivingCardIds);
        next.delete(id);
        return { archivingCardIds: next };
      });
    }
  },

  selectCard(id) {
    writeSelectedCardId(id);
    set({ selectedCardId: id });
  },

  setNewCardOpen(open) {
    writeNewCardOpen(open);
    set({ newCardOpen: open, newCardProjectId: open ? get().newCardProjectId : null });
  },

  openNewCardForProject(projectId) {
    writeNewCardOpen(true);
    set({ newCardOpen: true, newCardProjectId: projectId });
  },

  setDraggingCardId(id) {
    set({ draggingCardId: id });
  },
}));

/**
 * Pop cards from To Do into In Progress until we hit the
 * MAX_CONCURRENT_AGENTS cap. Called whenever (a) a card lands in To Do
 * or (b) an in-flight run exits / aborts. Each promoted card spawns its
 * agent; the agent's own first-log event will then move the card from
 * To Do to In Progress in the UI (we don't pre-move so the visual
 * matches the actual agent lifecycle).
 *
 * Ordering: priority first (high > med > low), then position (older =
 * lower position wins). Two `med` cards added back-to-back run in the
 * order the user enqueued them; a freshly-added `high` card jumps the
 * queue over older `med`/`low` cards still waiting.
 */
const PRIORITY_WEIGHT: Record<string, number> = {
  high: 3,
  med: 2,
  low: 1,
};

function drainQueue(
  set: (
    partial: Partial<State> | ((s: State) => Partial<State>),
  ) => void,
  get: () => State,
): void {
  const state = get();
  // We count "in-flight" by `runningCardIds` rather than the In Progress
  // column. A card in Review whose agent is mid-re-run still occupies a
  // slot; a card sitting in In Progress with no live process doesn't.
  const inFlight = state.runningCardIds.size;
  const free = Math.max(0, MAX_CONCURRENT_AGENTS - inFlight);
  if (free === 0) return;
  const queue = state.cardIdsByColumn.todo
    .map((id) => state.cards[id])
    .filter((c): c is NonNullable<typeof c> => Boolean(c))
    .filter((c) => !state.runningCardIds.has(c.id))
    // Cards whose setup just failed sit out the queue until the user
    // moves them out of To Do (clears the flag in `moveCardTo`).
    .filter((c) => !state.setupFailedCardIds.has(c.id))
    .sort((a, b) => {
      const pa = PRIORITY_WEIGHT[a.priority] ?? 0;
      const pb = PRIORITY_WEIGHT[b.priority] ?? 0;
      if (pa !== pb) return pb - pa; // higher priority first
      return a.position - b.position; // FIFO within same priority
    })
    .slice(0, free);
  for (const card of queue) {
    void spawnAgentForCard(set, get, card);
  }
}

function relocateCard(
  set: (
    partial:
      | Partial<State>
      | ((s: State) => Partial<State>),
  ) => void,
  // `prev` is kept for API compatibility but the body no longer trusts
  // its `columnId` for the cards-by-column map (a captured-then-stale
  // `prev` was leaving the card duplicated across two columns; we now
  // remove the id from EVERY column before appending). We DO still read
  // `prev.columnId` for the notification edge-detect below — there it's
  // OK if it's slightly stale: the worst case is firing or skipping one
  // duplicate notification, never a wrong card state.
  prev: Card,
  next: Card,
) {
  set((s) => {
    const cards = { ...s.cards, [next.id]: next };
    const cardIdsByColumn = { ...s.cardIdsByColumn };
    for (const col of Object.keys(cardIdsByColumn) as BoardColumnId[]) {
      cardIdsByColumn[col] = cardIdsByColumn[col].filter(
        (x) => x !== next.id,
      );
    }
    const target = cardIdsByColumn[next.columnId];
    target.push(next.id);
    target.sort((a, b) => (cards[a]?.position ?? 0) - (cards[b]?.position ?? 0));
    cardIdsByColumn[next.columnId] = target;
    return { cards, cardIdsByColumn };
  });

  // Single notification choke point: every column transition lands here,
  // so we can centralise the OS-notification dispatch instead of
  // sprinkling calls across spawnAgentForCard / exit handler / approve.
  // Reads the *latest* settings from the repo store so toggling a pref
  // takes effect immediately without remounting any subscriber.
  if (prev.columnId !== next.columnId) {
    const repoState = useRepoStore.getState();
    const projectName =
      useBoardStore.getState().projectsById[next.projectId]?.name ?? null;
    notifyCardTransition(next, prev.columnId, repoState.settings, {
      projectName,
      prUrl: next.prUrl,
    });
  }
}

/**
 * Run the project's `setup_script` inside the freshly created worktree
 * and resolve when it exits. Opens a read-only "Setup: <project>" tab in
 * the integrated terminal so the user can watch `bun install` etc happen
 * live. Throws on non-zero exit so the agent spawn aborts and the card
 * can be reverted to backlog.
 */
async function runProjectSetup(
  project: Project,
  worktreeAbs: string,
): Promise<void> {
  const runId =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `setup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Open the terminal tab FIRST so the pane mounts and starts listening
  // for `setup://run/<id>/data` before the spawn produces output. The
  // store action also opens the drawer if it was hidden. We hold onto
  // the tab id so we can auto-close it on success — the user doesn't
  // need to see `bun install` output for the dozenth time.
  const tabId = useRepoStore.getState().openTerminalTab({
    cwd: worktreeAbs,
    title: `Setup: ${project.name}`,
    setupRunId: runId,
  });

  // We need to subscribe to the exit event from the *store* too, since
  // the pane only updates its own xterm. Set up the listener before
  // invoking the command so we never miss the event.
  const exitPromise = new Promise<api.SetupExitEvent>((resolve) => {
    void api.listenSetupExit(runId, (event) => {
      resolve(event);
    });
  });

  // Yield a frame so the React tree mounts the pane (and its data
  // listener) before the script starts emitting.
  await new Promise<void>((r) => requestAnimationFrame(() => r()));

  await api.setupRunStart(runId, project.id, worktreeAbs);

  const exit = await exitPromise;
  if (exit.code !== 0) {
    const detail =
      exit.code === null ? exit.reason : `exit code ${exit.code}`;
    // Failure: keep the tab open so the user can read the error.
    throw new Error(`Setup script failed (${detail}) — see the Setup tab in the terminal.`);
  }
  // Success: dismiss the Setup tab after a brief beat so the user
  // catches the green "✓ setup finished" line. If this was the only
  // tab, `closeTerminalTab` also hides the drawer (see store).
  setTimeout(() => {
    useRepoStore.getState().closeTerminalTab(tabId);
  }, 1200);
}

/**
 * The core orchestration: ensure a worktree exists for the card, persist
 * the worktree metadata on the card, start the agent process, and
 * subscribe to its log/exit stream. The card's own `agent://card/<id>/exit`
 * handler is what moves it to Review on success.
 */
async function spawnAgentForCard(
  set: (
    partial: Partial<State> | ((s: State) => Partial<State>),
  ) => void,
  get: () => State,
  card: Card,
  explicitExtraPrompt?: string,
): Promise<void> {
  const project = get().projectsById[card.projectId];
  if (!project) return;

  // Already running — don't double-spawn.
  if (subscriptions.has(card.id)) return;

  // Consume any pending follow-up the user enqueued from the chat in
  // the detail view. We pull-and-clear atomically so a retry (e.g. on
  // setup failure) doesn't replay the same extra instructions twice.
  // The caller can also pass `explicitExtraPrompt` directly — that path
  // is unused right now but kept so internal callers don't have to
  // round-trip through the store map.
  const pendingFollowUp = get().pendingFollowUpByCardId[card.id];
  const extraPrompt = explicitExtraPrompt ?? pendingFollowUp;
  if (pendingFollowUp !== undefined) {
    set((s) => {
      if (!(card.id in s.pendingFollowUpByCardId)) return s;
      const next = { ...s.pendingFollowUpByCardId };
      delete next[card.id];
      return { pendingFollowUpByCardId: next };
    });
  }

  // Mark the card as in-flight BEFORE the slow IPC sequence
  // (worktreeAdd → setup script → agentStart can run 5-30s combined).
  // Without this the card sits in To Do with no spinner during that
  // whole window and reads as "stuck". `runningCardIds` is what
  // CardTile uses for the spinner; we clear it in the catch path on
  // failure and the exit handler on normal completion.
  set((s) => {
    const running = new Set(s.runningCardIds);
    running.add(card.id);
    return { runningCardIds: running };
  });

  // Wrap the rest in try/catch so any failure (git error, agent CLI
  // not found, network blip) shows up as a toast instead of vanishing
  // silently — the card would otherwise sit in To Do forever, with
  // spinner on, but no agent attached.
  try {
    await runSpawnSteps();
  } catch (err) {
    // Roll back the in-flight flag and surface the error.
    set((s) => {
      const running = new Set(s.runningCardIds);
      running.delete(card.id);
      return { runningCardIds: running };
    });
    const message =
      err instanceof Error ? err.message : String(err);
    useRepoStore
      .getState()
      .pushToast(
        `Failed to start ${card.title}: ${message}`,
        "danger",
      );
  }

  // The actual spawn body lives in a local function so the catch above
  // can wrap everything cleanly. Closures over the same params; no
  // behavior change other than the error path.
  async function runSpawnSteps(): Promise<void> {

  // Resolve worktree + branch on first run; reuse them on subsequent runs.
  let worktreePath = card.worktreePath;
  let branchName = card.branchName;
  let baseBranch = card.baseBranch;
  let isFirstRun = false;
  if (!worktreePath || !branchName) {
    isFirstRun = true;
    worktreePath = defaultWorktreePath(card);
    branchName = defaultBranchName(card);
    // Resolve base in priority order:
    //   1. What the user picked in the New Card dialog (card.baseBranch)
    //   2. The project's tracked default (set when the repo was added)
    //   3. Literal "main" as a last-ditch fallback
    // We keep #2 + #3 so cards created before the picker shipped still
    // spawn fine — `card.baseBranch` is just NULL for them.
    baseBranch = card.baseBranch ?? project.defaultBase ?? "main";
    await api.worktreeAdd(
      project.repoPath,
      branchName,
      baseBranch,
      worktreePath,
    );
    const updated = await api.updateCard(card.id, {
      worktreePath,
      branchName,
      baseBranch,
    });
    set((s) => ({ cards: { ...s.cards, [updated.id]: updated } }));
  }

  // Setup script: only on first run (subsequent re-runs reuse the
  // worktree, so deps are already installed). On non-zero exit we keep
  // the card in To Do and add it to `setupFailedCardIds` so
  // `drainQueue` doesn't retry forever — user has to either fix the
  // setup script and drag the card away+back, or drop it to Backlog
  // to clear. The terminal drawer is already open on the Setup tab
  // (`runProjectSetup` ensures that) so the user can read the error
  // output directly.
  if (isFirstRun && project.setupScript && project.setupScript.trim()) {
    const setupAbs = worktreePath.startsWith("/")
      ? worktreePath
      : `${project.repoPath}/${worktreePath}`;
    try {
      await runProjectSetup(project, setupAbs);
    } catch (err) {
      const repoStore = useRepoStore.getState();
      const message =
        err instanceof Error ? err.message : String(err);
      repoStore.pushToast(
        `Setup failed for ${card.title}: ${message}`,
        "danger",
      );
      // Mark as setup-failed AND clear the in-flight spinner (we added
      // it at the top of spawnAgentForCard). Without this clear the
      // card would show a spinner forever even though no agent runs.
      set((s) => {
        const failed = new Set(s.setupFailedCardIds);
        failed.add(card.id);
        const running = new Set(s.runningCardIds);
        running.delete(card.id);
        return {
          setupFailedCardIds: failed,
          runningCardIds: running,
        };
      });
      return;
    }
  }

  // Scope constraints prepended to every run. Both Claude Code and
  // Codex respect this kind of instruction in their non-interactive
  // prompts. The constraints exist because Approve → PR will push every
  // tracked-file change in the worktree to a branch and open a PR; if
  // the agent touches unrelated files, that PR ships unrelated changes.
  const SCOPE_PREAMBLE = [
    "You are working in an isolated git worktree on a single focused task.",
    "Whatever tracked files you modify will be committed and shipped as a PR when the human approves.",
    "",
    "Constraints:",
    "- Only edit files that are strictly required to complete the task below.",
    "- Do NOT touch unrelated files, configs, dependencies, or formatting in code you didn't need to change.",
    "- Do NOT leave generated artifacts, logs, scratch files, or build outputs in the worktree.",
    "- If you need to create a new file as part of the task, `git add` it so it's included in the commit. Anything you don't stage will be left behind.",
    "- If the task is ambiguous, pick the smallest-scope interpretation.",
  ].join("\n");

  const taskBody = `# Task\n${card.title}\n\n${card.description}`;
  const extraSection = extraPrompt
    ? `\n\n# Additional instructions\n${extraPrompt}`
    : "";

  const worktreeAbs = worktreePath.startsWith("/")
    ? worktreePath
    : `${project.repoPath}/${worktreePath}`;

  // Stage any pinned attachments into the worktree so the agent can
  // read them from a known relative path. We do this before spawning so
  // the prompt below can list them by name.
  let attachmentSection = "";
  try {
    const names = await api.attachmentStageForRun(card.id, worktreeAbs);
    if (names.length > 0) {
      attachmentSection =
        "\n\n# Reference attachments\n" +
        "The following files are available under `.dispatch/attachments/` in the worktree. " +
        "Open them with your file-reading tool when you need to consult them:\n" +
        names.map((n) => `- \`.dispatch/attachments/${n}\``).join("\n");
    }
  } catch {
    /* attachment staging is non-fatal — the agent still gets the task */
  }

  const prompt = `${SCOPE_PREAMBLE}\n\n${taskBody}${attachmentSection}${extraSection}`;

  const { runId } = await api.agentStart(
    card.id,
    prompt,
    card.agent,
    worktreeAbs,
  );

  // `runningCardIds` was already added at the top of spawnAgentForCard
  // so the spinner appeared during the slow IPC sequence. Here we just
  // seed the empty log array for this run so the modal has a stable
  // selector key when the agent emits its first batch.
  set((s) => ({
    logsByRun: { ...s.logsByRun, [runId]: [] },
  }));
  // Refresh run history so the drawer's "runs" tab picks up the new entry.
  get().reloadRuns(card.id);

  // Move the card to In Progress AS SOON AS the agent process is
  // spawned — we used to wait for the first log byte, but some CLIs
  // (codex in particular) can take 10–30s to produce their first line
  // while warming up the model. During that window the card stayed in
  // To Do with a spinner, which read as "stuck." The agent IS running
  // by this point (`agent_start` resolved), so the column should
  // reflect that immediately.
  const cardNow = get().cards[card.id];
  if (cardNow && cardNow.columnId === "todo") {
    api
      .moveCard(card.id, "in_progress")
      .then((next) => relocateCard(set, cardNow, next))
      .catch(() => {
        /* ignored — store will reconcile on next reload */
      });
  }

  const logUnlisten = await api.listenAgentLog(card.id, (e: AgentLogEvent) => {
    bufferLog(set, {
      // The streaming event doesn't carry a stable id (those come from
      // the DB on reload). Synthesize a negative id so it can't collide
      // with persisted rows.
      id: -Date.now() - Math.floor(Math.random() * 1000),
      runId: e.runId,
      ts: e.ts,
      stream: e.stream,
      line: e.line,
    });
    // Safety net: if the immediate promotion above lost a race against
    // a slow IPC reply, the first log still flips the column. (No
    // harm if it's already past To Do — the check guards that.)
    {
      const current = get().cards[card.id];
      if (current && current.columnId === "todo") {
        api
          .moveCard(card.id, "in_progress")
          .then((next) => relocateCard(set, current, next))
          .catch(() => {
            /* ignored */
          });
      }
    }
  });

  const exitUnlisten = await api.listenAgentExit(
    card.id,
    (_e: AgentExitEvent) => {
      const sub = subscriptions.get(card.id);
      if (sub) {
        sub.logUnlisten();
        sub.exitUnlisten();
        subscriptions.delete(card.id);
      }
      set((s) => {
        const running = new Set(s.runningCardIds);
        running.delete(card.id);
        return { runningCardIds: running };
      });
      get().reloadRuns(card.id);

      // Any exit — clean, killed, idle_timeout, or error — advances the
      // card to Review. Even an aborted run produced *something* worth
      // looking at (logs, partial worktree state, error message), and
      // Review is where the user inspects + decides whether to retry
      // via the chat composer. Leaving aborted runs in In Progress
      // stranded them with no obvious next step.
      const cur = get().cards[card.id];
      if (cur && cur.columnId !== "review") {
        api
          .moveCard(card.id, "review")
          .then((next) => relocateCard(set, cur, next))
          .catch((err) => {
            // Surface so we don't silently strand the card in In
            // Progress again (that was the migration-mismatch bug).
            console.error("[agent exit] move to review failed:", err);
            useRepoStore
              .getState()
              .pushToast(
                `Failed to move card to Review: ${
                  err instanceof Error ? err.message : String(err)
                }`,
                "danger",
              );
          });
      }
      // A slot freed up — promote the next queued card if any.
      drainQueue(set, get);
    },
  );

  subscriptions.set(card.id, { logUnlisten, exitUnlisten, runId });
  }
}
