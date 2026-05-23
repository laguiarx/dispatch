import { useEffect, useState } from "react";
import { useRepoStore } from "@/features/repository/repository.store";
import { useBoardStore } from "@/features/board/board.store";
import {
  detectIntegrations,
  type Integration,
  type IntegrationsReport,
} from "@/features/ai/ai.api";
import { Button } from "@/components/ui/button";
import { isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { I } from "./icons";
import { Spinner } from "./spinner";
import { Kbd } from "./kbd";
import { Overlay } from "./overlay";

/**
 * Shared style fragments for the onboarding screens. Each step renders the
 * same `<body>` + `<footer>` skeleton inside the same card, so pulling these
 * up keeps tweaks to "the onboarding look" a single-edit affair.
 */
const CARD =
  "w-[min(640px,92vw)] max-h-[88vh] flex flex-col overflow-hidden " +
  "bg-bg-1 border border-bd-2 rounded-3 shadow-[0_24px_60px_rgba(0,0,0,0.55)]";
const HEAD = "flex items-center gap-2 px-3.5 py-3 border-b border-bd-1";
const STEP_LABEL =
  "font-mono text-fg-2 text-[10.5px] tracking-[0.06em] uppercase";
const BODY = "px-[22px] pt-[22px] pb-[18px] overflow-y-auto";
const TITLE = "m-0 mb-2 text-[18px] font-semibold tracking-[-0.01em]";
const LEDE = "m-0 mb-[18px] text-fg-2 text-[13px] leading-[1.6]";
const FEATURE_GRID = "grid grid-cols-1 gap-3";
const FEATURE_CARD = "px-3.5 py-3 bg-bg-2 border border-bd-1 rounded-2";
const FEATURE_TITLE = "text-[13px] font-semibold text-fg-0 mb-1";
const FEATURE_BODY = "text-[12px] text-fg-2 leading-[1.5]";
const INTEGRATION_LIST = "flex flex-col gap-2";
// Base integration card. Two-column grid (status icon | body). `is-on`
// (installed) and `is-disabled` (prereq missing) tweak colors / opacity.
const INTEGRATION_BASE =
  "grid grid-cols-[22px_1fr] gap-3 px-3 py-2.5 border rounded-2 bg-bg-2 border-bd-1";
const INTEGRATION_ON =
  "border-[color-mix(in_oklab,var(--git-add)_35%,transparent)] " +
  "bg-[color-mix(in_oklab,var(--git-add)_6%,var(--bg-2))]";
const INTEGRATION_DISABLED = "opacity-65";
const STATUS_CELL = "grid place-items-center text-fg-3";
const STATUS_CELL_ON = "text-git-add";
const INT_NAME = "text-[13px] font-semibold text-fg-0";
const INT_PURPOSE = "text-[11.5px] text-fg-2 mt-0.5";
const INSTALL_ROW =
  "grid grid-cols-[1fr_auto] items-stretch gap-1.5 mt-2";
const INSTALL_CMD =
  "font-mono text-[11px] px-2 py-1.5 bg-bg-0 border border-bd-2 rounded-[4px] " +
  "text-fg-1 whitespace-nowrap overflow-x-auto " +
  "[scrollbar-width:thin] [&::-webkit-scrollbar]:h-1";
const INSTALL_PLAY_BASE =
  "w-7 grid place-items-center rounded-[4px] cursor-pointer text-[12px] leading-none pl-[2px] " +
  "transition-[filter] duration-[120ms]";
const INSTALL_PLAY_ENABLED =
  "!bg-accent !bg-none text-white border border-[color-mix(in_oklab,var(--accent)_80%,#000)] " +
  "hover:!bg-accent hover:!bg-none";
const INSTALL_PLAY_DISABLED =
  "bg-bg-2 text-fg-3 border border-bd-1 cursor-not-allowed";
// While polling, dim the play button less aggressively — spinner reads as
// "working", not "disabled".
const INSTALL_PLAY_INSTALLING =
  "bg-bg-1 border border-bd-2 text-fg-3 cursor-progress " +
  "[&_[data-ai-spinner]]:w-3 [&_[data-ai-spinner]]:h-3 [&_[data-ai-spinner]]:border-2";
const INSTALL_PREREQ = "text-fg-2 italic text-[11px] mt-1";
const SHORTCUTS_GRID =
  "grid grid-cols-2 gap-x-4 gap-y-1.5 px-3.5 py-3 bg-bg-2 border border-bd-1 rounded-2";
const SHORTCUT_ROW =
  "flex items-center gap-2 text-[12px] text-fg-1 [&_[data-kbd]]:shrink-0 [&_[data-kbd]]:!m-0";
const FOOTER =
  "flex gap-2 px-4 py-3 border-t border-bd-1 bg-bg-0";

/**
 * First-run experience. Shows on launch if `settings.firstRunCompleted` is
 * false, and is also reachable from the command palette ("Show welcome
 * tour"). Walks the user through what the app does and what optional CLIs
 * unlock which features.
 */
export function OnboardingModal() {
  const open = useRepoStore((s) => s.onboardingOpen);
  const setOpen = useRepoStore((s) => s.setOnboardingOpen);
  const setFirstRunCompleted = useRepoStore((s) => s.setFirstRunCompleted);
  // The onboarding "Open a repo" CTA used to call `openRepositoryPicker`
  // — that's the legacy diff-mode flow, which opens the repo as the
  // active diff target but never registers it as a board project. The
  // result was a brand-new user finishing onboarding only to find the
  // Workspace sidebar still empty. We now go through `addProjectFromPicker`
  // (the same action the `+` button in the sidebar uses), which calls
  // the Rust `ensure_project` upsert and surfaces the repo as a kanban
  // board immediately.
  const addProjectFromPicker = useBoardStore((s) => s.addProjectFromPicker);
  const pushToast = useRepoStore((s) => s.pushToast);

  // Four screens: welcome (0) → Homebrew install (1) → tools install (2)
  // → done (3). Splitting Homebrew off as its own step matters because
  // every per-tool installer depends on it; surfacing it as a separate
  // gate avoids the user trying to install git/gh before brew is ready.
  const [step, setStep] = useState<0 | 1 | 2 | 3>(0);
  const [report, setReport] = useState<IntegrationsReport | null>(null);
  const [loading, setLoading] = useState(false);
  /**
   * Id of the tool whose ▶ button was just clicked. Triggers a background
   * polling loop (in the effect below) that calls `detectIntegrations`
   * every couple of seconds until the tool reports `available: true` — at
   * which point the row visually flips to the green "✓ installed" state
   * without the user having to click Re-scan.
   */
  const [installing, setInstalling] = useState<string | null>(null);
  const runInTerminal = useRepoStore((s) => s.runInTerminal);

  const refresh = () => {
    if (!isTauri()) {
      setReport({ integrations: [] });
      return;
    }
    setLoading(true);
    detectIntegrations()
      .then((r) => setReport(r))
      .catch(() => setReport({ integrations: [] }))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (!open) return;
    setStep(0);
    setInstalling(null);
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // While an install is in flight, poll until the target tool is on PATH.
  // Capped at 5 minutes (brew install can take a minute or two for casks),
  // after which we stop silently — the user can still click Re-scan or
  // re-click ▶. We don't subscribe to the terminal output because shell
  // prompt detection is fragile across configs; polling `which` is dumb
  // but reliable.
  useEffect(() => {
    if (!installing) return;
    if (!isTauri()) return;
    let cancelled = false;
    const POLL_MS = 2500;
    const TIMEOUT_MS = 5 * 60 * 1000;
    const start = Date.now();
    let timer: number | null = null;

    const tick = async () => {
      if (cancelled) return;
      try {
        const r = await detectIntegrations();
        if (cancelled) return;
        setReport(r);
        const target = r.integrations.find((i) => i.id === installing);
        if (target?.available) {
          setInstalling(null);
          return;
        }
      } catch {
        /* swallow — try again next tick */
      }
      if (Date.now() - start > TIMEOUT_MS) {
        setInstalling(null);
        return;
      }
      timer = window.setTimeout(tick, POLL_MS);
    };
    // Initial delay so the user actually sees the spinner before the
    // first probe (otherwise it can flash if brew was already finishing).
    timer = window.setTimeout(tick, 1500);
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
    };
  }, [installing]);

  if (!open) return null;

  const finish = () => {
    setFirstRunCompleted(true);
    setOpen(false);
  };

  const integrations = report?.integrations ?? [];
  const brew = integrations.find((i) => i.id === "brew") ?? null;
  const tools = integrations.filter((i) => i.id !== "brew");

  /**
   * Click handler for a ▶ install button. Two responsibilities:
   *   1. Pipe the install command into the integrated terminal.
   *   2. Start polling for `<id>` to appear on PATH so the row auto-flips
   *      to ✓ without the user manually re-scanning.
   *
   * The polling effect above keys off `installing`, so setting it here is
   * what kicks the whole flow.
   */
  const runInstall = (it: Integration) => {
    if (isTauri()) runInTerminal(it.installCommand);
    setInstalling(it.id);
  };

  return (
    <Overlay onClose={finish} centered>
      <div className={CARD}>
        <div className={HEAD}>
          <span className={STEP_LABEL}>Step {step + 1} of 4</span>
          <span className="flex-1" />
          <Button variant="unstyled"
            className="w-[22px] h-[22px] grid place-items-center rounded-[4px] text-fg-3 bg-transparent border-0 cursor-pointer hover:bg-bg-hover hover:text-fg-0"
            onClick={finish}
            title="Close"
            aria-label="Close"
          >
            {I.x}
          </Button>
        </div>

        {step === 0 ? (
          <WelcomeStep onNext={() => setStep(1)} />
        ) : step === 1 ? (
          <HomebrewStep
            brew={brew}
            installing={installing === "brew"}
            loading={loading && !report}
            onBack={() => setStep(0)}
            // If brew is missing, skipping past this step lands the user at
            // "You're set" — going to the Tools step would just show all
            // ▶ disabled, which is more confusing than informative.
            onNext={() => setStep(brew?.available ? 2 : 3)}
            onRefresh={refresh}
            onRun={runInstall}
          />
        ) : step === 2 ? (
          <ToolsStep
            tools={tools}
            brewAvailable={brew?.available ?? false}
            installing={installing}
            loading={loading && !report}
            onBack={() => setStep(1)}
            onNext={() => setStep(3)}
            onRefresh={refresh}
            onRun={runInstall}
          />
        ) : (
          <DoneStep
            // Skip back through Tools when brew is missing (it would have
            // been useless anyway).
            onBack={() => setStep(brew?.available ? 2 : 1)}
            onPickRepo={async () => {
              setFirstRunCompleted(true);
              setOpen(false);
              try {
                await addProjectFromPicker();
              } catch (err) {
                pushToast(
                  err instanceof Error ? err.message : String(err),
                  "danger",
                );
              }
            }}
            onFinish={finish}
          />
        )}
      </div>
    </Overlay>
  );
}

function WelcomeStep({ onNext }: { onNext: () => void }) {
  return (
    <>
      <div className={BODY}>
        <h2 className={TITLE}>Welcome to Dispatch</h2>
        <p className={LEDE}>
          A focused desktop tool for reviewing code that AI agents (Claude
          Code, Codex, Cursor) just wrote. Not a full IDE — it stays out of
          your way once the review is done.
        </p>
        <div className={FEATURE_GRID}>
          <Feature
            title="Read changes fast"
            body="Side-by-side or inline diffs, full-file view with subtle gutter marks on modified lines, hunk-level stage/revert."
          />
          <Feature
            title="Stay in the flow"
            body="⌘P to jump to any file, ⌘F to search in the open file, ⌘⇧F across the repo. ⌘K W to close everything."
          />
          <Feature
            title="AI Assist"
            body="Generate commit messages, PR descriptions, summaries and risk reviews — using your installed Claude or Codex CLI."
          />
        </div>
      </div>
      <div className={FOOTER}>
        <span className="flex-1" />
        <Button variant="default" size="sm" onClick={onNext} type="button">
          Next
        </Button>
      </div>
    </>
  );
}

/**
 * Step 2 — Homebrew. Singled out because every per-tool installer in the
 * next step depends on it (`brew install git`, `brew install gh`) or on a
 * Node toolchain that's most reliably installed via brew too. If the user
 * already has it, the screen is a one-line confirmation + Next.
 */
function HomebrewStep({
  brew,
  installing,
  loading,
  onBack,
  onNext,
  onRefresh,
  onRun,
}: {
  brew: Integration | null;
  installing: boolean;
  loading: boolean;
  onBack: () => void;
  onNext: () => void;
  onRefresh: () => void;
  onRun: (it: Integration) => void;
}) {
  // When brew isn't installed and the user clicks Next we'll skip the
  // Tools step entirely (handled by the parent). Reflect that in the
  // button label so it doesn't read as "Next: tools" when nothing
  // installable will be shown.
  const brewMissing = !!brew && !brew.available;
  return (
    <>
      <div className={BODY}>
        <h2 className={TITLE}>Install Homebrew</h2>
        <p className={LEDE}>
          The next step uses Homebrew to install Git, the GitHub CLI, Claude
          Code, and Codex in one click. If you already have it, you can
          skip ahead.
        </p>
        {loading && !brew ? (
          <div className="font-mono text-fg-2 text-[11.5px]">Detecting…</div>
        ) : brew?.available ? (
          <div className={cn(INTEGRATION_BASE, INTEGRATION_ON)}>
            <span className={cn(STATUS_CELL, STATUS_CELL_ON)}>{I.check}</span>
            <div>
              <div className={INT_NAME}>Homebrew is installed</div>
              <div className={INT_PURPOSE}>You're ready for the next step.</div>
            </div>
          </div>
        ) : brew ? (
          <InstallCard
            integration={brew}
            // No prerequisite for brew itself — its installer is a self-
            // contained curl|bash.
            disabled={false}
            installing={installing}
            onRun={onRun}
          />
        ) : null}
        <Button
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={onRefresh}
          type="button"
          disabled={loading}
        >
          {I.retry} Re-scan
        </Button>
      </div>
      <div className={FOOTER}>
        <Button variant="outline" size="sm" onClick={onBack} type="button">
          Back
        </Button>
        <span className="flex-1" />
        <Button variant="default" size="sm" onClick={onNext} type="button">
          {brewMissing ? "Skip — finish later" : "Next"}
        </Button>
      </div>
    </>
  );
}

/**
 * Step 3 — the actual tools (Git, GitHub CLI, Claude Code, Codex). Each row
 * shows status + a ▶ button that pipes the install command into the
 * integrated terminal. Rows whose `requires` prerequisite isn't ready are
 * grayed out with an explanatory tooltip — clicking "Install" on
 * `brew install gh` before brew exists would just error out.
 */
function ToolsStep({
  tools,
  brewAvailable,
  installing,
  loading,
  onBack,
  onNext,
  onRefresh,
  onRun,
}: {
  tools: Integration[];
  brewAvailable: boolean;
  /** id of the tool whose install is currently in flight, or null. */
  installing: string | null;
  loading: boolean;
  onBack: () => void;
  onNext: () => void;
  onRefresh: () => void;
  onRun: (it: Integration) => void;
}) {
  return (
    <>
      <div className={BODY}>
        <h2 className={TITLE}>Install your tools</h2>
        <p className={LEDE}>
          Click ▶ next to any missing tool to open the integrated terminal
          and run the install command. Git is required; the rest unlock AI
          and PR features.
        </p>
        <div className={INTEGRATION_LIST}>
          {loading && tools.length === 0 ? (
            <div className="font-mono text-fg-2 text-[11.5px]">Detecting…</div>
          ) : (
            tools.map((it) => {
              const prereqMissing =
                it.requires === "brew" && !brewAvailable;
              return (
                <InstallCard
                  key={it.id}
                  integration={it}
                  disabled={prereqMissing}
                  installing={installing === it.id}
                  prereqLabel={
                    prereqMissing
                      ? "Install Homebrew first (previous step)"
                      : null
                  }
                  onRun={onRun}
                />
              );
            })
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={onRefresh}
          type="button"
          disabled={loading}
        >
          {I.retry} Re-scan
        </Button>
      </div>
      <div className={FOOTER}>
        <Button variant="outline" size="sm" onClick={onBack} type="button">
          Back
        </Button>
        <span className="flex-1" />
        <Button variant="default" size="sm" onClick={onNext} type="button">
          Next
        </Button>
      </div>
    </>
  );
}

/**
 * One installable row. Reused for both the Homebrew step (single big card)
 * and the Tools step (list of cards). Shows the command in a `<code>` block
 * with a play button on the right; when the tool is already installed the
 * row collapses to a "is-on" check.
 */
function InstallCard({
  integration,
  disabled,
  installing = false,
  prereqLabel,
  onRun,
}: {
  integration: Integration;
  disabled: boolean;
  /** True while a background poll is waiting for this tool to appear on PATH. */
  installing?: boolean;
  prereqLabel?: string | null;
  onRun: (it: Integration) => void;
}) {
  const it = integration;
  if (it.available) {
    return (
      <div className={cn(INTEGRATION_BASE, INTEGRATION_ON)}>
        <span className={cn(STATUS_CELL, STATUS_CELL_ON)}>{I.check}</span>
        <div>
          <div className={INT_NAME}>{it.name}</div>
          <div className={INT_PURPOSE}>{it.purpose}</div>
        </div>
      </div>
    );
  }
  // Pick the correct play-button skin. `installing` wins over `disabled`
  // because polling state is more informative than the disabled-because-
  // prereq-missing state when both are technically true.
  const playSkin = installing
    ? INSTALL_PLAY_INSTALLING
    : disabled
      ? INSTALL_PLAY_DISABLED
      : INSTALL_PLAY_ENABLED;
  return (
    <div
      className={cn(INTEGRATION_BASE, disabled && INTEGRATION_DISABLED)}
    >
      <span
        className={cn(
          STATUS_CELL,
          // The spinner here is 14px (vs 12px inside the play button).
          "[&_[data-ai-spinner]]:w-[14px] [&_[data-ai-spinner]]:h-[14px]",
        )}
      >
        {installing ? <Spinner /> : I.x}
      </span>
      <div>
        <div className={INT_NAME}>{it.name}</div>
        <div className={INT_PURPOSE}>{it.purpose}</div>
        <div className={INSTALL_ROW}>
          <code className={INSTALL_CMD}>{it.installCommand}</code>
          <Button variant="unstyled"
            type="button"
            className={cn(INSTALL_PLAY_BASE, playSkin)}
            onClick={() => onRun(it)}
            // Keep the button disabled while installing so the user
            // doesn't queue a second invocation while the first is still
            // working through the terminal.
            disabled={disabled || installing}
            title={
              disabled
                ? prereqLabel ?? "Prerequisite missing"
                : installing
                  ? "Installing — checking back every few seconds…"
                  : "Run in integrated terminal"
            }
            aria-label="Install"
          >
            {installing ? <Spinner /> : "▶"}
          </Button>
        </div>
        {installing ? (
          <div className={INSTALL_PREREQ}>
            Running in terminal — this card will flip to ✓ when{" "}
            <code className="font-mono">{it.id}</code> appears on PATH.
          </div>
        ) : disabled && prereqLabel ? (
          <div className={INSTALL_PREREQ}>{prereqLabel}</div>
        ) : null}
      </div>
    </div>
  );
}

function DoneStep({
  onBack,
  onPickRepo,
  onFinish,
}: {
  onBack: () => void;
  onPickRepo: () => Promise<void>;
  onFinish: () => void;
}) {
  return (
    <>
      <div className={BODY}>
        <h2 className={TITLE}>You're set</h2>
        <p className={LEDE}>
          Open a repository to start reviewing. You can revisit this tour
          anytime from the command palette ("Show welcome tour"), and tweak
          AI / appearance in Preferences (⌘,).
        </p>
        <div className={SHORTCUTS_GRID}>
          <div className={SHORTCUT_ROW}>
            <Kbd>⌘O</Kbd>
            <span>Open repository</span>
          </div>
          <div className={SHORTCUT_ROW}>
            <Kbd>⌘P</Kbd>
            <span>Go to file</span>
          </div>
          <div className={SHORTCUT_ROW}>
            <Kbd>⌘⇧P</Kbd>
            <span>Command palette</span>
          </div>
          <div className={SHORTCUT_ROW}>
            <Kbd>⌘F</Kbd>
            <span>Find in file</span>
          </div>
          <div className={SHORTCUT_ROW}>
            <Kbd>⌘⇧F</Kbd>
            <span>Find in repository</span>
          </div>
          <div className={SHORTCUT_ROW}>
            <Kbd>⌘,</Kbd>
            <span>Preferences</span>
          </div>
        </div>
      </div>
      <div className={FOOTER}>
        <Button variant="outline" size="sm" onClick={onBack} type="button">
          Back
        </Button>
        <span className="flex-1" />
        <Button variant="outline" size="sm" onClick={onFinish} type="button">
          Pick later
        </Button>
        <Button variant="default" size="sm" onClick={onPickRepo} type="button">
          Open repository…
        </Button>
      </div>
    </>
  );
}

function Feature({ title, body }: { title: string; body: string }) {
  return (
    <div className={FEATURE_CARD}>
      <div className={FEATURE_TITLE}>{title}</div>
      <div className={FEATURE_BODY}>{body}</div>
    </div>
  );
}
