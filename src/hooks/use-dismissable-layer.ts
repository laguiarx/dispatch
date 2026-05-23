import { useEffect, useRef } from "react";

type DismissRef = { current: Node | null };

export function useDismissableLayer(
  open: boolean,
  setOpen: (open: boolean) => void,
  refs: readonly DismissRef[],
) {
  const refsRef = useRef(refs);
  refsRef.current = refs;

  useEffect(() => {
    if (!open) return;

    const closeFromPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (
        target &&
        refsRef.current.some((ref) => ref.current?.contains(target))
      ) {
        return;
      }
      setOpen(false);
    };

    const closeFromKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("pointerdown", closeFromPointer);
    document.addEventListener("keydown", closeFromKeyboard);
    return () => {
      document.removeEventListener("pointerdown", closeFromPointer);
      document.removeEventListener("keydown", closeFromKeyboard);
    };
  }, [open, setOpen]);
}
