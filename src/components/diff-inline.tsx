import { memo, type ReactNode } from "react";
import type { DiffLine } from "@/features/git/git.types";
import type { LineHighlightMap } from "@/lib/find-in-diff";
import type { DiffSection } from "@/lib/sections";
import { cn } from "@/lib/utils";
import { HLLine } from "./hl-line";
import { HunkActionBar, type HunkActions } from "./hunk-action-bar";
import { FoldButton } from "./fold-button";

// ----- shared style fragments ------------------------------------------------

const DIFF_INLINE_ROOT = "font-mono text-[12px] leading-[1.55]";
const DIFF_FILLER =
  "border-b border-bd-0 opacity-[0.78] [content-visibility:auto]";
// Inline rows have FOUR columns: old-num | new-num | mark | code. The
// double number gutter is the visual signature of inline-mode diffs.
const INLINE_ROW = "grid grid-cols-[44px_44px_16px_1fr] whitespace-pre";
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
  sections: DiffSection[];
  lang: string;
  lineHighlights?: LineHighlightMap;
  hunkActions?: HunkActions | null;
  popoverHunkIdx?: number | null;
  popoverNode?: ReactNode;
  collapsedHunks?: Set<number>;
  onToggleHunk?: (hunkIdx: number) => void;
};

/**
 * Memoized — see comment on `DiffSideBySide`. Same reasoning: skip
 * re-render when the diff content hasn't changed.
 *
 * Migrated from the `.diff-inline*` / `.diff-row*` / `.diff-gut*` /
 * `.diff-code` rules.
 */
export const DiffInline = memo(function DiffInline({
  sections,
  lang,
  lineHighlights,
  hunkActions,
  popoverHunkIdx,
  popoverNode,
  collapsedHunks,
  onToggleHunk,
}: Props) {
  return (
    <div className={DIFF_INLINE_ROOT}>
      {sections.map((sec, si) => {
        if (sec.kind === "filler") {
          return (
            <div
              key={si}
              className={DIFF_FILLER}
              style={{
                containIntrinsicSize: `1px ${sec.lines.length * 18}px`,
              }}
            >
              <div>
                {sec.lines.map((l, li) => (
                  <InlineRow
                    key={li}
                    line={l}
                    lang={lang}
                    highlight={lineHighlights?.get(`${si}:${li}`)}
                  />
                ))}
              </div>
            </div>
          );
        }
        const h = sec.hunk;
        const hi = sec.hunkIdx;
        const collapsed = collapsedHunks?.has(hi) ?? false;
        const intrinsicH = collapsed ? 28 : 28 + h.lines.length * 18;
        return (
          <div
            key={si}
            className="group border-b border-bd-0 [content-visibility:auto]"
            data-hunk-idx={hi}
            style={{ containIntrinsicSize: `1px ${intrinsicH}px` }}
          >
            <div className="flex items-center gap-1.5 pl-3.5 pr-2.5 py-1 bg-bg-1 border-b border-bd-0 sticky top-0 z-[1] text-[11px]">
              <FoldButton
                collapsed={collapsed}
                onClick={() => onToggleHunk?.(hi)}
              />
              <span className="font-mono text-fg-2">{h.header}</span>
              {hunkActions ? (
                <HunkActionBar hunkIdx={hi} actions={hunkActions} />
              ) : null}
            </div>
            {popoverHunkIdx === hi && popoverNode ? (
              <div className="hunk-popover-host flex justify-end px-3.5 pt-2 pb-1 bg-bg-1 border-b border-bd-0">
                {popoverNode}
              </div>
            ) : null}
            {!collapsed ? (
              <div>
                {h.lines.map((l, li) => (
                  <InlineRow
                    key={li}
                    line={l}
                    lang={lang}
                    highlight={lineHighlights?.get(`${si}:${li}`)}
                  />
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
});

function InlineRow({
  line,
  lang,
  highlight,
}: {
  line: DiffLine;
  lang: string;
  highlight: { ranges: [number, number, boolean][] } | undefined;
}) {
  const variant = line.t === "add" ? "add" : line.t === "del" ? "del" : "ctx";
  const styles = ROW_STYLES[variant];
  return (
    <div className={cn(INLINE_ROW, styles.row)}>
      <span className={GUT_NUM}>{line.n_old ?? ""}</span>
      <span className={GUT_NUM}>{line.n_new ?? ""}</span>
      <span className={cn(GUT_MARK, styles.mark)}>
        {line.t === "add" ? "+" : line.t === "del" ? "−" : ""}
      </span>
      <span className={cn(CODE, styles.code)}>
        <HLLine text={line.text} lang={lang} highlight={highlight} />
      </span>
    </div>
  );
}
