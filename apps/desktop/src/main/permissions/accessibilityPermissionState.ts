// Pure Accessibility permission state derivation (M1 onboarding permissions step - mic +
// screen recording + Accessibility). Accessibility is what the global push-to-talk hook
// (uiohook) needs to observe the hotkey while any app has focus, so hold-to-talk works
// everywhere. Unlike the mic/screen media permissions, macOS exposes Accessibility as a
// single trusted/not-trusted bit (`AXIsProcessTrusted`), with no "not-determined" vs
// "denied" distinction and no in-process grant: the user toggles it in System Settings.
// So its state is a two-way fold, and "grant" means prompting/opening that pane rather
// than an OS dialog that resolves inline. Kept pure so the fold is unit-tested; the macOS
// `systemPreferences` edge stays in the main entry.

/**
 * Every Accessibility permission state the UI acts on, as one canonical list:
 *   - "granted": Lune is a trusted Accessibility client; the push-to-talk hook can run.
 *   - "not-granted": not trusted yet; the user must enable Lune in System Settings.
 *
 * This tuple is the single source of truth: the union below derives from it, and the
 * cross-boundary zod codec (`ipc/accessibilityPermission.ts`) builds its enum from the
 * same tuple, so the wire codec and the domain type cannot drift. It lives in this pure,
 * dependency-free module so the codec can import it without pulling in main-process code.
 */
export const ACCESSIBILITY_PERMISSION_STATES = ["granted", "not-granted"] as const;

/** The Accessibility permission state the UI acts on. */
export type AccessibilityPermissionState = (typeof ACCESSIBILITY_PERMISSION_STATES)[number];

/** Folds the OS "is this a trusted Accessibility client" bit into the UI state. */
export function deriveAccessibilityPermissionState(trusted: boolean): AccessibilityPermissionState {
  return trusted ? "granted" : "not-granted";
}
