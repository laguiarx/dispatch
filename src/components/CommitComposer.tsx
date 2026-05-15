import { useEffect, useRef, useState } from "react";
import { useRepoStore } from "@/features/repository/repository.store";
import { I } from "./Icons";
import { cn } from "@/lib/utils";

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
    <div className="commit-composer">
      <div className="commit-composer-textwrap">
        <textarea
          ref={taRef}
          className="commit-composer-textarea mono"
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
        <button
          type="button"
          className="commit-composer-wand"
          title="Draft commit message with AI"
          onClick={() => void generate()}
          disabled={!canGenerate}
        >
          {loading && draft === "" ? <span className="ai-spinner" /> : I.sparkles}
        </button>
      </div>

      <div className="commit-composer-actions">
        <div className="commit-composer-split" ref={menuWrapRef}>
          <button
            type="button"
            className="commit-composer-submit"
            onClick={() => void runCommit()}
            disabled={!canCommit}
            title="Commit staged changes (⌘↵)"
          >
            {loading && draft !== "" ? (
              <>
                <span className="ai-spinner" />
                <span>Committing…</span>
              </>
            ) : (
              <span>
                Commit{stagedCount > 0
                  ? ` ${stagedCount} file${stagedCount === 1 ? "" : "s"}`
                  : ""}
              </span>
            )}
          </button>
          <button
            type="button"
            className={cn(
              "commit-composer-split-chev",
              menuOpen && "is-active",
            )}
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
              <span className="ai-spinner" />
            ) : (
              I.chevron
            )}
          </button>
          {menuOpen ? (
            <div className="commit-composer-menu" role="menu">
              <div className="commit-composer-menu-section dim">Commit</div>
              <button
                role="menuitem"
                className="commit-composer-menu-item"
                onClick={() => {
                  closeMenu();
                  void runCommit();
                }}
                disabled={!canCommit}
              >
                <span className="commit-composer-menu-label">Commit</span>
                <span className="commit-composer-menu-desc dim">
                  Just commit, don't push.
                </span>
              </button>
              <button
                role="menuitem"
                className="commit-composer-menu-item"
                onClick={() => {
                  closeMenu();
                  void runCommitPush();
                }}
                disabled={!canCommit}
              >
                <span className="commit-composer-menu-label">
                  Commit & Push
                </span>
                <span className="commit-composer-menu-desc dim">
                  Commit, then `git push` to upstream.
                </span>
              </button>

              <div className="commit-composer-menu-sep" />

              <div className="commit-composer-menu-section dim">Remote</div>
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

              <div className="commit-composer-menu-sep" />

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
    <button
      role="menuitem"
      className={cn(
        "commit-composer-menu-item",
        danger && "is-danger",
        running && "is-running",
      )}
      onClick={onRun}
      disabled={disabled}
    >
      <span className="commit-composer-menu-label">
        {running ? (
          <>
            <span className="ai-spinner" />
            <span>{runningLabel}</span>
          </>
        ) : (
          label
        )}
      </span>
      <span className="commit-composer-menu-desc dim">{desc}</span>
    </button>
  );
}
