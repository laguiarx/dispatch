import { I } from "./icons";
import { cn } from "@/lib/utils";

export type ToastKind = "info" | "danger";

export type ToastMessage = {
  id: string;
  text: string;
  kind: ToastKind;
};

/**
 * Stack of transient notifications anchored at the bottom-center of the
 * window. `danger` toasts paint the icon red; `info` (default) uses the
 * accent color. Migrated from the `.toast` / `.toast-stack` rules.
 */
export function Toast({ messages }: { messages: ToastMessage[] }) {
  return (
    <div
      className={
        "absolute bottom-[18px] left-1/2 -translate-x-1/2 z-[60] " +
        "flex flex-col gap-1.5"
      }
    >
      {messages.map((m) => (
        <div
          key={m.id}
          className={cn(
            "inline-flex items-center gap-2 px-3.5 py-2",
            "bg-bg-3 border border-bd-2 rounded-full text-[12px]",
            "shadow-toast animate-toast-in",
          )}
        >
          <span
            className={cn(
              "grid place-items-center",
              m.kind === "danger" ? "text-diff-del-mark" : "text-accent",
            )}
          >
            {m.kind === "danger" ? I.x : I.check}
          </span>
          <span>{m.text}</span>
        </div>
      ))}
    </div>
  );
}
