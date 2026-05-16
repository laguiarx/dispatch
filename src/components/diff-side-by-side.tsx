import { Fragment, memo, useMemo, type ReactNode } from "react";
import type {
  ChangedFileStatus,
  DiffLine,
} from "@/features/git/git.types";
import type { LineHighlightMap } from "@/lib/find-in-diff";
import type { DiffSection } from "@/lib/sections";
import { cn } from "@/lib/utils";
import { HLLine } from "./hl-line";
import { DiffSingle } from "./diff-single";
import { HunkActionBar, type HunkActions } from "./hunk-action-bar";
import { FoldButton } from "./fold-button";

// ----- shared style fragments ------------------------------------------------

const DIFF_SBS_ROOT = "font-mono text-[12px] leading-[1.55]";
// 2-column grid (one per side) with no column gap. Each child cell is a
// `.diff-side`-style 3-column subgrid (44px gutter, 16px mark, 1fr code).
const DIFF_GRID = "grid grid-cols-2 gap-x-0";
// Filler section wrapper — content-visibility: auto for off-screen perf.
// The intrinsic-size is set inline (per-section, based on line count).
const DIFF_FILLER = "border-b border-bd-0 opacity-[0.78] [content-visibility:auto]";
// One cell of the SbsCell / single-row layout: a 3-column subgrid
// (line-number gutter, mark gutter, code). Border-right divides the two
// sides; the right side overrides it back off.
const SIDE =
  "grid grid-cols-[44px_16px_1fr] items-start p-0 border-r border-bd-0 " +
  "whitespace-pre overflow-hidden";
// The two `.diff-gut` columns. Same baseline metrics, just different
// alignment + role-specific color.
const GUT = "inline-block px-1.5 text-[11px] text-fg-3 select-none leading-[1.55]";
const GUT_NUM = `${GUT} text-right`;
const GUT_MARK = `${GUT} text-center !px-0 !text-fg-2 font-semibold`;
const CODE = "px-1.5 pr-3 whitespace-pre overflow-hidden text-ellipsis";

/**
 * Per-row-kind styling: a row paints (1) its own background, (2) the code
 * cell with a stronger background + the colored left-stripe, (3) the mark
 * glyph in the matching accent. Pulled into a small map so add/del/ctx
 * stay symmetrical and a styling tweak is one edit.
 */
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
  // Blank half on a paired row (deleted line with no matching add, or
  // vice versa). Rendered as a diagonal-stripe pattern so the eye reads
  // "intentionally empty" rather than "missing data".
  empty:
    "bg-[repeating-linear-gradient(135deg,transparent_0_4px,rgba(255,255,255,0.012)_4px_8px)] " +
    "[:root[data-theme='light']_&]:bg-[repeating-linear-gradient(135deg,transparent_0_4px,rgba(0,0,0,0.025)_4px_8px)]",
} as const;

type Props = {
  sections: DiffSection[];
  lang: string;
  status: ChangedFileStatus;
  lineHighlights?: LineHighlightMap;
  hunkActions?: HunkActions | null;
  popoverHunkIdx?: number | null;
  popoverNode?: ReactNode;
  collapsedHunks?: Set<number>;
  onToggleHunk?: (hunkIdx: number) => void;
};

/**
 * Memoized: skips re-render when the diff content hasn't changed. Critical
 * for ⌥↓ navigation perf — the parent (`DiffPane`) re-renders on many
 * unrelated store updates, but the diff body is the most expensive child
 * tree (thousands of `HLLine` rows). Stable identities on `sections` /
 * `lineHighlights` / `hunkActions` / `popoverNode` / `onToggleHunk` /
 * `collapsedHunks` come from the parent via useMemo / useCallback.
 */
export const DiffSideBySide = memo(function DiffSideBySide({
  sections,
  lang,
  status,
  lineHighlights,
  hunkActions,
  popoverHunkIdx,
  popoverNode,
  collapsedHunks,
  onToggleHunk,
}: Props) {
  // Pre-pair each hunk's lines into left/right rows once per `sections`
  // identity. `pairSides` walks the line array twice and allocates a
  // PairedRow per row; doing it during render is fine for a single file
  // but at 30Hz selection-change rates it's 60K+ pair allocations / sec.
  // Memoizing by `sections` lifts the cost to once-per-file (and the
  // sections cache in lib/sections.ts means once-per-file-EVER, until
  // refresh).
  const pairedSections = useMemo(() => {
    return sections.map((sec) =>
      sec.kind === "hunk" ? pairSides(sec.hunk.lines) : null,
    );
  }, [sections]);

  // For whole-file added / deleted / untracked, fall back to single-column.
  if (status === "added" || status === "untracked") {
    const hunks = sections.flatMap((s) => (s.kind === "hunk" ? [s.hunk] : []));
    return (
      <>
        <WholeFileBanner status={status} />
        <DiffSingle
          hunks={hunks}
          lang={lang}
          side="add"
          lineHighlights={lineHighlights}
          hunkActions={hunkActions}
        />
      </>
    );
  }
  if (status === "deleted") {
    const hunks = sections.flatMap((s) => (s.kind === "hunk" ? [s.hunk] : []));
    return (
      <>
        <WholeFileBanner status={status} />
        <DiffSingle
          hunks={hunks}
          lang={lang}
          side="del"
          lineHighlights={lineHighlights}
          hunkActions={hunkActions}
        />
      </>
    );
  }

  return (
    <div className={DIFF_SBS_ROOT}>
      {sections.map((sec, si) => {
        if (sec.kind === "filler") {
          return (
            <div
              key={si}
              className={DIFF_FILLER}
              // Tell the browser roughly how tall this section is so
              // `content-visibility: auto` (above) can skip layout/paint
              // for the off-screen ones without making the scrollbar
              // jump as they get promoted. ~18px is the diff row height.
              style={{
                containIntrinsicSize: `1px ${sec.lines.length * 18}px`,
              }}
            >
              <div className={DIFF_GRID}>
                {sec.lines.map((l, li) => (
                  <Fragment key={li}>
                    <SbsCell
                      line={l}
                      side="left"
                      lang={lang}
                      highlight={lineHighlights?.get(`${si}:${li}`)}
                    />
                    <SbsCell
                      line={l}
                      side="right"
                      lang={lang}
                      highlight={lineHighlights?.get(`${si}:${li}`)}
                    />
                  </Fragment>
                ))}
              </div>
            </div>
          );
        }

        const h = sec.hunk;
        const hi = sec.hunkIdx;
        const paired = pairedSections[si] ?? pairSides(h.lines);
        const collapsed = collapsedHunks?.has(hi) ?? false;
        // Header (~28px) + rows. When collapsed only the header renders.
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
              // Class name kept as a marker so HunkActionBar's
              // `group-[:has(.hunk-popover-host)]:opacity-100` selector
              // can detect the popover and keep the action cluster lit.
              <div className="hunk-popover-host flex justify-end px-3.5 pt-2 pb-1 bg-bg-1 border-b border-bd-0">
                {popoverNode}
              </div>
            ) : null}
            {!collapsed ? (
              <div className={DIFF_GRID}>
                {paired.map((row, ri) => (
                  <Fragment key={ri}>
                    <SbsCell
                      line={row.left}
                      side="left"
                      lang={lang}
                      highlight={
                        row.leftLineIdx != null
                          ? lineHighlights?.get(`${si}:${row.leftLineIdx}`)
                          : undefined
                      }
                    />
                    <SbsCell
                      line={row.right}
                      side="right"
                      lang={lang}
                      highlight={
                        row.rightLineIdx != null
                          ? lineHighlights?.get(`${si}:${row.rightLineIdx}`)
                          : undefined
                      }
                    />
                  </Fragment>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
});

function SbsCell({
  line,
  side,
  lang,
  highlight,
}: {
  line: DiffLine | null;
  side: "left" | "right";
  lang: string;
  highlight: { ranges: [number, number, boolean][] } | undefined;
}) {
  const variant = rowVariant(line);
  const styles =
    variant === "empty" ? null : ROW_STYLES[variant];
  // For the right column we cancel the divider border (the left column's
  // border-r is the divider between sides).
  const num = line == null ? "" : side === "left" ? (line.n_old ?? "") : (line.n_new ?? "");
  return (
    <div
      className={cn(
        SIDE,
        side === "right" && "border-r-0",
        variant === "empty" ? ROW_STYLES.empty : styles?.row,
      )}
    >
      <span className={GUT_NUM}>{num}</span>
      <span className={cn(GUT_MARK, styles?.mark)}>{markFor(line)}</span>
      <span className={cn(CODE, styles?.code)}>
        {line ? <HLLine text={line.text} lang={lang} highlight={highlight} /> : ""}
      </span>
    </div>
  );
}

type PairedRow = {
  left: DiffLine | null;
  leftLineIdx: number | null;
  right: DiffLine | null;
  rightLineIdx: number | null;
};

function pairSides(lines: DiffLine[]): PairedRow[] {
  const rows: PairedRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.t === "ctx") {
      rows.push({ left: l, leftLineIdx: i, right: l, rightLineIdx: i });
      i++;
    } else {
      const delPairs: { line: DiffLine; idx: number }[] = [];
      const addPairs: { line: DiffLine; idx: number }[] = [];
      while (i < lines.length && lines[i].t === "del") {
        delPairs.push({ line: lines[i], idx: i });
        i++;
      }
      while (i < lines.length && lines[i].t === "add") {
        addPairs.push({ line: lines[i], idx: i });
        i++;
      }
      const len = Math.max(delPairs.length, addPairs.length);
      for (let k = 0; k < len; k++) {
        rows.push({
          left: delPairs[k]?.line ?? null,
          leftLineIdx: delPairs[k]?.idx ?? null,
          right: addPairs[k]?.line ?? null,
          rightLineIdx: addPairs[k]?.idx ?? null,
        });
      }
    }
  }
  return rows;
}

function rowVariant(line: DiffLine | null): keyof typeof ROW_STYLES {
  if (!line) return "empty";
  if (line.t === "add") return "add";
  if (line.t === "del") return "del";
  return "ctx";
}

function markFor(line: DiffLine | null): string {
  if (!line) return "";
  if (line.t === "add") return "+";
  if (line.t === "del") return "−";
  return "";
}

function WholeFileBanner({ status }: { status: ChangedFileStatus }) {
  const map: Partial<Record<ChangedFileStatus, { text: string; color: string }>> = {
    added: {
      text: "New file — no previous version to compare against.",
      color: "var(--diff-add-mark)",
    },
    deleted: {
      text: "Deleted file — showing the last contents before removal.",
      color: "var(--diff-del-mark)",
    },
    untracked: {
      text: "Untracked file — not yet known to git.",
      color: "var(--git-unt)",
    },
  };
  const m = map[status];
  if (!m) return null;
  return (
    <div
      className="flex items-center gap-2 px-3.5 py-2 bg-bg-1 border-b border-bd-0 text-[11.5px]"
      style={{ color: m.color }}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-current" />
      <span style={{ color: "var(--fg-1)" }}>{m.text}</span>
    </div>
  );
}
