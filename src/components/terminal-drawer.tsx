import { useEffect, useRef, useState } from "react";
import { Terminal, type ILink, type ILinkProvider } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import "@xterm/xterm/css/xterm.css";
import { Button } from "@/components/ui/button";

import { useRepoStore } from "@/features/repository/repository.store";
import { useBoardStore } from "@/features/board/board.store";
import { isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import {
  termClose,
  termOpen,
  termResize,
  termWrite,
} from "@/features/terminal/terminal.api";
import { I } from "./icons";

/**
 * Shared style fragments for the drawer shell. `DRAWER` mirrors the
 * "floating card" look that `.main-col` and the sidebars use so the three
 * workspace bubbles read as a consistent set.
 */
const DRAWER =
  "relative shrink-0 flex flex-col min-h-[120px] overflow-hidden " +
  "bg-[color-mix(in_oklab,var(--bg-0)_92%,transparent)] " +
  "border border-bd-2 rounded-[10px] " +
  "shadow-[0_12px_32px_rgba(0,0,0,0.4),0_2px_8px_rgba(0,0,0,0.25)] " +
  "backdrop-blur-card backdrop-saturate-[140%]";
const HEADER =
  "flex items-stretch h-[28px] shrink-0 " +
  "bg-bg-1 border-b border-bd-1 select-none";
const ICON_BTN =
  "w-5 h-5 grid place-items-center border-0 bg-transparent text-fg-3 " +
  "rounded-[4px] leading-none cursor-pointer " +
  "hover:bg-bg-hover hover:text-fg-1";
// xterm host. The `:global` overrides reset xterm's own viewport bg so the
// drawer's translucent card shows through, and make the canvas fill the
// host so it doesn't bleed past the rounded corner.
const HOST =
  "flex-1 min-h-0 px-2 pt-1.5 bg-bg-0 select-text " +
  "[&_.xterm]:h-full " +
  "[&_.xterm-viewport]:!bg-transparent";

/**
 * Bottom-of-workspace integrated terminal — VSCode-style multi-tab.
 *
 * `terminalTabs` holds N independent PTYs; each tab mounts its own
 * `TerminalTabPane`. Inactive panes stay mounted with `display:none` so
 * their scrollback + running processes survive a tab switch. The trash
 * icon in the header tears everything down (kills every PTY).
 *
 * Lifecycle summary:
 *   - `terminalOpen` controls drawer visibility only.
 *   - Each tab is created via `openTerminalTab` (from a script run, the
 *     onboarding ▶, or the "+" in the tab strip).
 *   - Closing the last tab hides the drawer; the next ⌘\` re-spawns a
 *     default shell so the user never sees an empty drawer.
 */
export function TerminalDrawer() {
  const open = useRepoStore((s) => s.terminalOpen);
  const tabs = useRepoStore((s) => s.terminalTabs);
  const activeId = useRepoStore((s) => s.activeTerminalTabId);
  const repository = useRepoStore((s) => s.repository);
  const height = useRepoStore((s) => s.terminalHeight);
  // Selecting position + width separately so the drawer can re-render
  // only when one of them changes — same pattern as the existing
  // `height` selector above.
  const position = useRepoStore((s) => s.settings.terminalPosition);
  const rightWidth = useRepoStore((s) => s.settings.terminalRightWidth);
  const setTerminalPosition = useRepoStore((s) => s.setTerminalPosition);
  const setTerminalOpen = useRepoStore((s) => s.setTerminalOpen);
  const killTerminalSession = useRepoStore((s) => s.killTerminalSession);
  const openTerminalTab = useRepoStore((s) => s.openTerminalTab);
  const setActiveTerminalTab = useRepoStore((s) => s.setActiveTerminalTab);
  const closeTerminalTab = useRepoStore((s) => s.closeTerminalTab);
  const pushToast = useRepoStore((s) => s.pushToast);
  // Default cwd for the "+" button and for tabs that didn't pin one
  // themselves. Board mode prefers the active project's repo path; diff
  // mode uses the opened repo.
  const boardProjectPath = useBoardStore((s) =>
    s.activeProjectId ? s.projectsById[s.activeProjectId]?.repoPath ?? null : null,
  );
  const defaultCwd = repository?.path ?? boardProjectPath ?? null;

  if (tabs.length === 0) return null;

  // Two docking modes:
  //   - "bottom" (default): the drawer is a fixed-height strip beneath
  //     the main column, full width. Resize handle lives between the
  //     main pane and the drawer (vertical drag).
  //   - "right": the drawer becomes a fixed-width side panel, full
  //     height. Resize handle lives to its left (horizontal drag).
  // We swap the inline style — width/height — based on `position` so
  // the same component handles both layouts without splitting.
  const dockStyle: React.CSSProperties =
    position === "right"
      ? {
          width: `${rightWidth}px`,
          height: "100%",
          display: open ? undefined : "none",
        }
      : {
          height: `${height}px`,
          display: open ? undefined : "none",
        };

  return (
    <div
      className={DRAWER}
      style={dockStyle}
      role="region"
      aria-label="Integrated terminal"
    >
      <div className={HEADER}>
        <div className="flex-1 min-w-0 flex items-stretch overflow-x-auto">
          {tabs.map((tab) => (
            <TabHandle
              key={tab.id}
              title={tab.title}
              active={tab.id === activeId}
              onSelect={() => setActiveTerminalTab(tab.id)}
              onClose={() => closeTerminalTab(tab.id)}
            />
          ))}
          <Button variant="unstyled"
            type="button"
            onClick={() => openTerminalTab({ cwd: defaultCwd })}
            title="New terminal"
            className={cn(
              "h-full px-2 grid place-items-center text-fg-3",
              "bg-transparent border-0 cursor-pointer",
              "hover:bg-bg-hover hover:text-fg-1",
            )}
          >
            <span className="text-[14px] leading-none">+</span>
          </Button>
        </div>
        <div className="flex items-center px-1.5 gap-0.5 border-l border-bd-1">
          {/* Dock toggle — swaps bottom ↔ right. Distinct icon per
              destination so the click target makes its intent obvious
              ("you're at the bottom — click to move me to the right").
              Lives in the drawer header (not the topbar) so it travels
              with the terminal whichever way it's docked. */}
          <Button variant="unstyled"
            type="button"
            className={ICON_BTN}
            onClick={() =>
              setTerminalPosition(position === "bottom" ? "right" : "bottom")
            }
            aria-label={
              position === "bottom"
                ? "Move terminal to right side"
                : "Move terminal to bottom"
            }
            title={
              position === "bottom"
                ? "Dock to right side"
                : "Dock to bottom"
            }
          >
            {position === "bottom" ? I.sidebarRight : I.terminal}
          </Button>
          <Button variant="unstyled"
            type="button"
            className={ICON_BTN}
            onClick={killTerminalSession}
            aria-label="Kill every terminal tab"
            title="Kill every terminal tab"
          >
            {I.discard}
          </Button>
          <Button variant="unstyled"
            type="button"
            className={ICON_BTN}
            onClick={() => setTerminalOpen(false)}
            aria-label="Hide terminal"
            title="Hide terminal (⌘`) — sessions keep running"
          >
            {I.x}
          </Button>
        </div>
      </div>
      {/* Stack every tab's pane on top of each other; only the active one
          gets `display: block`. Keeping the rest mounted preserves their
          scrollback and lets long-running processes (bun run dev) keep
          producing output even when the user is looking at another tab. */}
      <div className="flex-1 min-h-0 relative">
        {tabs.map((tab) => (
          <TerminalTabPane
            key={tab.id}
            tabId={tab.id}
            cwd={tab.cwd ?? defaultCwd}
            pendingCommand={tab.pendingCommand}
            setupRunId={tab.setupRunId}
            visible={open && tab.id === activeId}
            onError={(msg) => pushToast(msg, "danger")}
          />
        ))}
      </div>
    </div>
  );
}

function TabHandle({
  title,
  active,
  onSelect,
  onClose,
}: {
  title: string;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className={cn(
        "group h-full inline-flex items-center gap-1.5 px-2.5",
        "border-r border-bd-1 cursor-pointer select-none",
        "text-[11px] tracking-[0.01em]",
        active
          ? "bg-bg-0 text-fg-0"
          : "text-fg-2 hover:bg-bg-hover hover:text-fg-1",
      )}
      onMouseDown={(e) => {
        // Use mousedown for snappier feel and so the close X can short-
        // circuit via stopPropagation without flashing the tab as active.
        if (e.button === 0) onSelect();
      }}
      title={title}
    >
      <span className="truncate max-w-[160px]">{title}</span>
      <Button variant="unstyled"
        type="button"
        onMouseDown={(e) => {
          e.stopPropagation();
        }}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        title="Close tab"
        className={cn(
          "w-4 h-4 grid place-items-center rounded-[3px] border-0 cursor-pointer",
          "bg-transparent text-fg-3 hover:bg-bg-hover hover:text-fg-0",
          active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
        )}
      >
        <span className="text-[10px] leading-none">×</span>
      </Button>
    </div>
  );
}

/**
 * Inject `cmd` into the active xterm session. We append `\r` so the user's
 * shell auto-executes it; if the caller wants the command merely typed (for
 * the user to inspect first), pass `executeImmediately=false`.
 */
function injectCommand(
  sessionId: string,
  cmd: string,
  executeImmediately = true,
): Promise<void> {
  const suffix = executeImmediately ? "\r" : "";
  return termWrite(sessionId, cmd + suffix);
}

type PaneProps = {
  tabId: string;
  cwd: string | null;
  pendingCommand: string | null;
  setupRunId?: string;
  /**
   * Whether this pane's tab is currently selected AND the drawer is
   * visible. Hidden panes keep their PTY running but skip refits and
   * focus-stealing.
   */
  visible: boolean;
  onError: (message: string) => void;
};

function TerminalTabPane({
  tabId,
  cwd,
  pendingCommand,
  setupRunId,
  visible,
  onError,
}: PaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const [sessionReady, setSessionReady] = useState(false);

  const clearTabPendingCommand = useRepoStore((s) => s.clearTabPendingCommand);
  const height = useRepoStore((s) => s.terminalHeight);
  // Setup tabs are read-only viewers — they subscribe to setup://run/<id>
  // events instead of allocating a PTY. We branch on this once at mount;
  // toggling mid-life isn't supported (tabs are either PTY or setup).
  const setupMode = !!setupRunId;

  // Theme / font settings we need to watch — xterm doesn't reactively re-read
  // CSS variables, so when the user switches Preferences → Theme or Code
  // font, we re-resolve the values from the DOM and push them into the
  // already-constructed terminal.
  const themeId = useRepoStore((s) => s.settings.theme);
  const customColors = useRepoStore((s) => s.settings.customColors);
  const codeFont = useRepoStore((s) => s.settings.codeFont);
  const customCodeFont = useRepoStore((s) => s.settings.customCodeFont);
  const uiZoom = useRepoStore((s) => s.settings.uiZoom);

  // Spin up xterm + PTY exactly once per tab mount. The `key={tabId}` on
  // the wrapper means a new tab gets a fresh shell, and a closed tab tears
  // its session down via the cleanup function below.
  useEffect(() => {
    if (setupMode) return; // setup tabs use a separate effect below
    if (!isTauri()) return;
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily: resolveMonoStack(),
      fontSize: 12 * uiZoom,
      letterSpacing: 0,
      lineHeight: 1.2,
      cursorBlink: true,
      allowProposedApi: true,
      linkHandler: {
        activate: (event, text) => openTerminalUrl(text, event),
      },
      theme: resolveXtermTheme(),
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    const linkProvider = term.registerLinkProvider(createUrlLinkProvider(term));
    xtermRef.current = term;
    fitRef.current = fit;

    let unlistenData: UnlistenFn | null = null;
    let unlistenExit: UnlistenFn | null = null;
    let disposed = false;

    (async () => {
      try {
        fit.fit();
        document.fonts?.ready
          .then(() => {
            if (disposed) return;
            term.options.fontFamily = resolveMonoStack();
            term.options.letterSpacing = 0;
            fit.fit();
            term.refresh(0, term.rows - 1);
          })
          .catch(() => {
            /* font readiness is best-effort */
          });
        const cols = term.cols;
        const rows = term.rows;
        const { id } = await termOpen(cols, rows, cwd);
        if (disposed) {
          termClose(id).catch(() => {});
          return;
        }
        sessionIdRef.current = id;
        setSessionReady(true);

        unlistenData = await listen<string>(
          `term://${id}/data`,
          (event) => {
            const bytes = base64ToUint8Array(event.payload);
            term.write(bytes);
          },
        );
        unlistenExit = await listen<string>(
          `term://${id}/exit`,
          () => {
            sessionIdRef.current = null;
            term.write(
              "\r\n\x1b[2m[process exited — close this tab to clear it]\x1b[0m\r\n",
            );
          },
        );

        term.onData((data) => {
          const sid = sessionIdRef.current;
          if (!sid) return;
          termWrite(sid, data).catch(() => {});
        });
        term.onResize(({ cols, rows }) => {
          const sid = sessionIdRef.current;
          if (!sid) return;
          termResize(sid, cols, rows).catch(() => {});
        });
        if (visible) term.focus();
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      disposed = true;
      unlistenData?.();
      unlistenExit?.();
      const sid = sessionIdRef.current;
      sessionIdRef.current = null;
      setSessionReady(false);
      if (sid) termClose(sid).catch(() => {});
      linkProvider.dispose();
      term.dispose();
      xtermRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // cwd is captured at first mount — tab id is stable for the lifetime of the tab

  // Drain the one-shot pending command once the PTY is alive.
  useEffect(() => {
    if (setupMode) return;
    if (!pendingCommand) return;
    if (!sessionReady) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    injectCommand(sid, pendingCommand, true)
      .catch((err) => {
        onError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => clearTabPendingCommand(tabId));
  }, [setupMode, pendingCommand, sessionReady, clearTabPendingCommand, onError, tabId]);

  // Setup-mode mount: build a read-only xterm and pipe setup script
  // events into it. No PTY is opened; input is ignored. A separate
  // listener also pops a final status line on exit so the user can see
  // how the script ended.
  useEffect(() => {
    if (!setupMode || !setupRunId) return;
    if (!isTauri()) return;
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily: resolveMonoStack(),
      fontSize: 12 * uiZoom,
      letterSpacing: 0,
      lineHeight: 1.2,
      cursorBlink: false,
      disableStdin: true,
      allowProposedApi: true,
      linkHandler: {
        activate: (event, text) => openTerminalUrl(text, event),
      },
      theme: resolveXtermTheme(),
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    const linkProvider = term.registerLinkProvider(createUrlLinkProvider(term));
    xtermRef.current = term;
    fitRef.current = fit;

    let unlistenData: UnlistenFn | null = null;
    let unlistenExit: UnlistenFn | null = null;
    let disposed = false;
    // Defer the first fit() to next frame so the host's layout (flex,
    // height) has actually been applied. Running fit() synchronously
    // here clamps xterm to 0×0 because the host has no measured size
    // yet — visible output starts at the top and the lower half stays
    // black even after a resize.
    requestAnimationFrame(() => {
      if (!disposed) fit.fit();
    });

    (async () => {
      try {
        unlistenData = await listen<{
          runId: string;
          line: string;
          stream: "stdout" | "stderr";
        }>(`setup://run/${setupRunId}/data`, (event) => {
          if (disposed) return;
          const { line, stream } = event.payload;
          // The Rust side emits the script preamble as a single payload
          // with embedded `\n`. xterm's `\n` only moves the cursor down,
          // it never returns to column 0 — without normalizing each
          // line stair-steps diagonally across the pane. Convert any
          // bare LF in the payload to CRLF before writing.
          const normalized = line.replace(/\r?\n/g, "\r\n");
          // Tint stderr red so script errors stand out — bash itself
          // doesn't ANSI-color most of its diagnostics.
          if (stream === "stderr") {
            term.write(`\x1b[31m${normalized}\x1b[0m\r\n`);
          } else {
            term.write(`${normalized}\r\n`);
          }
        });
        unlistenExit = await listen<{
          runId: string;
          code: number | null;
          reason: string;
        }>(`setup://run/${setupRunId}/exit`, (event) => {
          if (disposed) return;
          const { code, reason } = event.payload;
          const ok = code === 0;
          const tag = ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
          const codeStr = code === null ? reason : `exit ${code}`;
          term.write(`\r\n${tag} setup finished (${codeStr})\r\n`);
        });
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      disposed = true;
      unlistenData?.();
      unlistenExit?.();
      linkProvider.dispose();
      term.dispose();
      xtermRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setupMode, setupRunId]);

  useEffect(() => {
    const onWindowResize = () => fitRef.current?.fit();
    window.addEventListener("resize", onWindowResize);
    return () => window.removeEventListener("resize", onWindowResize);
  }, []);

  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;
    const handle = requestAnimationFrame(() => {
      term.options.theme = resolveXtermTheme();
      term.options.fontFamily = resolveMonoStack();
      term.options.fontSize = 12 * uiZoom;
      term.options.letterSpacing = 0;
      fitRef.current?.fit();
      term.refresh(0, term.rows - 1);
    });
    return () => cancelAnimationFrame(handle);
  }, [themeId, customColors, codeFont, customCodeFont, uiZoom]);

  useEffect(() => {
    const raf = requestAnimationFrame(() => fitRef.current?.fit());
    return () => cancelAnimationFrame(raf);
  }, [height]);

  // When the pane becomes visible, the host gains real pixel dimensions;
  // xterm needs a fresh fit + focus so keystrokes land.
  useEffect(() => {
    if (!visible) return;
    const raf = requestAnimationFrame(() => {
      fitRef.current?.fit();
      xtermRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [visible]);

  return (
    // `flex flex-col` so the `flex-1` on the host div actually resolves
    // against the pane height — without it the host has no constrained
    // height and xterm stays at its initial small size even after the
    // user resizes the drawer.
    <div
      className="absolute inset-0 flex flex-col"
      style={{ display: visible ? undefined : "none" }}
    >
      <div ref={hostRef} className={HOST} />
    </div>
  );
}

/**
 * Read the active theme's CSS variables and feed them to xterm. The terminal
 * doesn't accept `var(...)` in its theme object, so we resolve once at mount.
 */
function resolveXtermTheme(): NonNullable<
  ConstructorParameters<typeof Terminal>[0]
>["theme"] {
  const styles = getComputedStyle(document.documentElement);
  const cssVar = (name: string, fallback: string): string => {
    const v = styles.getPropertyValue(name).trim();
    return v || fallback;
  };
  return {
    background: cssVar("--bg-0", "#0b0b0c"),
    foreground: cssVar("--fg-1", "#e6e6e6"),
    cursor: cssVar("--accent", "#6cb1ff"),
    cursorAccent: cssVar("--bg-0", "#0b0b0c"),
    selectionBackground: cssVar("--selection", "rgba(108,177,255,0.35)"),
  };
}

/**
 * Pull `--font-mono` off the root element so the terminal renders in the
 * same code font as the diff editor.
 */
function resolveMonoStack(): string {
  const styles = getComputedStyle(document.documentElement);
  const v = styles.getPropertyValue("--font-mono").trim();
  return (
    v ||
    '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace'
  );
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'`{}|\\^[\]]+/gi;
const TRAILING_URL_PUNCT = /[),.;:!?]+$/;

function createUrlLinkProvider(term: Terminal): ILinkProvider {
  return {
    provideLinks(
      bufferLineNumber: number,
      callback: (links: ILink[] | undefined) => void,
    ) {
      const line = term.buffer.active.getLine(bufferLineNumber - 1);
      if (!line) {
        callback(undefined);
        return;
      }
      const text = line.translateToString(true);
      const links: ILink[] = [...text.matchAll(URL_RE)].map((match) => {
        const raw = match[0];
        const url = raw.replace(TRAILING_URL_PUNCT, "");
        const start = match.index ?? 0;
        const end = start + url.length;
        return {
          range: {
            start: { x: start + 1, y: bufferLineNumber },
            end: { x: end + 1, y: bufferLineNumber },
          },
          text: url,
          decorations: {
            underline: true,
            pointerCursor: true,
          },
          activate: (event: MouseEvent, linkText: string) => {
            openTerminalUrl(linkText, event);
          },
        };
      });
      callback(links.length > 0 ? links : undefined);
    },
  };
}

function openTerminalUrl(text: string, event: MouseEvent): void {
  if (!event.metaKey && !event.ctrlKey) return;
  const url = normalizeTerminalUrl(text);
  if (!url) return;
  openUrl(url).catch(() => {
    /* best-effort; terminal link activation should not interrupt input */
  });
}

function normalizeTerminalUrl(text: string): string | null {
  const trimmed = text.trim().replace(TRAILING_URL_PUNCT, "");
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function base64ToUint8Array(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
