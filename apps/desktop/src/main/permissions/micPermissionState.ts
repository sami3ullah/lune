// Pure microphone permission state derivation (ticket 14: onboarding's permissions
// step - mic + screen recording, live-detected). Unlike Screen Recording, the mic
// permission has no capture-only-after-relaunch quirk, so its state is a direct fold of
// the OS status: granted, blocked (denied/restricted - System Settings is the only
// path), or not-yet-requested (the first request will prompt). Kept pure so the (few)
// cases are unit-tested rather than discovered in the wild (M1 Shell test plan: pure
// logic only). This is the small platform-independent seam ticket 11's push-to-talk
// voice loop will read; the macOS `systemPreferences` edge stays in the main entry.

/** The raw values Electron's `systemPreferences.getMediaAccessStatus('microphone')` can return. */
export type MicrophoneAccessStatus =
  | "granted"
  | "denied"
  | "restricted"
  | "not-determined"
  | "unknown";

/**
 * Every microphone permission state the UI acts on, as one canonical list:
 *   - "granted": the mic is available to Lune.
 *   - "denied": the user denied (or policy restricts) mic access; System Settings is the only path.
 *   - "not-determined": access has never been requested; the first request will prompt.
 *
 * This tuple is the single source of truth: the union below derives from it, and the
 * cross-boundary zod codec (`ipc/micPermission.ts`) builds its enum from the same tuple,
 * so the wire codec and the domain type cannot drift. It lives in this pure,
 * dependency-free module so the codec can import it without pulling in main-process code.
 */
export const MIC_PERMISSION_STATES = ["granted", "denied", "not-determined"] as const;

/** The microphone permission state the UI acts on. */
export type MicPermissionState = (typeof MIC_PERMISSION_STATES)[number];

/**
 * Derives the permission state the UI renders from the OS status. A denied or
 * policy-restricted mic is "denied" (only System Settings can change it); an
 * unknown/undetermined status is "not-determined" (the first request will prompt).
 */
export function deriveMicPermissionState(status: MicrophoneAccessStatus): MicPermissionState {
  switch (status) {
    case "granted":
      return "granted";
    case "denied":
    case "restricted":
      return "denied";
    case "not-determined":
    case "unknown":
      return "not-determined";
  }
}
