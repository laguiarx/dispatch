import type { FontPreset, MonoPreset, Theme } from "./theme";

const RECENT_REPOS_KEY = "dispatch:recent-repos";
const SETTINGS_KEY = "dispatch:settings";

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

export type Settings = {
  theme: Theme;
  density: Density;
  diffExpansion: DiffExpansion;
  searchView: SearchView;
  /** Global UI zoom controlled by Cmd/Ctrl +/- shortcuts. */
  uiZoom: number;
  leftSidebarVisible: boolean;
  /** Workspace (project) sidebar shown next to the board. Distinct from
   * `leftSidebarVisible` which controls the diff-mode file list. */
  boardSidebarVisible: boolean;
  rightSidebarVisible: boolean;
  leftSidebarWidth: number;
  rightSidebarWidth: number;
  /**
   * Where the integrated terminal drawer docks. `"bottom"` is the
   * traditional VSCode layout (full-width strip under the main column).
   * `"right"` puts it next to the main column as a side panel — useful
   * when the user wants a wide diff/board AND a terminal at the same
   * time on a tall display.
   */
  terminalPosition: "bottom" | "right";
  /** Width of the right-docked terminal in px. Ignored when terminalPosition === "bottom". */
  terminalRightWidth: number;
  /** ID of the user's preferred external editor (e.g. "vscode", "zed"). */
  preferredEditor: string | null;
  /** ID of the user's preferred AI CLI ("codex" or "claude"). */
  preferredAiCli: string | null;
  /**
   * True after the old "first detected CLI" default has been migrated to
   * Codex. Keeps a user's later manual Claude choice from being overwritten
   * on every startup.
   */
  aiCliDefaultMigratedToCodex: boolean;
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
  /**
   * The last base branch the user picked when opening a PR, keyed by
   * absolute repo path. Lets the Create PR dialog default to "the branch
   * I always target in this repo" (e.g. `develop` in a GitFlow repo)
   * instead of falling back to `origin/HEAD` every time.
   */
  lastPrBaseByRepo: Record<string, string>;
  /**
   * Desktop notification preferences. Channel is currently fixed to the
   * OS notification center (via tauri-plugin-notification); the per-event
   * toggles let the user pick which board transitions actually fire one.
   * `enabled` is the master switch — when off, no notifications are
   * delivered regardless of the per-event flags.
   */
  notifications: {
    enabled: boolean;
    /** Card moved from To Do into In Progress (agent picked it up). */
    onInProgress: boolean;
    /** Agent finished and the card landed in Review (success, fail, or abort). */
    onReview: boolean;
    /** PR was opened — card is now in Done. */
    onPrOpened: boolean;
    /** Play a short system sound alongside the notification. */
    sound: boolean;
  };
};

const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  density: "cozy",
  diffExpansion: "hunks",
  searchView: "list",
  uiZoom: 1,
  leftSidebarVisible: true,
  boardSidebarVisible: true,
  rightSidebarVisible: true,
  leftSidebarWidth: 280,
  rightSidebarWidth: 296,
  terminalPosition: "bottom",
  terminalRightWidth: 480,
  preferredEditor: null,
  preferredAiCli: "codex",
  aiCliDefaultMigratedToCodex: true,
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
  lastPrBaseByRepo: {},
  notifications: {
    enabled: true,
    onInProgress: true,
    onReview: true,
    onPrOpened: true,
    sound: true,
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
      diffExpansion: parsed.diffExpansion === "full" ? "full" : "hunks",
      searchView: parsed.searchView === "tree" ? "tree" : "list",
      uiZoom:
        typeof parsed.uiZoom === "number" && Number.isFinite(parsed.uiZoom)
          ? Math.max(0.8, Math.min(1.5, Math.round(parsed.uiZoom * 10) / 10))
          : 1,
      leftSidebarVisible:
        typeof parsed.leftSidebarVisible === "boolean"
          ? parsed.leftSidebarVisible
          : true,
      boardSidebarVisible:
        typeof parsed.boardSidebarVisible === "boolean"
          ? parsed.boardSidebarVisible
          : true,
      rightSidebarVisible:
        typeof parsed.rightSidebarVisible === "boolean"
          ? parsed.rightSidebarVisible
          : true,
      leftSidebarWidth: clampWidth(parsed.leftSidebarWidth, 280),
      rightSidebarWidth: clampWidth(parsed.rightSidebarWidth, 296),
      terminalPosition:
        parsed.terminalPosition === "right" ? "right" : "bottom",
      terminalRightWidth:
        typeof parsed.terminalRightWidth === "number" &&
        Number.isFinite(parsed.terminalRightWidth)
          ? Math.max(280, Math.min(900, parsed.terminalRightWidth))
          : 480,
      preferredEditor:
        typeof parsed.preferredEditor === "string"
          ? parsed.preferredEditor
          : null,
      preferredAiCli:
        typeof parsed.preferredAiCli === "string"
          ? parsed.preferredAiCli
          : DEFAULT_SETTINGS.preferredAiCli,
      aiCliDefaultMigratedToCodex:
        typeof parsed.aiCliDefaultMigratedToCodex === "boolean"
          ? parsed.aiCliDefaultMigratedToCodex
          : false,
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
      lastPrBaseByRepo: readStringMap(parsed.lastPrBaseByRepo),
      notifications: readNotifications(parsed.notifications),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Read an unknown `Record<string, string>` defensively — used for the
 * `lastPrBaseByRepo` map (repo path → preferred PR base). Drops any
 * key/value pair that isn't strings. Returns an empty map if the input
 * isn't an object.
 */
function readStringMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k === "string" && typeof v === "string" && v.length > 0) {
      out[k] = v;
    }
  }
  return out;
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

/**
 * Read the persisted notifications preferences defensively. Older stored
 * `Settings` blobs predate this field; fall back to the default (notifications
 * enabled, all events on, sound on) so users upgrading the app aren't
 * silently opted out of the feature they didn't know about.
 */
function readNotifications(raw: unknown): Settings["notifications"] {
  const fallback: Settings["notifications"] = {
    enabled: true,
    onInProgress: true,
    onReview: true,
    onPrOpened: true,
    sound: true,
  };
  if (!raw || typeof raw !== "object") return fallback;
  const src = raw as Record<string, unknown>;
  const bool = (v: unknown, d: boolean) =>
    typeof v === "boolean" ? v : d;
  return {
    enabled: bool(src.enabled, fallback.enabled),
    onInProgress: bool(src.onInProgress, fallback.onInProgress),
    onReview: bool(src.onReview, fallback.onReview),
    onPrOpened: bool(src.onPrOpened, fallback.onPrOpened),
    sound: bool(src.sound, fallback.sound),
  };
}

function clampWidth(raw: unknown, fallback: number): number {
  const n = typeof raw === "number" ? raw : fallback;
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, n));
}
