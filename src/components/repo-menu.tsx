import { useEffect, useMemo, useRef, useState } from "react";
import { useRepoStore } from "@/features/repository/repository.store";
import type { RecentRepo } from "@/lib/paths";
import { cn } from "@/lib/utils";
import { I } from "./icons";
import { Kbd } from "./kbd";

function homeRelative(path: string): string {
  const home = "/Users/";
  // Best-effort: collapse "/Users/<name>/..." to "~/..." for readability.
  if (path.startsWith(home)) {
    const idx = path.indexOf("/", home.length);
    if (idx > 0) return "~" + path.slice(idx);
  }
  return path;
}

function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(ms).toLocaleDateString();
}

export function RepoMenu() {
  const open = useRepoStore((s) => s.repoMenuOpen);
  const setOpen = useRepoStore((s) => s.setRepoMenuOpen);
  const recents = useRepoStore((s) => s.recentRepos);
  const repository = useRepoStore((s) => s.repository);
  const openFromPath = useRepoStore((s) => s.openRepositoryFromPath);
  const pick = useRepoStore((s) => s.openRepositoryPicker);
  const forgetRecent = useRepoStore((s) => s.forgetRecent);

  const [filter, setFilter] = useState("");
  const ref = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setFilter("");
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const target = e.target as Node | null;
      if (ref.current && target && !ref.current.contains(target)) {
        // Don't close if the click was on the pill — it owns toggling.
        // Trigger is identified by data-attribute now that the pill's
        // className lives entirely in Tailwind utilities.
        const pill = document.querySelector("[data-repo-pill-trigger]");
        if (pill && pill.contains(target)) return;
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, setOpen]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return recents;
    return recents.filter(
      (r) =>
        r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q),
    );
  }, [recents, filter]);

  if (!open) return null;

  // Dropdown card anchored beneath the repo pill. Same shadow/border as
  // the other dropdowns; bigger width to fit recent-repo paths.
  const card =
    "absolute top-[calc(100%+6px)] left-0 z-[100] min-w-[360px] max-w-[480px] " +
    "flex flex-col bg-bg-1 border border-bd-2 rounded-3 " +
    "shadow-[0_18px_50px_rgba(0,0,0,0.5),0_0_0_0.5px_rgba(255,255,255,0.04)]";
  const sectionHead =
    "px-3 pt-2 pb-1 text-fg-3 text-[10.5px] tracking-[0.04em] font-semibold";

  return (
    <div ref={ref} className={card}>
      <div className="flex items-center gap-1.5 px-2.5 pt-2 pb-1">
        <span className="grid place-items-center shrink-0 text-fg-3">{I.search}</span>
        <input
          ref={inputRef}
          className="flex-1 min-w-0 h-full text-[12px] bg-transparent border-0 outline-none text-fg-0 placeholder:text-fg-3"
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter recent repositories…"
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <div className="max-h-[360px] overflow-y-auto">
        <button
          className={cn(
            "flex items-center gap-2 w-full px-3 py-2 text-[12.5px] text-accent",
            "bg-transparent border-0 border-b border-bd-0 hover:bg-bg-hover",
            // Kbd component lays out with its own margin — flatten it
            // inside this row so it doesn't add an extra left gap.
            "[&_[data-kbd]]:!m-0",
          )}
          onClick={() => {
            setOpen(false);
            pick();
          }}
          type="button"
        >
          <span className="grid place-items-center text-accent w-4">
            {I.plus}
          </span>
          <span>Open another folder…</span>
          <span className="flex-1" />
          <Kbd>⌘O</Kbd>
        </button>
        {recents.length === 0 ? (
          <div className="px-3.5 pt-3.5 pb-4 text-fg-2 text-[11.5px]">
            No recent projects yet. Open one to start.
          </div>
        ) : (
          <>
            <div className={sectionHead}>Recent repositories</div>
            {filtered.length === 0 ? (
              <div className="px-3.5 pt-3.5 pb-4 text-fg-2 text-[11.5px]">
                No repositories match &ldquo;{filter}&rdquo;
              </div>
            ) : (
              filtered.map((r: RecentRepo) => (
                <button
                  key={r.path}
                  className={cn(
                    "grid grid-cols-[1fr_auto] items-center gap-3 px-3 py-[7px]",
                    "w-full text-left text-fg-1 rounded-none",
                    repository?.path === r.path
                      ? "bg-bg-selected text-fg-0"
                      : "hover:bg-bg-hover hover:text-fg-0",
                  )}
                  onClick={() => openFromPath(r.path)}
                >
                  <div className="flex flex-col gap-px min-w-0">
                    <span className="text-[13px] font-medium whitespace-nowrap overflow-hidden text-ellipsis">
                      {r.name}
                    </span>
                    <span className="font-mono text-fg-2 text-[10.5px] whitespace-nowrap overflow-hidden text-ellipsis">
                      {homeRelative(r.path)}
                    </span>
                  </div>
                  <div className="inline-flex items-center gap-1.5 font-mono text-fg-2 text-[10.5px] whitespace-nowrap">
                    {r.branch ? <span>{r.branch}</span> : null}
                    {r.openedAt ? <span>· {timeAgo(r.openedAt)}</span> : null}
                    <button
                      className={cn(
                        "grid place-items-center w-[18px] h-[18px] rounded ml-1",
                        "text-fg-3 hover:bg-bg-active hover:text-diff-del-mark",
                      )}
                      title="Remove from recents"
                      onClick={(e) => {
                        e.stopPropagation();
                        forgetRecent(r.path);
                      }}
                    >
                      {I.x}
                    </button>
                  </div>
                </button>
              ))
            )}
          </>
        )}
      </div>
      <div className="px-3 pt-1.5 pb-2 border-t border-bd-1 text-fg-2 text-[10.5px]">
        {recents.length === 0
          ? "No recent repositories"
          : `${recents.length} recent ${recents.length === 1 ? "repository" : "repositories"}`}
      </div>
    </div>
  );
}
