import { memo, useState } from "react";
import type { Hunk } from "@/features/git/git.types";
import type { LineHighlightMap } from "@/lib/find-in-diff";
import { cn } from "@/lib/utils";
import { HLLine } from "./hl-line";
import { HunkActionBar, type HunkActions } from "./hunk-action-bar";
import { FoldButton } from "./fold-button";

// Same metrics as the inline diff but with a single number gutter (the
// other side doesn't exist — this is the whole-file added/deleted view).
const SINGLE_ROW = "grid grid-cols-[44px_16px_1fr] whitespace-pre";
const GUT = "inline-block px-1.5 text-[11px] text-fg-3 select-none leading-[1.55]";
const GUT_NUM = `${GUT} text-right`;
const GUT_MARK = `${GUT} text-center !px-0 !text-fg-2 font-semibold`;
const CODE = "px-1.5 pr-3 whitespace-pre overflow-hidden text-ellipsis";

const ROW_STYLES = {
  add: {
    row: "bg-diff-add-bg",
    code: "bg-diff-add-bg-strong shadow-[inset_2px_0_0_var(--diff-add-mark)]",
    mark: "!text-diff-add-mark",
  },
  del: {
    row: "bg-diff-del-bg",
    code: "bg-diff-del-bg-strong shadow-[inset_2px_0_0_var(--diff-del-mark)]",
    mark: "!text-diff-del-mark",
  },
  ctx: { row: "bg-transparent", code: "", mark: "" },
} as const;

type Props = {
  hunks: Hunk[];
  lang: string;
  side: "add" | "del";
  lineHighlights?: LineHighlightMap;
  hunkActions?: HunkActions | null;
};

/**
 * Memoized — same reasoning as `DiffSideBySide` / `DiffInline`. Used for
 * whole-file added / deleted / untracked diffs where the side-by-side
 * grid would just be a single-column with the other half blank.
 *
 * Migrated from `.diff-single*` rules.
 */
export const DiffSingle = memo(function DiffSingle({
  hunks,
  lang,
  side,
  lineHighlights,
  hunkActions,
}: Props) {
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());
  const toggle = (hi: number) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(hi)) next.delete(hi);
      else next.add(hi);
      return next;
    });
  return (
    <div className="font-mono text-[12px] leading-[1.55]">
      {hunks.map((h, hi) => {
        const isCollapsed = collapsed.has(hi);
        return (
          <div key={hi} className="group border-b border-bd-0 [content-visibility:auto]">
            <div className="flex items-center gap-1.5 pl-3.5 pr-2.5 py-1 bg-bg-1 border-b border-bd-0 sticky top-0 z-[1] text-[11px]">
              <FoldButton collapsed={isCollapsed} onClick={() => toggle(hi)} />
              <span className="font-mono text-fg-2">{h.header}</span>
              {hunkActions ? (
                <HunkActionBar hunkIdx={hi} actions={hunkActions} />
              ) : null}
            </div>
            {!isCollapsed ? (
              <div>
                {h.lines.map((l, li) => {
                  const variant =
                    l.t === "add" ? "add" : l.t === "del" ? "del" : "ctx";
                  const styles = ROW_STYLES[variant];
                  const num = side === "add" ? (l.n_new ?? "") : (l.n_old ?? "");
                  return (
                    <div
                      key={li}
                      className={cn(SINGLE_ROW, styles.row)}
                      data-line-key={`${hi}:${li}`}
                    >
                      <span className={GUT_NUM}>{num}</span>
                      <span className={cn(GUT_MARK, styles.mark)}>
                        {l.t === "add" ? "+" : l.t === "del" ? "−" : ""}
                      </span>
                      <span className={cn(CODE, styles.code)}>
                        <HLLine
                          text={l.text}
                          lang={lang}
                          highlight={lineHighlights?.get(`${hi}:${li}`)}
                        />
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
});
