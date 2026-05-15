import { useEffect, useMemo, useRef, useState } from "react";
import { useRepoStore } from "@/features/repository/repository.store";
import type { BranchInfo } from "@/features/git/git.types";
import { cn } from "@/lib/utils";
import { I } from "./Icons";

export function BranchMenu() {
  const open = useRepoStore((s) => s.branchMenuOpen);
  const setOpen = useRepoStore((s) => s.setBranchMenuOpen);
  const branches = useRepoStore((s) => s.branches);
  const branchesLoading = useRepoStore((s) => s.branchesLoading);
  const fetchBranches = useRepoStore((s) => s.fetchBranches);
  const checkoutBranch = useRepoStore((s) => s.checkoutBranch);
  const repository = useRepoStore((s) => s.repository);
  const stashes = useRepoStore((s) => s.stashes);
  const fetchStashes = useRepoStore((s) => s.fetchStashes);
  const popStash = useRepoStore((s) => s.popStash);
  const applyStash = useRepoStore((s) => s.applyStash);
  const requestDropStash = useRepoStore((s) => s.requestDropStash);
  const createBranch = useRepoStore((s) => s.createBranch);
  const generateBranchName = useRepoStore((s) => s.generateBranchName);
  const deleteBranch = useRepoStore((s) => s.deleteBranch);
  const requestPruneGoneBranches = useRepoStore(
    (s) => s.requestPruneGoneBranches,
  );

  // Count of "gone" local branches drives the visibility of the
  // bulk-prune button at the bottom of the menu.
  const goneCount = branches.filter((b) => !b.isRemote && b.gone).length;

  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [generating, setGenerating] = useState(false);
  const createInputRef = useRef<HTMLInputElement | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Fetch (or refresh) the list every time the menu opens.
  useEffect(() => {
    if (!open) return;
    setFilter("");
    setCreating(false);
    setNewName("");
    fetchBranches().catch(() => {
      /* error already surfaced */
    });
    fetchStashes().catch(() => {
      /* non-fatal */
    });
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open, fetchBranches, fetchStashes]);

  useEffect(() => {
    if (creating) {
      requestAnimationFrame(() => createInputRef.current?.focus());
    }
  }, [creating]);

  const submitCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    await createBranch(name);
    setCreating(false);
    setNewName("");
  };

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const target = e.target as Node | null;
      if (ref.current && target && !ref.current.contains(target)) {
        const pill = document.querySelector(".branch-pill");
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

  const { local, remote } = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const matches = (b: BranchInfo) =>
      !q || b.name.toLowerCase().includes(q);
    const localBranches = branches.filter((b) => !b.isRemote && matches(b));
    // Hide remote branches whose short name matches an existing local.
    const localNames = new Set(localBranches.map((b) => b.name));
    const remoteBranches = branches.filter((b) => {
      if (!b.isRemote || !matches(b)) return false;
      const short = b.name.replace(/^[^/]+\//, "");
      return !localNames.has(short);
    });
    return { local: localBranches, remote: remoteBranches };
  }, [branches, filter]);

  if (!open) return null;

  return (
    <div className="branch-menu" ref={ref}>
      <div className="branch-menu-search">
        <span className="filter-icon">{I.search}</span>
        <input
          ref={inputRef}
          className="filter-input"
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter branches…"
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <div className="branch-menu-body">
        {creating ? (
          <div className="branch-create-row">
            <span className="branch-create-icon">{I.plus}</span>
            <input
              ref={createInputRef}
              className="branch-create-input mono"
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submitCreate();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setCreating(false);
                  setNewName("");
                }
              }}
              placeholder={`New branch from ${repository?.currentBranch ?? "HEAD"}`}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
            />
            <button
              className="branch-create-ai"
              onClick={async () => {
                if (generating) return;
                setGenerating(true);
                const suggestion = await generateBranchName();
                setGenerating(false);
                if (suggestion) {
                  setNewName(suggestion);
                  requestAnimationFrame(() =>
                    createInputRef.current?.focus(),
                  );
                }
              }}
              disabled={generating}
              type="button"
              title="Suggest a branch name from the current diff"
              aria-label="Generate branch name with AI"
            >
              {generating ? (
                <span className="ai-spinner" />
              ) : (
                I.sparkles
              )}
            </button>
            <button
              className="branch-create-confirm"
              onClick={submitCreate}
              disabled={!newName.trim()}
              type="button"
              title="Create branch (↵)"
            >
              create
            </button>
          </div>
        ) : (
          <button
            className="branch-create-toggle"
            onClick={() => setCreating(true)}
            type="button"
          >
            <span className="branch-create-icon">{I.plus}</span>
            <span>Create new branch…</span>
          </button>
        )}
        {branchesLoading && branches.length === 0 ? (
          <div className="branch-menu-empty dim">Loading…</div>
        ) : null}
        {local.length > 0 ? (
          <>
            <div className="branch-menu-section-head">
              <span>Local</span>
              {goneCount > 0 ? (
                <button
                  type="button"
                  className="branch-menu-prune"
                  onClick={(e) => {
                    e.stopPropagation();
                    requestPruneGoneBranches();
                  }}
                  title={`Delete the ${goneCount} local branch${goneCount === 1 ? "" : "es"} whose remote was deleted`}
                >
                  Prune gone ({goneCount})
                </button>
              ) : null}
            </div>
            {local.map((b) => (
              <BranchRow
                key={`local:${b.name}`}
                branch={b}
                onClick={() => checkoutBranch(b.name)}
                onDelete={
                  b.isCurrent
                    ? null
                    : () => deleteBranch(b.name, { force: b.gone })
                }
              />
            ))}
          </>
        ) : null}
        {remote.length > 0 ? (
          <>
            <div className="branch-menu-section-head">Remote</div>
            {remote.map((b) => (
              <BranchRow
                key={`remote:${b.name}`}
                branch={b}
                onClick={() => checkoutBranch(b.name)}
                onDelete={null}
              />
            ))}
          </>
        ) : null}
        {!branchesLoading && local.length === 0 && remote.length === 0 ? (
          <div className="branch-menu-empty dim">
            {filter ? `No branches match "${filter}"` : "No branches found"}
          </div>
        ) : null}
        {stashes.length > 0 ? (
          <>
            <div className="branch-menu-section-head">Stashes</div>
            {stashes.map((s) => (
              <div key={s.ref} className="stash-row" title={s.message}>
                <span className="stash-row-ref mono dim">{s.ref}</span>
                <span className="stash-row-msg">{s.message}</span>
                <span className="stash-row-actions">
                  <button
                    className="stash-row-btn"
                    onClick={() => applyStash(s.ref)}
                    title="Apply (keep stash)"
                    type="button"
                  >
                    apply
                  </button>
                  <button
                    className="stash-row-btn is-primary"
                    onClick={() => popStash(s.ref)}
                    title="Pop (apply and remove)"
                    type="button"
                  >
                    pop
                  </button>
                  <button
                    className="stash-row-btn is-danger"
                    onClick={() => requestDropStash(s.ref, s.message)}
                    title="Drop (delete without applying)"
                    type="button"
                  >
                    drop
                  </button>
                </span>
              </div>
            ))}
          </>
        ) : null}
      </div>
      <div className="branch-menu-footer dim">
        {repository?.remote
          ? `Tracking ${repository.remote}`
          : "Local-only repo"}
      </div>
    </div>
  );
}

function BranchRow({
  branch,
  onClick,
  onDelete,
}: {
  branch: BranchInfo;
  onClick: () => void;
  /** When null the row has no trash button (current branch / remote rows). */
  onDelete: (() => void) | null;
}) {
  return (
    <div
      className={cn(
        "branch-menu-item",
        branch.isCurrent && "is-current",
        branch.gone && "is-gone",
      )}
    >
      <button
        type="button"
        className="branch-menu-item-main"
        onClick={branch.isCurrent ? undefined : onClick}
        disabled={branch.isCurrent}
        title={
          branch.isCurrent
            ? "Already on this branch"
            : `Checkout ${branch.name}`
        }
      >
        <span className="branch-menu-item-mark">
          {branch.isCurrent ? I.check : null}
        </span>
        <span className="branch-menu-item-name mono">{branch.name}</span>
        {branch.gone ? (
          <span
            className="branch-menu-item-tag is-gone"
            title="Remote branch was deleted — local is orphaned"
          >
            gone
          </span>
        ) : null}
        {branch.upstream ? (
          <span className="branch-menu-item-meta mono dim">
            ↳ {branch.upstream}
          </span>
        ) : branch.isRemote ? (
          <span className="branch-menu-item-meta mono dim">remote</span>
        ) : null}
      </button>
      {onDelete ? (
        <button
          type="button"
          className="branch-menu-item-delete"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          title={
            branch.gone
              ? `Delete '${branch.name}' (force — upstream is gone)`
              : `Delete '${branch.name}'`
          }
          aria-label={`Delete ${branch.name}`}
        >
          {I.discard}
        </button>
      ) : null}
    </div>
  );
}
