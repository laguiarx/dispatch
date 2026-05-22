/**
 * Native OS notifications for board transitions.
 *
 * Routed through `@tauri-apps/plugin-notification`, which calls into the
 * platform's notification center (NSUserNotification on macOS, the Action
 * Center on Windows, libnotify on Linux). The plugin is registered in
 * `src-tauri/src/lib.rs` and granted via `capabilities/default.json`.
 *
 * Permission is requested lazily on the first send — on macOS this is the
 * one-time system dialog ("Dispatch would like to send you notifications").
 * Once granted, subsequent sends are silent.
 *
 * The helper intentionally swallows every failure: a missing plugin, a
 * denied permission, or an unsupported platform should never surface as
 * a user-visible error — notifications are an enhancement, not a feature
 * the board depends on.
 */
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

import type { BoardColumnId, Card } from "@/features/board/board.types";
import type { Settings } from "@/lib/paths";

// Permission state shape:
//   - "unknown": never asked the OS in this session
//   - "granted": OS confirmed we can post notifications
//   - "denied":  user dismissed the prompt or said no
// We cache between calls so the streaming-fast path (a single drag-end
// firing notifyCardTransition) doesn't bounce through IPC every time.
// `force=true` callers (the Send test button) bypass the cache so the
// user can re-test after toggling something in System Settings without
// reloading the app.
let cachedPermissionState: "unknown" | "granted" | "denied" = "unknown";

async function ensurePermission(force = false): Promise<boolean> {
  if (!force) {
    if (cachedPermissionState === "granted") return true;
    if (cachedPermissionState === "denied") return false;
  }
  try {
    let granted = await isPermissionGranted();
    if (!granted) {
      // `requestPermission` resolves with "granted" / "denied" / "default".
      // "default" means the prompt was dismissed without a choice — treat
      // that as "not granted yet" so we don't cache a hard deny.
      const result = await requestPermission();
      granted = result === "granted";
      if (result === "default") {
        // Don't cache; let the next call re-prompt.
        return false;
      }
    }
    cachedPermissionState = granted ? "granted" : "denied";
    return granted;
  } catch {
    // Plugin not registered or platform doesn't support notifications —
    // treat as denied so we stop trying.
    cachedPermissionState = "denied";
    return false;
  }
}

type NotifyArgs = {
  title: string;
  body: string;
  /** Whether to play a sound. Falls through to the OS default chime. */
  sound: boolean;
};

async function notify({ title, body, sound }: NotifyArgs): Promise<void> {
  const granted = await ensurePermission();
  if (!granted) return;
  try {
    // The plugin treats `sound` as the name of a custom sound; omitting
    // it triggers the platform default (NSUserNotificationDefaultSoundName
    // on macOS). Passing `undefined` rather than `null` so the plugin's
    // optional-field handling kicks in cleanly.
    sendNotification({
      title,
      body,
      sound: sound ? "default" : undefined,
    });
  } catch {
    /* see file header — notifications are non-critical */
  }
}

/**
 * Whether the user has notifications enabled at all (master switch + the
 * platform actually being able to deliver). UI uses this to gate the
 * "Test notification" button's enabled state. Returns synchronously
 * against cached permission to avoid blocking the toggle UI.
 */
export function notificationsAvailable(
  settings: Settings,
): boolean {
  return settings.notifications.enabled;
}

/**
 * Fire a notification for a board transition. `prevColumn` is the column
 * the card came FROM; `card.columnId` is the column it just landed in.
 * Per-event toggles + the master switch are checked here so callers can
 * fire-and-forget without knowing the prefs.
 *
 * Currently handled transitions:
 *   - todo → in_progress  ("started")
 *   - * → review          ("ready to review")
 *   - * → done            ("PR opened")
 *
 * Anything else is a no-op so we don't bother the user with backlog
 * shuffling, drag-and-drop tweaks, or queue reshuffles.
 */
export function notifyCardTransition(
  card: Pick<Card, "title" | "taskNumber" | "columnId">,
  prevColumn: BoardColumnId | null,
  settings: Settings,
  context?: { projectName?: string | null; prUrl?: string | null },
): void {
  if (!settings.notifications.enabled) return;
  const { onInProgress, onReview, onPrOpened, sound } = settings.notifications;

  const taskLabel = card.taskNumber ? `T${card.taskNumber} · ` : "";
  const projectPrefix = context?.projectName ? `${context.projectName} — ` : "";
  const subject = `${projectPrefix}${taskLabel}${card.title}`;

  if (
    card.columnId === "in_progress" &&
    prevColumn !== "in_progress" &&
    onInProgress
  ) {
    void notify({
      title: "Agent started",
      body: subject,
      sound,
    });
    return;
  }

  if (card.columnId === "review" && prevColumn !== "review" && onReview) {
    void notify({
      title: "Ready to review",
      body: subject,
      sound,
    });
    return;
  }

  if (card.columnId === "done" && prevColumn !== "done" && onPrOpened) {
    void notify({
      title: "PR opened",
      body: context?.prUrl ? `${subject}\n${context.prUrl}` : subject,
      sound,
    });
  }
}

/**
 * Result codes returned by `sendTestNotification` so the Preferences UI
 * can show a precise toast / inline message instead of a vague "could
 * not send". The pane uses these to distinguish "user has the master
 * switch off" from "OS denied us" from "we never got a chance to ask".
 */
export type TestNotificationResult =
  | "sent"
  | "disabled" // master switch off in app prefs
  | "permission-denied" // user clicked Don't Allow in the OS prompt
  | "permission-pending" // prompt was dismissed without a choice (macOS "default")
  | "error"; // plugin threw — likely missing capability or unsupported

/**
 * One-shot test notification fired from the Preferences pane so the user
 * can verify the OS prompt + their toggles before relying on it during a
 * long agent run. Bypasses the per-event toggles but still respects the
 * master switch (otherwise the test wouldn't reflect production).
 *
 * Forces a fresh permission check on every invocation — the user might
 * have just changed something in System Settings → Notifications and
 * expects "Send test" to reflect the new state without an app reload.
 */
export async function sendTestNotification(
  settings: Settings,
): Promise<TestNotificationResult> {
  if (!settings.notifications.enabled) return "disabled";
  // Force a re-check so a cached "denied" from a previous attempt
  // doesn't permanently block testing after the user flipped the OS
  // toggle. Cheap (one IPC roundtrip).
  let permissionResult: Awaited<ReturnType<typeof requestPermission>> | null =
    null;
  try {
    let granted = await isPermissionGranted();
    if (!granted) {
      permissionResult = await requestPermission();
      granted = permissionResult === "granted";
    }
    if (!granted) {
      cachedPermissionState =
        permissionResult === "denied" ? "denied" : "unknown";
      return permissionResult === "default"
        ? "permission-pending"
        : "permission-denied";
    }
    cachedPermissionState = "granted";
  } catch {
    return "error";
  }
  try {
    sendNotification({
      title: "Dispatch",
      body: "Notifications are working. You'll get one when an agent finishes a task.",
      sound: settings.notifications.sound ? "default" : undefined,
    });
    return "sent";
  } catch {
    return "error";
  }
}
