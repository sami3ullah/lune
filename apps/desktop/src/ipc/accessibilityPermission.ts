import { z } from "zod";
import { ACCESSIBILITY_PERMISSION_STATES } from "../main/permissions/accessibilityPermissionState";

// The Shell's own renderer <-> main IPC for the macOS Accessibility permission (M1
// onboarding permissions step; consumed by ticket 11's push-to-talk voice loop, whose
// global uiohook hook needs Accessibility). Like the mic/screen permission messages,
// these never reach the Core: granting an OS permission is a pure OS concern a future
// HTTP adapter would never carry. They stay out of @lune/shared but are still fully
// zod-typed so nothing untyped crosses the process boundary (developer story 46).

/**
 * Renderer -> main (invoke): read the current Accessibility trust state *without*
 * prompting. The onboarding permissions step polls this for live status while it is open,
 * and the main process starts the push-to-talk hook the moment it reads "granted".
 */
export const ACCESSIBILITY_PERMISSION_STATUS_CHANNEL = "lune:accessibility:permission-status";

/**
 * Renderer -> main (invoke): request Accessibility access. macOS cannot grant it inline,
 * so this pops the system prompt that offers "Open System Settings"; the user flips the
 * toggle there and the next status poll detects it. Resolves to the current state.
 */
export const ACCESSIBILITY_PERMISSION_REQUEST_CHANNEL = "lune:accessibility:permission-request";

/**
 * Renderer -> main (send): open System Settings straight to the Accessibility pane, for
 * when the user dismissed the prompt and needs a second route to the toggle.
 */
export const ACCESSIBILITY_OPEN_SETTINGS_CHANNEL = "lune:accessibility:open-settings";

/**
 * The Accessibility permission state codec the renderer and main process share, built
 * from the same {@link ACCESSIBILITY_PERMISSION_STATES} tuple the pure
 * `AccessibilityPermissionState` union derives from, so the wire codec and the domain
 * type cannot drift. That tuple lives in a dependency-free module, so importing it here
 * pulls in no main-process code.
 */
export const AccessibilityPermissionStateSchema = z.enum(ACCESSIBILITY_PERMISSION_STATES);
export type AccessibilityPermissionStateValue = z.infer<typeof AccessibilityPermissionStateSchema>;
