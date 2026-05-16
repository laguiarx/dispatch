import { BTN_DANGER, BTN_GHOST, BTN_PRIMARY } from "@/lib/btn";
import { Overlay } from "./overlay";

type Props = {
  open: boolean;
  title?: string;
  body?: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm?: () => void;
  onCancel: () => void;
};

/**
 * Generic yes/no confirm modal. Hosted by the Overlay scrim. Used by the
 * store's `setConfirm()` plumbing for discards, deletes, etc.
 *
 * Migrated from `.confirm-card` / `.confirm-title` / `.confirm-body` /
 * `.confirm-actions` rules. The `.primary-btn` / `.ghost-btn` /
 * `.danger-btn` button classes remain legacy until the "global buttons"
 * cleanup wave.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = "Confirm",
  danger,
  onConfirm,
  onCancel,
}: Props) {
  if (!open) return null;
  return (
    <Overlay onClose={onCancel} centered>
      <div
        className={
          "w-[min(440px,92vw)] bg-bg-2 border border-bd-2 rounded-3 p-[18px] " +
          "flex flex-col gap-3 shadow-[0_24px_60px_rgba(0,0,0,0.55)]"
        }
      >
        <div className="text-[15px] font-semibold tracking-[-0.01em]">
          {title}
        </div>
        <div className="font-mono text-fg-2 text-[12px] leading-[1.5]">
          {body}
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <button className={BTN_GHOST} onClick={onCancel}>
            Cancel
          </button>
          <button
            className={danger ? BTN_DANGER : BTN_PRIMARY}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </Overlay>
  );
}
