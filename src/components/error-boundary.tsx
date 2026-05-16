import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null; info: ErrorInfo | null };

/**
 * Top-level React error boundary. Without this, any unhandled render error
 * unmounts the entire tree and the user sees nothing but `body`'s `bg-bg-0`
 * — a totally black window with the system chrome around it. The component
 * catches the error and surfaces it in plain text plus a copy/reload pair
 * so a real bug report can be filed.
 *
 * Errors thrown inside event handlers / `useEffect` callbacks still bubble
 * to `window.onerror`; this only catches errors thrown during render or in
 * the constructor / lifecycle methods of a descendant component.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ error, info });
    // Echo to the console too so DevTools / Tauri logs catch it.
    // eslint-disable-next-line no-console
    console.error("[Squint] Unhandled render error:", error, info);
  }

  reset = () => this.setState({ error: null, info: null });

  reload = () => {
    if (typeof window !== "undefined") window.location.reload();
  };

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    const stack = `${error.stack ?? error.message}\n\nComponent stack:${info?.componentStack ?? ""}`;

    return (
      <div className="h-screen flex flex-col bg-bg-0 text-fg-0 p-6 gap-3 overflow-auto">
        <div className="text-[14px] font-semibold text-git-del">
          Squint hit a render error
        </div>
        <div className="text-[12px] text-fg-2 leading-[1.5] max-w-[680px]">
          The UI threw an exception during rendering. Below is the stack
          trace. Try reloading the window — if the same error repeats, copy
          this and open an issue.
        </div>
        <pre
          className={
            "font-mono text-[11px] text-fg-1 bg-bg-2 border border-bd-2 rounded-2 " +
            "p-3 overflow-auto whitespace-pre-wrap break-words flex-1 min-h-0"
          }
        >
          {stack}
        </pre>
        <div className="flex gap-2 shrink-0">
          <button
            className={
              "inline-flex items-center gap-1.5 h-7 px-3 rounded-2 " +
              "bg-bg-2 border border-bd-1 text-fg-1 text-[12px] " +
              "hover:bg-bg-hover hover:border-bd-2 hover:text-fg-0 " +
              "cursor-pointer"
            }
            onClick={() => navigator.clipboard?.writeText(stack)}
            type="button"
          >
            Copy stack
          </button>
          <button
            className={
              "inline-flex items-center gap-1.5 h-7 px-3 rounded-2 " +
              "bg-accent text-accent-fg text-[12px] font-semibold " +
              "hover:bg-accent-hi cursor-pointer"
            }
            onClick={this.reload}
            type="button"
          >
            Reload window
          </button>
          <button
            className={
              "inline-flex items-center gap-1.5 h-7 px-3 rounded-2 " +
              "bg-transparent border border-bd-1 text-fg-1 text-[12px] " +
              "hover:bg-bg-hover hover:text-fg-0 cursor-pointer"
            }
            onClick={this.reset}
            type="button"
          >
            Dismiss
          </button>
        </div>
      </div>
    );
  }
}
