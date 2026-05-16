import { cn } from "@/lib/utils";

/**
 * Tiny indeterminate spinner used while AI / Git operations are in flight.
 *
 * Migrated from the legacy `.ai-spinner` CSS rule. Tailwind's built-in
 * `animate-spin` provides the @keyframes; everything else is composed via
 * arbitrary values so the spinner stays themable through the same
 * `--bd-2` / `--accent` tokens the rest of the app uses.
 *
 * The default 14×14 size matches the original `.ai-spinner`. Pass a custom
 * `className` (e.g. `"w-3 h-3"`) to resize for tight spaces. Existing
 * call-sites that did `<span className="ai-spinner" />` map 1:1 to
 * `<Spinner />`.
 */
export function Spinner({ className }: { className?: string }) {
  return (
    <span
      // `data-ai-spinner` is the hook that lets a parent component override
      // size via `[&_[data-ai-spinner]]:w-3` etc — preferred over a marker
      // class so we can keep `.ai-spinner` out of the global stylesheet.
      data-ai-spinner
      className={cn(
        "inline-block w-[14px] h-[14px] rounded-full border-2 border-bd-2 " +
          "border-t-accent animate-spin",
        className,
      )}
      aria-hidden
    />
  );
}
