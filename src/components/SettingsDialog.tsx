import { useState } from "react";
import { useRepoStore } from "@/features/repository/repository.store";
import type { DiffExpansion, SearchView } from "@/lib/paths";
import {
  THEME_PRESETS,
  TWEAKABLE_COLORS,
  type FontPreset,
  type MonoPreset,
} from "@/lib/theme";
import { cn } from "@/lib/utils";
import { I, type IconName } from "./Icons";
import { Kbd } from "./Kbd";
import { Overlay } from "./Overlay";

type TabId =
  | "appearance"
  | "fonts"
  | "colors"
  | "diff"
  | "ai"
  | "startup";

const TABS: { id: TabId; label: string; icon: IconName; hint: string }[] = [
  { id: "appearance", label: "Appearance", icon: "theme", hint: "Theme and density" },
  { id: "fonts", label: "Fonts", icon: "edit", hint: "UI and code fonts" },
  { id: "colors", label: "Colors", icon: "sparkles", hint: "Custom color overrides" },
  { id: "diff", label: "Diff", icon: "copy", hint: "How files render" },
  { id: "ai", label: "AI", icon: "sparkles", hint: "Preferred CLI" },
  { id: "startup", label: "Startup", icon: "folder", hint: "Launch behavior" },
];

const UI_FONTS: { id: FontPreset; label: string }[] = [
  { id: "inter", label: "Inter" },
  { id: "geist", label: "Geist" },
  { id: "system", label: "System" },
  { id: "custom", label: "Custom…" },
];

const CODE_FONTS: { id: MonoPreset; label: string }[] = [
  { id: "jetbrains", label: "JetBrains Mono" },
  { id: "geist-mono", label: "Geist Mono" },
  { id: "system", label: "System" },
  { id: "custom", label: "Custom…" },
];

const EXPANSIONS: { id: DiffExpansion; label: string; desc: string }[] = [
  {
    id: "full",
    label: "Full file",
    desc: "Show the whole file with continuous line numbers.",
  },
  {
    id: "hunks",
    label: "Hunks only",
    desc: "Show just the changed regions.",
  },
];

const SEARCH_VIEWS: { id: SearchView; label: string; desc: string }[] = [
  {
    id: "list",
    label: "List",
    desc: "Flat list of files with matches stacked below each.",
  },
  {
    id: "tree",
    label: "Tree",
    desc: "Folder hierarchy — collapse parts of the repository.",
  },
];

export function SettingsDialog() {
  const open = useRepoStore((s) => s.settingsOpen);
  const close = useRepoStore((s) => s.setSettingsOpen);
  const [tab, setTab] = useState<TabId>("appearance");

  if (!open) return null;

  return (
    <Overlay onClose={() => close(false)} centered>
      <div className="settings-card settings-card-split">
        <div className="settings-head">
          <span className="settings-title">Preferences</span>
          <Kbd>⌘,</Kbd>
          <span className="flex-spacer" />
          <button
            className="settings-close"
            onClick={() => close(false)}
            title="Close"
          >
            {I.x}
          </button>
        </div>

        <div className="settings-body">
          <nav className="settings-nav" aria-label="Preference categories">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={cn("settings-nav-item", tab === t.id && "is-active")}
                onClick={() => setTab(t.id)}
              >
                <span className="settings-nav-icon">{I[t.icon]}</span>
                <span className="settings-nav-text">
                  <span className="settings-nav-label">{t.label}</span>
                  <span className="settings-nav-hint">{t.hint}</span>
                </span>
              </button>
            ))}
          </nav>

          <div className="settings-panel" role="tabpanel">
            {tab === "appearance" ? <AppearanceSection /> : null}
            {tab === "fonts" ? <FontsSection /> : null}
            {tab === "colors" ? <CustomColorsSection /> : null}
            {tab === "diff" ? <DiffSection /> : null}
            {tab === "ai" ? <AiSection /> : null}
            {tab === "startup" ? <StartupSection /> : null}
          </div>
        </div>

        <div className="settings-footer dim">
          Preferences are stored locally.
        </div>
      </div>
    </Overlay>
  );
}

function AppearanceSection() {
  const settings = useRepoStore((s) => s.settings);
  const setTheme = useRepoStore((s) => s.setTheme);
  const setEditorCursor = useRepoStore((s) => s.setEditorCursor);
  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <div className="settings-section-title">Appearance</div>
        <div className="settings-section-sub dim">
          Theme + editor caret style.
        </div>
      </div>
      <div className="settings-row settings-row-stack">
        <div className="settings-row-label">Theme</div>
        <div className="theme-grid">
          {THEME_PRESETS.map((t) => (
            <button
              key={t.id}
              className={cn(
                "theme-card",
                settings.theme === t.id && "is-active",
              )}
              onClick={() => setTheme(t.id)}
              type="button"
            >
              <span className={cn("theme-card-swatch", `is-${t.id}`)} />
              <span className="theme-card-label">{t.label}</span>
              <span className="theme-card-hint dim">{t.hint}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="settings-row">
        <div className="settings-row-label">Editor caret</div>
        <div className="seg">
          <button
            className={cn(
              "seg-btn",
              settings.editorCursor === "block" && "is-active",
            )}
            onClick={() => setEditorCursor("block")}
            type="button"
            title="Wider block-shape caret (terminal-like)"
          >
            Block
          </button>
          <button
            className={cn(
              "seg-btn",
              settings.editorCursor === "blink" && "is-active",
            )}
            onClick={() => setEditorCursor("blink")}
            type="button"
            title="Thin bar — blink rate follows OS Keyboard settings"
          >
            Blink
          </button>
        </div>
      </div>
    </section>
  );
}

function FontsSection() {
  const settings = useRepoStore((s) => s.settings);
  const setUiFont = useRepoStore((s) => s.setUiFont);
  const setCodeFont = useRepoStore((s) => s.setCodeFont);
  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <div className="settings-section-title">Fonts</div>
        <div className="settings-section-sub dim">
          UI and code fonts are bundled locally. Pick "Custom" to use any
          font installed on your machine.
        </div>
      </div>
      <div className="settings-row">
        <div className="settings-row-label">UI font</div>
        <div className="seg">
          {UI_FONTS.map((f) => (
            <button
              key={f.id}
              className={cn(
                "seg-btn",
                settings.uiFont === f.id && "is-active",
              )}
              onClick={() => setUiFont(f.id)}
              type="button"
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>
      {settings.uiFont === "custom" ? (
        <div className="settings-row">
          <div className="settings-row-label">Custom UI font</div>
          <input
            className="settings-text-input"
            type="text"
            value={settings.customUiFont}
            onChange={(e) => setUiFont("custom", e.target.value)}
            placeholder="e.g. SF Pro Text"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>
      ) : null}
      <div className="settings-row">
        <div className="settings-row-label">Code font</div>
        <div className="seg">
          {CODE_FONTS.map((f) => (
            <button
              key={f.id}
              className={cn(
                "seg-btn",
                settings.codeFont === f.id && "is-active",
              )}
              onClick={() => setCodeFont(f.id)}
              type="button"
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>
      {settings.codeFont === "custom" ? (
        <div className="settings-row">
          <div className="settings-row-label">Custom code font</div>
          <input
            className="settings-text-input"
            type="text"
            value={settings.customCodeFont}
            onChange={(e) => setCodeFont("custom", e.target.value)}
            placeholder="e.g. Fira Code"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>
      ) : null}
    </section>
  );
}

function CustomColorsSection() {
  const settings = useRepoStore((s) => s.settings);
  const setCustomColor = useRepoStore((s) => s.setCustomColor);
  const resetCustomColors = useRepoStore((s) => s.resetCustomColors);

  const effective = (id: string) => {
    const override = settings.customColors[id];
    if (override) return override;
    if (typeof window !== "undefined") {
      const computed = getComputedStyle(document.documentElement)
        .getPropertyValue(`--${id}`)
        .trim();
      return hexishFrom(computed);
    }
    return "#000000";
  };

  const hasOverrides = Object.keys(settings.customColors).length > 0;

  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <div className="settings-section-title">Custom colors</div>
        <div className="settings-section-sub dim">
          Override the active theme on a per-variable basis. Leave blank to
          use the preset&apos;s default.
        </div>
      </div>
      <div className="color-grid">
        {TWEAKABLE_COLORS.map((c) => (
          <label key={c.id} className="color-row">
            <span className="color-row-label">{c.label}</span>
            <span className="color-row-controls">
              <input
                type="color"
                className="color-row-picker"
                value={effective(c.id)}
                onChange={(e) => setCustomColor(c.id, e.target.value)}
              />
              {settings.customColors[c.id] ? (
                <button
                  type="button"
                  className="color-row-reset"
                  onClick={() => setCustomColor(c.id, null)}
                  title="Reset to theme default"
                >
                  {I.undo}
                </button>
              ) : null}
            </span>
          </label>
        ))}
      </div>
      {hasOverrides ? (
        <button
          type="button"
          className="ghost-btn settings-reset-btn"
          onClick={resetCustomColors}
        >
          Reset all to theme defaults
        </button>
      ) : null}
    </section>
  );
}

function DiffSection() {
  const settings = useRepoStore((s) => s.settings);
  const setDiffExpansion = useRepoStore((s) => s.setDiffExpansion);
  const setSearchView = useRepoStore((s) => s.setSearchView);
  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <div className="settings-section-title">Diff</div>
        <div className="settings-section-sub dim">
          How files are rendered when you select them.
        </div>
      </div>
      <div className="settings-row">
        <div className="settings-row-label">Default view</div>
        <div className="seg">
          {EXPANSIONS.map((e) => (
            <button
              key={e.id}
              className={cn(
                "seg-btn",
                settings.diffExpansion === e.id && "is-active",
              )}
              onClick={() => setDiffExpansion(e.id)}
              title={e.desc}
            >
              {e.label}
            </button>
          ))}
        </div>
      </div>
      <div className="settings-row">
        <div className="settings-row-label">Search results</div>
        <div className="seg">
          {SEARCH_VIEWS.map((v) => (
            <button
              key={v.id}
              className={cn(
                "seg-btn",
                settings.searchView === v.id && "is-active",
              )}
              onClick={() => setSearchView(v.id)}
              title={v.desc}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

function StartupSection() {
  const settings = useRepoStore((s) => s.settings);
  const setAutoOpenLast = useRepoStore((s) => s.setAutoOpenLast);
  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <div className="settings-section-title">Startup</div>
        <div className="settings-section-sub dim">
          How Review Desk opens when you launch it.
        </div>
      </div>
      <label className="settings-toggle">
        <div className="settings-toggle-label">
          <div className="settings-row-label">Reopen last project</div>
          <div className="settings-row-sub dim">
            When off, you&apos;ll land on the project picker instead.
          </div>
        </div>
        <input
          type="checkbox"
          checked={settings.autoOpenLast}
          onChange={(e) => setAutoOpenLast(e.target.checked)}
        />
      </label>
    </section>
  );
}

type AiPromptKind = "commit" | "pr" | "summary" | "risk" | "branch";

const AI_PROMPT_FIELDS: {
  id: AiPromptKind;
  label: string;
  hint: string;
  placeholder: string;
}[] = [
  {
    id: "commit",
    label: "Commit message",
    hint: "Prepended when you click AI → Generate commit message.",
    placeholder:
      "e.g. Use Conventional Commits (feat|fix|refactor|chore...). Subject under 72 chars. Body explains WHY when non-obvious.",
  },
  {
    id: "branch",
    label: "Branch name",
    hint: "Used by the ✨ Generate button in the branch picker.",
    placeholder:
      "e.g. kebab-case, prefix with feat/, fix/, refactor/, chore/. No issue numbers.",
  },
  {
    id: "pr",
    label: "Pull request description",
    hint: "Prepended when drafting a PR description from the current branch.",
    placeholder:
      "e.g. Use ## Summary, ## Why, ## Test plan. Link issues with Refs #123. Keep it factual.",
  },
  {
    id: "summary",
    label: "Diff summary",
    hint: "Prepended when summarising the working-tree diff.",
    placeholder:
      "e.g. Focus on user-visible behaviour. Skip pure refactors and dependency bumps.",
  },
  {
    id: "risk",
    label: "Risk review",
    hint: "Prepended when reviewing diff risk.",
    placeholder:
      "e.g. Highlight security, performance, and missing test coverage. Cite file:line.",
  },
];

function AiSection() {
  const list = useRepoStore((s) => s.aiCliList);
  const loading = useRepoStore((s) => s.aiCliLoading);
  const fetchAiClis = useRepoStore((s) => s.fetchAiClis);
  const preferred = useRepoStore((s) => s.settings.preferredAiCli);
  const setPreferred = useRepoStore((s) => s.setPreferredAiCli);
  const aiSystemPrompts = useRepoStore((s) => s.settings.aiSystemPrompts);
  const setAiSystemPrompt = useRepoStore((s) => s.setAiSystemPrompt);

  if (list.length === 0 && !loading) {
    fetchAiClis().catch(() => {
      /* non-fatal */
    });
  }

  const available = list.filter((c) => c.available);

  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <div className="settings-section-title">AI</div>
        <div className="settings-section-sub dim">
          We shell out to your installed CLI. No API keys to manage here.
        </div>
      </div>
      {loading && list.length === 0 ? (
        <div className="settings-row-sub dim">Detecting CLIs…</div>
      ) : available.length === 0 ? (
        <div className="settings-row-sub dim">
          No supported CLI detected. Install one to enable AI Assist:
          <br />
          <code>brew install claude</code> or{" "}
          <code>npm i -g @openai/codex</code>.
        </div>
      ) : (
        <div className="settings-row">
          <div className="settings-row-label">Preferred CLI</div>
          <div className="seg">
            {available.map((c) => (
              <button
                key={c.id}
                className={cn("seg-btn", preferred === c.id && "is-active")}
                onClick={() => setPreferred(c.id)}
                title={c.version || c.name}
              >
                {c.name}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="settings-section-head settings-subsection-head">
        <div className="settings-section-title">System prompts</div>
        <div className="settings-section-sub dim">
          Custom instructions prepended to each AI action. Leave blank to use
          the built-in default.
        </div>
      </div>
      {AI_PROMPT_FIELDS.map((field) => (
        <div key={field.id} className="ai-prompt-field">
          <div className="ai-prompt-head">
            <span className="ai-prompt-label">{field.label}</span>
            <span className="ai-prompt-hint dim">{field.hint}</span>
          </div>
          <textarea
            className="ai-prompt-textarea"
            value={aiSystemPrompts[field.id]}
            onChange={(e) => setAiSystemPrompt(field.id, e.target.value)}
            placeholder={field.placeholder}
            rows={3}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
          />
        </div>
      ))}
    </section>
  );
}

/**
 * `<input type="color">` only accepts hex (#rrggbb). Some computed values
 * come back as `rgb(...)` or `rgba(...)`; fall back to black so the picker
 * doesn't reject the value. The actual stored override is the picker's hex
 * output, so this only affects the *initial* picker color.
 */
function hexishFrom(value: string): string {
  if (/^#[0-9a-f]{6}$/i.test(value)) return value;
  const m = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (m) {
    const toHex = (n: string) =>
      Math.max(0, Math.min(255, parseInt(n, 10)))
        .toString(16)
        .padStart(2, "0");
    return `#${toHex(m[1])}${toHex(m[2])}${toHex(m[3])}`;
  }
  return "#000000";
}
