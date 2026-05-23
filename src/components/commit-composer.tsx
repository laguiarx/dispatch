import { useEffect, useRef, useState } from "react";
import { useRepoStore } from "@/features/repository/repository.store";
import { I } from "./icons";
import { Spinner } from "./spinner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/**
 * Shared style fragments for the composer. The split-button (Commit |
 * chevron) and the menu rows all share the same accent palette, so
 * extracting these keeps tweaks to "the composer look" one edit.
 */
const SHELL =
  "shrink-0 flex flex-col gap-2 p-2.5 border-t border-bd-0 " +
  "bg-[color-mix(in_oklab,var(--bg-1)_60%,transparent)]";
const TEXTWRAP = "relative";
const TEXTAREA =
  "w-full min-h-24 max-h-60 py-2.5 pl-3 pr-9 resize-none outline-none " +
  "bg-bg-0 border border-bd-1 rounded-2 text-fg-0 font-mono text-[12px] leading-[1.55] " +
  "transition-colors duration-[120ms] focus:border-accent " +
  "placeholder:text-fg-3 disabled:opacity-60 disabled:cursor-not-allowed";
const WAND =
  "absolute top-1.5 right-1.5 w-6 h-6 grid place-items-center rounded-2 " +
  "bg-transparent border-0 text-fg-2 cursor-pointer " +
  "transition-[background-color,color] duration-[120ms] " +
  "hover:bg-accent-soft hover:text-accent disabled:opacity-35 disabled:cursor-not-allowed " +
  "disabled:hover:bg-transparent disabled:hover:text-fg-2 " +
  "[&_[data-ai-spinner]]:w-[14px] [&_[data-ai-spinner]]:h-[14px]";
const SPLIT = "relative inline-flex w-full";
const SUBMIT =
  "inline-flex items-center justify-center gap-2 flex-1 h-[30px] px-3 " +
  "rounded-l-2 !bg-accent !bg-none text-bg-0 border-0 text-[12px] font-medium cursor-pointer " +
  "transition-none hover:not-disabled:!bg-accent hover:not-disabled:!bg-none " +
  "disabled:bg-bg-3 disabled:text-fg-3 disabled:cursor-not-allowed " +
  "[&_[data-ai-spinner]]:w-3 [&_[data-ai-spinner]]:h-3";
const CHEV_BASE =
  "inline-flex items-center justify-center h-[30px] w-7 ml-px rounded-r-2 " +
  "!bg-accent !bg-none text-bg-0 border-0 cursor-pointer " +
  "transition-none hover:not-disabled:!bg-accent hover:not-disabled:!bg-none " +
  "disabled:bg-bg-3 disabled:text-fg-3 disabled:cursor-not-allowed " +
  "[&_[data-ai-spinner]]:w-3 [&_[data-ai-spinner]]:h-3";
const CHEV_ACTIVE = "brightness-115";
const MENU =
  "absolute bottom-[calc(100%+6px)] right-0 z-50 min-w-[240px] " +
  "bg-bg-2 border border-bd-2 rounded-3 py-1 " +
  "shadow-[0_18px_50px_rgba(0,0,0,0.55)]";
const MENU_ITEM_BASE =
  "flex flex-col gap-px px-3 py-2 w-full text-left text-[12px] text-fg-1 " +
  "bg-transparent border-0 cursor-pointer " +
  "hover:not-disabled:bg-bg-hover hover:not-disabled:text-fg-0 " +
  "disabled:opacity-40 disabled:cursor-not-allowed";
const MENU_ITEM_DANGER =
  "hover:not-disabled:!text-git-del " +
  "hover:not-disabled:bg-[color-mix(in_oklab,var(--git-del)_14%,transparent)]";
// Tint the row whose op is in flight so even after the menu closes and
// reopens it's clear which is still running.
const MENU_ITEM_RUNNING =
  "!text-accent [&_.commit-composer-menu-desc]:!text-accent " +
  "[&_.commit-composer-menu-desc]:opacity-70";
const MENU_LABEL =
  "font-medium inline-flex items-center gap-1.5 " +
  "[&_[data-ai-spinner]]:w-[11px] [&_[data-ai-spinner]]:h-[11px]";
const MENU_DESC = "commit-composer-menu-desc text-[10.5px] leading-[1.4] text-fg-2";
const MENU_SECTION =
  "px-3 pt-2.5 pb-1 text-fg-2 text-[9.5px] tracking-[0.08em] uppercase";
const MENU_SEP = "h-px bg-bd-0 my-1";

/**
 * Inline composer pinned at the bottom of the Changes tab.
 *
 * Layout:
 *   ┌──────────────────────────────────────────┐
 *   │ <textarea>                          (✨)  │
 *   │                                          │
 *   │                                          │
 *   └──────────────────────────────────────────┘
 *   ┌─────────────────────┐  ┌────┐
 *   │ Commit              │  │ ⌄  │
 *   └─────────────────────┘  └────┘
 *
 * The chevron opens a menu with: Commit, Commit & Push, and the
 * standalone Git ops (Push, Pull, Fetch, Undo last commit). Pull/push
 * used to live as visible buttons under the composer but the user
 * preferred them folded into the menu to reduce clutter.
 */
export function CommitComposer() {
  const draft = useRepoStore((s) => s.commitDraft);
  const loading = useRepoStore((s) => s.commitDraftLoading);
  const setDraft = useRepoStore((s) => s.setCommitDraft);
  const generate = useRepoStore((s) => s.generateCommitDraft);
  const runCommit = useRepoStore((s) => s.commitDraftRun);
  const runCommitPush = useRepoStore((s) => s.commitDraftAndPush);
  const gitPush = useRepoStore((s) => s.gitPush);
  const gitPull = useRepoStore((s) => s.gitPull);
  const gitFetchRemote = useRepoStore((s) => s.gitFetchRemote);
  const gitUndoLastCommit = useRepoStore((s) => s.gitUndoLastCommit);
  const gitOpLoading = useRepoStore((s) => s.gitOpLoading);
  const stagedCount = useRepoStore(
    (s) => s.files.filter((f) => f.staged).length,
  );
  // Single "is any git/commit work in flight" flag — drives the chevron's
  // spinner and the disabled state of every menu row, so the user can't
  // queue two ops on top of each other.
  const anyBusy = loading || gitOpLoading != null;

  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const menuWrapRef = useRef<HTMLDivElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  // Auto-grow the textarea up to a cap so multi-line messages aren't
  // crammed into 3 lines but also don't eat the whole sidebar.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [draft]);

  useEffect(() => {
    if (!menuOpen) return;
    function onDocClick(e: MouseEvent) {
      const t = e.target as Node | null;
      if (menuWrapRef.current && t && !menuWrapRef.current.contains(t)) {
        setMenuOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const canCommit =
    stagedCount > 0 && draft.trim().length > 0 && !anyBusy;
  const canGenerate = stagedCount > 0 && !anyBusy;
  const closeMenu = () => setMenuOpen(false);

  return (
    <div className={SHELL}>
      <div className={TEXTWRAP}>
        <textarea
          ref={taRef}
          className={TEXTAREA}
          placeholder={
            stagedCount === 0
              ? "Stage files to commit…"
              : "Commit message — or click the wand to draft one with AI"
          }
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canCommit) {
              e.preventDefault();
              void runCommit();
            }
          }}
          disabled={loading}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
        <Button variant="unstyled"
          type="button"
          className={WAND}
          title="Draft commit message with AI"
          onClick={() => void generate()}
          disabled={!canGenerate}
        >
          {loading && draft === "" ? <Spinner /> : I.sparkles}
        </Button>
      </div>

      <div className="flex">
        <div className={SPLIT} ref={menuWrapRef}>
          <Button variant="unstyled"
            type="button"
            className={SUBMIT}
            onClick={() => void runCommit()}
            disabled={!canCommit}
            title="Commit staged changes (⌘↵)"
          >
            {loading && draft !== "" ? (
              <>
                <Spinner />
                <span>Committing…</span>
              </>
            ) : (
              <span>
                Commit{stagedCount > 0
                  ? ` ${stagedCount} file${stagedCount === 1 ? "" : "s"}`
                  : ""}
              </span>
            )}
          </Button>
          <Button variant="unstyled"
            type="button"
            className={cn(CHEV_BASE, menuOpen && CHEV_ACTIVE)}
            onClick={() => setMenuOpen((o) => !o)}
            disabled={loading}
            title={
              gitOpLoading
                ? `${gitOpLoading[0].toUpperCase()}${gitOpLoading.slice(1)}ing…`
                : "More Git actions"
            }
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-busy={gitOpLoading != null}
          >
            {gitOpLoading != null ? (
              <Spinner />
            ) : (
              I.chevron
            )}
          </Button>
          {menuOpen ? (
            <div className={MENU} role="menu">
              <div className={MENU_SECTION}>Commit</div>
              <Button variant="unstyled"
                role="menuitem"
                className={MENU_ITEM_BASE}
                onClick={() => {
                  closeMenu();
                  void runCommit();
                }}
                disabled={!canCommit}
              >
                <span className={MENU_LABEL}>Commit</span>
                <span className={MENU_DESC}>Just commit, don't push.</span>
              </Button>
              <Button variant="unstyled"
                role="menuitem"
                className={MENU_ITEM_BASE}
                onClick={() => {
                  closeMenu();
                  void runCommitPush();
                }}
                disabled={!canCommit}
              >
                <span className={MENU_LABEL}>Commit & Push</span>
                <span className={MENU_DESC}>
                  Commit, then `git push` to upstream.
                </span>
              </Button>

              <div className={MENU_SEP} />

              <div className={MENU_SECTION}>Remote</div>
              <RemoteOpItem
                op="pull"
                label="Pull"
                desc="`git pull --ff-only` from upstream."
                runningLabel="Pulling…"
                running={gitOpLoading === "pull"}
                disabled={anyBusy}
                onRun={() => {
                  closeMenu();
                  void gitPull();
                }}
              />
              <RemoteOpItem
                op="push"
                label="Push"
                desc="`git push` local commits."
                runningLabel="Pushing…"
                running={gitOpLoading === "push"}
                disabled={anyBusy}
                onRun={() => {
                  closeMenu();
                  void gitPush();
                }}
              />
              <RemoteOpItem
                op="fetch"
                label="Fetch"
                desc="`git fetch --all --prune`."
                runningLabel="Fetching…"
                running={gitOpLoading === "fetch"}
                disabled={anyBusy}
                onRun={() => {
                  closeMenu();
                  void gitFetchRemote();
                }}
              />

              <div className={MENU_SEP} />

              <RemoteOpItem
                op="undo"
                label="Undo last commit"
                desc="Soft reset — keeps changes staged."
                runningLabel="Undoing…"
                running={gitOpLoading === "undo"}
                disabled={anyBusy}
                danger
                onRun={() => {
                  closeMenu();
                  void gitUndoLastCommit();
                }}
              />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * One row in the chevron menu for a standalone Git op (Pull / Push / Fetch
 * / Undo). Renders the static label by default, swaps in a spinner + the
 * "Pulling…" gerund while the op is in flight, and stays clickable when
 * disabled so the user can re-open the menu later. Kept local because no
 * other place uses this shape.
 */
function RemoteOpItem({
  label,
  desc,
  runningLabel,
  running,
  disabled,
  danger,
  onRun,
}: {
  op: string;
  label: string;
  desc: string;
  runningLabel: string;
  running: boolean;
  disabled: boolean;
  danger?: boolean;
  onRun: () => void;
}) {
  return (
    <Button variant="unstyled"
      role="menuitem"
      className={cn(
        MENU_ITEM_BASE,
        danger && MENU_ITEM_DANGER,
        running && MENU_ITEM_RUNNING,
      )}
      onClick={onRun}
      disabled={disabled}
    >
      <span className={MENU_LABEL}>
        {running ? (
          <>
            <Spinner />
            <span>{runningLabel}</span>
          </>
        ) : (
          label
        )}
      </span>
      <span className={MENU_DESC}>{desc}</span>
    </Button>
  );
}
