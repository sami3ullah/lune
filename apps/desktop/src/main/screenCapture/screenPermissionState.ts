// Pure screen-recording permission state derivation (ticket 05). macOS gates screen
// capture behind the Screen Recording permission, and it has one notorious quirk:
// after the user flips the toggle, `getMediaAccessStatus('screen')` reports
// "granted" but the *already-running* process still cannot capture - macOS only
// hands out real frames to a process launched after the grant. So a bare status
// check is not enough; the truthful signal is whether a real capture came back with
// content. This function folds the OS status and a capture probe into the single
// state the permission UI renders, kept pure so the (few, fiddly) cases are tested
// rather than discovered in the wild (M1 Shell test plan: pure logic only).

/** The raw values Electron's `systemPreferences.getMediaAccessStatus('screen')` can return. */
export type ScreenRecordingAccessStatus =
  | "granted"
  | "denied"
  | "restricted"
  | "not-determined"
  | "unknown";

/**
 * Every permission state the UI acts on, as one canonical list:
 *   - "granted": access is granted and capture is confirmed working.
 *   - "denied": the user denied (or policy restricts) screen recording; System Settings is the only path.
 *   - "not-determined": access has never been requested; the first capture attempt will prompt.
 *   - "granted-needs-relaunch": the OS grants access, but this running process must relaunch to capture.
 *
 * This tuple is the single source of truth: the union below derives from it, and the
 * cross-boundary zod codec (`ipc/screenPermission.ts`) builds its enum from the same
 * tuple - so the two cannot drift and need no hand-written guard. The list lives in
 * this pure, dependency-free module so the codec can import it without pulling in any
 * main-process code.
 */
export const SCREEN_PERMISSION_STATES = [
  "granted",
  "denied",
  "not-determined",
  "granted-needs-relaunch",
] as const;

/** The permission state the UI acts on. */
export type ScreenPermissionState = (typeof SCREEN_PERMISSION_STATES)[number];

export interface ScreenPermissionSignals {
  /** What the OS reports for this app's screen-recording access. */
  mediaAccessStatus: ScreenRecordingAccessStatus;
  /**
   * Whether the most recent real capture attempt produced actual pixels: `true` if
   * it did, `false` if it came back empty/black (the grant-needs-relaunch tell),
   * `null` if no capture has been attempted yet this run.
   */
  captureProducedContent: boolean | null;
}

/**
 * Derives the permission state the UI renders from the OS status and the last
 * capture probe. The only subtle case is "granted": if a real capture has been
 * attempted and came back empty, the running process predates the grant and must
 * relaunch; otherwise (capture confirmed, or not yet probed) it counts as granted.
 */
export function deriveScreenPermissionState(
  signals: ScreenPermissionSignals,
): ScreenPermissionState {
  switch (signals.mediaAccessStatus) {
    case "denied":
    case "restricted":
      return "denied";
    case "not-determined":
    case "unknown":
      return "not-determined";
    case "granted":
      // OS says granted, but a real capture that came back empty means macOS is
      // withholding frames from this pre-grant process until it relaunches.
      if (signals.captureProducedContent === false) {
        return "granted-needs-relaunch";
      }
      return "granted";
  }
}
