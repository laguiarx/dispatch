import type { FontPreset, MonoPreset, Theme } from "./theme";

const LAST_REPO_KEY = "ai-code-review:last-repo";
const RECENT_REPOS_KEY = "ai-code-review:recent-repos";
const SETTINGS_KEY = "ai-code-review:settings";

const MAX_RECENT = 10;

export type RecentRepo = {
  path: string;
  name: string;
  branch: string;
  openedAt: number;
};

export type Density = "compact" | "cozy";

export type DiffExpansion = "full" | "hunks";

export type SearchView = "list" | "tree";

/**
 * Caret style inside the in-app editor. `block` = wider block-shaped
 * caret (terminal-like, default). `blink` = the standard thin bar that
 * the OS blinks at its configured rate.
 */
export type EditorCursor = "block" | "blink";

export type Settings = {
  theme: Theme;
  density: Density;
  autoOpenLast: boolean;
  diffExpansion: DiffExpansion;
  searchView: SearchView;
  editorCursor: EditorCursor;
  leftSidebarVisible: boolean;
  rightSidebarVisible: boolean;
  leftSidebarWidth: number;
  rightSidebarWidth: number;
  /** ID of the user's preferred external editor (e.g. "vscode", "zed"). */
  preferredEditor: string | null;
  /** ID of the user's preferred AI CLI ("claude" or "codex"). */
  preferredAiCli: string | null;
  /** Whether the first-run onboarding tour has been completed. */
  firstRunCompleted: boolean;
  /** UI font preset (one of the bundled presets or "custom"). */
  uiFont: FontPreset;
  /** Code font preset. */
  codeFont: MonoPreset;
  /** Free-form font name when `uiFont === "custom"`. */
  customUiFont: string;
  /** Free-form font name when `codeFont === "custom"`. */
  customCodeFont: string;
  /**
   * Per-variable color overrides applied on top of the active theme. Keys
   * match the CSS variable suffix (e.g. "accent" → `--accent`). Empty means
   * "use theme defaults".
   */
  customColors: Record<string, string>;
  /**
   * User-provided "system" / instruction prompts prepended to each AI
   * action's built-in prompt. Empty string = no extra instructions, use
   * the built-in default. Keyed by AI action id (`commit` / `pr` /
   * `summary` / `risk` / `branch`).
   */
  aiSystemPrompts: {
    commit: string;
    pr: string;
    summary: string;
    risk: string;
    branch: string;
  };
};

const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  density: "cozy",
  autoOpenLast: true,
  diffExpansion: "full",
  searchView: "list",
  editorCursor: "block",
  leftSidebarVisible: true,
  rightSidebarVisible: true,
  leftSidebarWidth: 280,
  rightSidebarWidth: 296,
  preferredEditor: null,
  preferredAiCli: null,
  firstRunCompleted: false,
  uiFont: "inter",
  codeFont: "jetbrains",
  customUiFont: "",
  customCodeFont: "",
  customColors: {},
  aiSystemPrompts: {
    commit: "",
    pr: "",
    summary: "",
    risk: "",
    branch: "",
  },
};

/**
 * Minimum sidebar width — enough to keep the Changes filter row legible
 * (search input + status-filter dropdown + counts all visible). Smaller
 * than this and the resize handle clamps; the resize-handle's own
 * COLLAPSE_THRESHOLD then folds the sidebar entirely instead of squishing.
 */
export const SIDEBAR_MIN_WIDTH = 260;
export const SIDEBAR_MAX_WIDTH = 600;

// ---------- last repo (auto-open) ----------

export function readLastRepoPath(): string | null {
  try {
    return localStorage.getItem(LAST_REPO_KEY);
  } catch {
    return null;
  }
}

export function writeLastRepoPath(path: string | null): void {
  try {
    if (path) localStorage.setItem(LAST_REPO_KEY, path);
    else localStorage.removeItem(LAST_REPO_KEY);
  } catch {
    /* ignore */
  }
}

// ---------- recent repos ----------

export function readRecentRepos(): RecentRepo[] {
  try {
    const raw = localStorage.getItem(RECENT_REPOS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (r): r is RecentRepo =>
        r &&
        typeof r === "object" &&
        typeof r.path === "string" &&
        typeof r.name === "string",
    );
  } catch {
    return [];
  }
}

function writeRecentRepos(list: RecentRepo[]): void {
  try {
    localStorage.setItem(RECENT_REPOS_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

export function pushRecentRepo(entry: Omit<RecentRepo, "openedAt">): RecentRepo[] {
  const now = Date.now();
  const existing = readRecentRepos().filter((r) => r.path !== entry.path);
  const next: RecentRepo[] = [{ ...entry, openedAt: now }, ...existing].slice(
    0,
    MAX_RECENT,
  );
  writeRecentRepos(next);
  return next;
}

export function removeRecentRepo(path: string): RecentRepo[] {
  const next = readRecentRepos().filter((r) => r.path !== path);
  writeRecentRepos(next);
  return next;
}

export function clearRecentRepos(): void {
  writeRecentRepos([]);
}

// ---------- settings ----------

export function readSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const validThemes: Theme[] = [
      "dark",
      "light",
      "midnight",
      "vercel",
      "supabase",
      "catppuccin",
      "tokyo-night",
    ];
    const validUiFonts: FontPreset[] = ["inter", "geist", "system", "custom"];
    const validCodeFonts: MonoPreset[] = [
      "jetbrains",
      "geist-mono",
      "system",
      "custom",
    ];
    const colors =
      parsed.customColors &&
      typeof parsed.customColors === "object" &&
      !Array.isArray(parsed.customColors)
        ? Object.fromEntries(
            Object.entries(parsed.customColors).filter(
              ([, v]) => typeof v === "string",
            ),
          )
        : {};
    return {
      theme:
        typeof parsed.theme === "string" &&
        (validThemes as string[]).includes(parsed.theme)
          ? (parsed.theme as Theme)
          : "dark",
      // Density used to be user-selectable (compact / cozy) but the toggle
      // only affected the file-row height, which felt fragmented. We now
      // force `cozy` everywhere and ignore whatever the legacy prefs say.
      density: "cozy",
      autoOpenLast: typeof parsed.autoOpenLast === "boolean" ? parsed.autoOpenLast : true,
      diffExpansion: parsed.diffExpansion === "hunks" ? "hunks" : "full",
      searchView: parsed.searchView === "tree" ? "tree" : "list",
      editorCursor: parsed.editorCursor === "blink" ? "blink" : "block",
      leftSidebarVisible:
        typeof parsed.leftSidebarVisible === "boolean"
          ? parsed.leftSidebarVisible
          : true,
      rightSidebarVisible:
        typeof parsed.rightSidebarVisible === "boolean"
          ? parsed.rightSidebarVisible
          : true,
      leftSidebarWidth: clampWidth(parsed.leftSidebarWidth, 280),
      rightSidebarWidth: clampWidth(parsed.rightSidebarWidth, 296),
      preferredEditor:
        typeof parsed.preferredEditor === "string"
          ? parsed.preferredEditor
          : null,
      preferredAiCli:
        typeof parsed.preferredAiCli === "string"
          ? parsed.preferredAiCli
          : null,
      firstRunCompleted:
        typeof parsed.firstRunCompleted === "boolean"
          ? parsed.firstRunCompleted
          : false,
      uiFont:
        typeof parsed.uiFont === "string" &&
        (validUiFonts as string[]).includes(parsed.uiFont)
          ? (parsed.uiFont as FontPreset)
          : "inter",
      codeFont:
        typeof parsed.codeFont === "string" &&
        (validCodeFonts as string[]).includes(parsed.codeFont)
          ? (parsed.codeFont as MonoPreset)
          : "jetbrains",
      customUiFont:
        typeof parsed.customUiFont === "string" ? parsed.customUiFont : "",
      customCodeFont:
        typeof parsed.customCodeFont === "string"
          ? parsed.customCodeFont
          : "",
      customColors: colors as Record<string, string>,
      aiSystemPrompts: readPromptMap(parsed.aiSystemPrompts),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function writeSettings(settings: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
}

function readPromptMap(
  raw: unknown,
): Settings["aiSystemPrompts"] {
  const empty: Settings["aiSystemPrompts"] = {
    commit: "",
    pr: "",
    summary: "",
    risk: "",
    branch: "",
  };
  if (!raw || typeof raw !== "object") return empty;
  const src = raw as Record<string, unknown>;
  return {
    commit: typeof src.commit === "string" ? src.commit : "",
    pr: typeof src.pr === "string" ? src.pr : "",
    summary: typeof src.summary === "string" ? src.summary : "",
    risk: typeof src.risk === "string" ? src.risk : "",
    branch: typeof src.branch === "string" ? src.branch : "",
  };
}

function clampWidth(raw: unknown, fallback: number): number {
  const n = typeof raw === "number" ? raw : fallback;
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, n));
}
