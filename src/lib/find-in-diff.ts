import type { DiffSection } from "./sections";

export type LineHighlightMap = Map<
  string,
  { ranges: [number, number, boolean][] }
>;

export type DiffLineMatch = {
  /** "${sectionIdx}:${lineIdx}" — matches the keys the renderers emit. */
  key: string;
  rangeStart: number;
  rangeEnd: number;
};

export type ValueMatch = {
  start: number;
  end: number;
};

export function buildSearchRegex(
  query: string,
  caseSensitive: boolean,
  isRegex: boolean,
): RegExp | null {
  if (!query) return null;
  try {
    const pattern = isRegex
      ? query
      : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(pattern, caseSensitive ? "g" : "gi");
  } catch {
    return null;
  }
}

export function findInSections(
  sections: DiffSection[],
  re: RegExp,
): DiffLineMatch[] {
  const matches: DiffLineMatch[] = [];
  const source = re.source;
  const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
  sections.forEach((sec, si) => {
    const lines = sec.kind === "hunk" ? sec.hunk.lines : sec.lines;
    lines.forEach((l, li) => {
      if (!l.text) return;
      const g = new RegExp(source, flags);
      let m: RegExpExecArray | null;
      while ((m = g.exec(l.text)) !== null) {
        matches.push({
          key: `${si}:${li}`,
          rangeStart: m.index,
          rangeEnd: m.index + m[0].length,
        });
        if (m[0].length === 0) g.lastIndex++;
      }
    });
  });
  return matches;
}

export function findInValue(value: string, re: RegExp): ValueMatch[] {
  const matches: ValueMatch[] = [];
  const source = re.source;
  const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
  const g = new RegExp(source, flags);
  let m: RegExpExecArray | null;
  while ((m = g.exec(value)) !== null) {
    matches.push({ start: m.index, end: m.index + m[0].length });
    if (m[0].length === 0) g.lastIndex++;
  }
  return matches;
}

export function buildLineHighlights(
  matches: DiffLineMatch[],
  currentIdx: number,
): LineHighlightMap {
  const out: LineHighlightMap = new Map();
  matches.forEach((m, idx) => {
    const entry = out.get(m.key) ?? { ranges: [] };
    entry.ranges.push([m.rangeStart, m.rangeEnd, idx === currentIdx]);
    out.set(m.key, entry);
  });
  return out;
}

/**
 * Convert global offsets within `value` into per-line ranges, keyed by the
 * zero-based line index — the same key the editor's overlay uses.
 */
export function valueLineHighlights(
  value: string,
  matches: ValueMatch[],
  currentIdx: number,
): LineHighlightMap {
  const lineStarts: number[] = [0];
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "\n") lineStarts.push(i + 1);
  }
  function lineOf(offset: number): number {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
  const out: LineHighlightMap = new Map();
  matches.forEach((m, idx) => {
    let cursor = m.start;
    while (cursor < m.end) {
      const li = lineOf(cursor);
      const lineStart = lineStarts[li];
      const lineEnd =
        li + 1 < lineStarts.length ? lineStarts[li + 1] - 1 : value.length;
      const endInLine = Math.min(m.end, lineEnd);
      const entry = out.get(`${li}`) ?? { ranges: [] };
      entry.ranges.push([
        cursor - lineStart,
        endInLine - lineStart,
        idx === currentIdx,
      ]);
      out.set(`${li}`, entry);
      cursor = endInLine + 1;
    }
  });
  return out;
}
