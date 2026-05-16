import { memo, useMemo } from "react";
import { tokenizeCode, type Token, type TokenKind } from "@/lib/tokenize";

type HighlightRange = [start: number, end: number, isCurrent: boolean];

export type HighlightSpec = {
  ranges: HighlightRange[];
};

type Props = {
  text: string;
  lang: string;
  highlight?: HighlightSpec;
};

/**
 * Per-token-kind Tailwind classes. The legacy `.tk-keyword` … `.tk-heading`
 * rules in `index.css` are gone — each kind now uses arbitrary-value
 * Tailwind utilities pointing at the same CSS variables. The map is static
 * so Tailwind's JIT sees every class string.
 */
const TK_CLASS: Record<TokenKind, string> = {
  keyword: "text-[var(--tk-keyword)]",
  type: "text-[var(--tk-type)]",
  string: "text-[var(--tk-string)]",
  number: "text-[var(--tk-number)]",
  comment: "text-[var(--tk-comment)] italic",
  ident: "text-[var(--tk-ident)]",
  punct: "text-[var(--tk-punct)]",
  plain: "text-fg-0",
  heading: "text-[var(--tk-heading)] font-semibold",
};

/**
 * In-file search match highlight (rendered around any range that the user's
 * ⌘F query matched on this line). `MATCH_CURRENT` is the brighter variant
 * for the row that's currently in focus; we also tag that span with
 * `data-hl-current` so DiffPane's `querySelector('[data-hl-current]')` can
 * still scroll it into view.
 */
const MATCH =
  "bg-accent-softer rounded-[2px] " +
  "shadow-[0_0_0_1px_color-mix(in_oklab,var(--accent)_35%,transparent)]";
const MATCH_CURRENT = "bg-accent-soft rounded-[2px] shadow-[0_0_0_1px_var(--accent)]";

// Memoized so unchanged lines skip reconciliation when the parent re-renders
// (e.g. every keystroke in the editor). `highlight` shallow-compared is
// usually undefined on most lines; only the matched lines pass a new object.
export const HLLine = memo(function HLLine({ text, lang, highlight }: Props) {
  const tokens = useMemo(() => tokenizeCode(text, lang), [text, lang]);

  if (!highlight || highlight.ranges.length === 0) {
    return (
      <>
        {tokens.map((tk, i) => (
          <span key={i} className={TK_CLASS[tk.kind]}>
            {tk.text}
          </span>
        ))}
      </>
    );
  }

  const segs = splitTokensByRanges(tokens, highlight.ranges);
  return (
    <>
      {segs.map((s, i) => {
        const matchClass =
          s.matchKind === "current"
            ? ` ${MATCH} ${MATCH_CURRENT}`
            : s.matchKind === "match"
              ? ` ${MATCH}`
              : "";
        const isCurrent = s.matchKind === "current";
        return (
          <span
            key={i}
            className={TK_CLASS[s.kind] + matchClass}
            // Marker attribute used by DiffPane to scroll the active hit
            // into view; data-* is preferred over className for "hook"
            // selectors so the class list stays purely cosmetic.
            {...(isCurrent ? { "data-hl-current": "" } : {})}
          >
            {s.text}
          </span>
        );
      })}
    </>
  );
});

type Seg = {
  text: string;
  kind: Token["kind"];
  matchKind: false | "match" | "current";
};

function splitTokensByRanges(tokens: Token[], ranges: HighlightRange[]): Seg[] {
  const out: Seg[] = [];
  let pos = 0;
  for (const tk of tokens) {
    const start = pos;
    const end = pos + tk.text.length;
    // collect boundaries that fall strictly inside this token
    const boundaries = new Set<number>([start, end]);
    for (const r of ranges) {
      if (r[0] > start && r[0] < end) boundaries.add(r[0]);
      if (r[1] > start && r[1] < end) boundaries.add(r[1]);
    }
    const points = [...boundaries].sort((a, b) => a - b);
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      const seg = tk.text.slice(a - start, b - start);
      const containing = ranges.find((r) => r[0] <= a && r[1] >= b);
      const matchKind: Seg["matchKind"] = containing
        ? containing[2]
          ? "current"
          : "match"
        : false;
      out.push({ text: seg, kind: tk.kind, matchKind });
    }
    pos = end;
  }
  return out;
}
