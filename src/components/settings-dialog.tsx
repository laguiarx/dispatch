import { useState } from "react";
import { useRepoStore } from "@/features/repository/repository.store";
import { BTN_GHOST } from "@/lib/btn";
import type { DiffExpansion, SearchView } from "@/lib/paths";
import {
  THEME_PRESETS,
  TWEAKABLE_COLORS,
  type FontPreset,
  type MonoPreset,
} from "@/lib/theme";
import { cn } from "@/lib/utils";
import { I, type IconName } from "./icons";
import { Kbd } from "./kbd";
import { Overlay } from "./overlay";

type TabId = "appearance" | "diff" | "ai" | "startup";

const TABS: { id: TabId; label: string; icon: IconName; hint: string }[] = [
  {
    id: "appearance",
    label: "Appearance",
    icon: "theme",
    hint: "Theme, fonts and colors",
  },
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

// ----- shared style fragments ------------------------------------------------
// Pulled out so the same look is one edit. None of these are component
// boundaries on their own — they're just reused class strings.

const SECTION =
  "flex flex-col gap-3 px-4 py-3.5 border-b border-bd-0 last:border-b-0";
const SECTION_HEAD = "flex flex-col gap-0.5";
const SECTION_TITLE = "text-[13px] font-semibold";
const SECTION_SUB = "text-[11px] text-fg-2";
// `row-stack` variant on top of ROW changes from horizontal to vertical
// layout — used for full-width controls (theme grid, etc).
const ROW = "flex items-center justify-between gap-3";
const ROW_STACK = "flex flex-col items-stretch gap-2";
const ROW_LABEL = "text-[12px] font-medium text-fg-0";
const ROW_SUB = "text-[11px] text-fg-2";
const TEXT_INPUT =
  "flex-1 h-7 max-w-[240px] px-2.5 text-[12.5px] " +
  "rounded-2 bg-bg-2 border border-bd-2 text-fg-0 outline-none focus:border-accent";
// `seg` segmented control — also reused by DiffPane (kept legacy there
// already migrated). Used here for tab toggles inside settings rows.
const SEG_GROUP =
  "inline-flex bg-bg-2 border border-bd-1 rounded-2 p-0.5 gap-0.5";
const SEG_BTN =
  "px-[9px] py-[3px] rounded text-[11.5px] text-fg-2 font-medium whitespace-nowrap " +
  "hover:text-fg-0";
const SEG_BTN_ACTIVE =
  "bg-bg-4 text-fg-0 shadow-[0_1px_0_rgba(0,0,0,0.3)] " +
  "[:root[data-theme='light']_&]:bg-bg-0 " +
  "[:root[data-theme='light']_&]:shadow-[0_1px_2px_rgba(0,0,0,0.06)]";

export function SettingsDialog() {
  const open = useRepoStore((s) => s.settingsOpen);
  const close = useRepoStore((s) => s.setSettingsOpen);
  const setShortcutsOpen = useRepoStore((s) => s.setShortcutsOpen);
  const [tab, setTab] = useState<TabId>("appearance");

  if (!open) return null;

  return (
    <Overlay onClose={() => close(false)} centered>
      <div
        className={cn(
          "w-[min(820px,94vw)] h-[min(720px,88vh)] flex flex-col overflow-hidden",
          "bg-bg-1 border border-bd-2 rounded-3 shadow-[0_24px_60px_rgba(0,0,0,0.55)]",
        )}
      >
        <div className="flex items-center gap-2 px-3.5 py-3 border-b border-bd-1">
          <span className="text-[14px] font-semibold tracking-[-0.01em]">
            Preferences
          </span>
          <Kbd>⌘,</Kbd>
          <span className="flex-1" />
          <button
            className="w-[22px] h-[22px] grid place-items-center rounded-[4px] text-fg-3 bg-transparent border-0 cursor-pointer hover:bg-bg-hover hover:text-fg-0"
            onClick={() => close(false)}
            title="Close"
          >
            {I.x}
          </button>
        </div>

        <div className="grid grid-cols-[200px_1fr] flex-1 min-h-0">
          <nav
            aria-label="Preference categories"
            className="flex flex-col gap-px px-2 py-3 border-r border-bd-1 bg-bg-0 overflow-y-auto"
          >
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={cn(
                  "grid grid-cols-[16px_1fr] items-center gap-2.5 px-2.5 py-[7px] rounded-2",
                  "bg-transparent text-left transition-colors duration-100",
                  tab === t.id
                    ? "bg-accent-soft text-accent"
                    : "text-fg-1 hover:bg-bg-hover hover:text-fg-0",
                )}
                onClick={() => setTab(t.id)}
              >
                <span
                  className={cn(
                    "grid place-items-center [&_svg]:w-[13px] [&_svg]:h-[13px]",
                    tab === t.id ? "text-accent" : "text-fg-3",
                  )}
                >
                  {I[t.icon]}
                </span>
                <span className="flex flex-col min-w-0">
                  <span className="text-[12.5px] font-medium">{t.label}</span>
                  <span
                    className={cn(
                      "text-[10.5px] whitespace-nowrap overflow-hidden text-ellipsis",
                      tab === t.id
                        ? "text-[color:color-mix(in_oklab,var(--accent)_65%,var(--fg-2))]"
                        : "text-fg-3",
                    )}
                  >
                    {t.hint}
                  </span>
                </span>
              </button>
            ))}
          </nav>

          <div
            role="tabpanel"
            className={cn(
              "overflow-y-auto py-1 min-h-0",
              "[scrollbar-width:thin] [scrollbar-color:var(--bd-2)_transparent]",
              "[&::-webkit-scrollbar]:w-2",
              "[&::-webkit-scrollbar-thumb]:bg-bd-2 [&::-webkit-scrollbar-thumb]:rounded",
            )}
          >
            {tab === "appearance" ? (
              <>
                <AppearanceSection />
                <FontsSection />
                <CustomColorsSection />
              </>
            ) : null}
            {tab === "diff" ? <DiffSection /> : null}
            {tab === "ai" ? <AiSection /> : null}
            {tab === "startup" ? <StartupSection /> : null}
          </div>
        </div>

        <div className="flex items-center gap-2 px-4 py-2.5 bg-bg-2 border-t border-bd-1 text-[11px]">
          <span className="text-fg-2">Preferences are stored locally.</span>
          <span className="flex-1" />
          {/* Was a dedicated topbar icon; moved here so the topbar isn't
              cluttered and so the "rarely-needed reference" lives next to
              other rarely-needed reference material. */}
          <button
            type="button"
            className={cn(
              "inline-flex items-center gap-1.5 px-2 py-1 rounded text-[11px]",
              "border border-bd-2 bg-transparent text-fg-2 cursor-pointer",
              "hover:bg-bg-hover hover:text-fg-0 hover:border-bd-1",
            )}
            onClick={() => {
              close(false);
              setShortcutsOpen(true);
            }}
          >
            {I.keyboard}
            <span>Keyboard shortcuts</span>
          </button>
        </div>
      </div>
    </Overlay>
  );
}

// Theme swatches — each is a 3-stop linear gradient that previews the
// theme's bg-0 / bg-2 / accent at a glance. Keeping these as inline
// `background` values rather than CSS classes so adding a new theme is
// a one-line change in lib/theme.ts without touching styles.
const THEME_SWATCHES: Record<string, string> = {
  dark: "linear-gradient(90deg, #08090a 0 33%, #131417 33% 66%, #5e6ad2 66%)",
  light: "linear-gradient(90deg, #ffffff 0 33%, #f3f4f6 33% 66%, #5e6ad2 66%)",
  midnight:
    "linear-gradient(90deg, #05070f 0 33%, #101227 33% 66%, #7170ff 66%)",
  vercel:
    "linear-gradient(90deg, #000000 0 33%, #111111 33% 66%, #ffffff 66%)",
  supabase:
    "linear-gradient(90deg, #0a0e0d 0 33%, #141a19 33% 66%, #3ecf8e 66%)",
  catppuccin:
    "linear-gradient(90deg, #1e1e2e 0 33%, #232337 33% 66%, #cba6f7 66%)",
  "tokyo-night":
    "linear-gradient(90deg, #1a1b26 0 33%, #1f2335 33% 66%, #7dcfff 66%)",
};

function AppearanceSection() {
  const settings = useRepoStore((s) => s.settings);
  const setTheme = useRepoStore((s) => s.setTheme);
  return (
    <section className={SECTION}>
      <div className={SECTION_HEAD}>
        <div className={SECTION_TITLE}>Appearance</div>
        <div className={SECTION_SUB}>Theme presets.</div>
      </div>
      <div className={ROW_STACK}>
        <div className={ROW_LABEL}>Theme</div>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2">
          {THEME_PRESETS.map((t) => (
            <button
              key={t.id}
              className={cn(
                "flex flex-col gap-1 px-3 py-2.5 text-left rounded-2 border",
                "transition-[border-color,background-color] duration-100",
                settings.theme === t.id
                  ? "border-accent bg-accent-soft"
                  : "border-bd-2 bg-bg-2 text-fg-1 hover:border-bd-3 hover:bg-bg-3",
              )}
              onClick={() => setTheme(t.id)}
              type="button"
            >
              <span
                className="block h-[22px] rounded border border-bd-1 mb-1"
                style={{ background: THEME_SWATCHES[t.id] }}
              />
              <span
                className={cn(
                  "text-[12.5px] font-semibold",
                  settings.theme === t.id ? "text-accent" : "text-fg-0",
                )}
              >
                {t.label}
              </span>
              <span className="text-[10.5px] text-fg-2">{t.hint}</span>
            </button>
          ))}
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
    <section className={SECTION}>
      <div className={SECTION_HEAD}>
        <div className={SECTION_TITLE}>Fonts</div>
        <div className={SECTION_SUB}>
          UI and code fonts are bundled locally. Pick "Custom" to use any
          font installed on your machine.
        </div>
      </div>
      <div className={ROW}>
        <div className={ROW_LABEL}>UI font</div>
        <div className={SEG_GROUP}>
          {UI_FONTS.map((f) => (
            <button
              key={f.id}
              className={cn(SEG_BTN, settings.uiFont === f.id && SEG_BTN_ACTIVE)}
              onClick={() => setUiFont(f.id)}
              type="button"
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>
      {settings.uiFont === "custom" ? (
        <div className={ROW}>
          <div className={ROW_LABEL}>Custom UI font</div>
          <input
            className={TEXT_INPUT}
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
      <div className={ROW}>
        <div className={ROW_LABEL}>Code font</div>
        <div className={SEG_GROUP}>
          {CODE_FONTS.map((f) => (
            <button
              key={f.id}
              className={cn(SEG_BTN, settings.codeFont === f.id && SEG_BTN_ACTIVE)}
              onClick={() => setCodeFont(f.id)}
              type="button"
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>
      {settings.codeFont === "custom" ? (
        <div className={ROW}>
          <div className={ROW_LABEL}>Custom code font</div>
          <input
            className={TEXT_INPUT}
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
    <section className={SECTION}>
      <div className={SECTION_HEAD}>
        <div className={SECTION_TITLE}>Custom colors</div>
        <div className={SECTION_SUB}>
          Override the active theme on a per-variable basis. Leave blank to
          use the preset&apos;s default.
        </div>
      </div>
      <div className="grid grid-cols-2 gap-y-2 gap-x-4">
        {TWEAKABLE_COLORS.map((c) => (
          <label
            key={c.id}
            className="flex items-center justify-between gap-2 text-[12px]"
          >
            <span className="text-fg-1">{c.label}</span>
            <span className="inline-flex items-center gap-1.5">
              <input
                type="color"
                className={cn(
                  "w-8 h-[22px] p-0 bg-transparent cursor-pointer",
                  "border border-bd-2 rounded",
                  // The native color swatch is ringed by the input border;
                  // strip the inner padding so the swatch fills tightly.
                  "[&::-webkit-color-swatch]:border-0 [&::-webkit-color-swatch]:rounded-[3px]",
                  "[&::-webkit-color-swatch-wrapper]:p-px",
                )}
                value={effective(c.id)}
                onChange={(e) => setCustomColor(c.id, e.target.value)}
              />
              {settings.customColors[c.id] ? (
                <button
                  type="button"
                  className={cn(
                    "grid place-items-center w-[22px] h-[22px] rounded",
                    "text-fg-3 [&_svg]:w-3 [&_svg]:h-3",
                    "hover:text-fg-0 hover:bg-bg-hover",
                  )}
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
          className={cn(BTN_GHOST, "self-start mt-1")}
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
    <section className={SECTION}>
      <div className={SECTION_HEAD}>
        <div className={SECTION_TITLE}>Diff</div>
        <div className={SECTION_SUB}>
          How files are rendered when you select them.
        </div>
      </div>
      <div className={ROW}>
        <div className={ROW_LABEL}>Default view</div>
        <div className={SEG_GROUP}>
          {EXPANSIONS.map((e) => (
            <button
              key={e.id}
              className={cn(
                SEG_BTN,
                settings.diffExpansion === e.id && SEG_BTN_ACTIVE,
              )}
              onClick={() => setDiffExpansion(e.id)}
              title={e.desc}
            >
              {e.label}
            </button>
          ))}
        </div>
      </div>
      <div className={ROW}>
        <div className={ROW_LABEL}>Search results</div>
        <div className={SEG_GROUP}>
          {SEARCH_VIEWS.map((v) => (
            <button
              key={v.id}
              className={cn(
                SEG_BTN,
                settings.searchView === v.id && SEG_BTN_ACTIVE,
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
    <section className={SECTION}>
      <div className={SECTION_HEAD}>
        <div className={SECTION_TITLE}>Startup</div>
        <div className={SECTION_SUB}>
          How Squint opens when you launch it.
        </div>
      </div>
      {/* Custom switch built entirely from utility classes. The native
          checkbox is hidden visually via appearance-none + sized into a
          pill; the thumb is an `::after` pseudo that translates on
          `:checked`. Same look as the legacy `.settings-toggle` rule. */}
      <label className="flex items-center justify-between gap-3 cursor-pointer">
        <div className="flex flex-col gap-0.5 min-w-0">
          <div className={ROW_LABEL}>Reopen last project</div>
          <div className={ROW_SUB}>
            When off, you&apos;ll land on the project picker instead.
          </div>
        </div>
        <input
          type="checkbox"
          checked={settings.autoOpenLast}
          onChange={(e) => setAutoOpenLast(e.target.checked)}
          className={cn(
            "appearance-none relative w-8 h-[18px] rounded-full cursor-pointer",
            "bg-bg-3 border border-bd-2",
            "transition-[background-color,border-color] duration-[120ms]",
            // Thumb: 14×14 circle, top-1 left-1 inside the pill,
            // translates 14px on :checked.
            "after:content-[''] after:absolute after:top-px after:left-px",
            "after:w-[14px] after:h-[14px] after:rounded-full after:bg-fg-2",
            "after:transition-[transform,background-color] after:duration-[140ms]",
            // Checked state.
            "checked:bg-accent checked:border-accent",
            "checked:after:translate-x-[14px] checked:after:bg-white",
          )}
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
    <section className={SECTION}>
      <div className={SECTION_HEAD}>
        <div className={SECTION_TITLE}>AI</div>
        <div className={SECTION_SUB}>
          We shell out to your installed CLI. No API keys to manage here.
        </div>
      </div>
      {loading && list.length === 0 ? (
        <div className={ROW_SUB}>Detecting CLIs…</div>
      ) : available.length === 0 ? (
        <div className={ROW_SUB}>
          No supported CLI detected. Install one to enable AI Assist:
          <br />
          <code>brew install claude</code> or{" "}
          <code>npm i -g @openai/codex</code>.
        </div>
      ) : (
        <div className={ROW}>
          <div className={ROW_LABEL}>Preferred CLI</div>
          <div className={SEG_GROUP}>
            {available.map((c) => (
              <button
                key={c.id}
                className={cn(SEG_BTN, preferred === c.id && SEG_BTN_ACTIVE)}
                onClick={() => setPreferred(c.id)}
                title={c.version || c.name}
              >
                {c.name}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className={cn(SECTION_HEAD, "mt-2 pt-3.5 border-t border-bd-1")}>
        <div className={SECTION_TITLE}>System prompts</div>
        <div className={SECTION_SUB}>
          Custom instructions prepended to each AI action. Leave blank to use
          the built-in default.
        </div>
      </div>
      {AI_PROMPT_FIELDS.map((field) => (
        <div key={field.id} className="flex flex-col gap-1.5">
          <div className="flex flex-col gap-px">
            <span className="text-[12px] font-medium text-fg-0">
              {field.label}
            </span>
            <span className="text-[11px] text-fg-2">{field.hint}</span>
          </div>
          <textarea
            className={cn(
              "w-full min-h-16 px-2.5 py-2 resize-y outline-none",
              "font-sans text-[12px] leading-[1.5]",
              "bg-bg-2 border border-bd-2 rounded-2 text-fg-0",
              "focus:border-accent placeholder:text-fg-3",
            )}
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
