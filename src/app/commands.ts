import type { CommandItem } from "@/components/command-palette";
import { STATUS_META } from "@/components/icons";
import type { ChangedFile } from "@/features/git/git.types";
import type { AiKind } from "@/features/ai/ai.types";
import { THEME_PRESETS, type Theme } from "@/lib/theme";
import { basename, dirname } from "@/lib/utils";

type Deps = {
  files: ChangedFile[];
  selectedFilePath: string | null;
  theme: Theme;

  setTheme: (theme: Theme) => void;
  setSettingsOpen: (open: boolean) => void;
  selectFile: (path: string | null, staged?: boolean | null) => void;
  setSidebarTab: (tab: "changes" | "files") => void;
  toggleStage: (path: string) => Promise<void>;
  toggleReviewed: (path: string) => void;
  requestDiscard: (path: string) => void;
  refresh: () => Promise<void>;
  openSearchPanel: () => void;
  setReplaceOpen: (v: boolean) => void;
  openProjectInVscode: () => Promise<void>;
  setDiffMode: (m: "sbs" | "inline" | "edit") => void;
  setDiffExpansion: (v: "full" | "hunks") => void;
  setAiKind: (k: AiKind) => void;
  pushToast: (text: string) => void;
  /** Open the dedicated keyboard-shortcuts dialog. */
  openShortcuts: () => void;
  /** Re-open the first-run welcome tour. */
  openOnboarding: () => void;
};

const THEMES: { id: Theme; label: string }[] = THEME_PRESETS.map((t) => ({
  id: t.id,
  label: t.label,
}));

const AI_KINDS: AiKind[] = ["commit", "pr", "summary", "risk"];

/**
 * Build the **command palette** (⌘⇧P) items — actions only, no files.
 * Files are surfaced via {@link buildFileCommands} (⌘P).
 */
export function buildCommands(d: Deps): CommandItem[] {
  const selectedFile = d.files.find((f) => f.path === d.selectedFilePath);
  const commands: CommandItem[] = [];

  // Appearance
  commands.push({
    id: "preferences",
    name: "Open Preferences…",
    section: "Appearance",
    icon: "gear",
    keywords: "preferences settings options",
    kbd: ["⌘,"],
    run: () => d.setSettingsOpen(true),
  });
  commands.push({
    id: "open-shortcuts",
    name: "Show keyboard shortcuts",
    section: "Appearance",
    icon: "keyboard",
    keywords: "shortcuts keybindings hotkeys cheatsheet",
    run: () => d.openShortcuts(),
  });
  commands.push({
    id: "open-onboarding",
    name: "Show welcome tour",
    section: "Appearance",
    icon: "sparkles",
    keywords: "welcome tour onboarding intro tutorial integrations",
    run: () => d.openOnboarding(),
  });
  for (const th of THEMES) {
    commands.push({
      id: `theme-${th.id}`,
      name: `Switch theme: ${th.label}`,
      section: "Appearance",
      icon: "theme",
      keywords: "theme color dark light midnight",
      sub: th.id === d.theme ? "Current theme" : undefined,
      badge: th.id === d.theme ? "Active" : undefined,
      run: () => {
        d.setTheme(th.id);
        d.pushToast(`Theme: ${th.label}`);
      },
    });
  }

  // File-level
  commands.push({
    id: "stage",
    name: "Stage / unstage current file",
    section: "File",
    icon: "stage",
    keywords: "stage unstage git add",
    kbd: ["⌘↵"],
    run: () => {
      if (selectedFile) d.toggleStage(selectedFile.path);
    },
  });
  commands.push({
    id: "review",
    name: "Mark current file reviewed",
    section: "File",
    icon: "review",
    keywords: "review reviewed mark",
    kbd: ["⌘⇧M"],
    run: () => {
      if (selectedFile) d.toggleReviewed(selectedFile.path);
    },
  });
  commands.push({
    id: "edit",
    name: "Edit current file",
    section: "File",
    icon: "edit",
    keywords: "edit modify",
    kbd: ["⌘E"],
    run: () => {
      if (selectedFile) d.setDiffMode("edit");
    },
  });
  commands.push({
    id: "discard",
    name: "Discard changes to current file",
    section: "File",
    icon: "discard",
    keywords: "discard delete revert",
    kbd: ["⌘⌫"],
    run: () => {
      if (selectedFile) d.requestDiscard(selectedFile.path);
    },
  });

  // Git
  commands.push({
    id: "refresh",
    name: "Refresh git status",
    section: "Git",
    icon: "refresh",
    keywords: "refresh reload",
    kbd: ["⌘R"],
    run: () => {
      d.refresh();
    },
  });
  commands.push({
    id: "search",
    name: "Find in repository",
    section: "Git",
    icon: "search",
    keywords: "search find ripgrep",
    kbd: ["⌘⇧F"],
    run: () => d.openSearchPanel(),
  });
  commands.push({
    id: "replace",
    name: "Find & Replace",
    section: "Git",
    icon: "edit",
    keywords: "replace substitute",
    kbd: ["⌘⇧H"],
    run: () => d.setReplaceOpen(true),
  });
  commands.push({
    id: "open-vscode",
    name: "Open project in VS Code",
    section: "Git",
    icon: "code",
    keywords: "vscode code editor open",
    run: () => {
      d.openProjectInVscode();
    },
  });

  // AI
  for (const k of AI_KINDS) {
    const name =
      k === "commit"
        ? "Generate commit message"
        : k === "pr"
          ? "Draft PR description"
          : k === "summary"
            ? "Summarize this diff"
            : "Review risk";
    commands.push({
      id: `ai-${k}`,
      name: `AI: ${name}`,
      section: "AI",
      icon: "sparkles",
      keywords: `ai ${k}`,
      run: () => d.setAiKind(k),
    });
  }

  // View
  commands.push({
    id: "diff-sbs",
    name: "View: Side-by-side",
    section: "View",
    icon: "copy",
    keywords: "diff side by side",
    run: () => d.setDiffMode("sbs"),
  });
  commands.push({
    id: "diff-inline",
    name: "View: Inline",
    section: "View",
    icon: "copy",
    keywords: "diff inline",
    run: () => d.setDiffMode("inline"),
  });
  commands.push({
    id: "diff-full",
    name: "View: Full file (whole file with continuous numbers)",
    section: "View",
    icon: "copy",
    keywords: "full file expanded continuous",
    run: () => {
      d.setDiffExpansion("full");
      d.pushToast("Diff view: full file");
    },
  });
  commands.push({
    id: "diff-hunks",
    name: "View: Hunks only (changed regions)",
    section: "View",
    icon: "copy",
    keywords: "hunks chunks compact",
    run: () => {
      d.setDiffExpansion("hunks");
      d.pushToast("Diff view: hunks only");
    },
  });
  commands.push({
    id: "tab-changes",
    name: "View: Changes",
    section: "View",
    icon: "copy",
    keywords: "changes sidebar",
    kbd: ["⌘⌥G"],
    run: () => d.setSidebarTab("changes"),
  });
  commands.push({
    id: "tab-files",
    name: "View: File tree",
    section: "View",
    icon: "copy",
    keywords: "files tree sidebar",
    kbd: ["⌘⇧E"],
    run: () => d.setSidebarTab("files"),
  });

  return commands;
}

type FileDeps = {
  repoFiles: string[];
  changedFiles: ChangedFile[];
  selectFile: (path: string | null, staged?: boolean | null) => void;
  setSidebarTab: (tab: "changes" | "files") => void;
};

/**
 * Build the **file picker** (⌘P) items. Merges:
 *  - every changed file (with status decoration), surfaced first
 *  - every other file in the repository (gitignore-aware, cached)
 */
export function buildFileCommands(d: FileDeps): CommandItem[] {
  const changedByPath = new Map(d.changedFiles.map((f) => [f.path, f]));
  // de-dup: prefer the changed-file entry (so we get the status decoration)
  const seen = new Set<string>();
  const out: CommandItem[] = [];

  for (const f of d.changedFiles) {
    if (seen.has(f.path)) continue;
    seen.add(f.path);
    const meta = STATUS_META[f.status];
    out.push({
      id: `file-${f.path}`,
      name: basename(f.path),
      sub: dirname(f.path) || "/",
      section: "Changed files",
      icon: "file",
      keywords: f.path,
      badge: `${meta.letter}  +${f.additions} −${f.deletions}`,
      run: () => {
        d.selectFile(f.path, null);
        d.setSidebarTab("files");
      },
    });
  }

  for (const path of d.repoFiles) {
    if (seen.has(path)) continue;
    seen.add(path);
    const changed = changedByPath.get(path);
    out.push({
      id: `file-${path}`,
      name: basename(path),
      sub: dirname(path) || "/",
      section: "Files",
      icon: "file",
      keywords: path,
      run: () => {
        d.selectFile(path, null);
        d.setSidebarTab("files");
      },
      badge: changed
        ? `${STATUS_META[changed.status].letter}  +${changed.additions} −${changed.deletions}`
        : undefined,
    });
  }

  return out;
}
