import { z } from "zod";
import { MIC_PERMISSION_STATES } from "../main/permissions/micPermissionState";

// The Shell's own renderer <-> main IPC for the macOS microphone permission (ticket 14's
// onboarding permissions step; consumed by ticket 11's push-to-talk voice loop). Like
// the screen-permission messages, these never reach the Core: granting an OS permission
// is a pure OS concern a future HTTP adapter would never carry. They stay out of
// @lune/shared but are still fully zod-typed so nothing untyped crosses the process
// boundary (developer story 46).

/**
 * Renderer -> main (invoke): read the current microphone permission state *without*
 * prompting. The onboarding permissions step polls this for live status while it is open.
 */
export const MIC_PERMISSION_STATUS_CHANNEL = "lune:mic:permission-status";

/**
 * Renderer -> main (invoke): request microphone access, prompting the macOS permission
 * dialog on the first attempt. Resolves to the resulting state so the UI reflects
 * granted / denied live.
 */
export const MIC_PERMISSION_REQUEST_CHANNEL = "lune:mic:permission-request";

/**
 * Renderer -> main (send): open System Settings straight to the Microphone pane. Once
 * macOS has recorded a denial it never re-prompts, so the denied-state button opens the
 * pane where the user flips the toggle; the permission UI live-detects the grant on its
 * next poll.
 */
export const MIC_OPEN_SETTINGS_CHANNEL = "lune:mic:open-settings";

/**
 * The mic permission state codec the renderer and main process share, built from the
 * same {@link MIC_PERMISSION_STATES} tuple the pure `MicPermissionState` union derives
 * from, so the wire codec and the domain type cannot drift. That tuple lives in a
 * dependency-free module, so importing it here pulls in no main-process code.
 */
export const MicPermissionStateSchema = z.enum(MIC_PERMISSION_STATES);
export type MicPermissionStateValue = z.infer<typeof MicPermissionStateSchema>;
