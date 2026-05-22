import { BTN_PRIMARY } from "@/lib/btn";
import { useRepoStore } from "@/features/repository/repository.store";
import { I } from "./icons";
import { Kbd } from "./kbd";

function homeRelative(path: string): string {
  const home = "/Users/";
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

type Props = {
  onOpen: () => void;
};

/**
 * Empty state shown when no repo is open. Card with a "open repository"
 * primary CTA + a list of recent repos the user can click to reopen.
 *
 * Migrated from `.norepo*` rules to Tailwind utilities. The `primary-btn`
 * and `dim`/`mono` classes are still legacy CSS and will be migrated as
 * part of the utility-class wave.
 */
export function NoRepoState({ onOpen }: Props) {
  const recents = useRepoStore((s) => s.recentRepos);
  const openFromPath = useRepoStore((s) => s.openRepositoryFromPath);
  const forgetRecent = useRepoStore((s) => s.forgetRecent);

  return (
    <div className="h-full grid place-items-center p-[30px]">
      <div className="w-[min(520px,92vw)] bg-bg-1 border border-bd-1 rounded-4 p-7 flex flex-col items-center gap-[14px] text-center">
        <div className="grid place-items-center h-[42px] w-[42px] rounded-[10px] bg-accent text-white [&_svg]:h-[18px] [&_svg]:w-[18px]">
          {I.folder}
        </div>
        <div className="text-[18px] font-semibold tracking-[-0.01em]">
          Open a Git repository to start reviewing
        </div>
        <div className="max-w-[380px] font-mono text-fg-2 text-[12px] leading-[1.5]">
          Point Dispatch at a local folder. We&apos;ll detect the current
          branch and surface every changed file.
        </div>
        <div className="flex justify-center gap-2 pt-1">
          <button className={BTN_PRIMARY} onClick={onOpen}>
            Open repository <Kbd>⌘O</Kbd>
          </button>
        </div>
        {recents.length > 0 ? (
          <div className="w-full flex flex-col gap-0.5 pt-[14px] mt-1.5 border-t border-bd-1 text-left">
            <div className="font-mono text-fg-2 text-[10px] tracking-[0.1em] uppercase py-1">
              Recent
            </div>
            {recents.map((r) => (
              <button
                key={r.path}
                className="grid grid-cols-[1fr_auto_auto] gap-2.5 items-center px-2.5 py-2 rounded-2 text-[12px] w-full text-left hover:bg-bg-3"
                onClick={() => openFromPath(r.path)}
              >
                <span className="flex flex-col min-w-0 gap-[1px]">
                  <span className="font-medium text-fg-0">{r.name}</span>
                  <span className="font-mono text-fg-2 text-[10.5px] whitespace-nowrap overflow-hidden text-ellipsis">
                    {homeRelative(r.path)}
                  </span>
                </span>
                <span className="text-fg-2 font-mono">
                  {r.branch}
                  {r.openedAt ? ` · ${timeAgo(r.openedAt)}` : ""}
                </span>
                <button
                  className="grid place-items-center h-[22px] w-[22px] rounded-[4px] text-fg-3 hover:bg-bg-hover hover:text-diff-del-mark"
                  title="Remove from recents"
                  onClick={(e) => {
                    e.stopPropagation();
                    forgetRecent(r.path);
                  }}
                >
                  {I.x}
                </button>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
