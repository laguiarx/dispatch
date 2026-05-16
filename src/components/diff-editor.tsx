import {
  Fragment,
  forwardRef,
  memo,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import type { LineHighlightMap } from "@/lib/find-in-diff";
import { cn } from "@/lib/utils";
import { HLLine } from "./hl-line";

type Props = {
  value: string;
  onChange: (value: string) => void;
  lang: string;
  lineHighlights?: LineHighlightMap;
  /** 1-indexed line numbers to paint with a "modified" stripe in the gutter. */
  changedLines?: Set<number>;
};

export type DiffEditorHandle = {
  selectRange: (start: number, end: number, focus?: boolean) => void;
};

/**
 * Shared font feature normalisation for gutter / overlay / textarea — the
 * three layers must use IDENTICAL glyph widths or the caret drifts off the
 * visible text. JetBrains Mono ships stylistic sets (cv11, ss01, cv01) that
 * tweak character shapes in a way that renders subtly differently in spans
 * vs native form inputs, so we explicitly turn them off everywhere.
 */
const FONT_NORM =
  "font-mono [font-feature-settings:normal] [font-variant-ligatures:none]";

/**
 * Single-block overlay-textarea editor.
 *
 * Gutter + overlay + textarea are all single `<pre>` / `<textarea>`
 * elements so the browser computes one line metric per element — no
 * per-row rounding drift. Caret is the native textarea bar (OS-controlled
 * blink rate).
 *
 * Migrated from the `.editor-wrap` / `.editor-grid` / `.editor-gutter*` /
 * `.editor-content` / `.editor-overlay` / `.editor-textarea` rules. The
 * shared `--editor-line-h` CSS variable still lives in `index.css` so the
 * three layers stay in lockstep on line height.
 */
export const DiffEditor = memo(
  forwardRef<DiffEditorHandle, Props>(function DiffEditor(
  { value, onChange, lang, lineHighlights, changedLines },
  ref,
) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const overlayRef = useRef<HTMLPreElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const lines = useMemo(() => value.split("\n"), [value]);

  // Keep the textarea height matching the overlay so the caret can reach
  // the last line.
  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    const ta = textareaRef.current;
    if (!overlay || !ta) return;
    let last = 0;
    const sync = () => {
      const h = overlay.offsetHeight;
      if (h !== last) {
        last = h;
        ta.style.height = `${h}px`;
      }
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(overlay);
    return () => ro.disconnect();
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      selectRange(start: number, end: number, focus = true) {
        const ta = textareaRef.current;
        const wrap = wrapRef.current;
        const overlay = overlayRef.current;
        if (!ta) return;
        if (focus) {
          ta.focus();
          ta.setSelectionRange(start, end);
        }
        if (wrap && overlay) {
          const before = ta.value.slice(0, start);
          const lineIdx = (before.match(/\n/g) || []).length;
          const styles = window.getComputedStyle(overlay);
          const lineHeight = parseFloat(styles.lineHeight) || 19;
          const top = lineIdx * lineHeight;
          const visibleTop = wrap.scrollTop;
          const visibleBottom = visibleTop + wrap.clientHeight;
          if (top < visibleTop + 24) {
            wrap.scrollTop = Math.max(0, top - 48);
          } else if (top + lineHeight > visibleBottom - 24) {
            wrap.scrollTop = top - wrap.clientHeight + lineHeight + 48;
          }
        }
      },
    }),
    [],
  );

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Tab") {
      e.preventDefault();
      const ta = e.currentTarget;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const next = value.slice(0, start) + "  " + value.slice(end);
      onChange(next);
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + 2;
      });
    }
  }

  return (
    <div
      ref={wrapRef}
      className={cn(
        "relative h-full min-h-0 overflow-y-auto overflow-x-hidden bg-bg-0",
        "[scrollbar-width:thin] [scrollbar-color:var(--bd-2)_transparent]",
        "[&::-webkit-scrollbar]:w-2.5",
        "[&::-webkit-scrollbar-thumb]:bg-bd-2",
        "[&::-webkit-scrollbar-thumb]:rounded-[5px]",
        "[&::-webkit-scrollbar-thumb]:border-2",
        "[&::-webkit-scrollbar-thumb]:border-bg-0",
      )}
    >
      <div
        className={cn(
          "relative grid grid-cols-[48px_1fr] min-h-full",
          "font-mono text-[12px] [tab-size:2]",
          "leading-[var(--editor-line-h)]",
        )}
      >
        <pre
          aria-hidden="true"
          className={cn(
            FONT_NORM,
            "m-0 px-1.5 bg-bg-1 border-r border-bd-0 text-fg-3 text-[11px]",
            "text-right whitespace-pre select-none [font-variant-numeric:tabular-nums]",
            "leading-[var(--editor-line-h)]",
          )}
        >
          {lines.map((_, i) => {
            const n = i + 1;
            const isChanged = changedLines?.has(n) ?? false;
            return (
              <Fragment key={i}>
                <span className={isChanged ? "text-git-mod font-semibold" : undefined}>
                  {n}
                </span>
                {i < lines.length - 1 ? "\n" : null}
              </Fragment>
            );
          })}
        </pre>
        <div className="relative">
          <pre
            ref={overlayRef}
            aria-hidden="true"
            className={cn(
              FONT_NORM,
              "m-0 px-3.5 text-[12px] whitespace-pre pointer-events-none",
              "leading-[var(--editor-line-h)]",
              // Hard-coded #e0e0e0 fallback so that even if --fg-0 is empty
              // (e.g. a broken custom-color override), the editor text never
              // blends into the dark background.
              "text-[color:var(--fg-0,#e0e0e0)] bg-bg-0",
            )}
          >
            {lines.map((line, i) => (
              <Fragment key={i}>
                <HLLine
                  text={line}
                  lang={lang}
                  highlight={lineHighlights?.get(`${i}`)}
                />
                {i < lines.length - 1 ? "\n" : null}
              </Fragment>
            ))}
          </pre>
          <textarea
            ref={textareaRef}
            className={cn(
              FONT_NORM,
              "absolute inset-0 m-0 px-3.5 text-[12px] whitespace-pre [tab-size:2]",
              "border-0 outline-none resize-none overflow-hidden",
              "leading-[var(--editor-line-h)]",
              // Text is rendered invisibly — the overlay <pre> above paints
              // the visible glyphs. Only the caret (`caret-color`) and the
              // native selection rectangle are seen.
              "bg-transparent text-transparent [-webkit-text-fill-color:transparent]",
              "caret-accent",
              "selection:bg-accent-soft",
            )}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
          />
        </div>
      </div>
    </div>
  );
  }),
);
