import { z } from "zod";
import { SCREEN_PERMISSION_STATES } from "../main/screenCapture/screenPermissionState";

// The Shell's own renderer <-> main IPC for the macOS Screen Recording permission
// (ticket 05). Like the pill-control messages, these never reach the Core: granting
// an OS permission and relaunching the app are pure OS-and-pixels concerns a future
// HTTP adapter would never carry. They stay out of @lune/shared (the Core contract)
// but are still fully zod-typed so nothing untyped crosses the process boundary
// (developer story 46).

/**
 * Renderer -> main (invoke): read the current screen-recording permission state
 * *without* prompting when access has never been requested. When the OS already
 * reports access granted the main process may probe a real capture to surface the
 * needs-relaunch case; it never prompts on this channel, so the renderer can poll it
 * for live status while the permission UI is open.
 */
export const SCREEN_PERMISSION_STATUS_CHANNEL = "lune:screen:permission-status";

/**
 * Renderer -> main (invoke): actively attempt a capture to request access. This is
 * what triggers the macOS permission prompt on the first attempt (ticket 05
 * acceptance). Resolves to the resulting state so the UI reflects granted / denied /
 * needs-relaunch live.
 */
export const SCREEN_PERMISSION_REQUEST_CHANNEL = "lune:screen:permission-request";

/**
 * Renderer -> main (send): relaunch Lune. macOS only hands screen frames to a process
 * launched after the grant, so a freshly-granted, still-running app must restart
 * before it can capture - the "relaunch-if-needed" case.
 */
export const SCREEN_RELAUNCH_CHANNEL = "lune:screen:relaunch";

/**
 * Renderer -> main (send): open System Settings straight to the Screen Recording pane.
 * Once macOS has recorded a denial it never re-prompts, so re-probing a capture is a
 * dead end - the only way forward is the settings pane, where the user flips the toggle
 * (the permission UI then live-detects the grant on its next poll). This is the action
 * behind the denied-state button.
 */
export const SCREEN_OPEN_SETTINGS_CHANNEL = "lune:screen:open-settings";

/**
 * The permission state codec the renderer and main process share. It is built from
 * the same {@link SCREEN_PERMISSION_STATES} tuple the pure `ScreenPermissionState`
 * union derives from, so the wire codec and the domain type cannot drift. That tuple
 * lives in a dependency-free module, so importing it here pulls in no main-process code.
 */
export const ScreenPermissionStateSchema = z.enum(SCREEN_PERMISSION_STATES);
export type ScreenPermissionStateValue = z.infer<typeof ScreenPermissionStateSchema>;
