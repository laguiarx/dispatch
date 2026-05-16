import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRepoStore } from "@/features/repository/repository.store";
import { cn } from "@/lib/utils";
import { I } from "./icons";

type Anchor = { top: number; right: number };

/**
 * Read the trigger's viewport-relative position so the portal-mounted menu
 * can sit just under it regardless of any ancestor stacking contexts /
 * overflow / transforms.
 */
// Selector decoupled from className — the trigger button is now styled
// with Tailwind utilities and identified by this data-attribute (set on
// the chevron in `top-bar.tsx`'s EditorLauncher).
const TRIGGER_SELECTOR = "[data-editor-launcher-trigger]";

function computeAnchor(): Anchor {
  const trigger = document.querySelector<HTMLElement>(TRIGGER_SELECTOR);
  if (!trigger) return { top: 60, right: 16 };
  const rect = trigger.getBoundingClientRect();
  return {
    top: rect.bottom + 6,
    right: Math.max(8, window.innerWidth - rect.right),
  };
}

export function EditorMenu() {
  const open = useRepoStore((s) => s.editorMenuOpen);
  const setOpen = useRepoStore((s) => s.setEditorMenuOpen);
  const editors = useRepoStore((s) => s.editors);
  const fetchEditors = useRepoStore((s) => s.fetchEditors);
  const preferred = useRepoStore((s) => s.settings.preferredEditor);
  const setPreferred = useRepoStore((s) => s.setPreferredEditor);
  const pushToast = useRepoStore((s) => s.pushToast);

  const ref = useRef<HTMLDivElement | null>(null);
  const [anchor, setAnchor] = useState<Anchor>({ top: 60, right: 16 });

  // Recompute the trigger position when the menu opens, and keep it in sync
  // if the user resizes the window or scrolls a parent while it's open.
  useLayoutEffect(() => {
    if (!open) return;
    setAnchor(computeAnchor());
    const onResize = () => setAnchor(computeAnchor());
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    fetchEditors().catch(() => {
      /* error already surfaced */
    });
  }, [open, fetchEditors]);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const target = e.target as Node | null;
      if (ref.current && target && !ref.current.contains(target)) {
        // Don't close if the click was on the launcher chevron — it owns toggling.
        const trigger = document.querySelector(TRIGGER_SELECTOR);
        if (trigger && trigger.contains(target)) return;
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, setOpen]);

  if (!open) return null;

  // Portal-mounted at body so the menu is at the document root — escapes
  // any stacking context, overflow:hidden, or transform-creating ancestor
  // in the topbar / workspace tree.
  const cardShell =
    "fixed z-[9999] min-w-[220px] py-1 bg-bg-1 border border-bd-2 rounded-3 " +
    "shadow-[0_18px_50px_rgba(0,0,0,0.5),0_0_0_0.5px_rgba(255,255,255,0.04)]";
  const itemBase =
    "grid grid-cols-[16px_1fr_auto] items-center gap-2 w-full px-3 py-[7px] " +
    "text-left text-[12px] text-fg-1 bg-transparent border-0 cursor-pointer " +
    "hover:bg-bg-hover hover:text-fg-0";

  return createPortal(
    <div
      ref={ref}
      className={cardShell}
      style={{ top: anchor.top, right: anchor.right }}
    >
      <div className="px-3 pt-2 pb-1 text-fg-2 text-[9.5px] uppercase tracking-[0.08em]">
        Default editor
      </div>
      {editors.length === 0 ? (
        <div className="px-3.5 pt-3 pb-4 text-fg-2 text-[11.5px]">
          No supported editors detected on this machine.
        </div>
      ) : (
        editors.map((e) => (
          <button
            key={e.id}
            className={cn(itemBase, preferred === e.id && "text-fg-0")}
            onClick={() => {
              if (preferred !== e.id) {
                setPreferred(e.id);
                pushToast(`${e.name} is now the default editor`);
              }
              setOpen(false);
            }}
            title={
              preferred === e.id
                ? `${e.name} is the default`
                : `Set ${e.name} as default editor`
            }
          >
            <span className="grid place-items-center text-accent">
              {preferred === e.id ? I.check : null}
            </span>
            <span className="font-medium whitespace-nowrap overflow-hidden text-ellipsis">
              {e.name}
            </span>
            {preferred === e.id ? (
              <span className="font-mono text-fg-2 text-[9.5px] uppercase tracking-[0.04em]">
                default
              </span>
            ) : null}
          </button>
        ))
      )}
    </div>,
    document.body,
  );
}
