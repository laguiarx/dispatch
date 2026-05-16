import { useEffect, useMemo, useRef, useState } from "react";
import { useRepoStore } from "@/features/repository/repository.store";
import type { BranchInfo } from "@/features/git/git.types";
import type { PrSummary } from "@/features/git/git.api";
import { cn } from "@/lib/utils";
import { I } from "./icons";
import { Spinner } from "./spinner";

export function BranchMenu() {
  const open = useRepoStore((s) => s.branchMenuOpen);
  const setOpen = useRepoStore((s) => s.setBranchMenuOpen);
  const branches = useRepoStore((s) => s.branches);
  const branchesLoading = useRepoStore((s) => s.branchesLoading);
  const fetchBranches = useRepoStore((s) => s.fetchBranches);
  const branchPrs = useRepoStore((s) => s.branchPrs);
  const branchPrsLoading = useRepoStore((s) => s.branchPrsLoading);
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
        // Trigger identified by data-attribute (className lives in Tailwind now).
        const pill = document.querySelector("[data-branch-pill-trigger]");
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

  // Common card shell for the dropdown.
  const card =
    "absolute top-[calc(100%+6px)] left-0 z-[100] min-w-[280px] max-w-[420px] " +
    "flex flex-col bg-bg-1 border border-bd-2 rounded-3 " +
    "shadow-[0_18px_50px_rgba(0,0,0,0.5),0_0_0_0.5px_rgba(255,255,255,0.04)]";
  const sectionHead =
    "flex items-center justify-between px-3 pt-2 pb-1 " +
    "text-fg-3 text-[10.5px] tracking-[0.04em] font-semibold";
  // Compact uppercase mono pill used by the stash apply/pop/drop buttons.
  // Variant colors via inline conditional below.
  const stashBtn =
    "font-mono text-[10px] uppercase tracking-[0.04em] " +
    "px-1.5 py-0.5 rounded-[3px] bg-transparent border border-bd-2 text-fg-3 " +
    "hover:text-fg-0 hover:bg-bg-3";

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
          placeholder="Filter branches…"
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <div className="max-h-[360px] overflow-y-auto py-1">
        {creating ? (
          <div className="grid grid-cols-[16px_1fr_auto_auto] items-center gap-1.5 px-3 py-1.5 border-b border-bd-0">
            <span className="grid place-items-center text-accent">{I.plus}</span>
            <input
              ref={createInputRef}
              className={cn(
                "h-6 px-2 text-[12px] font-mono bg-bg-2 border border-bd-2 rounded-2",
                "text-fg-0 outline-none focus:border-accent",
              )}
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
              type="button"
              className={cn(
                "grid place-items-center w-6 h-6 rounded-1",
                "bg-accent-softer text-accent",
                "border border-[color-mix(in_oklab,var(--accent)_30%,transparent)]",
                "transition-colors duration-[120ms]",
                "hover:not-disabled:bg-accent-soft hover:not-disabled:border-accent",
                "disabled:cursor-default disabled:opacity-70",
                "[&_svg]:w-3 [&_svg]:h-3 [&_[data-ai-spinner]]:w-3 [&_[data-ai-spinner]]:h-3",
              )}
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
              title="Suggest a branch name from the current diff"
              aria-label="Generate branch name with AI"
            >
              {generating ? <Spinner /> : I.sparkles}
            </button>
            <button
              type="button"
              className={cn(
                "font-mono text-[10px] uppercase tracking-[0.04em]",
                "px-2 py-[3px] rounded-[3px] text-accent bg-accent-soft",
                "border border-[color-mix(in_oklab,var(--accent)_40%,transparent)]",
                "disabled:text-fg-3 disabled:bg-transparent disabled:border-bd-2 disabled:cursor-default",
              )}
              onClick={submitCreate}
              disabled={!newName.trim()}
              title="Create branch (↵)"
            >
              create
            </button>
          </div>
        ) : (
          <button
            className={cn(
              "flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-accent",
              "bg-transparent border-0 border-b border-bd-0 hover:bg-bg-hover",
            )}
            onClick={() => setCreating(true)}
            type="button"
          >
            <span className="grid place-items-center text-accent">
              {I.plus}
            </span>
            <span>Create new branch…</span>
          </button>
        )}
        {branchesLoading && branches.length === 0 ? (
          <div className="px-3.5 pt-3.5 pb-4 text-fg-2 text-[11.5px]">
            Loading…
          </div>
        ) : null}
        {local.length > 0 ? (
          <>
            <div className={sectionHead}>
              <span>Local</span>
              {goneCount > 0 ? (
                <button
                  type="button"
                  className={cn(
                    "text-[10px] font-medium normal-case tracking-normal",
                    "text-git-del bg-transparent px-2 py-px rounded-full cursor-pointer",
                    "border border-[color-mix(in_oklab,var(--git-del)_40%,transparent)]",
                    "hover:bg-[color-mix(in_oklab,var(--git-del)_14%,transparent)]",
                  )}
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
                pr={branchPrs[b.name] ?? null}
                prLoading={branchPrsLoading}
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
            <div className={sectionHead}>
              <span>Remote</span>
            </div>
            {remote.map((b) => (
              <BranchRow
                key={`remote:${b.name}`}
                branch={b}
                // Remote branches don't carry PR info — PRs are scoped
                // by HEAD branch (local). Pass null so the row layout
                // stays consistent without a badge slot.
                pr={null}
                prLoading={false}
                onClick={() => checkoutBranch(b.name)}
                onDelete={null}
              />
            ))}
          </>
        ) : null}
        {!branchesLoading && local.length === 0 && remote.length === 0 ? (
          <div className="px-3.5 pt-3.5 pb-4 text-fg-2 text-[11.5px]">
            {filter ? `No branches match "${filter}"` : "No branches found"}
          </div>
        ) : null}
        {stashes.length > 0 ? (
          <>
            <div className={sectionHead}>
              <span>Stashes</span>
            </div>
            {stashes.map((s) => (
              <div
                key={s.ref}
                title={s.message}
                className="grid grid-cols-[70px_1fr_auto] items-center gap-2 px-3 py-1.5 text-[11.5px] text-fg-1 hover:bg-bg-hover"
              >
                <span className="font-mono text-fg-2 text-[10.5px] whitespace-nowrap">
                  {s.ref}
                </span>
                <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                  {s.message}
                </span>
                <span className="inline-flex gap-1">
                  <button
                    className={stashBtn}
                    onClick={() => applyStash(s.ref)}
                    title="Apply (keep stash)"
                    type="button"
                  >
                    apply
                  </button>
                  <button
                    className={cn(
                      stashBtn,
                      "!text-accent !border-[color-mix(in_oklab,var(--accent)_40%,transparent)]",
                    )}
                    onClick={() => popStash(s.ref)}
                    title="Pop (apply and remove)"
                    type="button"
                  >
                    pop
                  </button>
                  <button
                    className={cn(
                      stashBtn,
                      "hover:!text-git-del hover:!border-[color-mix(in_oklab,var(--git-del)_40%,transparent)]",
                    )}
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
      <div className="px-3 pt-1.5 pb-2 border-t border-bd-1 text-fg-2 text-[10.5px]">
        {repository?.remote
          ? `Tracking ${repository.remote}`
          : "Local-only repo"}
      </div>
    </div>
  );
}

function BranchRow({
  branch,
  pr,
  prLoading,
  onClick,
  onDelete,
}: {
  branch: BranchInfo;
  /** Open PR opened FROM this branch, if any. Null = no PR or remote row. */
  pr: PrSummary | null;
  /** True only on the very first open of the picker before gh has replied. */
  prLoading: boolean;
  onClick: () => void;
  /** When null the row has no trash button (current branch / remote rows). */
  onDelete: (() => void) | null;
}) {
  return (
    <div
      // `group` so the delete button can fade in via group-hover. `is-gone`
      // semantics are captured by the inline classNames below.
      className={cn(
        "group relative flex items-stretch w-full",
        branch.isCurrent && "bg-bg-selected",
        !branch.isCurrent && "hover:bg-bg-hover",
      )}
    >
      <button
        type="button"
        className={cn(
          // Five tracks: check · name · PR badge · gone badge · upstream.
          // PR badge is its own slot so it lines up vertically across all
          // rows even when individual rows lack a PR or a "gone" marker.
          "grid grid-cols-[16px_1fr_auto_auto_auto] items-center gap-2 px-3 py-1.5",
          "flex-1 min-w-0 text-left text-fg-1 text-[12px] bg-transparent border-0 cursor-pointer",
          "disabled:cursor-default disabled:text-fg-0",
        )}
        onClick={branch.isCurrent ? undefined : onClick}
        disabled={branch.isCurrent}
        title={
          branch.isCurrent
            ? "Already on this branch"
            : `Checkout ${branch.name}`
        }
      >
        <span className="grid place-items-center text-accent">
          {branch.isCurrent ? I.check : null}
        </span>
        <span
          className={cn(
            "font-mono text-[12px] whitespace-nowrap overflow-hidden text-ellipsis",
            // Gone branches: dim + strikethrough with a red underline color.
            branch.gone &&
              "text-fg-3 line-through decoration-[color:color-mix(in_oklab,var(--git-del)_60%,transparent)]",
          )}
        >
          {branch.name}
        </span>
        <PrBadge pr={pr} loading={prLoading} />
        {branch.gone ? (
          <span
            className="text-[9.5px] uppercase tracking-[0.04em] px-1.5 py-px rounded-full bg-[color-mix(in_oklab,var(--git-del)_22%,transparent)] text-git-del"
            title="Remote branch was deleted — local is orphaned"
          >
            gone
          </span>
        ) : (
          // Empty span occupies the "gone" grid slot when the badge is
          // absent so the upstream column lines up across rows.
          <span aria-hidden="true" />
        )}
        {branch.upstream ? (
          <span className="font-mono text-fg-2 text-[10.5px] whitespace-nowrap">
            ↳ {branch.upstream}
          </span>
        ) : branch.isRemote ? (
          <span className="font-mono text-fg-2 text-[10.5px] whitespace-nowrap">
            remote
          </span>
        ) : (
          <span aria-hidden="true" />
        )}
      </button>
      {onDelete ? (
        <button
          type="button"
          className={cn(
            "grid place-items-center w-7 shrink-0 bg-transparent border-0 cursor-pointer",
            "text-fg-3 transition-[opacity,color,background-color] duration-100",
            "[&_svg]:w-3 [&_svg]:h-3",
            // Hidden unless the row is hovered, OR the branch is gone
            // (visible permanently to nudge cleanup).
            branch.gone
              ? "opacity-100"
              : "opacity-0 group-hover:opacity-100",
            "hover:text-git-del hover:bg-[color-mix(in_oklab,var(--git-del)_14%,transparent)]",
          )}
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

/**
 * Small "PR #42 ✓ approved" pill rendered inside each local-branch row
 * once `gh pr list` has returned. Encodes two orthogonal pieces of state:
 *
 *   - **Review decision** — the symbol next to the PR number:
 *       ✓ approved (accent green)
 *       ⚠ changes requested (warning amber)
 *       💬 commented (muted)
 *       … review required / not yet decided (dim)
 *
 *   - **CI status** — a tiny color dot AFTER the symbol:
 *       green = all checks passing
 *       red   = at least one failing
 *       amber = pending / in progress
 *     Absent when the PR has no checks at all.
 *
 * Clicking the badge opens the PR in the browser via `<a target="_blank">`
 * — we don't intercept it because the parent row's checkout-on-click
 * shouldn't fire for "I want to read the PR thread" intent.
 */
function PrBadge({ pr, loading }: { pr: PrSummary | null; loading: boolean }) {
  if (!pr) {
    // Grid slot still has to exist so columns line up across rows.
    // Render a hair-thin placeholder during the initial gh fetch so the
    // user sees the picker is "still working on it".
    return loading ? (
      <span
        className="text-[9.5px] text-fg-3 font-mono opacity-50"
        title="Loading PR status…"
      >
        …
      </span>
    ) : (
      <span aria-hidden="true" />
    );
  }

  const decision = pr.reviewDecision;
  const symbol =
    decision === "APPROVED"
      ? "✓"
      : decision === "CHANGES_REQUESTED"
        ? "⚠"
        : decision === "COMMENTED"
          ? "💬"
          : "…"; // REVIEW_REQUIRED or empty
  const decisionColor =
    decision === "APPROVED"
      ? "text-git-add"
      : decision === "CHANGES_REQUESTED"
        ? "text-git-mod"
        : "text-fg-2";
  const decisionLabel =
    decision === "APPROVED"
      ? "Approved"
      : decision === "CHANGES_REQUESTED"
        ? "Changes requested"
        : decision === "COMMENTED"
          ? "Commented"
          : "Review requested";

  const ciDot =
    pr.checkStatus === "SUCCESS"
      ? "bg-git-add"
      : pr.checkStatus === "FAILURE"
        ? "bg-git-del"
        : pr.checkStatus === "PENDING"
          ? "bg-git-mod"
          : null;
  const ciLabel =
    pr.checkStatus === "SUCCESS"
      ? "All checks passed"
      : pr.checkStatus === "FAILURE"
        ? "Failing checks"
        : pr.checkStatus === "PENDING"
          ? "Checks running"
          : "No CI";

  const fullTitle = [
    `PR #${pr.number}`,
    decisionLabel,
    pr.commentCount > 0
      ? `${pr.commentCount} comment${pr.commentCount === 1 ? "" : "s"}`
      : null,
    pr.checkStatus ? ciLabel : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <a
      href={pr.url}
      target="_blank"
      rel="noreferrer"
      // Pill mimics the "gone" badge metrics so adjacent rows line up.
      className={cn(
        "inline-flex items-center gap-1 px-1.5 py-px rounded-full",
        "text-[9.5px] font-mono no-underline",
        "bg-bg-3 border border-bd-1 text-fg-1",
        "hover:border-bd-2 hover:bg-bg-4",
      )}
      // Don't trigger the row's checkout-on-click — opening the PR is a
      // different intent.
      onClick={(e) => e.stopPropagation()}
      title={fullTitle}
    >
      <span className={decisionColor}>{symbol}</span>
      <span>#{pr.number}</span>
      {ciDot ? (
        <span
          aria-hidden="true"
          className={cn("w-1.5 h-1.5 rounded-full", ciDot)}
        />
      ) : null}
      {pr.commentCount > 0 ? (
        <span className="text-fg-3">💬{pr.commentCount}</span>
      ) : null}
    </a>
  );
}
