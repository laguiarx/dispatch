import type { DiffLine, Hunk } from "@/features/git/git.types";

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * Cross-mount cache for parsed diffs. `parseUnifiedDiff` is pure (string in →
 * `Hunk[]` out), and the input string is referentially stable for as long as
 * the underlying `DiffResult` lives in `DIFF_CACHE` (see git.api.ts). Caching
 * by string identity therefore turns navigation back to a recently-viewed
 * file into a Map lookup instead of a fresh parse over thousands of lines.
 *
 * 50 entries is overkill for individual reviews but trivial in memory — a
 * 2000-line file's `Hunk[]` is maybe 100KB.
 *
 * NOTE: keep this cache in sync with `DIFF_CACHE`. When the diff cache is
 * cleared (post-refresh) we should clear here too — see `clearDiffCache` in
 * git.api.ts, which calls `clearParsedDiffCache()` below.
 */
const PARSED_CACHE = new Map<string, Hunk[]>();
const PARSED_CACHE_MAX = 50;

export function clearParsedDiffCache(): void {
  PARSED_CACHE.clear();
}

/**
 * Parse a unified-diff text (as emitted by `git diff`) into a list of hunks.
 * Skips the diff header lines (`diff --git`, `index`, `---`, `+++`).
 *
 * Memoized — see PARSED_CACHE above.
 */
export function parseUnifiedDiff(diffText: string): Hunk[] {
  if (!diffText) return [];
  const cached = PARSED_CACHE.get(diffText);
  if (cached) return cached;
  const result = parseUnifiedDiffImpl(diffText);
  // LRU-ish: oldest insertion order entry gets dropped first.
  if (PARSED_CACHE.size >= PARSED_CACHE_MAX) {
    const oldest = PARSED_CACHE.keys().next().value;
    if (oldest !== undefined) PARSED_CACHE.delete(oldest);
  }
  PARSED_CACHE.set(diffText, result);
  return result;
}

function parseUnifiedDiffImpl(diffText: string): Hunk[] {
  const lines = diffText.split("\n");
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("diff --git") || line.startsWith("index ")) continue;
    if (line.startsWith("--- ") || line.startsWith("+++ ")) continue;
    if (line.startsWith("\\ No newline at end of file")) continue;
    if (line.startsWith("Binary files ")) continue;

    const hunkMatch = HUNK_RE.exec(line);
    if (hunkMatch) {
      if (current) hunks.push(current);
      const oldStart = Number(hunkMatch[1]);
      const newStart = Number(hunkMatch[3]);
      oldNo = oldStart;
      newNo = newStart;
      current = {
        header: line,
        oldStart,
        newStart,
        lines: [],
      };
      continue;
    }
    if (!current) continue;

    const first = line[0];
    const text = line.slice(1);
    let entry: DiffLine;
    if (first === "+") {
      entry = { t: "add", n_old: null, n_new: newNo, text };
      newNo++;
    } else if (first === "-") {
      entry = { t: "del", n_old: oldNo, n_new: null, text };
      oldNo++;
    } else if (first === " " || line === "") {
      entry = { t: "ctx", n_old: oldNo, n_new: newNo, text };
      oldNo++;
      newNo++;
    } else {
      continue;
    }
    current.lines.push(entry);
  }
  if (current) hunks.push(current);
  return hunks;
}

/**
 * Build a synthetic "added" hunk when there's no diff but only new content
 * (e.g. an untracked file shown for the first time).
 */
export function syntheticAddedHunk(newContent: string): Hunk {
  const arr = newContent.split("\n");
  if (arr.length && arr[arr.length - 1] === "") arr.pop();
  return {
    header: `@@ -0,0 +1,${arr.length} @@`,
    oldStart: 0,
    newStart: 1,
    lines: arr.map<DiffLine>((text, i) => ({
      t: "add",
      n_old: null,
      n_new: i + 1,
      text,
    })),
  };
}

/**
 * Build a synthetic "deleted" hunk from old content (no new content to compare).
 */
export function syntheticDeletedHunk(oldContent: string): Hunk {
  const arr = oldContent.split("\n");
  if (arr.length && arr[arr.length - 1] === "") arr.pop();
  return {
    header: `@@ -1,${arr.length} +0,0 @@`,
    oldStart: 1,
    newStart: 0,
    lines: arr.map<DiffLine>((text, i) => ({
      t: "del",
      n_old: i + 1,
      n_new: null,
      text,
    })),
  };
}
