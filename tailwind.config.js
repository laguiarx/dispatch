/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  // We don't use Tailwind's class-based dark mode — themes live on
  // `<html data-theme="...">` and resolve to CSS custom properties. Every
  // utility below points at a `var(--token)` so the same `bg-bg-0`
  // automatically re-paints when the user switches Theme in Preferences.
  darkMode: "class",
  // Keep utility names short by extending rather than replacing the
  // default theme. Anything we don't override falls through to Tailwind's
  // defaults, which is fine for `flex`, `gap`, `text-sm` etc.
  theme: {
    extend: {
      colors: {
        // Backgrounds & foregrounds — the workhorse tokens.
        "bg-0": "var(--bg-0)",
        "bg-1": "var(--bg-1)",
        "bg-2": "var(--bg-2)",
        "bg-3": "var(--bg-3)",
        "bg-4": "var(--bg-4)",
        "bg-hover": "var(--bg-hover)",
        "bg-active": "var(--bg-active)",
        "bg-selected": "var(--bg-selected)",
        "fg-0": "var(--fg-0)",
        "fg-1": "var(--fg-1)",
        "fg-2": "var(--fg-2)",
        "fg-3": "var(--fg-3)",
        "fg-4": "var(--fg-4)",
        // Border tokens — used as `border-bd-2` etc. Tailwind exposes the
        // color under `border-{name}` AND `bg-{name}` AND `text-{name}`
        // for free, which is occasionally useful (e.g. a divider drawn as
        // `bg-bd-2`).
        "bd-0": "var(--bd-0)",
        "bd-1": "var(--bd-1)",
        "bd-2": "var(--bd-2)",
        "bd-3": "var(--bd-3)",
        // Brand + status colors.
        accent: "var(--accent)",
        "accent-hi": "var(--accent-hi)",
        "accent-soft": "var(--accent-soft)",
        "accent-softer": "var(--accent-softer)",
        "accent-fg": "var(--accent-fg)",
        // Git statuses.
        "git-mod": "var(--git-mod)",
        "git-add": "var(--git-add)",
        "git-del": "var(--git-del)",
        "git-ren": "var(--git-ren)",
        "git-unt": "var(--git-unt)",
        // Diff highlight tokens — used by the side-by-side / inline panes.
        "diff-add-bg": "var(--diff-add-bg)",
        "diff-add-bg-strong": "var(--diff-add-bg-strong)",
        "diff-del-bg": "var(--diff-del-bg)",
        "diff-del-bg-strong": "var(--diff-del-bg-strong)",
        "diff-add-mark": "var(--diff-add-mark)",
        "diff-del-mark": "var(--diff-del-mark)",
        // Syntax tokens.
        "tk-keyword": "var(--tk-keyword)",
        "tk-type": "var(--tk-type)",
        "tk-string": "var(--tk-string)",
        "tk-number": "var(--tk-number)",
        "tk-comment": "var(--tk-comment)",
        "tk-ident": "var(--tk-ident)",
        "tk-punct": "var(--tk-punct)",
        "tk-heading": "var(--tk-heading)",
      },
      fontFamily: {
        // Tailwind merges these with its defaults rather than replacing —
        // `font-sans` falls back to system fonts if the user's stack
        // somehow doesn't have Inter loaded.
        sans: ["var(--font-sans)"],
        mono: ["var(--font-mono)"],
      },
      borderRadius: {
        // Match the full existing scale (--radius-1..4). Tailwind defaults
        // (`rounded`, `rounded-sm`, etc) stay available; ours add `rounded-1`
        // through `rounded-4` and map to CSS variables so theme changes
        // propagate without rebuilding.
        1: "var(--radius-1, 4px)",
        2: "var(--radius-2, 6px)",
        3: "var(--radius-3, 8px)",
        4: "var(--radius-4, 12px)",
      },
      // Approximate metrics for the topbar / row heights we use a lot.
      // Avoids magic-number h-[24px] sprinkled everywhere.
      height: {
        topbar: "var(--topbar-h, 36px)",
      },
      // Backdrop blur amount we use on the floating-card panes (topbar,
      // sidebar, main-col, terminal). Exposes as `backdrop-blur-card`.
      backdropBlur: {
        card: "14px",
      },
      boxShadow: {
        // Pair of shadows used by every floating card. Mirrors what the
        // original CSS hand-rolled per panel; exposes as `shadow-card`.
        card: "0 12px 32px rgba(0, 0, 0, 0.4), 0 2px 8px rgba(0, 0, 0, 0.25)",
        // Lifted shadow for transient surfaces (toast notifications,
        // detached popovers). One layer, looser than `card`.
        toast: "0 8px 30px rgba(0, 0, 0, 0.4)",
      },
      keyframes: {
        // Toast entrance — fade + 8px slide-up. Used by `animate-toast-in`.
        "toast-in": {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "none" },
        },
      },
      animation: {
        "toast-in": "toast-in 200ms ease",
      },
    },
  },
  // No plugins for now — we keep the surface area minimal so it's easy
  // to reason about what classes resolve to.
  plugins: [],
};
