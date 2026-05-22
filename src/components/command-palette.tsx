import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { I, type IconName } from "./icons";
import { Spinner } from "./spinner";
import { CHIP, Kbd, splitShortcut } from "./kbd";

export type CommandItem = {
  id: string;
  name: string;
  sub?: string;
  section: string;
  icon: IconName;
  keywords?: string;
  badge?: string;
  kbd?: string[];
  run: () => void;
};

export type PaletteMode = "files" | "commands";

type Props = {
  open: boolean;
  mode: PaletteMode;
  onClose: () => void;
  onSwitchMode: (mode: PaletteMode) => void;
  commands: CommandItem[];
  /** When true, render a loading hint (in lieu of results). */
  loading?: boolean;
  /** Below this query length, hide results and show a hint. Default 0. */
  minQueryLength?: number;
  /**
   * Hide the "switch to files" footer button (and disable the ⌘P chord)
   * when files-mode doesn't apply — e.g. on the board view, there's no
   * working tree to search.
   */
  allowFilesMode?: boolean;
};

const MAX_VISIBLE = 200;

const PLACEHOLDER: Record<PaletteMode, string> = {
  files: "Search files by name…",
  commands: "Type a command…",
};

const TOO_SHORT_HINT: Record<PaletteMode, string> = {
  files: "Start typing to find a file.",
  commands: "Type to search commands.",
};

const NO_MATCH_HINT: Record<PaletteMode, (q: string) => string> = {
  files: (q) => `No files match "${q}"`,
  commands: (q) => `No commands match "${q}"`,
};

export function CommandPalette({
  open,
  mode,
  onClose,
  onSwitchMode,
  commands,
  loading = false,
  minQueryLength = 0,
  allowFilesMode = true,
}: Props) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Bug guard: when the user navigates with arrow keys the list auto-scrolls.
  // A stationary cursor then ends up over a *new* row, which fires `mouseenter`
  // and would change `active` again — causing an infinite scroll loop.
  //
  // We track real mouse activity and only honour `mouseenter` after an actual
  // pointer move. `keyboardNavRef` separately gates the auto-scroll effect so
  // hovering never triggers scroll on its own.
  const mouseDrivenRef = useRef(false);
  const keyboardNavRef = useRef(true);

  useEffect(() => {
    if (!open) return;
    mouseDrivenRef.current = false;
    keyboardNavRef.current = true;
    function onMove() {
      mouseDrivenRef.current = true;
    }
    document.addEventListener("mousemove", onMove);
    return () => document.removeEventListener("mousemove", onMove);
  }, [open]);

  useEffect(() => {
    if (open) {
      setQ("");
      setActive(0);
      mouseDrivenRef.current = false;
      keyboardNavRef.current = true;
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open, mode]);

  const showResults = q.length >= minQueryLength;

  const filtered = useMemo(() => {
    if (!showResults) return [] as (CommandItem & { _score: number })[];
    if (!q) return commands.map((c) => ({ ...c, _score: 0 }));
    const scored = commands
      .map((c) => ({ ...c, _score: scoreItem(q, c) }))
      .filter((c) => c._score > 0);
    scored.sort((a, b) => b._score - a._score);
    return scored;
  }, [q, commands, showResults]);

  const visible = useMemo(
    () => filtered.slice(0, MAX_VISIBLE),
    [filtered],
  );

  const groups = useMemo(() => {
    const m = new Map<string, CommandItem[]>();
    visible.forEach((c) => {
      const arr = m.get(c.section) ?? [];
      arr.push(c);
      m.set(c.section, arr);
    });
    return [...m.entries()];
  }, [visible]);

  useEffect(() => {
    if (active >= visible.length) {
      setActive(Math.max(0, visible.length - 1));
    }
  }, [visible.length, active]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        mouseDrivenRef.current = false;
        keyboardNavRef.current = true;
        setActive((a) => Math.min(visible.length - 1, a + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        mouseDrivenRef.current = false;
        keyboardNavRef.current = true;
        setActive((a) => Math.max(0, a - 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const cmd = visible[active];
        if (cmd) {
          cmd.run();
          onClose();
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, visible, active, onClose]);

  useEffect(() => {
    // Mouse-driven active changes never auto-scroll — the hovered row is, by
    // definition, already under the cursor and therefore already visible.
    if (!keyboardNavRef.current) return;
    const el = listRef.current?.querySelector(
      "[data-palette-active]",
    ) as HTMLElement | null;
    if (!el || !listRef.current) return;
    const parent = listRef.current;
    const top = el.offsetTop;
    const bot = top + el.offsetHeight;
    if (top < parent.scrollTop) parent.scrollTop = top - 4;
    else if (bot > parent.scrollTop + parent.clientHeight)
      parent.scrollTop = bot - parent.clientHeight + 4;
  }, [active]);

  if (!open) return null;

  const truncated = filtered.length - visible.length;
  let runningIdx = 0;

  return (
    <div
      // Same backdrop look as Overlay (dark scrim + blur); reproduced
      // inline because CommandPalette anchors higher up the viewport than
      // Overlay's default `pt-[70px]`. Light theme gets a lighter scrim
      // via the `[:root[data-theme='light']_&]` override.
      className={cn(
        "absolute inset-0 z-50 grid justify-items-center items-start pt-[110px]",
        "bg-[rgba(2,3,5,0.55)] backdrop-blur-[4px]",
        "[:root[data-theme='light']_&]:bg-[rgba(40,42,60,0.3)]",
      )}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={cn(
          "w-[min(620px,92vw)] flex flex-col overflow-hidden",
          "bg-bg-1 border border-bd-2 rounded-3",
          "shadow-[0_24px_80px_rgba(0,0,0,0.6),0_0_0_0.5px_rgba(255,255,255,0.04)]",
        )}
      >
        <div className="flex items-center gap-2 px-3.5 py-3 border-b border-bd-1 [&_svg]:text-fg-3">
          {I.search}
          <input
            ref={inputRef}
            type="text"
            value={q}
            placeholder={PLACEHOLDER[mode]}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            className={cn(
              "flex-1 h-[22px] text-[14px] tracking-[-0.005em] text-fg-0",
              "bg-transparent border-0 outline-none",
              "placeholder:text-fg-3",
            )}
          />
          <span className="font-mono text-fg-3 text-[10px] px-1.5 py-0.5 rounded-[3px] bg-bg-2">
            ESC
          </span>
        </div>
        <div
          ref={listRef}
          className={cn(
            "max-h-[56vh] overflow-y-auto pt-1.5 pb-2.5",
            "[scrollbar-width:thin] [scrollbar-color:var(--bd-2)_transparent]",
          )}
        >
          {!showResults ? (
            <div className="px-7 py-7 text-center text-fg-3 text-[12px]">
              {TOO_SHORT_HINT[mode]}
            </div>
          ) : loading ? (
            <div className="px-7 py-7 text-center text-fg-3 text-[12px]">
              <Spinner className="mr-2 align-middle" />
              Indexing repository…
            </div>
          ) : groups.length === 0 ? (
            <div className="px-7 py-7 text-center text-fg-3 text-[12px]">
              {NO_MATCH_HINT[mode](q)}
            </div>
          ) : (
            groups.map(([section, items]) => (
              <div key={section}>
                {section ? (
                  <div className="px-3.5 pt-2 pb-1 font-mono text-fg-3 text-[9.5px] uppercase tracking-[0.08em]">
                    {section}
                  </div>
                ) : null}
                {items.map((item) => {
                  const isActive = runningIdx === active;
                  const myIdx = runningIdx;
                  runningIdx++;
                  return (
                    <button
                      key={item.id}
                      // Marker for the scroll-into-view effect above; the
                      // querySelector targets [data-palette-active].
                      {...(isActive ? { "data-palette-active": "" } : {})}
                      className={cn(
                        // 4-col grid: icon-tile, label+sub, badge, kbd
                        "grid grid-cols-[22px_1fr_auto_auto] gap-2.5 items-center",
                        "px-3.5 py-[7px] text-[13px] w-full text-left cursor-pointer",
                        isActive
                          ? "bg-bg-selected text-fg-0"
                          : "text-fg-1 hover:bg-bg-active hover:text-fg-0",
                      )}
                      onMouseEnter={() => {
                        // Ignore mouseenter events caused by the list scrolling
                        // under a stationary cursor — only act on real movement.
                        if (!mouseDrivenRef.current) return;
                        keyboardNavRef.current = false;
                        setActive(myIdx);
                      }}
                      onMouseMove={() => {
                        // Real movement → re-enable hover updates and adopt
                        // this row as active.
                        mouseDrivenRef.current = true;
                        if (active !== myIdx) {
                          keyboardNavRef.current = false;
                          setActive(myIdx);
                        }
                      }}
                      onClick={() => {
                        item.run();
                        onClose();
                      }}
                    >
                      <span
                        className={cn(
                          "grid place-items-center w-[22px] h-[22px] rounded bg-bg-2",
                          isActive ? "text-accent" : "text-fg-2",
                        )}
                      >
                        {I[item.icon] ?? I.search}
                      </span>
                      <span className="flex flex-col gap-px min-w-0">
                        <span className="overflow-hidden text-ellipsis whitespace-nowrap font-medium">
                          {item.name}
                        </span>
                        {item.sub ? (
                          <span className="text-[11px] text-fg-3 overflow-hidden text-ellipsis whitespace-nowrap">
                            {item.sub}
                          </span>
                        ) : null}
                      </span>
                      {item.badge ? (
                        <span className="font-mono text-fg-3 text-[9.5px] uppercase tracking-[0.04em] px-[5px] py-px rounded-[3px] bg-bg-2">
                          {item.badge}
                        </span>
                      ) : (
                        <span />
                      )}
                      {item.kbd ? (
                        <span className="inline-flex items-center gap-[3px] [&_[data-kbd]]:!m-0">
                          {item.kbd.map((chord, ci) => (
                            <span
                              key={ci}
                              className="inline-flex items-center gap-[3px]"
                            >
                              {splitShortcut(chord).map((k, ki) => (
                                <span key={ki} className={CHIP}>
                                  {k}
                                </span>
                              ))}
                            </span>
                          ))}
                        </span>
                      ) : (
                        <span />
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
          {truncated > 0 ? (
            <div className="font-mono text-fg-2 text-[10.5px] text-center px-3.5 pt-2 pb-1">
              … {truncated.toLocaleString()} more — refine your query
            </div>
          ) : null}
        </div>
        <div className="flex items-center gap-3.5 px-3.5 py-2 border-t border-bd-1 text-[11px] text-fg-3 [&_[data-kbd]]:!m-0">
          <span>
            <span className={CHIP}>↑↓</span> navigate
          </span>
          <span>
            <span className={CHIP}>↵</span> select
          </span>
          <span>
            <span className={CHIP}>esc</span> close
          </span>
          <span className="flex-1" />
          {allowFilesMode ? (
            <button
              className={cn(
                "inline-flex items-center gap-0.5 text-[11px] text-fg-2",
                "px-1.5 py-0.5 rounded hover:bg-bg-hover hover:text-fg-0",
              )}
              onClick={() =>
                onSwitchMode(mode === "files" ? "commands" : "files")
              }
              title={
                mode === "files"
                  ? "Switch to commands palette (⌘⇧P)"
                  : "Switch to file picker (⌘P)"
              }
            >
              <Kbd>{mode === "files" ? "⌘⇧P" : "⌘P"}</Kbd>
            </button>
          ) : null}
          <span>
            {showResults
              ? `${filtered.length.toLocaleString()} result${filtered.length === 1 ? "" : "s"}`
              : ""}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * Score how well `query` matches a command. Strategy:
 *   1. Substring of `name` (filename) → highest score, boosted toward start
 *   2. Substring of full keywords (path) → mid score
 *   3. Subsequence in name → low score, only if consecutive runs are meaningful
 *
 * Returns 0 when nothing matches.
 */
function scoreItem(query: string, c: CommandItem): number {
  const q = query.toLowerCase();
  const name = c.name.toLowerCase();
  const keys = (c.keywords ?? "").toLowerCase();

  // Strong: substring in name
  const inName = name.indexOf(q);
  if (inName !== -1) {
    // Earlier-in-name + starting-on-word-boundary wins.
    const boundary =
      inName === 0 || /[\s\-_./]/.test(name[inName - 1] ?? "") ? 200 : 0;
    return 1000 + boundary - inName;
  }

  // Medium: substring in keywords (path)
  const inKeys = keys.indexOf(q);
  if (inKeys !== -1) {
    return 400 - Math.min(inKeys, 200);
  }

  // Weak: subsequence in keywords with consecutive-run requirement
  let qi = 0;
  let ti = 0;
  let runs = 0;
  let bestRun = 0;
  let cur = 0;
  let last = -2;
  while (qi < q.length && ti < keys.length) {
    if (q[qi] === keys[ti]) {
      if (ti - last === 1) cur++;
      else {
        if (cur > bestRun) bestRun = cur;
        cur = 1;
        runs++;
      }
      last = ti;
      qi++;
    }
    ti++;
  }
  if (cur > bestRun) bestRun = cur;

  if (qi < q.length) return 0;
  // Reject if the best run is less than ~half the query (kills `pack` → `workspace`).
  if (bestRun < Math.max(2, Math.ceil(q.length / 2))) return 0;
  return Math.min(200, bestRun * 30 - runs * 5);
}
