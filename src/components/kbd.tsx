import type { ReactNode } from "react";

const MODIFIERS = new Set(["⌘", "⌥", "⌃", "⇧"]);

/**
 * Split a shortcut string like `"⌘⇧F"` into individual key chips:
 *   - modifier characters (⌘ ⌥ ⌃ ⇧) always become their own chip
 *   - everything else clumps together so multi-letter keys like "esc" or
 *     compound hints like "↑↓" stay in a single chip
 */
export function splitShortcut(input: string): string[] {
  const keys: string[] = [];
  let buf = "";
  for (const ch of input) {
    if (MODIFIERS.has(ch)) {
      if (buf) {
        keys.push(buf);
        buf = "";
      }
      keys.push(ch);
    } else {
      buf += ch;
    }
  }
  if (buf) keys.push(buf);
  return keys;
}

/**
 * Tailwind classes for an individual key chip. Pulled into a constant so
 * the standalone case and the in-group case stay visually identical — if
 * we tweak the chip look, there's exactly one place to edit. No left
 * margin here; spacing is handled by the wrapper (the standalone branch
 * adds `ml-1.5`, the multi-chip branch uses `gap-[3px]`).
 *
 * First component to be migrated from the legacy `.kbd` / `.shortcut`
 * rules in `index.css` — those have been removed.
 */
export const CHIP =
  "inline-flex items-baseline font-mono text-[10.5px] px-[5px] py-px " +
  "rounded-[3px] border border-bd-2 bg-bg-2 text-fg-2";

// Outermost Kbd element carries `data-kbd` so parents can override its
// margin via the arbitrary selector `[&_[data-kbd]]:!m-0`. The previous
// scheme used the `.kbd` className for the same purpose; we kept it as a
// marker (no styling) until the index.css shim was removed in the final
// cleanup wave.
export function Kbd({ children }: { children: ReactNode }) {
  if (typeof children === "string") {
    const keys = splitShortcut(children);
    if (keys.length > 1) {
      return (
        <span
          data-kbd
          className="inline-flex items-center gap-[3px] ml-1.5 align-baseline"
        >
          {keys.map((k, i) => (
            <span key={i} className={CHIP}>
              {k}
            </span>
          ))}
        </span>
      );
    }
  }
  return (
    <span data-kbd className={`${CHIP} ml-1.5`}>
      {children}
    </span>
  );
}
