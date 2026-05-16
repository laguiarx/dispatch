import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";

import { useRepoStore } from "@/features/repository/repository.store";
import { isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";

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
  "flex items-center justify-between h-[26px] px-2.5 shrink-0 " +
  "bg-bg-1 border-b border-bd-1 select-none";
const TITLE =
  "text-[11px] font-semibold tracking-[0.04em] uppercase text-fg-2";
const ICON_BTN =
  "w-5 h-5 grid place-items-center border-0 bg-transparent text-fg-3 " +
  "rounded-[4px] leading-none cursor-pointer ml-0.5 " +
  "hover:bg-bg-hover hover:text-fg-1";
// xterm host. The `:global` overrides reset xterm's own viewport bg so the
// drawer's translucent card shows through, and make the canvas fill the
// host so it doesn't bleed past the rounded corner.
const HOST =
  "flex-1 min-h-0 px-2 pt-1.5 bg-bg-0 " +
  "[&_.xterm]:h-full " +
  "[&_.xterm-viewport]:!bg-transparent";
import {
  termClose,
  termOpen,
  termResize,
  termWrite,
} from "@/features/terminal/terminal.api";
import { I } from "./icons";

/**
 * Bottom-of-workspace integrated terminal.
 *
 * Two pieces of state govern visibility/lifecycle:
 *   - `terminalSessionAlive` — whether the PTY + xterm exist in the tree
 *   - `terminalOpen`        — whether the drawer is visible
 *
 * The session is mounted as long as `terminalSessionAlive`; when the user
 * clicks the X (or presses ⌘`/⌘J) we only hide the drawer (display:none),
 * leaving the shell + any running process intact. Re-opening reveals the
 * same scrollback. The trash button in the drawer header is the explicit
 * "kill the session" affordance — it sets `terminalSessionAlive=false`,
 * which unmounts the inner component and (via its cleanup) closes the PTY.
 *
 * Resize handling: every layout change (drawer height drag, window resize,
 * drawer becoming visible after being hidden) calls `fitAddon.fit()` which
 * recomputes cols/rows and pushes the new size to the PTY via `termResize`.
 */
export function TerminalDrawer() {
  const open = useRepoStore((s) => s.terminalOpen);
  const sessionAlive = useRepoStore((s) => s.terminalSessionAlive);
  const repository = useRepoStore((s) => s.repository);
  const height = useRepoStore((s) => s.terminalHeight);
  const setTerminalOpen = useRepoStore((s) => s.setTerminalOpen);
  const killTerminalSession = useRepoStore((s) => s.killTerminalSession);
  const pushToast = useRepoStore((s) => s.pushToast);

  if (!sessionAlive) return null;

  return (
    <TerminalDrawerInner
      key={repository?.path ?? "no-repo"}
      cwd={repository?.path ?? null}
      visible={open}
      height={height}
      onHide={() => setTerminalOpen(false)}
      onKill={() => killTerminalSession()}
      onError={(msg) => pushToast(msg, "danger")}
    />
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

type InnerProps = {
  cwd: string | null;
  /**
   * Whether the drawer is currently visible. When false we keep the xterm
   * mounted (so scrollback + the PTY survive) and just toggle `display:none`
   * on the outer element.
   */
  visible: boolean;
  height: number;
  /** X button — hide the drawer, keep the session alive. */
  onHide: () => void;
  /** Trash button — kill the PTY and tear down xterm. */
  onKill: () => void;
  onError: (message: string) => void;
};

function TerminalDrawerInner({
  cwd,
  visible,
  height,
  onHide,
  onKill,
  onError,
}: InnerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  // Tracks PTY-ready state so the pending-command effect can hold off
  // writing until the shell is alive (otherwise the IPC call would fail
  // with "no such terminal").
  const [sessionReady, setSessionReady] = useState(false);

  // Pull the pending command + clear action via Zustand subscribers, so a
  // new ▶ click triggers the inject effect even when the drawer was
  // already mounted.
  const pendingCommand = useRepoStore((s) => s.pendingTerminalCommand);
  const clearPendingTerminalCommand = useRepoStore(
    (s) => s.clearPendingTerminalCommand,
  );

  // Theme / font settings we need to watch — xterm doesn't reactively re-read
  // CSS variables, so when the user switches Preferences → Theme or Code
  // font, we re-resolve the values from the DOM and push them into the
  // already-constructed terminal. (Listing the individual fields rather
  // than the whole settings object so unrelated setting changes don't
  // bust the effect.)
  const themeId = useRepoStore((s) => s.settings.theme);
  const customColors = useRepoStore((s) => s.settings.customColors);
  const codeFont = useRepoStore((s) => s.settings.codeFont);
  const customCodeFont = useRepoStore((s) => s.settings.customCodeFont);

  // Spin up xterm + PTY exactly once when the drawer mounts. The `key` on
  // the wrapper forces a clean remount when the repo path changes — the
  // new session starts in the new cwd.
  useEffect(() => {
    if (!isTauri()) {
      // Web preview mode: render a placeholder rather than crashing on the
      // Tauri-only `invoke` calls.
      return;
    }
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      // xterm's option parser does NOT evaluate CSS variables — it just
      // hands the string to the renderer's font-family. So we resolve
      // `--font-mono` ourselves at construction time. (The user's
      // preferred code font is already pushed into this variable by
      // `applyMonoFont` in lib/theme.ts, so the terminal stays in sync
      // with whatever they picked in Preferences.)
      fontFamily: resolveMonoStack(),
      fontSize: 12,
      lineHeight: 1.2,
      cursorBlink: true,
      allowProposedApi: true,
      // Theme keys map to our CSS variables; xterm doesn't accept var() so
      // we resolve them via getComputedStyle once at construction time.
      theme: resolveXtermTheme(),
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    xtermRef.current = term;
    fitRef.current = fit;

    let unlistenData: UnlistenFn | null = null;
    let unlistenExit: UnlistenFn | null = null;
    let disposed = false;

    (async () => {
      try {
        // Fit before opening the PTY so the shell starts at the right size.
        fit.fit();
        const cols = term.cols;
        const rows = term.rows;
        const { id } = await termOpen(cols, rows, cwd);
        if (disposed) {
          // Drawer was closed before the open promise resolved — tear down
          // the session immediately so we don't leak a shell.
          termClose(id).catch(() => {});
          return;
        }
        sessionIdRef.current = id;
        setSessionReady(true);

        unlistenData = await listen<string>(
          `term://${id}/data`,
          (event) => {
            // Payload is base64; decode and feed bytes directly to xterm.
            const bytes = base64ToUint8Array(event.payload);
            term.write(bytes);
          },
        );
        unlistenExit = await listen<string>(
          `term://${id}/exit`,
          () => {
            sessionIdRef.current = null;
            term.write(
              "\r\n\x1b[2m[process exited — click trash to start a new session]\x1b[0m\r\n",
            );
            // Deliberately DON'T flip `terminalSessionAlive` here — that
            // would unmount this component before the user reads the
            // message above. Let them dismiss via trash instead.
          },
        );

        // Wire keystrokes → PTY. xterm hands us already-encoded byte
        // sequences (e.g. \x1b[A for ↑), so we forward verbatim.
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
        term.focus();
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
      term.dispose();
      xtermRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // cwd handled via the wrapper's `key`

  // Drain any pending command — typically queued by the onboarding ▶
  // buttons via `runInTerminal`. We wait for `sessionReady` so the very
  // first install click (which also opens the drawer for the first time)
  // doesn't race the PTY spawn.
  useEffect(() => {
    if (!pendingCommand) return;
    if (!sessionReady) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    injectCommand(sid, pendingCommand, true)
      .catch((err) => {
        onError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => clearPendingTerminalCommand());
  }, [pendingCommand, sessionReady, clearPendingTerminalCommand, onError]);

  // Refit whenever the drawer's pixel height changes (user drag) or the
  // window itself resizes. xterm's `fit()` reads the host's clientWidth/Height,
  // recomputes cols/rows, and calls `term.resize()` which in turn fires the
  // `onResize` handler that pushes the new size to the PTY.
  useEffect(() => {
    const onWindowResize = () => fitRef.current?.fit();
    window.addEventListener("resize", onWindowResize);
    return () => window.removeEventListener("resize", onWindowResize);
  }, []);
  // Re-apply theme + font when the user changes Preferences. `applyTheme`
  // / `applyMonoFont` already updated the CSS variables for the rest of
  // the app; we just need to pull the fresh values and push them into
  // xterm's option bag. The renderer picks them up on the next paint.
  // We defer to a microtask so the CSS variable write from the settings
  // action has actually landed in the DOM before we read it back.
  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;
    const handle = requestAnimationFrame(() => {
      term.options.theme = resolveXtermTheme();
      term.options.fontFamily = resolveMonoStack();
      // Force a re-measure: the font might be wider/narrower than before,
      // which would invalidate the current cols/rows.
      fitRef.current?.fit();
    });
    return () => cancelAnimationFrame(handle);
  }, [themeId, customColors, codeFont, customCodeFont]);
  useEffect(() => {
    // Run on next frame so the new drawer height has been laid out before
    // xterm measures.
    const raf = requestAnimationFrame(() => fitRef.current?.fit());
    return () => cancelAnimationFrame(raf);
  }, [height]);
  // When the drawer transitions from hidden → visible, the host element
  // gains real pixel dimensions; xterm needs a fresh fit otherwise it stays
  // sized to whatever it had when last visible (or 0×0 if it was hidden at
  // mount time). Refocus so keystrokes go to the shell again.
  useEffect(() => {
    if (!visible) return;
    const raf = requestAnimationFrame(() => {
      fitRef.current?.fit();
      xtermRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [visible]);

  return (
    <div
      className={DRAWER}
      style={{
        height: `${height}px`,
        // Hide-by-display rather than unmount so the session keeps running
        // while the drawer is invisible. The outer wrapper component is
        // what decides whether the inner exists at all (sessionAlive).
        display: visible ? undefined : "none",
      }}
      role="region"
      aria-label="Integrated terminal"
    >
      <div className={HEADER}>
        <span className={TITLE}>Terminal</span>
        <span className="flex-1" />
        <button
          type="button"
          className={ICON_BTN}
          onClick={onKill}
          aria-label="Kill terminal session"
          title="Kill terminal session"
        >
          {I.discard}
        </button>
        <button
          type="button"
          className={cn(ICON_BTN, "ml-0.5")}
          onClick={onHide}
          aria-label="Hide terminal"
          title="Hide terminal (⌘`) — session keeps running"
        >
          {I.x}
        </button>
      </div>
      <div ref={hostRef} className={HOST} />
    </div>
  );
}

/**
 * Read the active theme's CSS variables and feed them to xterm. The terminal
 * doesn't accept `var(...)` in its theme object, so we resolve once at mount.
 * Re-mounting on theme change is acceptable; in practice the drawer is
 * typically closed during a settings dive anyway.
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
 * same code font as the diff editor. Falls back to a safe monospace chain
 * if the variable is unset (e.g. before `applyMonoFont` has run).
 */
function resolveMonoStack(): string {
  const styles = getComputedStyle(document.documentElement);
  const v = styles.getPropertyValue("--font-mono").trim();
  return (
    v ||
    '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace'
  );
}

function base64ToUint8Array(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
